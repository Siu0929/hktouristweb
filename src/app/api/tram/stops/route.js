/**
 * GET /api/tram/stops
 *
 * Lists Hong Kong Tramways (the Hong Kong Island "Ding Ding") stops
 * with their lat/lng, suitable for plotting on the home map.
 *
 * Data source: the official HK Tramways JS file
 *   GET https://www.hktramways.com/js/googleMap.js
 * This is the same catalogue linked by the Hong Kong government's
 * open-data portal at
 *   https://data.gov.hk/tc-data/dataset/hktramways-hktramways-tram-stops
 *
 * The upstream JS file defines two direction-keyed arrays
 * (`stopsArrayEB` for east-bound, `stopsArrayWB` for west-bound) and we
 * dedupe by `stop_code`, preferring the west-bound coordinates for
 * shared stops. See `@/lib/hkTramways` for the parse strategy and the
 * 6-hour TTL cache.
 *
 * Query params:
 *   q        - optional case-insensitive substring match against the
 *              localised stop name (en + tc + sc together)
 *   direction - optional direction filter: "west" | "east" | "terminus"
 *              | "east & west" (defaults to no filter)
 *   lat/lon  - optional user location; when both are set, results are
 *              sorted by ascending distance and limited to `limit`.
 *   limit    - max results to return (default: 200, max: 500)
 *   locale   - "en" | "zh-Hant" | "zh-Hans" (default: "en")
 *
 * Response:
 *   {
 *     total, queryMs, locale, hasLocation,
 *     stops: [{ id, stopCode, name, nameEn, nameTc, nameSc, direction, lat, lng, distanceMetres? }]
 *   }
 */
import { CACHE_NEARBY } from "@/lib/apiCache";
import {
  getTramStops,
  serialiseTramStop,
} from "@/lib/hkTramways";

export const dynamic = "force-dynamic";

const HK_BBOX = { minLat: 22.1, maxLat: 22.6, minLng: 113.8, maxLng: 114.5 };
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

const ALLOWED_DIRECTIONS = new Set([
  "west",
  "east",
  "terminus",
  "east & west",
]);

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

  const directionRaw = (searchParams.get("direction") ?? "").trim().toLowerCase();
  const directionFilter = directionRaw && ALLOWED_DIRECTIONS.has(directionRaw)
    ? directionRaw
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

  let rawStops;
  try {
    rawStops = await getTramStops();
  } catch (err) {
    console.error("[/api/tram/stops] tram stops fetch failed:", err);
    return Response.json(
      { error: "Failed to load tram stop catalogue" },
      { status: 502 }
    );
  }

  const matchesKeyword = (stop) => {
    if (!keyword) return true;
    const en = (stop?.en_name ?? "").toLowerCase();
    const tc = (stop?.tc_name ?? "").toLowerCase();
    const sc = (stop?.sc_name ?? "").toLowerCase();
    return (
      en.includes(keyword) || tc.includes(keyword) || sc.includes(keyword)
    );
  };

  const matchesDirection = (stop) =>
    !directionFilter || stop.direction === directionFilter;

  let stops = [];
  for (const stop of rawStops) {
    if (!matchesKeyword(stop)) continue;
    if (!matchesDirection(stop)) continue;
    const lat0 = stop?.latitude;
    const lng0 = stop?.longitude;
    if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) continue;

    const serialised = serialiseTramStop(stop, locale);
    if (hasLocation) {
      serialised.distanceMetres = haversineMetres(lat, lon, lat0, lng0);
    }
    stops.push(serialised);
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
