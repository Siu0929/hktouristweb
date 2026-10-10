/**
 * Shared helper around the `hk-bus-eta` package.
 *
 * Why a wrapper?
 *   `fetchEtaDb()` returns the full Hong Kong transit corpus — every KMB,
 *   CTB, NLB, LRT feeder, ferry, MTR, Light Rail and Green Minibus route
 *   plus every stop those routes touch. The app surfaces four
 *   transport-type APIs, each filtered from the same underlying catalogue:
 *
 *     - "bus"       — KMB, CTB, NLB, LRT feeder. Ferries (sunferry,
 *                     hkkf, fortuneferry), MTR, Light Rail, and Green
 *                     Minibus (GMB) are all excluded — ferries and GMB
 *                     are out of scope for this app, and rail trips
 *                     are planned via the dedicated MTR / Light Rail
 *                     apps, and ferry trips via the dedicated ferry app.
 *     - "mtr"       — MTR lines and stations.
 *     - "lightrail" — Light Rail lines and stops.
 *     - "ferry"     — Sun Ferry, Hong Kong & Kowloon Ferry, and Fortune
 *                     Ferry routes and piers.
 *
 *   Filtering happens once per transport type, behind cached accessors, so
 *   every API route here shares the same exclusion policy.
 *
 * Data-shape notes (from inspecting `routeFareList.min.json`):
 *   - `routeList` is keyed by a human-readable composite ID
 *     (e.g. "1+1+Central+The Peak", "MTR-TWL", "LRT-505"). Each entry has
 *     `co`, `stops` (per company, an array of stop IDs), `bound`, etc.
 *   - `stopList` is keyed by stop ID (the same IDs that appear inside
 *     `route.stops[*]`).
 *   - `stopMap` is a partial join table: only a subset of stops have an
 *     entry, and the route IDs it references use an opaque secondary ID
 *     space that is NOT a key in `routeList`. Because of that, **stopMap
 *     cannot be used to look up route metadata**. The real "which route
 *     serves which stop" relationship lives in `route.stops[co]`.
 *
 * Filtering strategy (applied per transport type):
 *   - Route filter: keep a route iff at least one of its companies
 *     matches the transport type's company list. A KMB↔CTB joint service
 *     is "bus" because both `co` values are bus companies; MTR↔bus joint
 *     services do not exist in the upstream catalogue.
 *   - Stop filter: keep a stop iff it appears in the `stops[company]`
 *     array of at least one surviving route.
 *
 * Caching (Phase 1):
 *   The upstream `routeFareList.min.json` is ~8 MB and changes
 *   infrequently. The raw payload used to be held in `rawCache.db` for
 *   the full 6-hour TTL — i.e. ~8 MB of resident JSON sitting on the
 *   heap for every Next.js worker, even after every per-type cache had
 *   been built and was serving traffic.
 *
 *   The Phase 1 cache now holds the raw JSON only while there is at
 *   least one in-flight per-type build, and drops it the moment the
 *   last build completes. Each per-type cache retains just the
 *   filtered subset it needs (~tens of KB for MTR / Light Rail / ferry,
 *   a few MB for "bus"). Concurrent requests for the same type share a
 *   single build; concurrent requests for different types share a single
 *   upstream fetch. The trade-off: a brand-new type requested after
 *   every other type has been built will re-fetch the raw JSON once
 *   (an 8 MB body that the network/Next.js cache would absorb), in
 *   exchange for freeing ~8 MB of process memory permanently.
 *
 * Memory optimisation (Phase 2):
 *   The previous build also pre-built a `stopRoutes` reverse index —
 *   a `Map<stopId, Array<{routeId, company, seq}>>` covering every
 *   (route, company, stop-position) triple in the catalogue. That map
 *   held roughly 77 940 entries for the "bus" type alone, each V8
 *   object around 120 bytes, costing ~10 MB of permanent memory per
 *   worker per type.
 *
 *   Phase 2 drops that pre-built map and replaces it with a compact
 *   reverse index that stores only route IDs (~0.5 MB for "bus"):
 *
 *     `stopRoutes[stopId]` → `string[]`  (route IDs that serve the stop)
 *
 *   Callers that need only the route IDs (the `*-stops` and `*-routes`
 *   listing endpoints) consume the compact form directly. Callers that
 *   need the full `{routeId, company, seq}` triple (the four `*-eta`
 *   endpoints) call `getRouteMappingsForStop(stopId, type)`, which
 *   walks each candidate route's `stops[co]` to derive `company` and
 *   `seq` on demand. That derivation is O(routes-per-stop ×
 *   companies-per-route × stops-per-sequence) — for "bus" stops this
 *   is typically ≤ 100 operations per call (≈ 5 routes × 1 company ×
 *   20 stops), called once per ETA request, so it stays cheap. ETA
 *   endpoints always have a per-stop 1:1 input/output shape, so the
 *   cost stays bounded.
 *
 *   `routeStops` is NOT cached. It is derived on demand from
 *   `db.routeList[routeId].stops[company]` — the per-company stop
 *   sequences are already in boarding order, so a flatMap per request
 *   is O(stops-on-route) with no extra memory.
 *
 * Pre-warming (Phase 2):
 *   The 4 transport-type caches are now pre-built at module-load time
 *   via a fire-and-forget `prewarmAllTypes()`. This is a deliberate
 *   trade-off: workers spend ~1–3 s of boot time fetching the raw
 *   JSON and building the four caches, but every request ever served
 *   (including the first) hits a warm cache. The alternative — letting
 *   the first request per type trigger the fetch — adds a one-time
 *   ~8 MB transient spike to the request hot path, which is exactly
 *   the spike we are trying to keep under the 200 MB ceiling.
 */

/**
 * Transport types served by this wrapper. The string is the public token
 * callers pass to `getEtaDb(type)` / `getRoutesForStop(type, stopId)` /
 * `getStopsForRoute(type, routeId)`. Add a new entry here to introduce a
 * new transport-type API set without touching the filter engine.
 *
 *   include — route is kept iff ANY of its `co` values is in this list.
 *   exclude — route is dropped if ANY of its `co` values is in this list.
 *             Applied AFTER include, so a route listed as ["mtr","kmb"]
 *             would still survive a "bus" filter unless "mtr" is in the
 *             bus exclude list.
 *   label   — short human-readable label used by API error messages.
 *   noun    — singular noun for the stop/station vocabulary ("stop",
 *             "station"). Used in 404 messages.
 */
export const TRANSPORT_TYPES = Object.freeze({
  bus: Object.freeze({
    label: "bus",
    noun: "stop",
    // "bus" only includes franchised buses + LRT feeder routes:
    //   kmb       — Kowloon Motor Bus
    //   ctb       — Citybus
    //   nlb       — New Lantao Bus
    //   lrtfeeder — LRT Feeder Bus
    // Ferries (sunferry, hkkf, fortuneferry), MTR, Light Rail, and
    // Green Minibus ("gmb") are all excluded — see the `exclude` list.
    include: Object.freeze(["kmb", "ctb", "nlb", "lrtfeeder"]),
    exclude: Object.freeze([
      "mtr",
      "lightRail",
      "gmb",
      "sunferry",
      "hkkf",
      "fortuneferry",
    ]),
  }),
  mtr: Object.freeze({
    label: "mtr",
    noun: "station",
    include: Object.freeze(["mtr"]),
    exclude: Object.freeze([]),
  }),
  lightrail: Object.freeze({
    label: "lightrail",
    noun: "stop",
    include: Object.freeze(["lightRail"]),
    exclude: Object.freeze([]),
  }),
  ferry: Object.freeze({
    label: "ferry",
    noun: "pier",
    // "ferry" includes the three ferry operators shipped by hk-bus-eta:
    //   sunferry     — Sun Ferry (newer sky-pier services + inter-islands)
    //   hkkf         — Hong Kong & Kowloon Ferry (many outlying island routes)
    //   fortuneferry — Fortune Ferry (water-taxi style cross-harbour routes)
    // Buses / rail / minibus are explicitly excluded so a bizarre mixed-
    // operator route that includes "sunferry" together with "kmb" still
    // gets dropped from this feed.
    include: Object.freeze(["sunferry", "hkkf", "fortuneferry"]),
    exclude: Object.freeze([
      "kmb",
      "ctb",
      "nlb",
      "lrtfeeder",
      "mtr",
      "lightRail",
      "gmb",
    ]),
  }),
});

/** Default transport type used when callers omit the argument. */
export const DEFAULT_TRANSPORT_TYPE = "bus";

import { fetchEtaDb, fetchEtas as fetchEtasUpstream } from "hk-bus-eta";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Raw upstream cache state.
 *
 *   ref        — the raw upstream JSON, held only while at least one
 *                per-type build is in flight. Cleared (set to null) the
 *                moment the last build completes, so the ~8 MB payload
 *                becomes eligible for garbage collection.
 *   fetchedAt  — ms epoch of the most recent successful upstream fetch.
 *                Used to decide whether the per-type caches are still
 *                within the TTL window.
 *   promise    — in-flight upstream fetch. Shared by concurrent callers
 *                so we never trigger two upstream requests for the same
 *                TTL window.
 */
const rawCache = {
  ref: null,
  fetchedAt: 0,
  promise: null,
};

/** Number of per-type builds currently in flight (also tracks pre-warm
 *  builds so the raw can be released once the pre-warm finishes). */
let pendingBuilds = 0;

/**
 * Per-transport-type filtered cache.
 *
 *   type          — TRANSPORT_TYPES key
 *   db            — filtered { routeList, stopList, holidays, serviceDayMap }
 *                   (`stopMap` is intentionally NOT carried forward — no
 *                   consumer reads it and it just bloats the cache)
 *   stopRouteIds  — Map<stopId, string[]>  compact reverse index that
 *                   stores ONLY the route IDs serving each stop. The
 *                   `{company, seq}` half is derived on demand from
 *                   `routeList`. See the "Memory optimisation (Phase 2)"
 *                   doc block at the top of this file for the rationale.
 *   builtAt       — ms epoch; informational only
 *
 * `routeStops` is NOT cached. It is derived on demand from
 * `db.routeList[routeId].stops[company]` — the per-company stop
 * sequences are already in boarding order, so a flatMap per request
 * is O(stops-on-route) with no extra memory.
 *
 * @type {Map<string, {
 *   db: {
 *     routeList: Record<string, import("hk-bus-eta").RouteListEntry>,
 *     stopList: Record<string, import("hk-bus-eta").StopListEntry>,
 *     holidays: string[],
 *     serviceDayMap: import("hk-bus-eta").EtaDb["serviceDayMap"],
 *   },
 *   stopRouteIds: Map<string, string[]>,
 *   builtAt: number,
 * }>}
 */
const typeCaches = new Map();

/** In-flight per-type build promises, used to coalesce concurrent
 *  requests for the same transport type. */
const typeBuilds = new Map();

function resolveType(type) {
  const key = type ?? DEFAULT_TRANSPORT_TYPE;
  if (!TRANSPORT_TYPES[key]) {
    throw new Error(
      `Unknown transport type "${type}". Expected one of: ${Object.keys(TRANSPORT_TYPES).join(", ")}`
    );
  }
  return TRANSPORT_TYPES[key];
}

/**
 * Decide whether a route should be kept for a given transport type.
 * Returns true iff at least one of the route's `co` values is in the
 * type's include list AND none of the `co` values is in the type's
 * exclude list.
 */
function routeMatchesType(route, type) {
  if (!route || !Array.isArray(route.co)) return false;
  const include = new Set(type.include);
  const exclude = new Set(type.exclude);
  const hasInclude = route.co.some((c) => include.has(c));
  if (!hasInclude) return false;
  const hasExclude = route.co.some((c) => exclude.has(c));
  return !hasExclude;
}

/**
 * Fetch (and cache) the raw upstream ETA database. Concurrent callers
 * share the in-flight promise so we only pay the network cost once per
 * TTL window per process.
 */
async function getRawDb() {
  // Fast path: we already hold the raw JSON within the TTL window and
  // it is ready to be handed to a builder.
  if (rawCache.ref && Date.now() - rawCache.fetchedAt < CACHE_TTL_MS) {
    return rawCache.ref;
  }

  // Slow path: trigger (or share) an upstream fetch.
  if (!rawCache.promise) {
    rawCache.promise = (async () => {
      const json = await fetchEtaDb();
      rawCache.fetchedAt = Date.now();
      rawCache.ref = json;
      // Per-type caches derived from a previous raw are now stale.
      typeCaches.clear();
      return json;
    })().finally(() => {
      rawCache.promise = null;
    });
  }
  return rawCache.promise;
}

/**
 * Build (or rebuild) the per-type filtered cache from the raw upstream
 * DB. Called once per transport type, lazily on the first
 * `getEtaDb(type)` invocation that needs it (and once up-front for
 * each type when `prewarmAllTypes()` runs at module load).
 *
 * The compact reverse index `stopRouteIds` collects ONLY route IDs.
 * The corresponding `{company, seq}` info is derived on demand by
 * `getRouteMappingsForStop()`. See the top of this file for why.
 */
function buildTypeCache(type, raw) {
  // 1. Filter routes by transport-type membership.
  const routeList = {};
  for (const [routeId, route] of Object.entries(raw.routeList ?? {})) {
    if (!routeMatchesType(route, type)) continue;
    routeList[routeId] = route;
  }

  // 2. Build the COMPACT reverse index and the reachable-stops set in
  //    a single pass through the filtered routes.
  //
  //    Each entry of `stopRouteIds` holds only an array of route IDs
  //    — for "bus" this shrinks the reverse index from ~78 K
  //    `{routeId, company, seq}` triples (~10 MB) to ~25 K route-id
  //    strings (~0.5 MB).
  const stopRouteIds = new Map();
  const reachableStops = new Set();

  for (const [routeId, route] of Object.entries(routeList)) {
    for (const company of route.co ?? []) {
      const sequence = route.stops?.[company];
      if (!Array.isArray(sequence)) continue;
      for (const stopId of sequence) {
        reachableStops.add(stopId);
        let bucket = stopRouteIds.get(stopId);
        if (!bucket) {
          bucket = [];
          stopRouteIds.set(stopId, bucket);
        }
        // Same routeId under multiple operators (joint KMB↔CTB cross-
        // harbour services) is intentionally de-duplicated at lookup
        // time by `getRouteMappingsForStop`, so we just push here.
        bucket.push(routeId);
      }
    }
  }

  // 3. Apply the reachable-stops filter to stopList. (Saving these
  //    bytes is the whole point — stopList is the bulk of the
  //    resident memory after the raw is freed.)
  const stopList = {};
  for (const [stopId, stop] of Object.entries(raw.stopList ?? {})) {
    if (!reachableStops.has(stopId)) continue;
    stopList[stopId] = stop;
  }

  // 4. Build the filtered db. `stopMap` is intentionally dropped — it is
  //    not used by any consumer in this codebase (see the data-shape
  //    notes at the top of the file for why it can't be looked up
  //    against `routeList` anyway).
  const db = {
    routeList,
    stopList,
    holidays: raw.holidays,
    serviceDayMap: raw.serviceDayMap,
  };

  typeCaches.set(type.label, {
    db,
    stopRouteIds,
    builtAt: Date.now(),
  });
}

/**
 * Fetch (and cache) the filtered ETA database for the given transport
 * type. Returns
 * `{ routeList, stopList, holidays, serviceDayMap }` — the same shape
 * the previous build produced minus the unused `stopMap` field, so
 * callers can pass `stopList` and the route metadata straight through
 * to `fetchEtas()` when they need ETAs.
 *
 * @param {keyof TRANSPORT_TYPES} [type="bus"]
 */
export async function getEtaDb(type) {
  const t = resolveType(type);
  // Fast path: type cache is still warm.
  const existing = typeCaches.get(t.label);
  if (existing) return existing.db;

  // Coalesce concurrent same-type requests onto a single build.
  let build = typeBuilds.get(t.label);
  if (!build) {
    build = (async () => {
      pendingBuilds++;
      try {
        const raw = await getRawDb();
        if (!typeCaches.has(t.label)) {
          buildTypeCache(t, raw);
        }
      } finally {
        pendingBuilds--;
        typeBuilds.delete(t.label);
        // Release the ~8 MB raw reference the moment the last in-flight
        // build finishes. Subsequent type requests within the TTL
        // window will refetch (a bandwidth cost we accept in exchange
        // for permanent memory relief); concurrent same-type requests
        // are coalesced onto the in-flight promise above.
        if (pendingBuilds === 0 && rawCache.ref) {
          rawCache.ref = null;
        }
      }
    })();
    typeBuilds.set(t.label, build);
  }
  await build;
  return typeCaches.get(t.label).db;
}

/**
 * Pre-warm every transport-type cache at module-load time. This shifts
 * the one-time ~8 MB raw fetch + per-type build from the first request
 * for each type onto the worker's startup path, so request handling
 * always sees warm caches and never re-introduces the request-time
 * raw-fetch transient spike.
 *
 * Fire-and-forget. Errors are logged but never propagated — a pre-warm
 * failure must not break the import chain. Subsequent `getEtaDb(type)`
 * calls transparently retry the failed build via the slow path.
 */
function prewarmAllTypes() {
  if (prewarmAllTypes._started) return;
  prewarmAllTypes._started = true;
  // Schedule on the next tick so module-level imports return first and
  // so the rest of the server has a chance to be ready before the heavy
  // upstream fetch kicks off.
  setImmediate(async () => {
    try {
      await Promise.all(Object.values(TRANSPORT_TYPES).map((t) => getEtaDb(t.label)));
    } catch (err) {
      console.warn("[hkBusEta] pre-warm failed:", err?.message ?? err);
    }
  });
}
prewarmAllTypes._started = false;

// Kick off the pre-warm exactly once per module load. Wrapping in a
// try/catch is defensive — `prewarmAllTypes()` itself never throws on
// synchronous paths.
try {
  prewarmAllTypes();
} catch (err) {
  console.warn("[hkBusEta] pre-warm scheduling failed:", err?.message ?? err);
}

/**
 * Backwards-compatible alias for the bus transport type. Older callers
 * (and the existing `/api/bus-*` routes) used `getFilteredEtaDb()` —
 * that function is kept here so the API surface does not break.
 */
export function getFilteredEtaDb() {
  return getEtaDb(DEFAULT_TRANSPORT_TYPE);
}

/**
 * Look up the route IDs that serve a given stop, for the given
 * transport type. Returns the compact form — an array of route-id
 * strings. The corresponding `{company, seq}` info is available via
 * `getRouteMappingsForStop()`.
 *
 * Cost: O(1) — direct lookup on the cached reverse index.
 *
 * @param {keyof TRANSPORT_TYPES} [type="bus"]
 */
export function getRoutesForStop(stopId, type) {
  const t = resolveType(type);
  const cache = typeCaches.get(t.label);
  if (!cache) {
    throw new Error("getEtaDb() must be awaited before getRoutesForStop()");
  }
  return cache.stopRouteIds.get(stopId) ?? EMPTY_ARRAY;
}

/** Reused empty array — saves an allocation per lookup miss. */
const EMPTY_ARRAY = Object.freeze([]);

/**
 * Look up the full `{routeId, company, seq}` mapping for every route
 * that serves a given stop, in the given transport type. The `seq`
 * field is the boarding position (0-based) inside the per-company
 * stop list and is exactly what `fetchEtas()` expects as its `seq`
 * argument.
 *
 * Derived on demand by walking each candidate route's `stops[co]`
 * arrays — the compact reverse index only carries route IDs. See the
 * "Memory optimisation (Phase 2)" doc block at the top of this file
 * for the rationale (saves ~10 MB of permanent memory per worker per
 * type, at the cost of an O(routes-per-stop × companies ×
 * stops-per-sequence) derivation per call).
 *
 * @param {keyof TRANSPORT_TYPES} [type="bus"]
 * @returns {Array<{routeId: string, company: string, seq: number}>}
 */
export function getRouteMappingsForStop(stopId, type) {
  const t = resolveType(type);
  const cache = typeCaches.get(t.label);
  if (!cache) {
    throw new Error("getEtaDb() must be awaited before getRouteMappingsForStop()");
  }
  const routeIds = cache.stopRouteIds.get(stopId);
  if (!routeIds || routeIds.length === 0) return EMPTY_ARRAY;
  const out = [];
  const seen = new Set();
  for (const routeId of routeIds) {
    const route = cache.db.routeList[routeId];
    if (!route) continue;
    for (const company of route.co ?? []) {
      const sequence = route.stops?.[company];
      if (!Array.isArray(sequence)) continue;
      // indexOf is O(stops-on-sequence) which is small (~20 for "bus"
      // routes) and bounded. joint services rarely repeat a company.
      const seq = sequence.indexOf(stopId);
      if (seq < 0) continue;
      const key = `${routeId}::${company}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ routeId, company, seq });
    }
  }
  return out;
}

/**
 * Backwards-compatible alias for the bus transport type.
 */
export function getRoutesForStopBus(stopId) {
  return getRoutesForStop(stopId, DEFAULT_TRANSPORT_TYPE);
}

/**
 * Look up every stop served by a given route, in boarding order, for the
 * given transport type. Derived on demand from
 * `routeList[routeId].stops[company]` — the per-company stop sequences
 * are already in boarding order, so the walk is O(stops-on-route) with
 * zero additional memory.
 *
 * @param {keyof TRANSPORT_TYPES} [type="bus"]
 */
export function getStopsForRoute(routeId, type) {
  const t = resolveType(type);
  const cache = typeCaches.get(t.label);
  if (!cache) {
    throw new Error("getEtaDb() must be awaited before getStopsForRoute()");
  }
  const route = cache.db.routeList[routeId];
  if (!route) return [];
  const out = [];
  for (const company of route.co ?? []) {
    const sequence = route.stops?.[company];
    if (!Array.isArray(sequence)) continue;
    sequence.forEach((stopId, seq) => {
      out.push({ stopId, company, seq });
    });
  }
  return out;
}

/**
 * Backwards-compatible alias for the bus transport type.
 */
export function getStopsForRouteBus(routeId) {
  return getStopsForRoute(routeId, DEFAULT_TRANSPORT_TYPE);
}

/**
 * Localised stop name. hk-bus-eta stores names as { en, zh }; we map the
 * app's locale strings ("zh-Hant" / "zh-Hans") onto the upstream "zh".
 */
export function localisedStopName(stop, locale) {
  if (!stop?.name) return "";
  const isChinese = (locale ?? "").toLowerCase().startsWith("zh");
  return isChinese ? stop.name.zh ?? stop.name.en ?? "" : stop.name.en ?? stop.name.zh ?? "";
}

/**
 * Localised route terminal name (`orig` / `dest` are `{ en, zh }`).
 */
export function localisedTerminal(terminal, locale) {
  if (!terminal) return "";
  const isChinese = (locale ?? "").toLowerCase().startsWith("zh");
  return isChinese ? terminal.zh ?? terminal.en ?? "" : terminal.en ?? terminal.zh ?? "";
}

/**
 * Convert a stop entry into the lean payload the API exposes to clients.
 */
export function serialiseStop(stopId, stop, locale) {
  return {
    id: stopId,
    name: localisedStopName(stop, locale),
    nameEn: stop?.name?.en ?? "",
    nameZh: stop?.name?.zh ?? "",
    lat: stop?.location?.lat ?? null,
    lng: stop?.location?.lng ?? null,
  };
}

/**
 * Silent wrapper around `hk-bus-eta`'s `fetchEtas()`.
 *
 * Why?
 *   `hk-bus-eta`'s `fetchEtas()` aggregates per-operator handlers
 *   (`kmb.js`, `ctb.js`, `nlb.js`, `lrtfeeder.js`, …) via
 *   `Promise.allSettled`, then logs any rejected reason via
 *   `console.error`. Two of those handlers — `nlb.js` and
 *   `lrtfeeder.js` — are missing a terminal `.catch()`, so when their
 *   upstream returns an HTML error page (CloudFront/Cloudflare 502
 *   challenge, gateway hiccup, etc.) instead of JSON, the resulting
 *   `SyntaxError: Unexpected token '<'` propagates up to
 *   `fetchEtas()`'s `console.error(result.reason)` and floods the dev
 *   server log with one stack trace per failed operator per poll.
 *
 *   Each API route already wraps `fetchEtas()` in its own try/catch
 *   and falls back to an empty eta array, so the user-facing response
 *   is unaffected — the noise is purely cosmetic. This wrapper
 *   suppresses it.
 *
 * What it does:
 *   - Swallows the `SyntaxError` from `JSON.parse` printed by the
 *     upstream package's per-company handlers during the call.
 *   - Re-throws anything else so the per-route try/catch still
 *     surfaces real bugs (Timeouts, network errors, …).
 *   - Always restores the original `console.error` (even on throw)
 *     so the suppression window is bounded.
 *
 * @param args
 * @returns Promise resolving to the upstream `fetchEtas()` result
 */
export async function fetchEtasSafe(args) {
  const originalConsoleError = console.error;
  // Replace `console.error` only for the duration of the upstream
  // call. The replacement forwards everything except the noisy
  // `SyntaxError` from `JSON.parse`, which is the one specific
  // signature the upstream package produces when a per-company
  // handler fails to parse an HTML error page as JSON. Any other
  // error — including a non-JSON SyntaxError from unrelated code —
  // still flows to the original handler.
  console.error = (...errArgs) => {
    const first = errArgs[0];
    if (
      first instanceof SyntaxError &&
      typeof first?.message === "string" &&
      first.message.includes("is not valid JSON")
    ) {
      return;
    }
    originalConsoleError.apply(console, errArgs);
  };
  try {
    return await fetchEtasUpstream(args);
  } finally {
    console.error = originalConsoleError;
  }
}

/**
 * Convert a route entry into the lean payload the API exposes to clients.
 */
export function serialiseRoute(routeId, route, locale) {
  return {
    id: routeId,
    route: route.route,
    co: route.co,
    orig: {
      en: route.orig?.en ?? "",
      zh: route.orig?.zh ?? "",
      display: localisedTerminal(route.orig, locale),
    },
    dest: {
      en: route.dest?.en ?? "",
      zh: route.dest?.zh ?? "",
      display: localisedTerminal(route.dest, locale),
    },
    fares: route.fares ?? null,
    faresHoliday: route.faresHoliday ?? null,
    serviceType: route.serviceType,
    seq: route.seq,
    jt: route.jt,
    bound: route.bound,
    stops: route.stops,
  };
}

/**
 * Force the next call to re-fetch the raw upstream DB (and rebuild all
 * per-type caches). Mainly useful for tests / hot reload.
 */
export function _resetCache() {
  rawCache.ref = null;
  rawCache.fetchedAt = 0;
  rawCache.promise = null;
  typeCaches.clear();
  typeBuilds.clear();
  pendingBuilds = 0;
  prewarmAllTypes._started = false;
}

/**
 * Backwards-compatible alias for `fetchEtasSafe`. The four
 * `/api/_star_/eta` route files import the symbol under the name
 * `fetchEtas` from this module; this re-export keeps that contract
 * intact while the actual implementation is the `fetchEtasSafe`
 * wrapper above (which silences the upstream package's per-company
 * `SyntaxError` noise).
 */
export { fetchEtasSafe as fetchEtas };
