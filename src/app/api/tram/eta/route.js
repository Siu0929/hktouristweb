/**
 * GET /api/tram/eta
 *
 * Returns live arrival times for Hong Kong Tramways trams at a given
 * stop. Thin wrapper over the upstream `geteat.php` endpoint that the
 * `hongkong-trams` npm package also wraps (we replicate the upstream
 * call directly with native fetch + an XML attribute parser to avoid
 * pulling in the package's legacy `request`/`bluebird` deps).
 *
 * The HK Tramways service shares a single linear stretch of track on
 * Hong Kong Island, so trams at any given stop are heading to one of
 * a small number of well-known termini (Kennedy Town, Shau Kei Wan,
 * Happy Valley, Western Market, …). The upstream response surfaces
 * that target in each arrival entry (`dest_stop_code` +
 * `tram_dest_en`/`tram_dest_tc`).
 *
 * Behaviour note (Sep 2026): the upstream `getmessage.php` endpoint
 * currently reports "The system is currently undergoing an upgrade",
 * and `geteat.php` returns `<root/>` until the upgrade finishes.
 * During that window this endpoint serves an empty `etas` list — no
 * error. When the upstream comes back online, live data resumes
 * automatically.
 *
 * Query params:
 *   stop     - upstream `stop_code` (required; obtain from
 *              /api/tram/stops, e.g. "92W", "KTT", "27E")
 *   locale   - app locale ("en" | "zh-Hant" | "zh-Hans", default "en")
 *
 * Response:
 *   {
 *     stop: { id, name, nameEn, nameTc, nameSc, lat, lng, direction },
 *     fetchedAt,
 *     upstreamNote,
 *     etas: [
 *       {
 *         seq, tramId, stopCode,
 *         dest: { stopCode, en, tc, sc, display },
 *         etaIso, etaRaw, minutesUntilArrival,
 *         isArrived, isLastTram, isRealtime
 *       }
 *     ]
 *   }
 *
 * Errors:
 *   400 - missing stop
 *   404 - stop not in the tram-stop catalogue
 *   502 - upstream fetch failed
 */
import { CACHE_REALTIME } from "@/lib/apiCache";
import {
  getTramStop,
  getTramEtas,
  localisedTramStopName,
  serialiseTramEta,
} from "@/lib/hkTramways";

export const dynamic = "force-dynamic";

function sanitiseLocale(raw) {
  const value = (raw ?? "en").toLowerCase();
  if (value.startsWith("zh-hant") || value === "zh-tw") return "zh-Hant";
  if (value.startsWith("zh-hans") || value === "zh-cn") return "zh-Hans";
  return "en";
}

export async function GET(request) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);

  const stopId = (searchParams.get("stop") ?? searchParams.get("stopId") ?? "").trim();
  const locale = sanitiseLocale(searchParams.get("locale"));

  if (!stopId) {
    return Response.json(
      { error: "Query param `stop` is required (use a stop_code from /api/tram/stops)" },
      { status: 400 }
    );
  }

  // Look up the stop for the response envelope. We deliberately fall
  // through to the upstream ETA call even if the stop isn't in our
  // cached catalogue — the upstream can still serve arrivals for
  // stop_codes we haven't seen (e.g. older catalogue or special cases).
  let stopMeta = null;
  try {
    stopMeta = await getTramStop(stopId);
  } catch (err) {
    // getTramStop only throws when the upstream googleMap.js fetch
    // fails. We swallow it here so the ETA call below still has a
    // chance to succeed against the live endpoint.
    console.warn(
      "[/api/tram/eta] stop metadata lookup failed, continuing without it:",
      err?.message ?? err
    );
  }

  let rawArrivals;
  try {
    rawArrivals = await getTramEtas(stopId);
  } catch (err) {
    console.error(
      `[/api/tram/eta] upstream fetch failed for stop "${stopId}":`,
      err
    );
    return Response.json(
      { error: `Failed to fetch tram ETAs from upstream: ${err?.message ?? "unknown error"}` },
      { status: 502 }
    );
  }

  // Serialise ETAs through the shared library helper. Each raw entry
  // comes back as a flat attribute object keyed by upstream field names
  // — the serialiser converts `eat` → `etaIso` (via Date.parse),
  // localises the destination, and computes `minutesUntilArrival`.
  const etas = rawArrivals.map((raw) => serialiseTramEta(raw, locale));

  // Stable sort: soonest arrival first.
  etas.sort((a, b) => {
    const aM = a.minutesUntilArrival;
    const bM = b.minutesUntilArrival;
    if (aM == null && bM == null) return 0;
    if (aM == null) return 1;
    if (bM == null) return -1;
    return aM - bM;
  });

  const stopPayload = stopMeta
    ? {
        id: stopMeta.stop_code,
        stopCode: stopMeta.stop_code,
        name: localisedTramStopName(stopMeta, locale),
        nameEn: stopMeta.en_name ?? "",
        nameTc: stopMeta.tc_name ?? "",
        nameSc: stopMeta.sc_name ?? "",
        direction: stopMeta.direction ?? "east & west",
        lat: Number.isFinite(stopMeta.latitude) ? stopMeta.latitude : null,
        lng: Number.isFinite(stopMeta.longitude) ? stopMeta.longitude : null,
      }
    : {
        id: stopId,
        stopCode: stopId,
        name: "",
        nameEn: "",
        nameTc: "",
        nameSc: "",
        direction: null,
        lat: null,
        lng: null,
        _warning:
          "stop is not in the cached HK Tramways catalogue; " +
          "arrivals (if any) come from the live upstream endpoint only",
      };

  return Response.json(
    {
      queryMs: Date.now() - t0,
      fetchedAt: new Date().toISOString(),
      stop: stopPayload,
      etas,
      upstreamNote:
        etas.length === 0
          ? "HK Tramways upstream returned no arrivals for this stop. " +
            "If this persists, the upstream service may be undergoing maintenance " +
            "(the /nextTram/getmessage.php endpoint surfaces operator notices)."
          : undefined,
    },
    {
      headers: {
        ...CACHE_REALTIME,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
