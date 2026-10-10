/**
 * Shared API caching constants for HKTouristApp.
 *
 * Cache-Control header strategy (Phase 1):
 *
 *   The previous versions used `s-maxage` only, which controls CDN /
 *   shared caches but does NOT instruct the user's browser to cache the
 *   response. Every page load was therefore re-issuing the same GET
 *   for the stops / toilets-nearby endpoints, and re-running the
 *   full upstream catalogue scan on the server.
 *
 *   Phase 1 adds max-age so the browser actually keeps a private copy,
 *   plus stale-while-revalidate so a request that hits a stale copy
 *   still reuses the bytes while a background refresh runs. The data
 *   here is reference-style (stop lists, routes, fare tables) — none of
 *   it changes second-to-second, so we can be aggressive.
 *
 *   Per-class numbers:
 *     - Real-time ETA / arrival data:  max-age=0,    s-maxage=15,  swr=45
 *         (browser must always re-validate; CDN can hold briefly)
 *     - Suggestion / autocomplete:     max-age=30,   s-maxage=60,  swr=120
 *         (autocomplete is per-keystroke — short browser window)
 *     - Bbox / proximity:              max-age=60,   s-maxage=120, swr=600
 *         (results shift as the user pans the map)
 *     - Nearby / list queries:         max-age=60,   s-maxage=300, swr=3600
 *         (stops, routes — basically static for the session)
 *     - Static reference data:         max-age=300,  s-maxage=3600, swr=86400
 *         (route details, fare tables — refresh hourly)
 *     - Geographic polyline / waypoints: max-age=3600, s-maxage=86400, swr=604800
 *         (Google Maps polylines — refresh daily)
 */

/** Real-time ETA / arrival data — browser must always re-validate. */
export const CACHE_REALTIME = {
  "Cache-Control": "public, max-age=0, s-maxage=15, stale-while-revalidate=45",
};

/** Suggestion / autocomplete — refresh every 30 s in the browser. */
export const CACHE_SUGGEST = {
  "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
};

/** Bbox / proximity — refresh every minute in the browser. */
export const CACHE_BBOX = {
  "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=600",
};

/** Nearby / list — refresh every minute in the browser, hourly on the CDN. */
export const CACHE_NEARBY = {
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
};

/** Static reference data — 5-minute browser cache, hourly CDN. */
export const CACHE_STATIC = {
  "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
};

/** Geographic polyline / waypoints — 1-hour browser cache, daily CDN. */
export const CACHE_WAYPOINTS = {
  "Cache-Control":
    "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
};
