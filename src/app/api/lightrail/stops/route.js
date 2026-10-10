/**
 * GET /api/lightrail/stops
 *
 * Lists Light Rail stops (the Light-Rail equivalent of `/api/bus-stops`).
 * Populated from the same `hk-bus-eta` upstream catalogue, filtered by
 * `co === ["lightRail"]` at the data layer (see @/lib/hkBusEta). A stop
 * survives the filter iff at least one surviving Light Rail route lists
 * it in its stop sequence.
 *
 * Query params:
 *   q       - optional case-insensitive substring match against the
 *             localised stop name (matches en and zh fields together)
 *   line    - optional Light Rail route filter, e.g. "505" or "505,610".
 *             A stop is kept iff at least one Light Rail route in the
 *             list passes through it.
 *   lat/lon - optional user location; when both are set, results are
 *             sorted by ascending distance and limited to `limit`.
 *   limit   - max results to return (default: 200, max: 1000)
 *   locale  - "en" | "zh-Hant" | "zh-Hans" (default: "en")
 *
 * Response:
 *   { total, queryMs, locale, stops: [{ id, name, nameEn, nameZh, lat, lng, routes: [...], distanceMetres? }] }
 */
import { CACHE_NEARBY } from "@/lib/apiCache";
import {
  getEtaDb,
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

  const routesRaw = (searchParams.get("line") ?? "").trim();
  const routeFilter = routesRaw
    ? new Set(
        routesRaw
          .split(",")
          .map((r) => r.trim())
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
    db = await getEtaDb("lightrail");
  } catch (err) {
    console.error("[/api/lightrail/stops] hk-bus-eta fetch failed:", err);
    return Response.json(
      { error: "Failed to load Light Rail stop catalogue" },
      { status: 502 }
    );
  }

  const matchesKeyword = (stop) => {
    if (!keyword) return true;
    const en = (stop?.name?.en ?? "").toLowerCase();
    const zh = (stop?.name?.zh ?? "").toLowerCase();
    return en.includes(keyword) || zh.includes(keyword);
  };

  // A stop survives the Light Rail filter when it is in db.stopList, and
  // at least one Light Rail route in the optional route filter passes
  // through it.
  //
  // Phase 2: `getRoutesForStop()` now returns `string[]` of route IDs
  // (compact form). The callers below iterate the strings directly
  // instead of destructuring a rich triple.
  const stopSatisfiesRouteFilter = (stopId) => {
    if (!routeFilter) return true;
    const routeIds = getRoutesForStop(stopId, "lightrail");
    for (const routeId of routeIds) {
      const route = db.routeList?.[routeId];
      if (!route) continue;
      if (routeFilter.has(route.route)) return true;
    }
    return false;
  };

  let stops = [];
  for (const [stopId, stop] of Object.entries(db.stopList ?? {})) {
    if (!matchesKeyword(stop)) continue;
    if (!stopSatisfiesRouteFilter(stopId)) continue;
    const lat0 = stop?.location?.lat;
    const lng0 = stop?.location?.lng;
    if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) continue;

    // Collect the unique Light Rail route numbers that touch this stop,
    // in their upstream boarding order.
    const routes = [];
    const seenRoutes = new Set();
    for (const routeId of getRoutesForStop(stopId, "lightrail")) {
      const route = db.routeList?.[routeId];
      if (!route) continue;
      const code = route.route;
      if (!code || seenRoutes.has(code)) continue;
      seenRoutes.add(code);
      routes.push(code);
    }

    stops.push({
      ...serialiseStop(stopId, stop, locale),
      routes,
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