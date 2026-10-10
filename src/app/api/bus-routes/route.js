/**
 * GET /api/bus-routes
 *
 * Lists every bus route from the filtered `hk-bus-eta` database.
 * Routes whose `co` includes "mtr", "lightRail", "gmb", or any ferry
 * code ("sunferry", "hkkf", "fortuneferry") are excluded — see
 * @/lib/hkBusEta for the rationale and filter rules.
 *
 * Query params:
 *   q        - optional case-insensitive substring match against the
 *              route number, origin, or destination (en + zh together)
 *   company  - optional company filter, e.g. "kmb" or "kmb,ctb". Routes
 *              must include at least one of the listed companies.
 *   stopId   - optional: only return routes that pass through `stopId`
 *              (uses the cached reverse index from @/lib/hkBusEta)
 *   limit    - max results (default: 200, max: 2000)
 *   locale   - "en" | "zh-Hant" | "zh-Hans" (default: "en")
 *
 * Response:
 *   { total, queryMs, locale, routes: [{ id, route, co, orig, dest, ... }] }
 */
import { CACHE_NEARBY } from "@/lib/apiCache";
import {
  getFilteredEtaDb,
  getRoutesForStop,
  serialiseRoute,
} from "@/lib/hkBusEta";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 200;

function sanitiseLocale(raw) {
  const value = (raw ?? "en").toLowerCase();
  if (value.startsWith("zh-hant") || value === "zh-tw") return "zh-Hant";
  if (value.startsWith("zh-hans") || value === "zh-cn") return "zh-Hans";
  return "en";
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

  const stopId = (searchParams.get("stopId") ?? "").trim();

  const limit = Math.min(
    Math.max(Number.parseInt(searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  let db;
  try {
    db = await getFilteredEtaDb();
  } catch (err) {
    console.error("[/api/bus-routes] hk-bus-eta fetch failed:", err);
    return Response.json(
      { error: "Failed to load bus route catalogue" },
      { status: 502 }
    );
  }

  // When filtering by stopId, only routes listed in the cached reverse
  // index for that stop are eligible. De-duplicate by routeId because
  // the reverse index can list the same routeId twice if it passes
  // through a stop under multiple operators.
  //
  // Phase 2: `getRoutesForStop()` returns `string[]` of route IDs. We
  // wrap in a Set to deduplicate (joint KMB↔CTB services still surface
  // a single route-id here, but defensive dedup is cheap).
  let stopFilter = null;
  if (stopId) {
    stopFilter = new Set(getRoutesForStop(stopId));
  }

  const matchesKeyword = (route) => {
    if (!keyword) return true;
    const haystack = [
      route.route ?? "",
      route.orig?.en ?? "",
      route.orig?.zh ?? "",
      route.dest?.en ?? "",
      route.dest?.zh ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(keyword);
  };

  const matchesCompany = (route) => {
    if (!companyFilter) return true;
    return route.co?.some((c) => companyFilter.has(c));
  };

  let routes = [];
  for (const [routeId, route] of Object.entries(db.routeList ?? {})) {
    if (stopFilter && !stopFilter.has(routeId)) continue;
    if (!matchesCompany(route)) continue;
    if (!matchesKeyword(route)) continue;
    routes.push(serialiseRoute(routeId, route, locale));
  }

  const collator = new Intl.Collator(locale);
  routes.sort((a, b) => {
    const an = Number.parseInt(a.route, 10);
    const bn = Number.parseInt(b.route, 10);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    if (a.route !== b.route) return collator.compare(a.route, b.route);
    return collator.compare(a.orig.display, b.orig.display);
  });

  const truncated = routes.length > limit;
  if (truncated) routes = routes.slice(0, limit);

  return Response.json(
    {
      total: routes.length,
      truncated,
      queryMs: Date.now() - t0,
      locale,
      routes,
    },
    {
      headers: {
        ...CACHE_NEARBY,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
