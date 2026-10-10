/**
 * POST /api/laya/intent
 *
 * Server-side wrapper that classifies a HK Tourist search-bar query
 * using Laya's `queryIntent` + `appFunction` presets. Designed to be cheap
 * enough to call from the live SearchBar dropdown — both presets are
 * sent in a single Laya inference so we only pay the ~140ms cost once.
 *
 * Tier 2 #5: a pre-Laya regex fast path answers obvious queries
 * (toilets / MTR / 點去 / plan a trip) in <5 ms without ONNX or
 * Google Translate, then falls through to Laya for the rest. See
 * `src/lib/regexFastPath.js` for the predicate layer.
 *
 * Request body (JSON):
 *   query         {string}  - raw user query (any language)
 *   locale        {string?} - app locale for translate fallback, default "zh-Hant"
 *   userLocation  {{lat, lng}?} - optional, used as routing context
 *   recentHistory {string[]?} - optional last few queries for context
 *
 * Response (200):
 *   {
 *     query:        string,        // original
 *     englishQuery: string,        // translated (or original if skipped)
 *     detectedLocale: string,      // "zh-Hant" | "zh-Hans" | "en" | ...
 *     sourceLocale:  string|null,  // raw BCP-47 from Google
 *     translateSkipped: false | string, // reason if translate was skipped
 *     intent: { choice: string, confidence: number, probabilities: { [opt]: number } },
 *     transport: { choice: string, confidence: number, probabilities: { [opt]: number } } | null,
 *     needsRoute: { p: number, choice: "true"|"false" } | null,
 *     appFunction: { choice: string, confidence: number, probabilities: { [opt]: number } },
 *     queryType: "empty" | "route" | "district" | "transportMode" | "place",
 *     cacheHit:   boolean,         // true if served from in-memory LRU (sub-ms)
 *     fastPath:   boolean,         // true if served by pre-Laya regex (no ONNX call)
 *     latencyMs:  number,          // wall-clock per request; for hits this is ~1
 *     cacheStats?: { size, live, expired, max },        // verdict LRU stats (misses only)
 *     translateCacheStats?: { size, live, expired, max }, // translate LRU stats (misses only)
 *     model:      "laya:queryIntent+appFunction" | "regex:fastPath",
 *   }
 *
 * Errors:
 *   400  missing query
 *   200  with { error, query } on inference failure (so UI can degrade gracefully)
 *
 * NOTE: First Laya call after server start takes ~10s while the
 * ~1.7 GB ONNX bundle loads. Subsequent Laya calls are ~140ms on CPU.
 * Fast-path calls are <5ms and have no warmup cost.
 */

import { runLayaDecisionTranslated, LayaQuestions } from "@/lib/laya";
import {
  getCachedVerdict,
  setCachedVerdict,
  getVerdictCacheStats,
} from "@/lib/layaCache";
import { getTranslateCacheStats } from "@/lib/translateService";
import {
  tryRegexFastPath,
  regexRouteGrammar,
  regexAppFunctionChoice,
  TRANSPORT_MODE_PATTERN,
} from "@/lib/regexFastPath";
import { studentSystemOne } from "@/lib/layaStudentModel";

// Re-export so scratch tests can drive the fast path without booting Next.
export { tryRegexFastPath, regexRouteGrammar } from "@/lib/regexFastPath";

export const dynamic = "force-dynamic";

// Merge the two presets into one questions map so a single Laya inference
// answers both. Namespaces are already distinct (intent / transport /
// needsRoute from queryIntent, function from appFunction), so spreading
// never collides.
const SEARCH_BAR_QUESTIONS = {
  ...LayaQuestions.queryIntent,
  ...LayaQuestions.appFunction,
};

/** Extract a normalised {choice, confidence, probabilities} from a Laya choice answer. */
function normalizeChoice(answer) {
  if (!answer || answer.type !== "choice") return null;
  return {
    choice: answer.choice ?? null,
    confidence: answer.confidence ?? 0,
    probabilities: answer.probabilities ?? {},
  };
}

/** Extract a normalised {p, choice} from a Laya noul answer. */
function normalizeNoul(answer) {
  if (!answer || answer.type !== "noul") return null;
  const p = typeof answer.noul === "number" ? answer.noul : 0;
  return { p, choice: p >= 0.5 ? "true" : "false" };
}

/**
 * Laya is a small ONNX classifier — it cannot apply the "hard rules"
 * written into its instruction text. A clear "from X to Y" query still
 * comes back at ~2% confidence. To compensate we run a deterministic
 * regex sweep AFTER Laya and override intent + needsRoute when the
 * grammar is unambiguous. The original Laya probabilities are still
 * preserved under `laya` so debug views can see what the model thought.
 *
 * Route patterns win over direct-search patterns. Patterns are tuned
 * to be conservative — only override when we're sure.
 *
 * Note: ROUTE_PATTERNS / DIRECT_SEARCH_PATTERNS live in
 * `src/lib/regexFastPath.js` so the pre-Laya fast path can reuse them.
 */

/**
 * Apply deterministic grammar rules on top of Laya's verdict.
 * - When a rule matches and disagrees with Laya (or Laya is low
 *   confidence), override choice + boost confidence to 0.96.
 * - When Laya already picked the right answer with reasonable
 *   confidence, leave it alone (no need to second-guess).
 * - needsRoute is forced to true whenever intent is route_planner
 *   via grammar rule, so the chip stays in sync.
 */
function applyGrammarRules(query, intent, needsRoute) {
  const grammarIntent = regexRouteGrammar(query);

  // Compute the "effective" intent: rule wins if it disagrees with
  // a low-confidence Laya answer, or if Laya didn't pick anything.
  let effectiveChoice = intent?.choice ?? null;
  let ruleApplied = null;

  if (grammarIntent === "route_planner") {
    if (intent?.choice !== "route_planner" || (intent.confidence ?? 0) < 0.7) {
      effectiveChoice = "route_planner";
      ruleApplied = "route_grammar";
    }
  } else if (grammarIntent === "direct_search") {
    if (intent?.choice !== "direct_search" || (intent.confidence ?? 0) < 0.7) {
      effectiveChoice = "direct_search";
      ruleApplied = "direct_search_grammar";
    }
  }

  const overridden = ruleApplied != null;
  const effectiveConfidence = overridden ? 0.96 : (intent?.confidence ?? 0);
  const effectiveProbs = overridden
    ? {
        ...(intent?.probabilities ?? {}),
        [effectiveChoice]: 0.96,
        ...(effectiveChoice === "route_planner"
          ? { direct_search: 0.04 }
          : { route_planner: 0.04 }),
      }
    : intent?.probabilities ?? {};

  const nextIntent = {
    choice: effectiveChoice,
    confidence: effectiveConfidence,
    probabilities: effectiveProbs,
    laya: intent
      ? {
          choice: intent.choice,
          confidence: intent.confidence,
          probabilities: intent.probabilities ?? {},
        }
      : null,
    ruleApplied,
  };

  // Keep needsRoute in sync — if grammar says route_planner, force true.
  let nextNeedsRoute = needsRoute;
  if (effectiveChoice === "route_planner") {
    if (!needsRoute || needsRoute.choice !== "true" || needsRoute.p < 0.7) {
      nextNeedsRoute = { p: 0.96, choice: "true", overridden: true };
    }
  }

  return { intent: nextIntent, needsRoute: nextNeedsRoute };
}

/**
 * Transport grammar rule (Fix 2).
 *
 * Laya's transport question often picks a specific mode (commonly `taxi`)
 * even when the query is a bare "how do I get from A to B" with NO mode
 * mentioned. We treat that as a hallucination and force `unspecified`
 * whenever:
 *     - intent is route_planner (already grammar-overridden above), AND
 *     - the query contains no explicit mode keyword in any language.
 *
 * Only overrides when the user did NOT name a mode — `太子到旺角搭的士`
 * still gets `taxi`; `太子到旺角點搭車` becomes `unspecified`.
 *
 * Note: TRANSPORT_MODE_PATTERN lives in `src/lib/regexFastPath.js` so
 * the pre-Laya fast path can reuse it.
 */

function applyTransportRule(query, intent, transport) {
  const q = (query ?? "").trim();
  if (intent?.choice !== "route_planner") {
    return { transport, ruleApplied: null };
  }
  if (!transport) {
    return { transport, ruleApplied: null };
  }

  // If the user already mentioned a mode, leave Laya (or grammar) alone.
  if (TRANSPORT_MODE_PATTERN.test(q)) {
    return { transport, ruleApplied: null };
  }

  // No mode keyword found — override Laya's choice with `unspecified`.
  return {
    transport: {
      choice: "unspecified",
      confidence: 0.96,
      probabilities: {
        ...(transport.probabilities ?? {}),
        unspecified: 0.96,
        [transport.choice ?? "taxi"]: Math.max(
          0.01,
          0.04 / Math.max(1, Object.keys(transport.probabilities ?? {}).length - 1)
        ),
      },
      laya: {
        choice: transport.choice,
        confidence: transport.confidence,
        probabilities: transport.probabilities ?? {},
      },
      ruleApplied: "no_explicit_mode",
    },
    ruleApplied: "no_explicit_mode",
  };
}

/**
 * App-function grammar rule.
 *
 * Laya's appFunction preset is a small ONNX classifier — it can't reliably
 * catch Cantonese "點去" / "點搭" / English "how do I get to X" routing
 * grammar, so it tends to fall back to `home` (its catch-all) for those
 * queries. We layer deterministic regex rules on top so the SearchBar
 * shows the right 4 candidate buttons.
 *
 * Decision tree (applied in order, first match wins) — see
 * `regexAppFunctionChoice` in `src/lib/regexFastPath.js` for the
 * shared predicate:
 *   1. Toilet keywords               → toilets    (override any Laya pick)
 *   2. Trip-planning keywords        → planner    (override)
 *   3. Routing grammar (intent =
 *      route_planner from grammar)    → unspecified (override)
 *      — but only if user didn't already pick a planner phrase (rule 2).
 *      The 6-way `queryIntent.transport` answer carries the inferred
 *      mode separately so the chip filter still works.
 *   4. Direct-search + transport keyword (e.g. "MTR", "巴士") → mtr/bus/
 *      taxi/walk/ferry depending on the matched mode (override)
 *   5. Direct-search + transport-only
 *      generic keyword (e.g. "transport",
 *      "transit")                     → unspecified  (override)
 *   6. Otherwise                      → leave Laya alone, but refine
 *      a generic "transport" pick (legacy 5-way output) into the
 *      specific mode from `queryIntent.transport` (see
 *      `refineTransportChoice` below).
 *
 * Mirrors the applyGrammarRules / applyTransportRule pattern: sets
 * confidence to 0.96, redistributes the leftover 0.04 across the other
 * functions, and records `laya` + `ruleApplied` for debug views.
 */

function forceAppFunction(appFunction, choice, ruleApplied) {
  const originalProbs = appFunction?.probabilities ?? {};
  const otherChoices = Object.keys(originalProbs).filter((c) => c !== choice);
  const leftoverPer = otherChoices.length > 0 ? 0.04 / otherChoices.length : 0;
  const newProbs = {
    ...Object.fromEntries(otherChoices.map((c) => [c, leftoverPer])),
    [choice]: 0.96,
  };
  return {
    choice,
    confidence: 0.96,
    probabilities: newProbs,
    laya: appFunction
      ? {
          choice: appFunction.choice,
          confidence: appFunction.confidence,
          probabilities: originalProbs,
        }
      : null,
    ruleApplied,
  };
}

/**
 * Refine a generic "transport" appFunction pick (legacy 5-way Laya
 * output, before the 6-way split in `LayaQuestions.appFunction`) into
 * the specific mode using the existing `queryIntent.transport` 6-way
 * answer.
 *
 * Laya's appFunction output was trained against a 5-way schema so it
 * may still pick the generic "transport" key — the model emits it
 * with high confidence even when `queryIntent.transport` has a
 * specific mode. This refinement step trusts the more-granular
 * 6-way transport answer when both are present and the Laya appFunction
 * choice is the generic "transport" key.
 *
 * If Laya's appFunction already picked one of the 6 specific modes,
 * we leave it alone (Laya made the right call itself). If
 * `queryIntent.transport` is unavailable, we keep the generic
 * "transport" choice rather than risk a wrong override.
 */
function refineTransportChoice(appFunction, transport) {
  if (!appFunction || !transport) return appFunction;
  if (appFunction.choice !== "transport") return appFunction;

  // 6 specific modes that can replace the generic "transport" pick.
  const SPECIFIC_MODES = new Set(["mtr", "bus", "taxi", "walk", "ferry", "unspecified"]);
  const specificMode = transport.choice;
  if (!specificMode || !SPECIFIC_MODES.has(specificMode)) return appFunction;

  // Keep the original Laya probabilities for debug, but re-anchor
  // the top choice to the specific mode so the SearchBar can render
  // a mode-specific label.
  return {
    ...appFunction,
    choice: specificMode,
    laya: appFunction.laya ?? {
      choice: appFunction.choice,
      confidence: appFunction.confidence,
      probabilities: appFunction.probabilities ?? {},
    },
    ruleApplied: appFunction.ruleApplied
      ? `${appFunction.ruleApplied}+transport_refine`
      : "transport_refine",
  };
}

function applyAppFunctionRule(query, intent, appFunction, transport) {
  const q = (query ?? "").trim();
  if (!q || !appFunction) {
    return { appFunction, ruleApplied: null };
  }

  const match = regexAppFunctionChoice(q, intent?.choice);
  if (!match) {
    // Laya's choice is kept as-is, but we refine a generic "transport"
    // into the specific mode using the 6-way transport verdict.
    const refined = refineTransportChoice(appFunction, transport);
    if (refined !== appFunction) {
      return { appFunction: refined, ruleApplied: refined.ruleApplied ?? "transport_refine" };
    }
    return { appFunction, ruleApplied: null };
  }
  return {
    appFunction: forceAppFunction(appFunction, match.choice, match.ruleApplied),
    ruleApplied: match.ruleApplied,
  };
}

/**
 * Query-type classifier used by the SearchBar to choose a contextual
 * button label. Without this distinction the Laya chip would show
 * "Find transport stops in Bus" when the user actually wants to find
 * bus stops, or "Find toilets near Bus" — neither makes sense. The
 * classifier runs AFTER the grammar rules so it can use the post-rule
 * intent choice (route_planner / direct_search).
 *
 * Returns one of:
 *   "empty"          – empty / whitespace query
 *   "route"          – routing grammar ("點去元朗", "from A to B")
 *   "district"       – query names a HK district (元朗, 銅鑼灣, etc.)
 *   "transportMode"  – query IS a transport mode keyword (mtr, bus, 巴士, …)
 *   "place"          – default: assume it's a POI / attraction / generic
 *
 * Order matters: route grammar beats everything except emptiness, district
 * beats transportMode so "元朗巴士總站" classifies as "place" (the user
 * is looking up a specific bus terminus, not asking for bus transport).
 */
const HK_DISTRICTS = [
  // Hong Kong Island
  "中環", "中环", "上環", "上环", "西環", "西环", "金鐘", "金钟",
  "灣仔", "湾仔", "銅鑼灣", "铜锣湾", "跑馬地", "跑马地",
  "北角", "鰂魚涌", "鲗鱼涌", "筲箕灣", "筲箕湾", "天后", "炮台山",
  "香港仔", "薄扶林", "赤柱",
  // Kowloon
  "尖沙咀", "佐敦", "油麻地", "旺角", "太子", "深水埗",
  "紅磡", "红磡", "土瓜灣", "土瓜湾", "黃埔", "黄埔", "何文田",
  "九龍", "九龙", "九龍城", "九龙城", "觀塘", "观塘",
  "黃大仙", "黄大仙", "油尖旺", "啟德", "启德", "牛頭角", "牛头角",
  // New Territories
  "元朗", "屯門", "屯门", "荃灣", "荃湾", "葵青", "葵涌", "荔景",
  "沙田", "大埔", "北區", "北区", "將軍澳", "将军澳", "西貢", "西贡",
  "東涌", "东涌", "大嶼山", "大屿山",
  // Generic regions
  "新界", "離島", "离岛", "香港島", "香港岛", "香港",
];

// Strict transport-mode pattern. Whole-word / exact-match only so that
// place names containing mode keywords (e.g. "巴士總站", "mtr exit A3")
// don't accidentally classify as transportMode.
const QUERY_TRANSPORT_MODE_PATTERN = new RegExp(
  "^(mtr|bus|taxi|ferry|tram|minibus|subway|train|" +
  "mtr\\s+(stop|station|line|exit)|" +
  "bus\\s+(stop|station|route|term)|" +
  "taxi\\s+stand|ferry\\s+pier|tram\\s+stop|" +
  "港鐵|港铁|地鐵|地铁|巴士|的士|渡輪|渡轮|電車|电车|小巴|公交)$",
  "i"
);

// Catch-all "how do I get to X" probe — single-character question words
// the existing grammar rules don't reliably match. (applyGrammarRules
// already covers most cases via applyAppFunctionRule; this is a
// safety net for the classifier alone.)
const ROUTE_PROBE_PATTERN = /(點樣|怎样|怎么|如何|點|怎)\s*(去|搭|到|前往)/;

function detectQueryType(query, intent) {
  const q = (query ?? "").trim();
  if (!q) return "empty";

  // Routing grammar: includes both applyGrammarRules (intent.choice) and
  // the bare probe patterns. This wins over district/mode classification.
  if (intent?.choice === "route_planner") return "route";
  if (ROUTE_PROBE_PATTERN.test(q)) return "route";

  // District: a HK district name in the query. Beats transportMode so
  // queries like "元朗巴士總站" classify as "place".
  for (const district of HK_DISTRICTS) {
    if (q.includes(district)) return "district";
  }

  // Transport mode keyword — must be exact match (no extra characters),
  // so "Bus" works but "Bus station near me" falls through to "place"
  // (handled by the home page text filter instead).
  if (QUERY_TRANSPORT_MODE_PATTERN.test(q)) return "transportMode";

  return "place";
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { query, locale = "zh-Hant", userLocation, recentHistory } = body ?? {};

  if (typeof query !== "string" || query.trim().length === 0) {
    return Response.json({ error: '"query" (non-empty string) is required' }, { status: 400 });
  }

  const state = {
    query,
    locale,
    userLocation: userLocation ?? null,
    recentHistory: Array.isArray(recentHistory) ? recentHistory.slice(0, 5) : [],
    timestamp: new Date().toISOString(),
  };

  const t0 = Date.now();
  try {
    // Cache lookup. Repeat queries (district names, transport keywords,
    // common spots) hit the LRU and skip both the Google Translate REST
    // call and the ONNX forward pass entirely. cacheHit is surfaced in
    // the response so dev tools can verify the path was taken.
    const cached = getCachedVerdict(query);
    if (cached) {
      return Response.json({
        ...cached,
        // latencyMs is per-request, not per-Laya-call. A cache hit
        // sub-millisecond so we record that explicitly.
        latencyMs: Date.now() - t0,
        cacheHit: true,
      });
    }

    // ─── Tier 2 #5: pre-Laya regex fast path ─────────────────────────
    // Bypass the 2-3s Laya call when regex is confident enough to
    // answer all 4 questions. Returns null when regex is not
    // confident (e.g. for place names, vague queries) — the caller
    // falls through to the slow Laya path in that case.
    const fastVerdict = tryRegexFastPath(query);
    if (fastVerdict) {
      const queryType = detectQueryType(query, fastVerdict.intent);
      const responseBody = {
        query,
        // No Google Translate call in the fast path — the SearchBar
        // uses the user's original query for the search API call, so
        // passing the original here is correct.
        englishQuery: query,
        // Locale: trust what the client sent. The regex predicates
        // don't care about script direction.
        detectedLocale: locale,
        sourceLocale: null,
        translateSkipped: "fast_path",
        translateError: null,
        intent: fastVerdict.intent,
        transport: fastVerdict.transport,
        needsRoute: fastVerdict.needsRoute,
        appFunction: fastVerdict.appFunction,
        queryType,
        model: "regex:fastPath",
        fastPath: true,
      };
      // Cache it so the second call is sub-ms, same as Laya verdicts.
      setCachedVerdict(query, responseBody);
      if (process.env.NODE_ENV !== "production") {
        console.info(
          `[laya/intent] fastPath rule=${fastVerdict.appFunction.ruleApplied} ` +
          `intent=${fastVerdict.intent.choice} ` +
          `transport=${fastVerdict.transport.choice} ` +
          `q=${JSON.stringify(query)}`
        );
      }
      return Response.json({
        ...responseBody,
        latencyMs: Date.now() - t0,
        cacheHit: false,
      });
    }

    // ─── Tier 2.5: student model (pure-JS, sub-ms) ──────────────
    // Bypass the 2-3 s Laya call when the student model's
    // hand-coded rules give a confident, specific answer.
    // The student handles the 4 questions the production route
    // needs (intent / transport / needsRoute / function) using
    // the same shape as Laya's output, so the same post-rules
    // apply on top.
    //
    // Use the student when EITHER:
    //   1. intent is route_planner — the post-rule layer will
    //      pin function to "unspecified" deterministically, so
    //      the student's function pick doesn't matter.
    //   2. function is a specific (non-default) choice — toilets
    //      / planner / mtr / bus / taxi / walk / ferry / unspecified.
    //      The student only emits these when a pattern matches,
    //      so they're a strong "I'm confident" signal.
    //   3. function is "search" with confidence ≥ 0.7 — student
    //      bumped confidence when the query contains a known
    //      landmark (Peak, Harbour, Disneyland, station, park,
    //      beach, 山頂, 海港, etc.). For these the post-rule
    //      won't override so the student's "search" answer is
    //      what Laya would have picked anyway, just sub-ms.
    //
    // Otherwise the student returned "search" / "home" as a
    // default fallback → fall through to Laya to figure out
    // the actual intent (it's likely a place name the student
    // doesn't recognise).
    const SPECIFIC_FN_CHOICES = new Set([
      "toilets", "planner",
      "mtr", "bus", "taxi", "walk", "ferry", "unspecified",
    ]);
    const sRawAnswers = studentSystemOne(state, SEARCH_BAR_QUESTIONS).answers ?? {};
    const sRawFnChoice = sRawAnswers.function?.choice;
    const sRawFnConf = sRawAnswers.function?.confidence ?? 0;
    const sRawIntentChoice = sRawAnswers.intent?.choice;
    const useStudent =
      sRawIntentChoice === "route_planner" ||
      SPECIFIC_FN_CHOICES.has(sRawFnChoice) ||
      (sRawFnChoice === "search" && sRawFnConf >= 0.7);

    if (useStudent) {
      const studentResult = {
        answers: sRawAnswers,
        model: "student:rules-v1",
        studentStats: {
          totalQuestions: Object.keys(sRawAnswers).length,
          avgConfidence: 0,
          lowConfidenceCount: 0,
          elapsedMs: 0,
        },
      };
      const sRawNeedsRoute = normalizeNoul(sRawAnswers.needsRoute);
      const sRawTransport = normalizeChoice(sRawAnswers.transport);
      const sRawAppFunction = normalizeChoice(sRawAnswers.function);
      const { intent: sIntent, needsRoute: sNeedsRoute } = applyGrammarRules(
        query,
        sRawAnswers.intent ? normalizeChoice(sRawAnswers.intent) : null,
        sRawNeedsRoute
      );
      const { transport: sTransport } = applyTransportRule(query, sIntent, sRawTransport);
      const { appFunction: sAppFunction } = applyAppFunctionRule(
        query,
        sIntent,
        sRawAppFunction,
        sTransport
      );
      const sQueryType = detectQueryType(query, sIntent);

      const studentResponseBody = {
        query,
        // Student runs in pure JS — no Google Translate call needed.
        englishQuery: query,
        detectedLocale: locale,
        sourceLocale: null,
        translateSkipped: "student_path",
        translateError: null,
        intent: sIntent,
        transport: sTransport ?? sRawTransport,
        needsRoute: sNeedsRoute,
        appFunction: sAppFunction ?? sRawAppFunction ?? {
          choice: null,
          confidence: 0,
          probabilities: {},
        },
        queryType: sQueryType,
        model: "student:rules-v1",
        studentStats: studentResult.studentStats,
      };
      setCachedVerdict(query, studentResponseBody);
      if (process.env.NODE_ENV !== "production") {
        console.info(
          `[laya/intent] student path intent=${sIntent?.choice} ` +
          `transport=${sTransport?.choice} appFn=${sAppFunction?.choice} ` +
          `q=${JSON.stringify(query)}`
        );
      }
      return Response.json({
        ...studentResponseBody,
        latencyMs: Date.now() - t0,
        cacheHit: false,
      });
    }

    // ─── Slow path: Laya inference + post-Laya grammar rules ─────────
    const { result, translate } = await runLayaDecisionTranslated(
      state,
      SEARCH_BAR_QUESTIONS
    );

    const answers = result?.answers ?? {};
    const rawIntent = normalizeChoice(answers.intent);
    const rawNeedsRoute = normalizeNoul(answers.needsRoute);
    const rawTransport = normalizeChoice(answers.transport);
    const rawAppFunction = normalizeChoice(answers.function);
    const { intent, needsRoute } = applyGrammarRules(query, rawIntent, rawNeedsRoute);
    const { transport } = applyTransportRule(query, intent, rawTransport);
    // Pass the post-rule transport verdict so `applyAppFunctionRule`
    // can refine a generic "transport" Laya pick into the specific
    // mode (mtr / bus / taxi / walk / ferry / unspecified) using the
    // existing 6-way transport answer.
    const { appFunction } = applyAppFunctionRule(query, intent, rawAppFunction, transport);
    const queryType = detectQueryType(query, intent);

    // Build the cacheable shape — everything EXCEPT per-request fields
    // (latencyMs, cacheHit). The verdict is deterministic for a given
    // query (Laya sees the same translated state, grammar rules are
    // pure functions of the query), so this is safe to memoize.
    const responseBody = {
      query,
      englishQuery: translate.englishQuery,
      detectedLocale: translate.detectedLocale,
      sourceLocale: translate.sourceLocale,
      translateSkipped: translate.skipped ?? false,
      translateError: translate.error ?? null,
      intent,
      transport: transport ?? rawTransport,
      needsRoute,
      appFunction: appFunction ?? rawAppFunction ?? {
        choice: null,
        confidence: 0,
        probabilities: {},
      },
      queryType,
      model: "laya:queryIntent+appFunction",
    };
    setCachedVerdict(query, responseBody);

    return Response.json({
      ...responseBody,
      latencyMs: Date.now() - t0,
      cacheHit: false,
      // Cache stats — only included on misses to keep cache-hit
      // responses small (they're the common case in steady state).
      cacheStats: getVerdictCacheStats(),
      translateCacheStats: getTranslateCacheStats(),
    });
  } catch (err) {
    console.error("[/api/laya/intent]", err);
    // Return 200 with error so the UI can silently degrade (chip hides itself).
    return Response.json({
      query,
      error: err?.message ?? String(err),
      latencyMs: Date.now() - t0,
      model: "laya:queryIntent+appFunction",
    });
  }
}
