/**
 * GET /api/bus-eta
 *
 * Returns live arrival times for bus routes at a given stop. Thin wrapper
 * over `fetchEtas()` from `hk-bus-eta` with the same MTR / Light Rail /
 * ferry / minibus exclusion policy as the rest of the bus API surface
 * (see @/lib/hkBusEta). The following operators are filtered out at the
 * data layer:
 *   - MTR (mtr)
 *   - Light Rail (lightRail)
 *   - Ferries (sunferry, hkkf, fortuneferry)
 *   - Green Minibus (gmb)
 *
 * Query params:
 *   stop     - upstream stop ID (required; obtain from /api/bus-stops)
 *   route    - optional upstream route ID. When set, only ETAs for that
 *              route are returned; otherwise every surviving route through
 *              `stop` is queried.
 *   seq      - optional explicit boarding sequence index (0-based, per
 *              company). When omitted, we infer it from the cached
 *              reverse index.
 *   language - "en" (default) | "zh". Mapped from the app's locale strings
 *              ("zh-Hant" / "zh-Hans") automatically.
 *   locale   - app locale ("en" | "zh-Hant" | "zh-Hans"). Used to translate
 *              the response shape; falls back to `language`.
 *
 * Response:
 *   {
 *     stop: { id, name, nameEn, nameZh, lat, lng },
 *     routes: [
 *       {
 *         routeId, routeNo, co, company, bound, serviceType,
 *         etas: [{ eta, minutes, isRealtime, dest, remark, co }]
 *       }
 *     ]
 *   }
 *
 * Errors:
 *   400 - missing stop
 *   404 - stop not in the filtered catalogue
 *   502 - upstream ETA fetch failed
 */
import { fetchEtas } from "@/lib/hkBusEta";

import {
  getFilteredEtaDb,
  getRouteMappingsForStop,
  localisedStopName,
  localisedTerminal,
} from "@/lib/hkBusEta";

export const dynamic = "force-dynamic";

const APP_TO_UPSTREAM_LANG = {
  en: "en",
  "zh-hant": "zh",
  "zh-hans": "zh",
  zh: "zh",
};

function resolveLanguage(rawLanguage, rawLocale) {
  const fromLang = APP_TO_UPSTREAM_LANG[String(rawLanguage ?? "").toLowerCase()];
  if (fromLang) return fromLang;
  const fromLocale = APP_TO_UPSTREAM_LANG[String(rawLocale ?? "").toLowerCase()];
  return fromLocale ?? "en";
}

function resolveAppLocale(rawLocale) {
  const v = String(rawLocale ?? "").toLowerCase();
  if (v.startsWith("zh-hant") || v === "zh-tw") return "zh-Hant";
  if (v.startsWith("zh-hans") || v === "zh-cn") return "zh-Hans";
  return "en";
}

/** ms since epoch → human-friendly minutes-from-now, or null if not parseable. */
function etaMinutes(etaString) {
  if (!etaString) return null;
  const t = Date.parse(etaString);
  if (!Number.isFinite(t)) return null;
  const diff = Math.round((t - Date.now()) / 60000);
  return diff;
}

export async function GET(request) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);

  const stopId = (searchParams.get("stop") ?? searchParams.get("stopId") ?? "").trim();
  const routeId = (searchParams.get("route") ?? searchParams.get("routeId") ?? "").trim();
  const seqOverrideRaw = searchParams.get("seq");
  const seqOverride = seqOverrideRaw != null && seqOverrideRaw !== ""
    ? Number.parseInt(seqOverrideRaw, 10)
    : null;
  const appLocale = resolveAppLocale(searchParams.get("locale"));
  const language = resolveLanguage(searchParams.get("language"), appLocale);

  if (!stopId) {
    return Response.json(
      { error: "Query param `stop` is required (use a stop ID from /api/bus-stops)" },
      { status: 400 }
    );
  }

  let db;
  try {
    db = await getFilteredEtaDb();
  } catch (err) {
    console.error("[/api/bus-eta] hk-bus-eta db fetch failed:", err);
    return Response.json(
      { error: "Failed to load bus route catalogue" },
      { status: 502 }
    );
  }

  const stop = db.stopList?.[stopId];
  if (!stop) {
    return Response.json(
      { error: `Stop "${stopId}" not found in filtered catalogue` },
      { status: 404 }
    );
  }

  // Find the routes that serve this stop using the cached reverse index.
  // De-duplicate by routeId — a stop can be listed twice (once per company)
  // when a joint service serves it.
  //
  // Phase 2: the reverse index only carries route IDs (`string[]`), so
  // `getRouteMappingsForStop()` is used here to derive the
  // `(routeId, company, seq)` triple required by `fetchEtas()`. The
  // derivation walks each candidate route's `stops[co]` arrays to find
  // the company + boarding position — O(routes-per-stop × co ×
  // stops-on-sequence), called once per ETA request.
  const stopMappings = getRouteMappingsForStop(stopId);
  const seenRouteIds = new Set();
  const routeCandidates = [];
  for (const { routeId: candidateRouteId, company, seq } of stopMappings) {
    if (routeId && routeId !== candidateRouteId) continue;
    const route = db.routeList?.[candidateRouteId];
    if (!route) continue;
    if (seenRouteIds.has(candidateRouteId)) continue;
    seenRouteIds.add(candidateRouteId);
    routeCandidates.push({
      routeId: candidateRouteId,
      route,
      companyForStop: company,
      seqForCompany: seq,
    });
  }

  if (routeId && routeCandidates.length === 0) {
    return Response.json(
      { error: `Route "${routeId}" does not stop at "${stopId}"` },
      { status: 404 }
    );
  }

  // Fetch ETAs for every candidate route in parallel. Each call can throw if
  // the company-specific upstream goes down, so we wrap every fetchEtas in
  // its own try/catch and return an empty eta array on failure rather than
  // letting one bad operator nuke the whole response.
  const perRoute = await Promise.all(
    routeCandidates.map(async ({ routeId: candidateRouteId, route, companyForStop, seqForCompany }) => {
      const seq = seqOverride != null ? seqOverride : seqForCompany;
      try {
        const rawEtas = await fetchEtas({
          ...route,
          seq,
          language,
          stopList: db.stopList,
          holidays: db.holidays,
          serviceDayMap: db.serviceDayMap,
        });
        return { candidateRouteId, route, companyForStop, seq, etas: rawEtas };
      } catch (err) {
        console.warn(
          `[/api/bus-eta] fetchEtas failed for route ${candidateRouteId}:`,
          err?.message ?? err
        );
        return { candidateRouteId, route, companyForStop, seq, etas: [] };
      }
    })
  );

  // Sort the route list so it reads naturally in the UI:
  //   1. Routes with live ETA data bubble to the top, ordered by their
  //      earliest arrival (closest first). Within ties, fall back to the
  //      localised route-number ordering so "1A" / "1B" stay grouped.
  //   2. Routes with no ETA data (empty upstream response or all-null
  //      minutes) sink to the bottom. There they're still ordered by
  //      route number so the "no service today" tail isn't random.
  const collator = new Intl.Collator(appLocale);
  const earliestMinutes = (etas) => {
    for (const e of etas) {
      const m = etaMinutes(e.eta);
      if (m != null) return m;
    }
    return null;
  };
  perRoute.sort((a, b) => {
    const aMin = earliestMinutes(a.etas);
    const bMin = earliestMinutes(b.etas);
    const aHas = aMin != null;
    const bHas = bMin != null;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    if (aHas && bHas) {
      if (aMin !== bMin) return aMin - bMin;
    }
    return collator.compare(a.route.route, b.route.route);
  });

  const enriched = perRoute.map(({ candidateRouteId, route, companyForStop, seq, etas }) => ({
    routeId: candidateRouteId,
    routeNo: route.route,
    co: route.co,
    company: companyForStop,
    bound: route.bound?.[companyForStop] ?? null,
    serviceType: route.serviceType,
    seq,
    orig: {
      en: route.orig?.en ?? "",
      zh: route.orig?.zh ?? "",
      display: localisedTerminal(route.orig, appLocale) || route.orig?.en || "",
    },
    dest: {
      en: route.dest?.en ?? "",
      zh: route.dest?.zh ?? "",
      display: localisedTerminal(route.dest, appLocale) || route.dest?.en || "",
    },
    etas: etas.map((e) => {
      const minutes = etaMinutes(e.eta);
      return {
        eta: e.eta, // ISO string from upstream
        minutes,
        isRealtime: minutes != null,
        dest: e.dest ?? { zh: "", en: "" },
        remark: e.remark ?? { zh: "", en: "" },
        co: e.co,
      };
    }),
  }));

  return Response.json(
    {
      queryMs: Date.now() - t0,
      stop: {
        id: stopId,
        name: localisedStopName(stop, appLocale),
        nameEn: stop.name?.en ?? "",
        nameZh: stop.name?.zh ?? "",
        lat: stop.location?.lat ?? null,
        lng: stop.location?.lng ?? null,
      },
      routes: enriched,
    },
    {
      headers: {
        // ETAs change every few seconds — keep the CDN cache window tiny.
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
