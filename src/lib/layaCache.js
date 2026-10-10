/**
 * Verdict cache for /api/laya/intent.
 *
 * The Laya pipeline (translate REST + ONNX forward pass) costs ~300–600 ms
 * per request, but the same query is typed by many users — district
 * names, transport keywords, common tourist spots. Caching by normalized
 * query turns repeat hits into a sub-millisecond map lookup, which is
 * the single biggest user-visible speedup we can ship.
 *
 * Cache key: normalizeQueryKey(query) — trim + collapse whitespace + lowercase.
 * Cache value: the full response body (post-grammar-rules, post-queryType
 * classifier). This means a cache hit also skips the deterministic regex
 * passes, not just the network/ONNX work.
 *
 * Cache misses recompute everything as before. The cache is in-memory,
 * single-process, 5 min TTL, 200-entry LRU. See ./lruCache.js for the
 * underlying primitive.
 *
 * The cache lives at module scope so the singleton is shared across all
 * route invocations within the same Node worker.
 */
import { createLruCache, normalizeQueryKey } from "./lruCache";

const verdictCache = createLruCache({
  max: 200,
  defaultTtlMs: 5 * 60_000, // 5 min — long enough to absorb repeat
                            // typing within a session, short enough
                            // that tweaks to the grammar rules surface
                            // quickly in dev.
});

/**
 * Look up a cached verdict for `query`. Returns the full response body
 * (same shape as the route's Response.json body) or null on miss.
 */
export function getCachedVerdict(query) {
  const key = normalizeQueryKey(query);
  if (!key) return null;
  return verdictCache.get(key) ?? null;
}

/**
 * Store a verdict in the cache. Silently ignores empty queries so the
 * caller doesn't have to guard.
 */
export function setCachedVerdict(query, verdict) {
  const key = normalizeQueryKey(query);
  if (!key) return;
  verdictCache.set(key, verdict);
}

/** Invalidate a single entry (e.g. after a grammar-rule tweak in dev). */
export function invalidateVerdict(query) {
  verdictCache.delete(normalizeQueryKey(query));
}

/** Drop everything — useful for tests and the rare "wipe" debug action. */
export function clearVerdictCache() {
  verdictCache.clear();
}

/** Inspect the cache (for the `?debug=cache` response field). */
export function getVerdictCacheStats() {
  return verdictCache.stats();
}