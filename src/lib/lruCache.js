/**
 * Tiny in-memory LRU + TTL cache.
 *
 * Designed for caching Laya verdicts and Google Translate results
 * inside the Node server process. Key properties:
 *
 *   - Bounded size (`max`): oldest entry is evicted when full.
 *   - Per-entry TTL (`set(key, value, ttlMs)`): lazy expiry on read.
 *   - Single-process: NOT shared across multiple Node workers. Each
 *     worker keeps its own cache. That's fine for a single-instance
 *     dev/prod server, and acceptable as a first-tier cache (a shared
 *     Redis layer would be the second tier if/when we need it).
 *   - No persistence: lost on restart. Translations and Laya verdicts
 *     re-populate on first use.
 *   - O(1) get/set. Map iteration order = insertion order, which is
 *     what we rely on for LRU recency bumps.
 *
 * Not thread-safe — but Node is single-threaded so that's fine.
 *
 * @example
 *   const cache = createLruCache({ max: 200, defaultTtlMs: 5 * 60_000 });
 *   cache.set("元朗", { verdict: "..." });        // default TTL
 *   cache.set("元朗", { verdict: "..." }, 1000); // 1 s override
 *   cache.get("元朗");                            // → { verdict: "..." } or undefined
 *   cache.stats();                                // → { size, live, expired, max }
 */
export function createLruCache({ max = 200, defaultTtlMs = 5 * 60_000 } = {}) {
  // `Map` preserves insertion order, so the first key is the oldest.
  // LRU bump = delete + re-set; eviction = delete first key.
  const map = new Map();

  function isExpired(entry, now = Date.now()) {
    return entry.expiresAt <= now;
  }

  function get(key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (isExpired(entry)) {
      map.delete(key);
      return undefined;
    }
    // LRU recency bump: re-insert at the end so it's the "newest".
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }

  function set(key, value, ttlMs = defaultTtlMs) {
    const expiresAt = Date.now() + Math.max(0, ttlMs);
    if (map.has(key)) map.delete(key);
    map.set(key, { value, expiresAt });
    while (map.size > max) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
  }

  function has(key) {
    const entry = map.get(key);
    if (!entry) return false;
    if (isExpired(entry)) {
      map.delete(key);
      return false;
    }
    return true;
  }

  function del(key) {
    map.delete(key);
  }

  function clear() {
    map.clear();
  }

  function size() {
    return map.size;
  }

  function stats() {
    const now = Date.now();
    let live = 0;
    let expired = 0;
    for (const entry of map.values()) {
      if (isExpired(entry, now)) expired++;
      else live++;
    }
    return { size: map.size, live, expired, max };
  }

  return { get, set, has, delete: del, clear, size, stats };
}

/**
 * Normalize a query string into a stable cache key.
 *   - non-string → ""
 *   - trim + collapse internal whitespace
 *   - lowercase (CJK is unaffected; latin letters fold)
 *   - empty after trim → ""
 *
 * Two queries that differ only in case or whitespace share a cache entry.
 */
export function normalizeQueryKey(query) {
  if (typeof query !== "string") return "";
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}