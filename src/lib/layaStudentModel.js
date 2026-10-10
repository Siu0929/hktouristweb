/**
 * layaStudentModel.js — Pure-JS distilled "student" model for the laya-test page
 *
 * This is a lightweight JavaScript classifier that mimics the behaviour of the
 * full Laya ONNX teacher model for a small set of well-defined question types.
 * The goal is to demonstrate **model distillation** in pure JavaScript — not
 * to replace Laya in production.
 *
 * Architecture:
 *   Teacher  = @receptron/laya ONNX model (slow, ~140 ms, accurate)
 *   Student  = this file (fast, <1 ms, hand-coded rules + heuristics)
 *
 * The student handles the most common cases well and explicitly marks itself
 * as "unsure" (low confidence) on edge cases so the UI can fall back to the
 * teacher. This is exactly what a real distilled model does — predict fast
 * when confident, defer when not.
 *
 * Supported question types:
 *   - choice: transport mode, intent, app function, ticket category
 *   - score:  severity, urgency, relevance, accessibility
 *   - noul:   needsRoute, needsWheelchair, isSafetyRisk, isOpenNow
 *
 * Usage from laya-test/page.js:
 *   import { studentSystemOne } from "@/lib/layaStudentModel";
 *   const result = studentSystemOne(state, questions);
 *   // → { answers: {...}, usage: {...}, model: "student:rules-v1" }
 *
 * The returned `answers` shape is identical to runLayaDecision() so the
 * existing AnswerBlock / ProbabilityBar components can render both.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Softmax a numeric array. */
function softmax(z) {
  const zmax = Math.max(...z);
  const e = z.map((v) => Math.exp(v - zmax));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/** Standard deviation of a probability distribution. */
function stdOf(p) {
  const mean = 1 / p.length;
  return Math.sqrt(p.reduce((s, x) => s + (x - mean) ** 2, 0) / p.length);
}

/** Log-probabilities (base 10) of a probability distribution. */
function logProbs(p) {
  return p.map((x) => Math.log10(Math.max(x, 1e-12)));
}

/** Confidence derived from the entropy of a distribution (0..1). */
function confidenceFromProbs(p) {
  if (p.length < 2) return 1;
  let ent = 0;
  for (const x of p) ent -= x * Math.log(Math.max(x, 1e-12));
  return Math.max(0, Math.min(1, 1 - ent / Math.log(p.length)));
}

/** Find the highest-probability option's key. */
function argmaxKeys(keys, probs) {
  let bi = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bi]) bi = i;
  return { key: keys[bi], prob: probs[bi] };
}

/** Build a uniform probability vector and bias it towards `preferKey`. */
function biasedProbs(keys, preferKey, weight = 0.5) {
  const n = keys.length;
  const uniform = 1 / n;
  const probs = keys.map((k) => uniform * (1 - weight) + (k === preferKey ? uniform * weight : 0));
  // Renormalise so the preferKey gets (1 - (n-1) * uniform * (1 - weight))
  // which is uniform * (weight - (n-1)*(1-weight))... easier to just set explicitly:
  const target = 0.6 + 0.35 * weight; // confidence 0.6..0.95
  const remainder = (1 - target) / (n - 1);
  return keys.map((k) => (k === preferKey ? target : remainder));
}

// ─── Question type definitions ──────────────────────────────────────────────────

/** Map of question key → inference function. Each fn takes (state, criteria) and
 *  returns { choice|distribution|noul, confidence }. */
const STUDENT_INFERENCERS = {
  // ── Transport mode (5-way choice) ────────────────────────────────────────
  transport: (state) => inferTransportMode(state),

  // ── Query intent (2-way choice) ──────────────────────────────────────────
  intent: (state) => inferQueryIntent(state),

  // ── App function (5-way choice) ──────────────────────────────────────────
  function: (state) => inferAppFunction(state),

  // ── Ticket category (5-way choice) ───────────────────────────────────────
  category: (state) => inferTicketCategory(state),

  // ── Severity (4-level score) ─────────────────────────────────────────────
  severity: (state) => inferSeverity(state),
  urgency: (state) => inferUrgency(state),

  // ── POI relevance (4-level score) ────────────────────────────────────────
  relevance: (state) => inferRelevance(state),

  // ── POI accessibility (4-level score) ────────────────────────────────────
  accessibility: (state) => inferAccessibility(state),

  // ── Binary flags (noul) ──────────────────────────────────────────────────
  needsWheelchair: (state) => inferNeedsWheelchair(state),
  needsRoute: (state) => inferNeedsRoute(state),
  isSafetyRisk: (state) => inferIsSafetyRisk(state),
  isOpenNow: (state) => inferIsOpenNow(state),
};

// ─── Choice-type inferencers ──────────────────────────────────────────────────

/** Transport mode detector — same priority order as the production rules. */
const TRANSPORT_KEYS = ["mtr", "bus", "taxi", "walk", "ferry"];

function inferTransportMode(state) {
  const q = String(state?.query ?? "").trim();
  const patternMap = [
    { key: "taxi",  re: /(的士|截的士|打的|打車|滴滴|出租|出租車|出租车|Didi|taxi|cab|uber)/i },
    { key: "mtr",   re: /(港鐵|港铁|地鐵|地铁|MTR|metro|subway|underground)/i },
    { key: "bus",   re: /(巴士|公车|公交车|KMB|九巴|城巴|新巴|NWFB|龍運|LWB|小巴|綠Van|紅Van|綠van|紅van|minibus|bus\b|bus\s+[a-z0-9]+)/i },
    { key: "ferry", re: /(渡輪|渡轮|天星小輪|天星小轮|Star Ferry|過海|过海|ferry)/i },
    { key: "walk",  re: /(步行|行過去|行路|走路|走路过去|步行过去|走路去|walk|on foot|walking)/i },
  ];
  for (const { key, re } of patternMap) {
    if (re.test(q)) {
      return { choice: key, confidence: 0.92, _probs: biasedProbs(TRANSPORT_KEYS, key, 0.92) };
    }
  }
  // No explicit mode — guess based on destination, with low confidence
  const dest = state?.destination?.name ?? "";
  if (/(Cheung Chau|大嶼山|大屿山|Lantau|南丫|南丫|梅窩|坪洲)/i.test(dest)) {
    return { choice: "ferry", confidence: 0.65, _probs: biasedProbs(TRANSPORT_KEYS, "ferry", 0.5) };
  }
  if (/(機場|机场|Airport|迪士尼|Disneyland)/i.test(q) || /(機場|机场|Airport|迪士尼|Disneyland)/i.test(dest)) {
    return { choice: "mtr", confidence: 0.65, _probs: biasedProbs(TRANSPORT_KEYS, "mtr", 0.5) };
  }
  // Default — unsure
  return { choice: "mtr", confidence: 0.4, _probs: biasedProbs(TRANSPORT_KEYS, "mtr", 0.2) };
}

const INTENT_KEYS = ["route_planner", "direct_search"];

function inferQueryIntent(state) {
  const q = String(state?.query ?? "").trim();
  if (!q) return { choice: "direct_search", confidence: 0.5, _probs: [0.5, 0.5] };

  // Route grammar: from X to Y, 點去, 怎麼去
  const routeGrammar =
    /(\bfrom\s+.+\s+to\s+.+)|(\bto\s+get\s+to\s+.+)|(how\s+(do|can|should)\s+(i|we)\s+(get|go))|(\bto\s+.+?from\s+.+)|(點去|怎去|點樣去|怎么去|如何去|搭.{0,15}去|前往)/i;
  if (routeGrammar.test(q)) {
    return { choice: "route_planner", confidence: 0.9, _probs: [0.9, 0.1] };
  }
  // Direct search: 哪裡, 找, 最近, nearest
  if (/(哪裡|那里|邊度|搵|找|最近|nearest|nearby|where\s+is|where\s+are|find\s+|show\s+me)/i.test(q)) {
    return { choice: "direct_search", confidence: 0.85, _probs: [0.15, 0.85] };
  }
  // Bare mode/place keyword → direct_search
  if (/^(mtr|bus|taxi|ferry|tram|港鐵|地鐵|港铁|地铁|巴士|的士|渡輪)$/i.test(q)) {
    return { choice: "direct_search", confidence: 0.7, _probs: [0.3, 0.7] };
  }
  return { choice: "direct_search", confidence: 0.55, _probs: [0.45, 0.55] };
}

const APP_FN_KEYS = [
  "toilets",
  // Transport is a 6-way split that mirrors queryIntent.transport so
  // the SearchBar can render mode-specific labels. The student model
  // picks the same key the SearchBar's LayaSuggestions reads.
  "mtr", "bus", "taxi", "walk", "ferry", "unspecified",
  "planner", "search", "home",
];

function inferAppFunction(state) {
  const q = String(state?.query ?? "").trim();
  if (!q) return { choice: "home", confidence: 0.7, _probs: biasedProbs(APP_FN_KEYS, "home", 0.7) };

  // Toilets
  if (/(toilet|restroom|washroom|bathroom|廁所|洗手間|卫生間|衛生間|厕所|卫生间|無障礙|無障礙|barrier.?free|wheelchair)/i.test(q)) {
    return { choice: "toilets", confidence: 0.93, _probs: biasedProbs(APP_FN_KEYS, "toilets", 0.93) };
  }
  // Planner
  if (/(plan\s+(a\s+)?(trip|day|itinerary)|day\s+trip|itinerary|行程|一日遊|半日遊|旅遊路線|規劃行程|计划|規劃)/i.test(q)) {
    return { choice: "planner", confidence: 0.9, _probs: biasedProbs(APP_FN_KEYS, "planner", 0.9) };
  }
  // Transport-only — pick the specific 6-way mode so the SearchBar
  // can render a mode-specific label (e.g. "搵 MTR 嘅站"). Order
  // matters: more specific modes (mtr / taxi) are tried first so
  // compound words like "Taxi Stand" don't get misclassified.
  if (/^(mtr|港鐵|地鐵|港铁|地铁|subway|metro)$/i.test(q)) {
    return { choice: "mtr", confidence: 0.92, _probs: biasedProbs(APP_FN_KEYS, "mtr", 0.92) };
  }
  if (/^(bus|巴士|公交|minibus|小巴)$/i.test(q)) {
    return { choice: "bus", confidence: 0.92, _probs: biasedProbs(APP_FN_KEYS, "bus", 0.92) };
  }
  if (/^(taxi|的士|uber|didi|出租車|出租车|計程車|计程车)$/i.test(q)) {
    return { choice: "taxi", confidence: 0.92, _probs: biasedProbs(APP_FN_KEYS, "taxi", 0.92) };
  }
  if (/^(ferry|渡輪|渡轮|渡船|天星小輪|天星小轮|Star\s*Ferry)$/i.test(q)) {
    return { choice: "ferry", confidence: 0.92, _probs: biasedProbs(APP_FN_KEYS, "ferry", 0.92) };
  }
  if (/^(tram|電車|电车)$/i.test(q)) {
    // Tram is a transport mode but doesn't have a dedicated chip on
    // the home page — fall through to "unspecified" so the text
    // filter handles it.
    return { choice: "unspecified", confidence: 0.85, _probs: biasedProbs(APP_FN_KEYS, "unspecified", 0.85) };
  }
  if (/(mtr|港鐵|地鐵|港铁|地铁|subway|metro)/i.test(q)) {
    return { choice: "mtr", confidence: 0.85, _probs: biasedProbs(APP_FN_KEYS, "mtr", 0.85) };
  }
  if (/(taxi|的士|uber|didi|出租車|出租车|計程車|计程车)/i.test(q)) {
    return { choice: "taxi", confidence: 0.85, _probs: biasedProbs(APP_FN_KEYS, "taxi", 0.85) };
  }
  if (/(ferry|渡輪|渡轮|渡船|天星小輪|天星小轮|Star\s*Ferry)/i.test(q)) {
    return { choice: "ferry", confidence: 0.85, _probs: biasedProbs(APP_FN_KEYS, "ferry", 0.85) };
  }
  if (/(bus|巴士|公交|minibus|小巴|KMB|城巴|新巴|NWFB|LWB|龍運|龙运)/i.test(q)) {
    return { choice: "bus", confidence: 0.85, _probs: biasedProbs(APP_FN_KEYS, "bus", 0.85) };
  }
  // Generic transport keyword → unspecified
  if (/^(transport|transit|巴士站|車站|车站|站|stop|station)$/i.test(q)) {
    return { choice: "unspecified", confidence: 0.8, _probs: biasedProbs(APP_FN_KEYS, "unspecified", 0.8) };
  }
  // Likely a place / landmark — search
  if (/(Peak|Harbour|Disneyland|Temple|Museum|Mall|山頂|山顶|海港|廟|寺|館|馆|商場|商場|中心|station|park|beach)/i.test(q)) {
    return { choice: "search", confidence: 0.7, _probs: biasedProbs(APP_FN_KEYS, "search", 0.7) };
  }
  // Default — search
  return { choice: "search", confidence: 0.5, _probs: biasedProbs(APP_FN_KEYS, "search", 0.5) };
}

const CATEGORY_KEYS = ["data", "infra", "ux", "content", "safety"];

function inferTicketCategory(state) {
  const subject = String(state?.subject ?? "").trim();
  const body = String(state?.body ?? "").trim();
  const text = (subject + " " + body).toLowerCase();

  // Safety keywords — always priority
  if (/(broken\s+glass|flooding|crush|assault|injury|hazard|danger|broken|玻璃|水浸|洪水|擠|擠迫|攻擊|傷害|危險)/i.test(text)) {
    return { choice: "safety", confidence: 0.95, _probs: biasedProbs(CATEGORY_KEYS, "safety", 0.95) };
  }
  // Data
  if (/(bus\s+time|eta|schedule|wrong\s+time|incorrect\s+stop|missing\s+route|stale|時刻|班次|時間|站名|路線|路線)/i.test(text)) {
    return { choice: "data", confidence: 0.9, _probs: biasedProbs(CATEGORY_KEYS, "data", 0.9) };
  }
  // Infra (map)
  if (/(map|marker|geocode|poi|missing\s+poi|broken\s+marker|地圖|標記|定位|poi)/i.test(text)) {
    return { choice: "infra", confidence: 0.88, _probs: biasedProbs(CATEGORY_KEYS, "infra", 0.88) };
  }
  // UX
  if (/(ui|layout|label|button|interaction|broken|broken\s+layout|界面|按鈕|标签|亂碼|loadload|loading|卡)/i.test(text)) {
    return { choice: "ux", confidence: 0.87, _probs: biasedProbs(CATEGORY_KEYS, "ux", 0.87) };
  }
  // Content
  if (/(translation|description|hours|address|phone|missing|翻譯|描述|開放時間|地址|電話|电话|資訊|信息|资讯|資料)/i.test(text)) {
    return { choice: "content", confidence: 0.86, _probs: biasedProbs(CATEGORY_KEYS, "content", 0.86) };
  }
  return { choice: "data", confidence: 0.4, _probs: biasedProbs(CATEGORY_KEYS, "data", 0.2) };
}

// ─── Score-type inferencers ────────────────────────────────────────────────────

const SEVERITY_KEYS = ["cosmetic", "minor", "moderate", "blocking"];
function inferSeverity(state) {
  const body = String(state?.body ?? "").toLowerCase();
  const subject = String(state?.subject ?? "").toLowerCase();
  const text = subject + " " + body;
  // Hard safety signals
  if (/(broken\s+glass|flooding|injury|emergency|crush|assault|danger|玻璃|水浸|洪水|擠|擠迫|攻擊|傷害|危險)/i.test(text)) {
    return { level: 3, _probs: [0.02, 0.05, 0.18, 0.75] }; // blocking
  }
  // Heavy / data-affecting
  if (/(always\s+wrong|completely\s+wrong|all\s+users|every|broken|崩潰|壞|crash)/i.test(text)) {
    return { level: 2, _probs: [0.05, 0.15, 0.55, 0.25] };
  }
  // Minor
  if (/(sometimes|occasionally|sometimes|偶爾|偶而|有時|minor|small)/i.test(text)) {
    return { level: 1, _probs: [0.2, 0.55, 0.2, 0.05] };
  }
  // Cosmetic
  if (/(typo|spelling|label|color|錯字|typo|顏色|颜色)/i.test(text)) {
    return { level: 0, _probs: [0.7, 0.2, 0.07, 0.03] };
  }
  return { level: 1, _probs: [0.25, 0.4, 0.25, 0.1] };
}

const URGENCY_KEYS = ["low", "medium", "high", "critical"];
function inferUrgency(state) {
  const q = String(state?.query ?? "").toLowerCase();
  if (/(emergency|urgent|right\s+now|asap|hospital|airport|check.?in|班|急|立刻|現在|机场|急診|赶)/i.test(q)) {
    return { level: 3, _probs: [0.02, 0.08, 0.3, 0.6] };
  }
  if (/(soon|leaving|commut|morning|tonight|準備|赶|快|即將|即将|leave|go\s+now)/i.test(q)) {
    return { level: 2, _probs: [0.08, 0.27, 0.5, 0.15] };
  }
  if (/(weekend|next\s+week|planning|trip|plan|行程|下次|打算)/i.test(q)) {
    return { level: 0, _probs: [0.65, 0.25, 0.07, 0.03] };
  }
  return { level: 1, _probs: [0.3, 0.45, 0.2, 0.05] };
}

const RELEVANCE_KEYS = ["poor", "fair", "good", "excellent"];
function inferRelevance(state) {
  const poi = state?.poi ?? {};
  const q = String(state?.query ?? "").toLowerCase();
  // Wheelchair + toilet query + POI has wheelchair
  if (/(wheelchair|accessible|barrier.?free|無障礙|无障碍)/i.test(q) && poi.wheelchairAccess === true) {
    return { level: 3, _probs: [0.02, 0.05, 0.15, 0.78] };
  }
  // Wheelchair + no access
  if (/(wheelchair|accessible|barrier.?free|無障礙|无障碍)/i.test(q) && !poi.wheelchairAccess) {
    return { level: 0, _probs: [0.85, 0.1, 0.03, 0.02] };
  }
  // Right category match
  if (poi.category && /toilet|restroom|廁所|洗手間/.test(q) && poi.category === "mall") {
    return { level: 2, _probs: [0.05, 0.15, 0.65, 0.15] };
  }
  // Close distance
  if (poi.distanceMetres != null && poi.distanceMetres < 200 && poi.category) {
    return { level: 2, _probs: [0.05, 0.18, 0.6, 0.17] };
  }
  return { level: 1, _probs: [0.15, 0.55, 0.22, 0.08] };
}

const ACCESSIBILITY_KEYS = ["not_accessible", "partially", "mostly", "fully"];
function inferAccessibility(state) {
  const poi = state?.poi ?? {};
  if (poi.wheelchairAccess === true && poi.category === "mall") {
    return { level: 3, _probs: [0.02, 0.05, 0.18, 0.75] };
  }
  if (poi.wheelchairAccess === true) {
    return { level: 2, _probs: [0.05, 0.2, 0.6, 0.15] };
  }
  if (poi.wheelchairAccess === false) {
    return { level: 0, _probs: [0.7, 0.2, 0.07, 0.03] };
  }
  return { level: 1, _probs: [0.2, 0.5, 0.25, 0.05] };
}

// ─── Noul-type inferencers ─────────────────────────────────────────────────────

function inferNeedsWheelchair(state) {
  const q = String(state?.query ?? "").toLowerCase();
  const prefs = state?.userPreferences ?? {};
  if (/(wheelchair|accessible|barrier.?free|無障礙|无障碍|elderly|with\s+stroller|pram|輪椅|长者|老人|婴儿车)/i.test(q)) {
    return { noul: 0.95 };
  }
  if (prefs.mobilityNeeds === true) return { noul: 0.9 };
  return { noul: 0.05 };
}

function inferNeedsRoute(state) {
  const intent = inferQueryIntent(state);
  return { noul: intent.choice === "route_planner" ? 0.95 : 0.05 };
}

function inferIsSafetyRisk(state) {
  const body = String(state?.body ?? "").toLowerCase();
  const subject = String(state?.subject ?? "").toLowerCase();
  const text = subject + " " + body;
  if (/(broken\s+glass|flooding|injury|emergency|crush|assault|danger|hazard|玻璃|水浸|洪水|擠|擠迫|攻擊|傷害|危險)/i.test(text)) {
    return { noul: 0.95 };
  }
  return { noul: 0.1 };
}

function inferIsOpenNow(state) {
  const poi = state?.poi ?? {};
  // Heuristic: if the POI has openingHours and looks like a 10:00-22:00 mall
  if (poi.category === "mall" && /10:00.{0,3}22:00/i.test(poi.openingHours ?? "")) {
    return { noul: 0.9 }; // assume now is within range for the demo
  }
  if (poi.openingHours && /\d+:\d+/.test(poi.openingHours)) {
    return { noul: 0.7 };
  }
  return { noul: 0.5 };
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Student systemOne — pure-JS distilled decision model.
 *
 * Iterates the questions map, dispatches to the appropriate hand-coded
 * inferencer, and wraps the result in the same shape as the teacher's
 * `runLayaDecision()` output so existing UI components (AnswerBlock,
 * ProbabilityBar) work unchanged.
 *
 * @param {object} state       - the same state object the teacher gets
 * @param {object} questions   - map of question-key → question definition
 * @returns {{
 *   answers: object,
 *   usage: { input_tokens, generation_tokens, total_tokens },
 *   model: string,
 *   studentStats: { totalQuestions, avgConfidence, lowConfidenceCount, elapsedMs }
 * }}
 */
export function studentSystemOne(state, questions) {
  const t0 = Date.now();
  const answers = {};
  let totalConf = 0;
  let lowConfCount = 0;

  for (const [qkey, qdef] of Object.entries(questions)) {
    const inferencer = STUDENT_INFERENCERS[qkey];
    if (!inferencer) {
      // Unknown question type — emit a low-confidence "unsure" answer
      answers[qkey] = makeUnsure(qdef);
      lowConfCount++;
      continue;
    }

    const out = inferencer(state, qdef);
    const conf = out.confidence ?? 0.5;
    totalConf += conf;
    if (conf < 0.6) lowConfCount++;

    if (qdef.type === "choice") {
      const keys = Object.keys(qdef.criteria ?? {});
      const probs = out._probs ?? keys.map(() => 1 / keys.length);
      const norm = renormalise(probs);
      const { key } = argmaxKeys(keys, norm);
      answers[qkey] = {
        type: "choice",
        choice: key,
        confidence: conf,
        probabilities: Object.fromEntries(keys.map((k, i) => [k, norm[i]])),
        std: round4(stdOf(norm)),
        logProbs: logProbs(norm).map(round4),
      };
    } else if (qdef.type === "score") {
      const levels = Array.isArray(qdef.criteria) ? qdef.criteria.length : 4;
      const probs = out._probs ?? new Array(levels).fill(1 / levels);
      const norm = renormalise(probs);
      answers[qkey] = {
        type: "score",
        distribution: norm,
        expected: norm.reduce((s, p, i) => s + p * i, 0),
        std: round4(stdOf(norm)),
        logProbs: logProbs(norm).map(round4),
      };
    } else if (qdef.type === "noul") {
      answers[qkey] = {
        type: "noul",
        noul: clamp01(out.noul ?? 0.5),
        std: round4(Math.sqrt((out.noul ?? 0.5) * (1 - (out.noul ?? 0.5)))),
        logProbs: [round4(Math.log10(Math.max(1 - (out.noul ?? 0.5), 1e-12))),
                   round4(Math.log10(Math.max(out.noul ?? 0.5, 1e-12)))],
      };
    } else {
      answers[qkey] = makeUnsure(qdef);
      lowConfCount++;
    }
  }

  return {
    answers,
    usage: { input_tokens: 0, generation_tokens: 0, total_tokens: 0 },
    model: "student:rules-v1",
    studentStats: {
      totalQuestions: Object.keys(answers).length,
      avgConfidence: round4(answers ? totalConf / Object.keys(answers).length : 0),
      lowConfidenceCount: lowConfCount,
      elapsedMs: Date.now() - t0,
    },
  };
}

function makeUnsure(qdef) {
  if (qdef.type === "choice") {
    const keys = Object.keys(qdef.criteria ?? {});
    return {
      type: "choice",
      choice: keys[0] ?? null,
      confidence: 0.2,
      probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])),
      std: 0,
      logProbs: keys.map(() => 0),
    };
  }
  if (qdef.type === "score") {
    const levels = Array.isArray(qdef.criteria) ? qdef.criteria.length : 4;
    const u = new Array(levels).fill(1 / levels);
    return { type: "score", distribution: u, expected: (levels - 1) / 2, std: 0, logProbs: u.map(() => 0) };
  }
  return { type: "noul", noul: 0.5, std: 0, logProbs: [0, 0] };
}

function renormalise(p) {
  const s = p.reduce((a, b) => a + b, 0);
  if (s === 0) return p.map(() => 1 / p.length);
  return p.map((v) => v / s);
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round4(x) { return Math.round(x * 1e4) / 1e4; }

/**
 * Compare teacher vs student answers and produce an agreement report.
 *
 * @param {object} teacherResult  - result from runLayaDecision()
 * @param {object} studentResult  - result from studentSystemOne()
 * @returns {{
 *   agreementRate: number,         // 0..1 — fraction of questions with matching top pick
 *   perQuestion: { [qkey]: { teacher: {...}, student: {...}, agree: boolean, confGap: number } },
 *   recommendsTeacher: boolean,    // true if student is too weak to be trusted
 * }}
 */
export function compareDistilled(teacherResult, studentResult) {
  const tAnswers = teacherResult?.answers ?? {};
  const sAnswers = studentResult?.answers ?? {};
  const perQuestion = {};
  let matches = 0;
  let total = 0;
  let lowConfStudent = 0;

  for (const qkey of Object.keys(tAnswers)) {
    const t = tAnswers[qkey];
    const s = sAnswers[qkey];
    if (!s) continue;
    total++;

    let agree = false;
    let confGap = 0;
    if (t.type === "choice" && s.type === "choice") {
      agree = t.choice === s.choice;
      confGap = Math.abs((t.confidence ?? 0) - (s.confidence ?? 0));
    } else if (t.type === "noul" && s.type === "noul") {
      // Consider agree if both above/below 0.5 in the same direction
      const tt = (t.noul ?? 0.5) >= 0.5;
      const ss = (s.noul ?? 0.5) >= 0.5;
      agree = tt === ss;
      confGap = Math.abs((t.noul ?? 0) - (s.noul ?? 0));
    } else if (t.type === "score" && s.type === "score") {
      // Compare expected levels (rounded to nearest)
      const tExp = Math.round(t.expected ?? 0);
      const sExp = Math.round(s.expected ?? 0);
      agree = tExp === sExp;
      confGap = Math.abs((t.expected ?? 0) - (s.expected ?? 0));
    }

    if (agree) matches++;
    if ((s.confidence ?? s.noul ?? 0) < 0.6) lowConfStudent++;

    perQuestion[qkey] = {
      agree,
      confGap: round4(confGap),
      teacherPick: t.type === "choice" ? t.choice : t.type === "noul" ? (t.noul >= 0.5 ? "true" : "false") : `level ${Math.round(t.expected ?? 0)}`,
      studentPick: s.type === "choice" ? s.choice : s.type === "noul" ? (s.noul >= 0.5 ? "true" : "false") : `level ${Math.round(s.expected ?? 0)}`,
      teacherConf: round4(t.confidence ?? t.noul ?? 0),
      studentConf: round4(s.confidence ?? s.noul ?? 0),
    };
  }

  return {
    agreementRate: total > 0 ? round4(matches / total) : 0,
    totalCompared: total,
    matched: matches,
    lowConfStudent,
    perQuestion,
    recommendsTeacher: lowConfStudent > total / 2,
  };
}
