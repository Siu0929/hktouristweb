/**
 * GET /api/lightrail/routes
 *
 * Lists every Light Rail route from the filtered `hk-bus-eta` database
 * (the Light-Rail equivalent of `/api/bus-routes`). Each entry is a
 * Light Rail route such as 505, 610, 614, etc.
 *
 * Query params:
 *   q      - optional case-insensitive substring match against the route
 *            number, origin or destination (en + zh together).
 *   stopId - optional: only return routes that pass through `stopId`
 *            (uses the cached reverse index from @/lib/hkBusEta).
 *   limit  - max results (default: 200, max: 500)
 *   locale - "en" | "zh-Hant" | "zh-Hans" (default: "en")
 *
 * Response:
 *   { total, queryMs, locale, routes: [{ id, route, co, orig, dest, ... }] }
 */
import { CACHE_NEARBY } from "@/lib/apiCache";
import {
  getEtaDb,
  getRoutesForStop,
  serialiseRoute,
} from "@/lib/hkBusEta";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;
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

  const stopId = (searchParams.get("stopId") ?? "").trim();

  const limit = Math.min(
    Math.max(Number.parseInt(searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  let db;
  try {
    db = await getEtaDb("lightrail");
  } catch (err) {
    console.error("[/api/lightrail/routes] hk-bus-eta fetch failed:", err);
    return Response.json(
      { error: "Failed to load Light Rail route catalogue" },
      { status: 502 }
    );
  }

  let stopFilter = null;
  if (stopId) {
    // Phase 2: `getRoutesForStop()` returns `string[]` of route IDs.
    stopFilter = new Set(getRoutesForStop(stopId, "lightrail"));
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

  let routes = [];
  for (const [routeId, route] of Object.entries(db.routeList ?? {})) {
    if (stopFilter && !stopFilter.has(routeId)) continue;
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