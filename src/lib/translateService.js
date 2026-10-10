/**
 * translateService.js — Google Cloud Translation v2 (REST) wrapper
 *
 * Purpose: normalise any HK-tourist query (TC / SC / Cantonese / mixed / EN)
 * into English text before sending to Laya. This bypasses Laya's
 * encoder-level locale bias and gives the multilingual model a clean
 * English signal it can discriminate on.
 *
 * Why REST instead of @google-cloud/translate SDK:
 *   - No extra dependency, no service-account JSON to manage
 *   - Uses a simple API key (server-side only) so env var stays plain
 *   - One call does BOTH detect + translate (cheaper, lower latency)
 *
 * Cost: Google Cloud Translation Basic (v2) — 500K chars/month free,
 *       then $20/million chars. A typical tourist query is 10–30 chars
 *       so 50K queries/month ≈ $10 USD.
 *
 * Setup:
 *   1. Create a GCP project (or reuse the one you have for Maps)
 *   2. Enable "Cloud Translation API"
 *   3. Create an API key, restrict it to "Cloud Translation API"
 *   4. Add to .env.local:  GOOGLE_TRANSLATE_API_KEY=AIza...
 *
 * Fallback behaviour: if the key is missing OR the API call fails, the
 * service returns { englishQuery: originalQuery, detectedLocale: 'en',
 * skipped: 'reason' } so callers can decide whether to surface an error
 * or silently fall through to the untranslated path. Never throws.
 */

const TRANSLATE_ENDPOINT =
  "https://translation.googleapis.com/language/translate/v2";

/** Map Google's BCP-47 codes to the Laya `multilingual` enum used in the
 *  HK Tourist app. Google returns "zh-TW" / "zh-CN" / "zh-Hant" / "zh-Hans"
 *  depending on how the API decided to classify the input; we normalise
 *  to a stable 3-way choice so post-processing has clean values. */
function normalizeLocale(googleCode) {
  if (!googleCode) return "en";
  const lc = googleCode.toLowerCase();
  // Explicit Traditional first (most HK queries)
  if (lc === "zh-tw" || lc === "zh-hk" || lc === "zh-mo" || lc === "zh-hant") return "zh-Hant";
  if (lc === "zh-cn" || lc === "zh-hans" || lc === "zh-sg")                  return "zh-Hans";
  // Bare "zh" is ambiguous — default to Traditional because the HK Tourist
  // app's primary audience reads Traditional. Callers can override via
  // detectQueryLanguage() if they need finer disambiguation.
  if (lc === "zh")      return "zh-Hant";
  if (lc === "yue")     return "zh-Hant"; // Cantonese → Traditional script
  if (lc === "en")      return "en";
  // Fallback: keep Google's code so debugging is easier
  return googleCode;
}

/**
 * Cheap pre-flight check: does the query have ANY non-ASCII / CJK
 * characters that might need translation? Pure-ASCII English queries
 * can be sent straight to Laya without burning a translate call.
 *
 * Returns true if translate() should be called.
 */
export function queryNeedsTranslation(query) {
  if (typeof query !== "string" || query.length === 0) return false;
  // ASCII printable only (letters, digits, punctuation, space) → English
  return /[^\x20-\x7E]/.test(query);
}

// ── Translation cache ────────────────────────────────────────────────────
// Google Cloud Translation v2 is the single biggest cost in the Laya
// pipeline (200–500 ms per call vs ~140 ms for the ONNX forward pass).
// The same query gets asked many times across users (district names,
// transport keywords, common spots) so an in-memory LRU is a massive
// win. TTL is 1 h because translations are stable — Google rarely
// changes a given result. Keyed by the normalised query (trim +
// collapse whitespace + lowercase) so `元朗 ` and `元朗` share an entry.
//
// Lives at module scope, single-process, 500-entry LRU. Not shared
// across multiple Node workers — that's a second-tier problem (Redis)
// if/when we need it.
import { createLruCache, normalizeQueryKey } from "./lruCache";

const translateCache = createLruCache({
  max: 500,
  defaultTtlMs: 60 * 60_000, // 1 h
});

/** Diagnostics — used by the route's debug response field. */
export function getTranslateCacheStats() {
  return translateCache.stats();
}

/** Invalidate one entry (e.g. after a locale-mapping tweak in dev). */
export function invalidateTranslate(query) {
  translateCache.delete(normalizeQueryKey(query));
}

/**
 * Detect source language AND translate to English in a single REST call.
 *
 * @param {string} query - user query (any language)
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - forwarded to fetch for cancellation
 * @returns {Promise<{
 *   englishQuery: string,
 *   detectedLocale: string,   // 'zh-Hant' | 'zh-Hans' | 'en' | ...
 *   sourceLocale: string|null,// raw BCP-47 from Google, or null if skipped
 *   skipped: false | string,  // true reason string if we didn't translate
 *   error?: string            // present if the call failed
 * }>}
 */
export async function translateToEnglish(query, opts = {}) {
  const empty = {
    englishQuery: query ?? "",
    detectedLocale: "en",
    sourceLocale: null,
    skipped: "empty-query",
  };
  if (typeof query !== "string" || query.trim().length === 0) return empty;

  // Cache lookup — keyed by the normalised query. We always return the
  // cached result regardless of opts.signal, because a hit means no
  // network call is made (and the signal would only cancel an in-flight
  // fetch). Callers that pass a signal are typically cancelling on
  // debounce, which is fine — they'll just get the cached value for
  // their next attempt instead.
  const cacheKey = normalizeQueryKey(query);
  const cached = cacheKey ? translateCache.get(cacheKey) : null;
  if (cached) return cached;

  const apiKey =
    process.env.GOOGLE_TRANSLATE_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    const out = {
      englishQuery: query,
      detectedLocale: "en",
      sourceLocale: null,
      skipped: "no-api-key",
    };
    if (cacheKey) translateCache.set(cacheKey, out);
    return out;
  }

  if (!queryNeedsTranslation(query)) {
    // Pure ASCII → assume English without an API call.
    const out = {
      englishQuery: query,
      detectedLocale: "en",
      sourceLocale: "en",
      skipped: "ascii-only",
    };
    if (cacheKey) translateCache.set(cacheKey, out);
    return out;
  }

  let out;
  try {
    const url = `${TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: query,
        target: "en",
        format: "text",
        // source is intentionally omitted → Google auto-detects
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      out = {
        englishQuery: query,
        detectedLocale: "en",
        sourceLocale: null,
        skipped: `http-${res.status}`,
        error: errText.slice(0, 500),
      };
    } else {
      const data = await res.json();
      const tr = data?.data?.translations?.[0];
      if (!tr || typeof tr.translatedText !== "string") {
        out = {
          englishQuery: query,
          detectedLocale: "en",
          sourceLocale: null,
          skipped: "bad-response",
          error: JSON.stringify(data).slice(0, 500),
        };
      } else {
        out = {
          englishQuery: tr.translatedText,
          detectedLocale: normalizeLocale(tr.detectedSourceLanguage),
          sourceLocale: tr.detectedSourceLanguage ?? null,
          skipped: false,
        };
      }
    }
  } catch (e) {
    out = {
      englishQuery: query,
      detectedLocale: "en",
      sourceLocale: null,
      skipped: "fetch-error",
      error: e?.message ?? String(e),
    };
  }
  if (cacheKey) translateCache.set(cacheKey, out);
  return out;
}

/**
 * Translate and return ONLY the locale (no English text). Cheaper for
 * callers that only need the locale tag for UI purposes.
 *
 * For simplicity we still call the full translate endpoint — Google v2
 * doesn't have a "detect-only" endpoint in the free tier, and the
 * translated text is returned anyway.
 */
export async function detectLocale(query, opts = {}) {
  const result = await translateToEnglish(query, opts);
  return {
    locale: result.detectedLocale,
    sourceLocale: result.sourceLocale,
    skipped: result.skipped,
    error: result.error,
  };
}
