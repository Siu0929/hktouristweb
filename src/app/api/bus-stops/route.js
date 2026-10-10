/**
 * GET /api/bus-stops
 *
 * Returns the filtered bus-stop catalogue from `hk-bus-eta`.
 * A stop is kept iff it appears in at least one surviving route's
 * `stops[co]` list — see @/lib/hkBusEta for the filter rules.
 *
 * Note: The following operators are intentionally filtered out at the
 * data layer:
 *   - Green Minibus (gmb)    — minibus data is out of scope
 *   - MTR (mtr)              — served by dedicated MTR API
 *   - Light Rail (lightRail) — served by dedicated Light Rail API
 *   - Ferries (sunferry, hkkf, fortuneferry) — out of scope
 *
 * Only the surviving KMB / CTB / NLB / LRT feeder stops and routes
 * reach the response.
 *
 * Query params:
 *   q        - optional case-insensitive substring match against the
 *              localised stop name (matches en and zh fields together)
 *   company  - optional company filter (kmb, ctb, nlb, lrtfeeder).
 *              Multiple values separated by comma. Defaults to every
 *              surviving company.
 *   lat/lon  - optional user location; when both are set, results are
 *              sorted by ascending distance and limited to `limit`.
 *   limit    - max results to return (default: 200, max: 1000)
 *   locale   - "en" | "zh-Hant" | "zh-Hans" (default: "en")
 *
 * Response:
 *   { total, queryMs, locale, stops: [{ id, name, nameEn, nameZh, lat, lng, distanceMetres? }] }
 */
import { CACHE_NEARBY } from "@/lib/apiCache";
import {
  getFilteredEtaDb,
  getRoutesForStop,
  serialiseStop,
} from "@/lib/hkBusEta";

export const dynamic = "force-dynamic";

const HK_BBOX = { minLat: 22.1, maxLat: 22.6, minLng: 113.8, maxLng: 114.5 };
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

function sanitiseLocale(raw) {
  const value = (raw ?? "en").toLowerCase();
  if (value.startsWith("zh-hant") || value === "zh-tw") return "zh-Hant";
  if (value.startsWith("zh-hans") || value === "zh-cn") return "zh-Hans";
  return "en";
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRadians = (d) => (d * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(request) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);

  const rawQ = (searchParams.get("q") ?? "").trim();
  const keyword = rawQ.toLowerCase();
  const locale = sanitiseLocale(searchParams.get("locale"));

  const companiesRaw = (searchParams.get("company") ?? "").trim();
  const companyFilter = companiesRaw
    ? new Set(
        companiesRaw
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean)
      )
    : null;

  const lat = Number.parseFloat(searchParams.get("lat") ?? "");
  const lon = Number.parseFloat(searchParams.get("lon") ?? "");
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lon);

  if (hasLocation && (lat < HK_BBOX.minLat || lat > HK_BBOX.maxLat ||
                       lon < HK_BBOX.minLng || lon > HK_BBOX.maxLng)) {
    return Response.json(
      { error: "lat/lon outside Hong Kong bounding box" },
      { status: 400 }
    );
  }

  const limit = Math.min(
    Math.max(Number.parseInt(searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  let db;
  try {
    db = await getFilteredEtaDb();
  } catch (err) {
    console.error("[/api/bus-stops] hk-bus-eta fetch failed:", err);
    return Response.json(
      { error: "Failed to load bus stop catalogue" },
      { status: 502 }
    );
  }

  const matchesKeyword = (stop) => {
    if (!keyword) return true;
    const en = (stop?.name?.en ?? "").toLowerCase();
    const zh = (stop?.name?.zh ?? "").toLowerCase();
    return en.includes(keyword) || zh.includes(keyword);
  };

  // A stop survives the filter when it is in db.stopList (the reachable-
  // stops filter already removed MTR / Light Rail / ferry / minibus
  // stops), and at least one of the routes that serves it matches the
  // optional company filter.
  //
  // Phase 2: `getRoutesForStop()` returns a compact `string[]` of route
  // IDs (no `{company, seq}` triple). We derive the companies per stop
  // by looking up the route metadata directly in `db.routeList`. The
  // walk is O(routes-per-stop × companies-per-route) which is small.
  const stopSatisfiesCompanyFilter = (stopId) => {
    if (!companyFilter) return true;
    const routeIds = getRoutesForStop(stopId);
    for (const routeId of routeIds) {
      const route = db.routeList?.[routeId];
      if (!route) continue;
      for (const co of route.co ?? []) {
        if (companyFilter.has(co)) return true;
      }
    }
    return false;
  };

  let stops = [];
  for (const [stopId, stop] of Object.entries(db.stopList ?? {})) {
    if (!matchesKeyword(stop)) continue;
    if (!stopSatisfiesCompanyFilter(stopId)) continue;
    const lat0 = stop?.location?.lat;
    const lng0 = stop?.location?.lng;
    if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) continue;
    stops.push({
      ...serialiseStop(stopId, stop, locale),
      distanceMetres: hasLocation ? haversineMetres(lat, lon, lat0, lng0) : null,
    });
  }

  if (hasLocation) {
    stops.sort((a, b) => (a.distanceMetres ?? 0) - (b.distanceMetres ?? 0));
  }

  const truncated = stops.length > limit;
  if (truncated) stops = stops.slice(0, limit);

  return Response.json(
    {
      total: stops.length,
      truncated,
      queryMs: Date.now() - t0,
      locale,
      hasLocation,
      stops,
    },
    {
      headers: {
        ...CACHE_NEARBY,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
