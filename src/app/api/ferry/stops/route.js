/**
 * GET /api/ferry/stops
 *
 * Lists ferry piers from the filtered `hk-bus-eta` catalogue
 * (Sun Ferry / HKKF / Fortune Ferry), scoped to routes whose `co` is one
 * of the three ferry operators (see @/lib/hkBusEta). A pier survives the
 * filter iff at least one surviving ferry route lists it in its stop
 * sequence.
 *
 * Query params:
 *   q        - optional case-insensitive substring match against the
 *              localised pier name (matches en and zh fields together)
 *   company  - optional ferry-operator filter: "sunferry", "hkkf",
 *              "fortuneferry" (comma-separated). A pier is kept iff at
 *              least one route touching it is run by a company in the
 *              filter. Defaults to every ferry operator.
 *   lat/lon  - optional user location; when both are set, results are
 *              sorted by ascending distance and limited to `limit`.
 *   limit    - max results to return (default: 200, max: 500)
 *   locale   - "en" | "zh-Hant" | "zh-Hans" (default: "en")
 *
 * Response:
 *   {
 *     total, queryMs, locale, hasLocation,
 *     stops: [{ id, name, nameEn, nameZh, lat, lng, companies: [...], distanceMetres? }]
 *   }
 */
import { CACHE_NEARBY } from "@/lib/apiCache";
import {
  getEtaDb,
  getRoutesForStop,
  serialiseStop,
} from "@/lib/hkBusEta";

export const dynamic = "force-dynamic";

const HK_BBOX = { minLat: 22.1, maxLat: 22.6, minLng: 113.8, maxLng: 114.5 };
const MAX_LIMIT = 500;
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
    db = await getEtaDb("ferry");
  } catch (err) {
    console.error("[/api/ferry/stops] hk-bus-eta fetch failed:", err);
    return Response.json(
      { error: "Failed to load ferry pier catalogue" },
      { status: 502 }
    );
  }

  const matchesKeyword = (stop) => {
    if (!keyword) return true;
    const en = (stop?.name?.en ?? "").toLowerCase();
    const zh = (stop?.name?.zh ?? "").toLowerCase();
    return en.includes(keyword) || zh.includes(keyword);
  };

  // A pier survives the ferry filter when it is in db.stopList, and at
  // least one route that calls there is run by a company in the optional
  // filter. Ferry companies are mutually exclusive in the upstream data
  // (a single ferry route's `co` has exactly one operator), so this is
  // effectively an "any of" check.
  //
  // Phase 2: `getRoutesForStop()` returns `string[]` of route IDs only;
  // we derive the per-route companies via `db.routeList`.
  const pierSatisfiesCompanyFilter = (stopId) => {
    if (!companyFilter) return true;
    const routeIds = getRoutesForStop(stopId, "ferry");
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
    if (!pierSatisfiesCompanyFilter(stopId)) continue;
    const lat0 = stop?.location?.lat;
    const lng0 = stop?.location?.lng;
    if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) continue;

    // Collect the unique ferry companies that touch this pier, in their
    // first-seen upstream order.
    const companies = [];
    const seenCompanies = new Set();
    for (const routeId of getRoutesForStop(stopId, "ferry")) {
      const route = db.routeList?.[routeId];
      if (!route) continue;
      for (const company of route.co ?? []) {
        if (!company || seenCompanies.has(company)) continue;
        seenCompanies.add(company);
        companies.push(company);
      }
    }

    stops.push({
      ...serialiseStop(stopId, stop, locale),
      companies,
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
