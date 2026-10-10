/**
 * laya.js — Laya decision-model singleton for the HKTouristApp
 *
 * Laya is a System-1 decision model (Jev-compatible). It takes a state object
 * and typed questions, then returns calibrated answers in a single forward pass:
 *   - choice  → pick one option with per-option probabilities
 *   - score   → an expected level on an ordered rubric
 *   - noul    → calibrated P(true) for a yes/no statement
 *
 * Usage:
 *   import { getLayaInstance } from "@/lib/laya";
 *   const laya = await getLayaInstance();
 *   const result = await laya.systemOne(state, questions);
 *
 * The model (~1.7 GB fp32 ONNX weights) is downloaded from Hugging Face on first
 * run and cached under ~/.cache/receptron-laya (override with LAYA_CACHE env var).
 * Requires Node.js 20+.  Expect ~140 ms per call on Apple Silicon CPU once warm.
 *
 * ── HK Tourist App use-case schema ──────────────────────────────────────────────
 *
 * POI routing example:
 *   systemOne(
 *     { query, location, locale, userPreferences },
 *     {
 *       priority: {
 *         type: "score",
 *         instructions: "How urgent / time-sensitive is this query?",
 *         criteria: ["low", "medium", "high", "critical"],
 *       },
 *       needsWheelchair: {
 *         type: "noul",
 *         instructions: "Does the user need wheelchair-accessible facilities?",
 *       },
 *     }
 *   )
 *
 * Ticket classification example (for admin / issue reporting):
 *   systemOne(
 *     { subject, body, userId, timestamp },
 *     {
 *       category: {
 *         type: "choice",
 *         instructions: "Which team should handle this ticket?",
 *         criteria: {
 *           data:   "wrong bus times, incorrect stop names, missing routes",
 *           infra:  "map errors, broken markers, missing POIs",
 *           ux:     "ui issues, confusing labels, layout problems",
 *           content:"descriptions, translations, missing info",
 *         },
 *       },
 *       severity: {
 *         type: "score",
 *         instructions: "How severe is this issue for users?",
 *         criteria: ["cosmetic", "minor", "moderate", "blocking"],
 *       },
 *       isSafetyRisk: {
 *         type: "noul",
 *         instructions: "Does this report indicate a safety risk to users?",
 *       },
 *     }
 *   )
 *
 * ────────────────────────────────────────────────────────────────────────────────
 */

import { Laya } from "@receptron/laya";

/** Singleton instance, initialised once and reused across requests. */
let _instance = null;
let _initPromise = null;

/**
 * Load (or return the cached) Laya instance.
 * Subsequent calls return the same promise, so concurrent requests all wait
 * on a single initialisation.
 *
 * @param {object} [options] - forwarded to Laya.load()
 * @param {string} [options.modelDir]       - use a local ONNX bundle instead of downloading
 * @param {string} [options.repo]            - HuggingFace repo (default: "receptron/laya-onnx")
 * @param {string} [options.subfolder]       - checkpoint subfolder (default: "multilingual")
 * @param {string} [options.revision]        - commit hash or "main"
 * @param {string} [options.cacheDir]        - override cache directory
 * @param {string} [options.token]           - HF token for private repos
 * @param {Function} [options.onProgress]    - download progress callback
 * @param {string[]} [options.executionProviders] - onnxruntime providers (default: ["cpu"])
 * @param {object} [options.sessionOptions]  - onnxruntime session options
 */
export async function getLayaInstance(options = {}) {
  if (_instance) return _instance;
  if (!_initPromise) {
    _initPromise = Laya.load({
      // Allow env-var overrides without duplicating them in each call
      ...(process.env.LAYA_MODEL_DIR    ? { modelDir: process.env.LAYA_MODEL_DIR }    : {}),
      ...(process.env.LAYA_REPO         ? { repo: process.env.LAYA_REPO }              : {}),
      ...(process.env.LAYA_SUBFOLDER   ? { subfolder: process.env.LAYA_SUBFOLDER }    : {}),
      ...(process.env.LAYA_REVISION     ? { revision: process.env.LAYA_REVISION }      : {}),
      ...(process.env.LAYA_CACHE        ? { cacheDir: process.env.LAYA_CACHE }         : {}),
      ...(process.env.HF_TOKEN          ? { token: process.env.HF_TOKEN }              : {}),
      // Explicit options override env vars
      ...options,
    });
  }
  _instance = await _initPromise;
  return _instance;
}

/**
 * Run a decision pass using the global Laya instance.
 * Convenience wrapper around `getLayaInstance().then(laya => laya.systemOne(...))`.
 *
 * @param {object} state       - context object (ticket, query, POI record, etc.)
 * @param {object} questions   - map of question-key → question definition
 * @param {object} [options]   - passed to getLayaInstance()
 */
export async function runLayaDecision(state, questions, options = {}) {
  const laya = await getLayaInstance(options);
  return laya.systemOne(state, questions);
}

/**
 * Convenience helpers for common HK Tourist app question shapes.
 * Each returns a pre-built questions object; pass it to runLayaDecision().
 */
export const LayaQuestions = {
  /** Classify a user support / issue-report ticket. */
  ticketClassification: {
    category: {
      type: "choice",
      instructions: "Which team should handle this ticket?",
      criteria: {
        data:    "wrong bus times, incorrect stop names, missing routes, stale schedules",
        infra:   "map errors, broken markers, missing POIs, geocoding failures",
        ux:      "ui issues, confusing labels, layout problems, broken interactions",
        content: "missing descriptions, bad translations, incomplete information",
      },
    },
    severity: {
      type: "score",
      instructions: "How severe is this issue for users?",
      criteria: ["cosmetic", "minor", "moderate", "blocking"],
    },
    isSafetyRisk: {
      type: "noul",
      instructions: "Does this report indicate a safety risk to users?",
    },
  },

  /** Decide how to prioritise a user support / issue-report ticket. */
  priorityHelp: {
    urgency: {
      type: "score",
      instructions: "How urgent is this request?",
      criteria: ["not urgent", "somewhat urgent", "urgent", "critical"],
    },
    needsWheelchair: {
      type: "noul",
      instructions: "Does the user need wheelchair-accessible options?",
    },
  },

  /** Rank POI search results by relevance + user context. */
  poiRanking: {
    relevance: {
      type: "score",
      instructions: "How well does this POI match the user's intent?",
      criteria: ["poor", "fair", "good", "excellent"],
    },
    accessibility: {
      type: "score",
      instructions: "How accessible is this POI for someone with mobility needs?",
      criteria: ["not accessible", "partially accessible", "mostly accessible", "fully accessible"],
    },
    isOpenNow: {
      type: "noul",
      instructions: "Is this POI likely to be open right now?",
    },
  },
};
<<<<<<< HEAD

// ───────────────────────────────────────────────────────────────────────────
// Tier comparison — run cache + fastPath + Laya for a single query and
// return a per-tier timing + verdict report. Exposed for the
// `<TierCompare>` debug panel in the SearchBar dropdown.
// ───────────────────────────────────────────────────────────────────────────
//
// The Laya decision pipeline has three tiers, ordered slowest → fastest:
//
//   laya      — full ONNX forward pass via runLayaDecisionTranslated
//               (~140 ms warm, ~10 s cold; first call after process start)
//   fastPath  — pre-Laya regex short-circuit (tryRegexFastPath)
//               (~1 ms; handles toilets / MTR / planner; returns null
//                for place names, vague queries, anything multilingual)
//   cache     — in-memory LRU lookup against the verdict cache
//               (sub-millisecond on hit, miss on first time)
//
// All three are functionally equivalent for the queries they handle
// (deterministic given the same input), so the user-visible difference
// is purely latency. This function times each tier in isolation and
// returns a structured report so the UI can render a comparison table.
//
// Caveats:
//   - The `prime: true` default runs Laya once to populate the LRU.
//     This is intentionally NOT counted toward the laya tier's ms —
//     we want a fair "single inference" number, not "cold-start + warm".
//   - The fastPath tier always runs synchronously in <1 ms, so timing
//     it is largely ceremonial. We still measure for honesty.
//   - The cache tier is only meaningful if `prime: true` (or the route
//     has already populated the LRU from a previous request).

/** Same 4 questions /api/laya/intent sends to Laya, used by the
 *  tier-comparison so the per-tier results are directly comparable
 *  to what the live SearchBar sees. */
const COMPARE_QUESTIONS = {
  ...LayaQuestions.queryIntent,
  ...LayaQuestions.appFunction,
};

/**
 * Run all 3 decision tiers for one query and return a per-tier report.
 *
 * @param {string} query            - raw user query
 * @param {object} [options]
 * @param {string} [options.locale="zh-Hant"] - locale for Laya state
 * @param {boolean} [options.prime=true]     - run Laya once first to
 *                                              populate the verdict cache
 * @returns {Promise<{
 *   query: string,
 *   tiers: {
 *     cache:    { ms, hit, topPick, confidence, result },
 *     fastPath: { ms, hit, topPick, confidence, ruleApplied, result },
 *     laya:     { ms, hit, topPick, confidence, result, error }
 *   },
 *   agreement: {
 *     allAgree: boolean,
 *     cacheVsFastPath: boolean, cacheVsLaya: boolean, fastPathVsLaya: boolean,
 *     picks: { cache, fastPath, laya }
 *   }
 * }>}
 */
export async function runAllTiersForQuery(query, options = {}) {
  const { locale = "zh-Hant", prime = true } = options;
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    throw new Error("runAllTiersForQuery: query is required");
  }

  const state = {
    query: trimmed,
    locale,
    userLocation: null,
    recentHistory: [],
    timestamp: new Date().toISOString(),
  };

  // ── Optional prime pass (NOT timed) ─────────────────────────────
  // Run Laya once up-front so the cache tier returns a real hit. We
  // intentionally do NOT count this toward the laya tier timing —
  // the laya tier should report single-inference latency, not
  // "cold-start + warm" (which is what /api/laya/intent's first call
  // sees, but it's misleading as a per-call number).
  if (prime) {
    try {
      const { result } = await runLayaDecisionTranslated(state, COMPARE_QUESTIONS);
      setCachedVerdict(trimmed, buildCacheableResponse(trimmed, result, locale));
    } catch {
      // Continue — we'll still measure the other tiers and surface
      // the laya error in the report so the UI can show it.
    }
  }

  // ── Tier 0: cache lookup (sub-ms on hit) ─────────────────────────
  const t0 = performance.now();
  const cacheResult = getCachedVerdict(trimmed);
  const cacheMs = performance.now() - t0;

  // ── Tier 1: regex fast path (<1 ms) ──────────────────────────────
  const t1 = performance.now();
  const fastVerdict = tryRegexFastPath(trimmed);
  const fastMs = performance.now() - t1;

  // ── Tier 2: Laya ONNX (~140 ms warm) ────────────────────────────
  const t2 = performance.now();
  let layaResult = null;
  let layaError = null;
  try {
    const { result } = await runLayaDecisionTranslated(state, COMPARE_QUESTIONS);
    layaResult = result;
  } catch (e) {
    layaError = e?.message ?? String(e);
  }
  const layaMs = performance.now() - t2;

  // Extract top appFunction pick from each tier's result shape.
  //   - cache:    { appFunction: { choice, confidence, probabilities } }
  //   - fastPath: { appFunction: { choice, confidence, ... } }
  //   - laya:     { answers: { function: { choice, confidence, ... } } }
  //               (note: the question key inside `answers` is `function`
  //                because that's the key inside LayaQuestions.appFunction)
  const cacheTop = cacheResult?.appFunction?.choice ?? null;
  const fastTop = fastVerdict?.appFunction?.choice ?? null;
  const layaTop = layaResult?.answers?.function?.choice ?? null;

  return {
    query: trimmed,
    tiers: {
      cache: {
        ms: round3(cacheMs),
        hit: !!cacheResult,
        topPick: cacheTop,
        confidence: cacheResult?.appFunction?.confidence ?? null,
        result: cacheResult,
      },
      fastPath: {
        ms: round3(fastMs),
        hit: !!fastVerdict,
        topPick: fastTop,
        confidence: fastVerdict?.appFunction?.confidence ?? null,
        ruleApplied: fastVerdict?.appFunction?.ruleApplied ?? null,
        result: fastVerdict,
      },
      laya: {
        ms: round3(layaMs),
        hit: false,
        topPick: layaTop,
        confidence: layaResult?.answers?.function?.confidence ?? null,
        result: layaResult,
        error: layaError,
      },
    },
    agreement: {
      allAgree: !!(
        cacheTop && fastTop && layaTop &&
        cacheTop === fastTop && fastTop === layaTop
      ),
      cacheVsFastPath: cacheTop != null && cacheTop === fastTop,
      cacheVsLaya:     cacheTop != null && cacheTop === layaTop,
      fastPathVsLaya:  fastTop  != null && fastTop  === layaTop,
      picks: { cache: cacheTop, fastPath: fastTop, laya: layaTop },
    },
  };
}

/** Build a minimal cacheable response body so the LRU has something to
 *  return on the cache tier. Mirrors the shape /api/laya/intent sets —
 *  the tier-comparison doesn't need the post-grammar-rule overrides
 *  (which are deterministic given the same query), so we skip them. */
function buildCacheableResponse(query, layaResult, locale) {
  const answers = layaResult?.answers ?? {};
  const appFn = answers.function;
  const intentAns = answers.intent;
  return {
    query,
    englishQuery: query,
    detectedLocale: locale,
    sourceLocale: null,
    translateSkipped: "compare",
    appFunction: appFn
      ? {
          choice: appFn.choice ?? null,
          confidence: appFn.confidence ?? 0,
          probabilities: appFn.probabilities ?? {},
        }
      : null,
    intent: intentAns
      ? {
          choice: intentAns.choice ?? null,
          confidence: intentAns.confidence ?? 0,
          probabilities: intentAns.probabilities ?? {},
        }
      : null,
    // Surface the 6-way transport verdict so the cache tier can show
    // mode-specific top picks (mtr / bus / taxi / walk / ferry /
    // unspecified) without re-running Laya. Falls back to null when
    // the underlying Laya output didn't include a transport question.
    transport: answers.transport
      ? {
          choice: answers.transport.choice ?? null,
          confidence: answers.transport.confidence ?? 0,
          probabilities: answers.transport.probabilities ?? {},
        }
      : null,
    queryType: "place",
    model: "compare:seed",
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }


//hi
=======
>>>>>>> b897931cdb546cf1f5772a706d8e7cb81d15adea
