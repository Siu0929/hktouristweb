/**
 * regexFastPath.js — Tier 2 #5 pre-Laya regex short-circuit.
 *
 * Goal: answer the four Laya intent questions (intent / transport /
 * needsRoute / appFunction) from regex alone when the query is
 * unambiguous. Bypasses the 2-3 s Laya ONNX call entirely for
 * "toilet / MTR / plan a trip / 點去元朗" type queries.
 *
 * Why this exists:
 *   Laya's multilingual encoder is unreliable on short Chinese
 *   keywords (廁所 / MTR / 點去) and on bare transport-mode probes.
 *   We were paying the full Laya cost for queries that are
 *   trivially decidable by regex. Caching helps repeat hits but
 *   first-time visitors still eat the 2-3 s. The fast path
 *   answers obvious cases in <5 ms with no ONNX, no Google
 *   Translate, and no I/O.
 *
 * Coverage:
 *   - appFunction: confident for toilets / transport / planner;
 *     null for search / home (those need Laya's place-name
 *     understanding).
 *   - intent:      confident for route_planner / direct_search;
 *     defaults to direct_search when no grammar matches (matches
 *     Laya's bias for short queries).
 *   - transport:   confident for any mode keyword (mtr / bus /
 *     taxi / walk / ferry) OR unspecified when no mode in a route
 *     context.
 *   - needsRoute:  derived from intent (true iff route_planner).
 *
 * The post-Laya override layer in `src/app/api/laya/intent/route.js`
 * uses the same predicate helpers so the regexes stay in sync
 * between the pre-Laya fast path and the post-Laya rule layer.
 */

// ─── Route / direct-search grammar patterns ───────────────────────────────
//
// These were originally inside route.js; hoisted here so the
// pre-Laya fast path can reuse them. Order matters: route patterns
// are tried first (they win when both match).

export const ROUTE_PATTERNS = [
  // English: "from X to Y", "from Mong Kok to Central"
  /\bfrom\s+[\s\S]+?\s+to\s+/i,
  // English: "X to Y" with travel verb in between ("how do I get from A to B")
  /\bto\s+get\s+to\s+/i,
  /\bget\s+to\s+/i,
  /\bgo\s+to\s+/i,
  /\btravel\s+(from|to)\s+/i,
  /\btraveling\s+(from|to)\s+/i,
  /\bheading\s+(from|to)\s+/i,
  /\bhow\s+(to|do\s+i|can\s+i|should\s+i)\s+(get|go|travel)\b/i,
  /\bdirections?\s+(from|to|between)\s+/i,
  /\broute\s+(from|to|between)\s+/i,
  /\bnavigate\s+(from|to)\s+/i,
  /\bplan\s+(a\s+)?(trip|route|journey|visit)\b/i,
  /\bcommute\s+(from|to)\s+/i,
  // Cantonese: 由 X 去/到 Y
  /由.{1,30}(去|到).{1,30}/,
  // Cantonese: X 去 Y / X 到 Y (place + travel verb + place)
  /[\u4e00-\u9fff]{2,15}\s*(去|到)\s*[\u4e00-\u9fff]{2,15}/,
  // Cantonese: 點去/點搭/點到 — bare "how do I get to X" with only one
  // Chinese character before the verb (e.g. "點去元朗", "點搭車"). The
  // generic "X 去 Y" pattern above requires 2+ chars before the verb,
  // which misses these single-character probes.
  /點\s*(去|搭|到)/,
  // Cantonese: 點樣去 / 點樣搭 / 怎樣去
  /(點樣|怎樣|怎样|怎么|如何)\s*(去|搭|到|前往)/,
  // Simplified Chinese: 从 X 到 Y / 从 X 去 Y
  /从.{1,30}(到|去|往).{1,30}/,
  /[\u4e00-\u9fff]{2,15}(到|去|往)[\u4e00-\u9fff]{2,15}/,
];

export const DIRECT_SEARCH_PATTERNS = [
  // English: "where is X", "where can I find X"
  /^\s*where\s+(is|are|can\s+i\s+find)\s+/i,
  // English: "nearest X", "near me X"
  /\bnearest\s+/i,
  /\bnear\s+(me|here)\b/i,
  // English: "find X near me", "find me X"
  /\bfind\s+(a\s+|the\s+|me\s+)?[a-z0-9]/i,
  // English: "show me X"
  /\bshow\s+me\s+/i,
  // English: opening hours / status
  /\b(open|opening)\s+(now|today|hours|at|time)\b/i,
  /\bis\s+[\w\s]+\s+open\b/i,
  // English: address / phone
  /\baddress\s+(of|for)\b/i,
  /\bphone\s+(number|of)\b/i,
];

/** Pure predicate: returns "route_planner" / "direct_search" / null. */
export function regexRouteGrammar(q) {
  if (!q) return null;
  for (const p of ROUTE_PATTERNS) {
    if (p.test(q)) return "route_planner";
  }
  for (const p of DIRECT_SEARCH_PATTERNS) {
    if (p.test(q)) return "direct_search";
  }
  return null;
}

// ─── Toilet / planner / transport-mode keyword patterns ───────────────────

export const TOILET_KEYWORDS =
  // English + Cantonese + Simplified — single or compound.
  /toilet|restroom|washroom|bathroom|\bwc\b|\bloo\b|公廁|廁所|洗手間|衛生間|無障礙廁所|公厕|厕所|卫生间|洗手间|无障碍厕所/i;

export const PLANNER_KEYWORDS =
  /\b(plan\s+(a|my|the)\s+(trip|day|day\s*trip|itinerary|route|visit|schedule))|itinerary|multi-?stop|day\s*trip|行程|一日遊|半日遊|旅遊路線|計劃行程|行程規劃|路线|旅游路线|计划行程|行程规划|一日游|半日游/i;

// Used to distinguish "I want to GET TO X" from "I want to FIND a place".
// If the query is essentially a transport-mode keyword (with no place name)
// it's transport, not search.
export const TRANSPORT_ONLY_KEYWORDS =
  /\b(mtr|bus|taxi|ferry|tram|minibus|station|stop)\b|地鐵|地铁|的士|巴士|公交|渡輪|渡轮|電車|電车|小巴|港鐵|港铁|車站|车站|碼頭|码头/i;

// Transport mode — used by applyTransportRule to detect "did the user
// name a specific mode?". Wider than TRANSPORT_ONLY_KEYWORDS so that
// phrases like "搭的士去旺角" or "by bus" are caught.
export const TRANSPORT_MODE_PATTERN = new RegExp(
  // English keywords
  "\\b(mtr|bus|taxi|uber|didi|cab|ferry|walk|walking|on\\s+foot|subway|train|tram|minibus)\\b|" +
  // English phrasal "by X"
  "\\b(by\\s+(mtr|bus|taxi|ferry|train|tram|rail))\\b|" +
  // Chinese single keywords — covers Traditional (HK/TW) + Simplified (CN).
  "(地鐵|地铁|的士|巴士|公交車|公交车|公交|出租車|出租车|計程車|计程车|打車|打车|滴滴|步行|走路|渡輪|渡轮|渡船|輪渡|轮渡|港鐵|輕鐵|電車|捷運|捷运|高鐵|高铁|火车|火車|飞机|飛機|小巴)|" +
  // Chinese "坐/搭/打 X" patterns — note: `搭車` alone is vague ("what transport should I take"),
  // so `車` is excluded from the ending list. Use `搭的士/巴士/地鐵` for specific modes.
  "(坐|搭|打)[\u4e00-\u9fff]{0,3}(巴士|的士|地鐵|地铁|出租車|出租车|公交|渡輪|渡轮|輪渡|轮渡|小巴|高铁|高铁|火车|飛機|飛机|船)",
  "i"
);

// Per-mode sub-regexes for the fast path. Returns the named Laya
// transport option ("mtr" / "bus" / etc.) or null when none matches.
// Order matters: more specific modes (mtr, taxi) are tried first so
// that compound words like "Taxi Stand" don't get misclassified.
//
// Boundary handling: English terms are wrapped in \b (so "training"
// doesn't match "train"); Chinese terms are bare (no \b) because
// Chinese characters don't form a word-boundary concept here, and
// \b never matches between two CJK chars. This is why "太子到旺角
// 搭的士" needs a regex that doesn't try to anchor 的士 with \b.
const MODE_PATTERNS = [
  ["mtr",   /\b(?:mtr|subway|train)\b|(?:港鐵|港铁|地鐵|地铁|捷運|捷运|高鐵|高铁|火车|火車)/i],
  ["bus",   /\b(?:bus|minibus)\b|(?:巴士|公交|公交车|小巴|KMB|城巴|新巴|NWFB|LWB|龍運|龙运)/i],
  ["taxi",  /\b(?:taxi|uber|didi)\b|(?:的士|滴滴|出租車|出租车|計程車|计程车)/i],
  ["walk",  /\b(?:walk|walking|on\s+foot)\b|(?:步行|走路|行路|行過去|步行过去|走路过去)/i],
  ["ferry", /\b(?:ferry)\b|(?:渡輪|渡轮|渡船|輪渡|轮渡|天星小輪|天星小轮|Star\s*Ferry)/i],
];

/** Returns the Laya transport option ("mtr" / "bus" / "taxi" / "walk" / "ferry")
 *  that the query mentions, or null when none matches. */
export function regexModeOf(q) {
  if (!q) return null;
  for (const [mode, re] of MODE_PATTERNS) {
    if (re.test(q)) return mode;
  }
  return null;
}

// ─── App-function decision tree (shared with post-Laya rule layer) ────────

/**
 * Decide which app function the query maps to. First match wins.
 * Mirrors the post-Laya `applyAppFunctionRule` decision tree.
 *
 * The returned `choice` is one of the 10 appFunction options
 * (toilets, mtr, bus, taxi, walk, ferry, unspecified, planner,
 * search, home) — transport is split into the 6 sub-modes that
 * mirror the `queryIntent.transport` 6-way verdict, so the
 * SearchBar can render mode-specific labels (e.g. "搵 MTR 嘅站").
 *
 * Returns { choice, ruleApplied } on hit, null on miss.
 */
export function regexAppFunctionChoice(q, intentChoice) {
  if (!q) return null;
  if (TOILET_KEYWORDS.test(q)) return { choice: "toilets", ruleApplied: "toilet_keyword" };
  if (PLANNER_KEYWORDS.test(q)) return { choice: "planner", ruleApplied: "planner_keyword" };
  if (intentChoice === "route_planner") {
    // Route queries don't get a specific mode — leave the choice as
    // "unspecified" so the route-planner surface wins. The
    // `queryIntent.transport` 6-way answer still carries the inferred
    // mode for the chip filter.
    return { choice: "unspecified", ruleApplied: "route_intent" };
  }
  if (intentChoice === "direct_search") {
    // Direct-search + transport keyword: pick the specific mode.
    // Order matters — try the 5 explicit modes first, then fall
    // back to "unspecified" for the generic "transport / transit" case.
    const mode = regexModeOf(q);
    if (mode) return { choice: mode, ruleApplied: "transport_keyword" };
    if (TRANSPORT_ONLY_KEYWORDS.test(q)) {
      return { choice: "unspecified", ruleApplied: "transport_keyword_generic" };
    }
  }
  return null;
}

/** Decide the transport option for the fast path. */
export function regexTransportChoice(q, intentChoice) {
  if (intentChoice !== "route_planner") {
    return { choice: "unspecified", ruleApplied: "not_routing" };
  }
  const mode = regexModeOf(q);
  if (mode) return { choice: mode, ruleApplied: "mode_keyword" };
  return { choice: "unspecified", ruleApplied: "no_explicit_mode" };
}

// ─── Probability builder ──────────────────────────────────────────────────

export const APP_FUNCTION_CHOICES = [
  "toilets",
  // Transport is now a 6-way split that mirrors queryIntent.transport
  // so the SearchBar can render mode-specific labels.
  "mtr", "bus", "taxi", "walk", "ferry", "unspecified",
  "planner", "search", "home",
];
export const INTENT_CHOICES = ["route_planner", "direct_search"];
export const TRANSPORT_CHOICES = ["mtr", "bus", "taxi", "walk", "ferry", "unspecified"];

/** Build a probability map where `choice` gets `confidence` and the
 *  remaining mass is split evenly across the other choices. Used by
 *  the fast path to build Laya-shaped { probabilities } objects. */
export function buildRegExProbabilities(choice, allChoices, confidence = 0.96) {
  const others = allChoices.filter((c) => c !== choice);
  const leftover = others.length > 0 ? (1 - confidence) / others.length : 0;
  const probs = Object.fromEntries(others.map((c) => [c, leftover]));
  probs[choice] = confidence;
  return probs;
}

// ─── The fast path itself ─────────────────────────────────────────────────

/**
 * Tier 2 #5: pre-Laya regex fast path.
 *
 * Tries to answer all 4 questions (intent, transport, needsRoute, appFunction)
 * from regex alone. Returns a verdict if regex is confident enough,
 * or null when the caller should fall through to Laya.
 *
 * Confidence coverage:
 *   - appFunction: confident for toilets / transport / planner; null
 *     for search / home (Laya's multilingual encoder handles those).
 *   - intent:      confident for route_planner / direct_search; defaults
 *     to direct_search when no grammar matches (matches Laya's bias
 *     for short queries).
 *   - transport:   confident for any mode keyword (mtr/bus/taxi/walk/ferry)
 *     OR unspecified when no mode in a route context.
 *   - needsRoute:  derived from intent (true iff route_planner).
 *
 * Intent / appFunction reconciliation:
 *   The pre-existing \bplan\s+trip\b pattern in ROUTE_PATTERNS would
 *   mark "plan a trip" as route_planner, but the user actually wants
 *   the planner surface (not a route). When the appFunction match
 *   wins as "planner", we override the grammar-derived intent to
 *   direct_search so the returned shape is internally consistent
 *   (intent=direct_search, appFunction=planner). The same logic
 *   applies to toilets — we keep the route grammar if present, but
 *   the toilet surface wins for appFunction regardless.
 *
 * @param {string} query - raw user query
 * @returns {null | {
 *   intent: { choice, confidence, probabilities, ruleApplied, laya },
 *   transport: { choice, confidence, probabilities, ruleApplied, laya },
 *   needsRoute: { p, choice },
 *   appFunction: { choice, confidence, probabilities, ruleApplied, laya },
 * }}
 */
export function tryRegexFastPath(query) {
  const q = (query ?? "").trim();
  if (!q) return null;

  const grammarIntent = regexRouteGrammar(q);
  const preliminaryIntent = grammarIntent ?? "direct_search";
  const appFunc = regexAppFunctionChoice(q, preliminaryIntent);
  if (!appFunc) return null; // not enough signal to skip Laya

  // Reconcile: a planner surface implies the user is NOT asking for
  // a route, even if the grammar pattern matched "plan a trip" as a
  // route. Override intent so the response is self-consistent.
  const intentChoice = appFunc.choice === "planner" ? "direct_search" : preliminaryIntent;

  const trans = regexTransportChoice(q, intentChoice);
  const needsRouteChoice = intentChoice === "route_planner" ? "true" : "false";
  const needsRouteP = needsRouteChoice === "true" ? 0.96 : 0.04;

  const intentRuleApplied =
    appFunc.choice === "planner" ? "no_grammar_default" :
    grammarIntent === "route_planner" ? "route_grammar" :
    grammarIntent === "direct_search" ? "direct_search_grammar" :
    "no_grammar_default";

  return {
    intent: {
      choice: intentChoice,
      confidence: 0.96,
      probabilities: buildRegExProbabilities(intentChoice, INTENT_CHOICES),
      ruleApplied: intentRuleApplied,
      laya: null,
    },
    transport: {
      choice: trans.choice,
      confidence: 0.96,
      probabilities: buildRegExProbabilities(trans.choice, TRANSPORT_CHOICES),
      ruleApplied: trans.ruleApplied,
      laya: null,
    },
    needsRoute: { p: needsRouteP, choice: needsRouteChoice },
    appFunction: {
      choice: appFunc.choice,
      confidence: 0.96,
      probabilities: buildRegExProbabilities(appFunc.choice, APP_FUNCTION_CHOICES),
      ruleApplied: appFunc.ruleApplied,
      laya: null,
    },
  };
}
