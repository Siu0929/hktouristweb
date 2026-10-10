/**
 * GET /api/mtr/eta
 *
 * Returns live arrival times for MTR lines at a given station. Thin
 * wrapper over `fetchEtas()` from `hk-bus-eta`, scoped to routes whose
 * `co` includes "mtr" (see @/lib/hkBusEta for the filter rules).
 *
 * Query params:
 *   stop     - upstream stop ID (required; obtain from /api/mtr/stops)
 *   route    - optional upstream route ID. When set, only ETAs for that
 *              MTR line are returned; otherwise every surviving MTR line
 *              through `stop` is queried.
 *   seq      - optional explicit boarding sequence index (0-based, per
 *              company). When omitted, we infer it from the cached
 *              reverse index.
 *   language - "en" (default) | "zh". Mapped from the app's locale
 *              strings ("zh-Hant" / "zh-Hans") automatically.
 *   locale   - app locale ("en" | "zh-Hant" | "zh-Hans"). Used to
 *              translate the response shape; falls back to `language`.
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
 *   404 - station not in the filtered catalogue, or line does not stop there
 *   502 - upstream ETA fetch failed
 */
import { fetchEtas } from "@/lib/hkBusEta";

import { CACHE_REALTIME } from "@/lib/apiCache";
import {
  getEtaDb,
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
      { error: "Query param `stop` is required (use a station ID from /api/mtr/stops)" },
      { status: 400 }
    );
  }

  let db;
  try {
    db = await getEtaDb("mtr");
  } catch (err) {
    console.error("[/api/mtr/eta] hk-bus-eta db fetch failed:", err);
    return Response.json(
      { error: "Failed to load MTR catalogue" },
      { status: 502 }
    );
  }

  const stop = db.stopList?.[stopId];
  if (!stop) {
    return Response.json(
      { error: `MTR station "${stopId}" not found in filtered catalogue` },
      { status: 404 }
    );
  }

  // Find the MTR lines that serve this station using the cached reverse
  // index. De-duplicate by routeId because the index can list the same
  // routeId twice if a stop sits on a route under multiple operators
  // (MTR lines are not joint services, so this is defensive).
  //
  // Phase 2: `getRoutesForStop()` now returns `string[]` of route IDs.
  // The ETA route needs the rich `{routeId, company, seq}` triple so
  // it switches to `getRouteMappingsForStop()`, which derives the
  // missing fields on demand by walking each candidate route's
  // `stops[co]` arrays (cheap — MTR routes are single-operator).
  const stopMappings = getRouteMappingsForStop(stopId, "mtr");
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
      { error: `MTR line "${routeId}" does not stop at "${stopId}"` },
      { status: 404 }
    );
  }

  // Fetch ETAs for every candidate line in parallel. Each call can throw
  // if the MTR upstream goes down, so we wrap every fetchEtas in its own
  // try/catch and return an empty eta array on failure rather than letting
  // one bad request nuke the whole response.
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
          `[/api/mtr/eta] fetchEtas failed for route ${candidateRouteId}:`,
          err?.message ?? err
        );
        return { candidateRouteId, route, companyForStop, seq, etas: [] };
      }
    })
  );

  const collator = new Intl.Collator(appLocale);
  perRoute.sort((a, b) => collator.compare(a.route.route, b.route.route));

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
        ...CACHE_REALTIME,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}