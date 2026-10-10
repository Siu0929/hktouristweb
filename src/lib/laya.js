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
 *       transport: {
 *         type: "choice",
 *         instructions: "Best transport mode for this user query?",
 *         criteria: {
 *           bus:   "public transit, buses, minibuses",
 *           mtr:   "MTR rail, heavy rail, Airport Express",
 *           taxi:  "private car, taxi, ride-hailing",
 *           walk:  "on foot, within walking distance",
 *           ferry: "ferries, Star Ferry, cross-harbour",
 *         },
 *       },
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
import { Tensor as ort_Tensor } from "onnxruntime-node";
import { translateToEnglish } from "@/lib/translateService";
import { getCachedVerdict, setCachedVerdict } from "@/lib/layaCache";
import { tryRegexFastPath } from "@/lib/regexFastPath";

// ─── Re-implemented from @receptron/laya/dist/sequence.js ────────────────────
// The Laya package's package.json `exports` field blocks direct subpath
// imports (only "." is exported), so we duplicate the pure helpers here
// instead of fighting webpack / turbopack module resolution. These functions
// are tiny and have no ONNX dependency.
const QTYPES = { choice: 0, score: 1, noul: 2 };
const QTYPE_NAMES = ["choice", "score", "noul"];

function pyJsonDumps(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "[" + v.map(pyJsonDumps).join(", ") + "]";
  return ("{" + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJsonDumps(x)}`).join(", ") + "}");
}
function serializeState(state) {
  return typeof state === "string" ? state : pyJsonDumps(state);
}
function toInternal(q) {
  let crit = q.criteria;
  if (q.type === "choice" && Array.isArray(crit)) {
    crit = Object.fromEntries(crit.map((c) => [c, null]));
  }
  return {
    t: q.type,
    ins: typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions),
    crit,
  };
}
function renderOptions(q) {
  if (q.t === "choice") return Object.entries(q.crit).map(([k, v]) => (v ? `${k}: ${v}` : k));
  if (q.t === "score") return q.crit.map((c, i) => `level ${i}: ${c}`);
  const c = (q.crit ?? {});
  return ["false: " + (c.false || "no, the statement does not hold"), "true: " + (c.true || "yes, the statement holds")];
}
function sizeBucket(k) {
  if (k <= 2) return "2";
  if (k <= 5) return "3-5";
  if (k <= 10) return "6-10";
  return "11+";
}
function tempBucket(qtype, k) {
  return `${QTYPE_NAMES[qtype]}:${sizeBucket(k)}`;
}
function confidenceFromProbs(p) {
  const k = p.length;
  if (k < 2) return 1;
  let ent = 0;
  for (const x of p) ent -= x * Math.log(Math.max(x, 1e-12));
  return 1 - ent / Math.log(k);
}
function softmax(z) {
  const zmax = Math.max(...z);
  const e = z.map((v) => Math.exp(v - zmax));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}
function buildSequence(encode, ids, state, q, maxLen, headMaxLen) {
  const scrub = (s) => s.split(ids.maskTok).join(" ");
  const opts = renderOptions(q);
  let headIds = encode(`${q.t} question: ${scrub(q.ins)}`);
  let optIds = opts.map((o) => [ids.mask, ...encode(" " + scrub(o)).slice(0, 48)]);
  const total = (xs) => xs.reduce((s, o) => s + o.length, 0);
  let optBudget = headMaxLen - total(optIds);
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => o.slice(0, per));
    optBudget = headMaxLen - total(optIds);
  }
  headIds = headIds.slice(0, Math.max(8, optBudget));
  const seq = [ids.cls, ...headIds, ids.sep];
  const markers = [];
  for (const o of optIds) {
    markers.push(seq.length);
    seq.push(...o);
  }
  seq.push(ids.sep);
  const room = Math.max(0, maxLen - seq.length - 1);
  const st = encode(scrub(serializeState(state))).slice(0, room);
  seq.push(...st, ids.sep);
  return { ids: seq.slice(0, maxLen), markers: markers.filter((m) => m < maxLen) };
}

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
 * Debug variant of runLayaDecision that exposes the model internals so we
 * can see exactly what happens between the raw ONNX logits and the
 * calibrated probabilities that systemOne returns.
 *
 * For each question in `questions` the response now includes a `debug`
 * field with:
 *   - logits_raw       Float32Array — the model's raw output, pre-temperature
 *   - logits_scaled    number[]     — after dividing by temperature
 *   - probs_raw        number[]     — softmax(logits_raw) — the model's
 *                                     intrinsic preference before calibration
 *   - probs_scaled     number[]     — softmax(logits_scaled) — matches what
 *                                     systemOne returns
 *   - temperature      number       — what temperature was actually used
 *   - temp_bucket      string       — bucket key, e.g. "choice:3-5"
 *   - best_raw         string       — argmax of probs_raw (what the model
 *                                     "really" wants before calibration)
 *   - best_scaled      string       — argmax of probs_scaled (the calibrated
 *                                     answer that systemOne reports)
 *   - choice_flip      boolean      — true if best_raw !== best_scaled
 *
 * @param {object} state       - context object
 * @param {object} questions   - map of question-key → question definition
 * @param {object} [options]   - passed to getLayaInstance()
 */
export async function runLayaDecisionDebug(state, questions, options = {}) {
  const laya = await getLayaInstance(options);
  // systemOne already does the heavy lifting (build sequence, run session,
  // apply temperature, softmax, build answer). We re-implement the loop
  // here using the same primitives so we can also keep the raw logits.

  const qids = Object.keys(questions);
  if (qids.length === 0) {
    throw new Error("systemOne: at least one question is required");
  }

  const items = qids.map((qid) => {
    const q = toInternal(questions[qid]);
    const { ids, markers } = buildSequence(
      laya.encode, laya.ids, state, q, laya.config.max_len, laya.config.head_max_len
    );
    if (markers.length !== renderOptions(q).length) {
      throw new Error(`question ${JSON.stringify(qid)}: options do not fit in head_max_len=${laya.config.head_max_len} tokens`);
    }
    return { q, ids, markers, qtype: QTYPES[q.t] };
  });

  const n = items.length;
  const L = Math.max(...items.map((it) => it.ids.length));
  const K = Math.max(...items.map((it) => it.markers.length));
  const inputIds = new BigInt64Array(n * L).fill(BigInt(laya.ids.pad));
  const attention = new BigInt64Array(n * L);
  const markerPos = new BigInt64Array(n * K);
  const markerMask = new Uint8Array(n * K);
  const qtype = new BigInt64Array(n);
  let nTokens = 0;
  items.forEach((it, i) => {
    it.ids.forEach((v, j) => {
      inputIds[i * L + j] = BigInt(v);
      attention[i * L + j] = 1n;
    });
    nTokens += it.ids.length;
    it.markers.forEach((m, j) => {
      markerPos[i * K + j] = BigInt(m);
      markerMask[i * K + j] = 1;
    });
    qtype[i] = BigInt(it.qtype);
  });

  const out = await laya.session.run({
    input_ids: new ort_Tensor("int64", inputIds, [n, L]),
    attention_mask: new ort_Tensor("int64", attention, [n, L]),
    marker_pos: new ort_Tensor("int64", markerPos, [n, K]),
    marker_mask: new ort_Tensor("bool", markerMask, [n, K]),
    qtype: new ort_Tensor("int64", qtype, [n]),
  });
  const logits = out["logits"].data;
  const act = out["act_probs"];
  const actData = act.data;
  const nAct = act.dims[1] ?? 1;

  // Also run the standard systemOne so the user sees the same answer shape
  const standard = await laya.systemOne(state, questions);

  const debugByQ = {};
  items.forEach((it, r) => {
    const qid = qids[r];
    const k = it.markers.length;
    const temp = laya.config.temperature_by_options?.[tempBucket(it.qtype, k)]
      ?? laya.config.temperature?.[it.qtype]
      ?? 1;
    const logitsRaw = Array.from(logits.subarray(r * K, r * K + k));
    const logitsScaled = logitsRaw.map((v) => v / temp);
    const probsRaw = softmax(logitsRaw);
    const probsScaled = softmax(logitsScaled);
    const q = it.q;
    const keys = q.t === "choice"
      ? Object.keys(q.crit)
      : q.t === "score"
        ? q.crit.map((_, i) => String(i))
        : ["false", "true"];
    const argmax = (arr) => arr.reduce((bi, v, i, a) => v > a[bi] ? i : bi, 0);
    const bestRaw = keys[argmax(probsRaw)];
    const bestScaled = keys[argmax(probsScaled)];
    debugByQ[qid] = {
      temperature: temp,
      temp_bucket: tempBucket(it.qtype, k),
      logits_raw: logitsRaw.map((v) => Math.round(v * 1e4) / 1e4),
      logits_scaled: logitsScaled.map((v) => Math.round(v * 1e4) / 1e4),
      probs_raw: probsRaw.map((v) => Math.round(v * 1e4) / 1e4),
      probs_scaled: probsScaled.map((v) => Math.round(v * 1e4) / 1e4),
      best_raw: bestRaw,
      best_scaled: bestScaled,
      choice_flip: bestRaw !== bestScaled,
      confidence_raw: Math.round(confidenceFromProbs(probsRaw) * 1e4) / 1e4,
      confidence_scaled: Math.round(confidenceFromProbs(probsScaled) * 1e4) / 1e4,
      act_probability: Math.round((actData[r * nAct] ?? 0) * 1e4) / 1e4,
      option_keys: keys,
      qtype: ["choice", "score", "noul"][it.qtype],
    };
  });

  return {
    ...standard,
    debug: debugByQ,
    debug_config: {
      max_len: laya.config.max_len,
      head_max_len: laya.config.head_max_len,
      temperature_global: laya.config.temperature,
      temperature_by_options: laya.config.temperature_by_options,
      model_dir: laya.modelDir,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// HK-tourism query gloss for Laya
// ───────────────────────────────────────────────────────────────────────────
//
// Laya's multilingual encoder is weak on long compound Chinese/Traditional
// nouns (e.g. 港鐵, 天星小輪): pure-Chinese queries get near-uniform
// probabilities and the right option often loses to whichever criteria
// happens to share a generic verb token.  We saw this in v1–v3 of the
// transport test (≈ 9 % → 33 % CN/TW accuracy no matter how careful the
// criteria were).
//
// The fix that actually moved the needle is to AUGMENT the state with a
// tiny English-language gloss derived from a small HK-transport
// dictionary.  With even one English token in the state the model
// discriminates correctly (v5: 13/13 = 100 %).  This is dramatically
// cheaper than running a translation LLM — it's regex + ≈ 50 entries.
//
// Order of pattern matching matters: TRANSPORT modes are matched
// FIRST with a short-circuit, otherwise landmarks (e.g. 銅鑼灣) can
// re-route the model into the wrong bucket (v4 → 80 %, v5 → 100 %).

/** Ordered transport-mode detectors. First match wins; landmarks are
 *  then collected separately and don't influence the transport signal. */
const TRANSPORT_PRIORITY = [
  { re: /(的士|截的士|打的|打車|滴滴|出租|出租車|出租车|Didi)/, en: "take a taxi" },
  { re: /(港鐵|港铁|地鐵|地铁|MTR)/,                       en: "take the MTR" },
  { re: /(巴士|公车|公交车|KMB|九巴|城巴|新巴|NWFB|龍運|LWB|小巴|綠Van|紅Van|綠van|紅van|minibus)/, en: "take a bus" },
  { re: /(渡輪|渡轮|天星小輪|天星小轮|Star Ferry|過海|过海)/, en: "take the Star Ferry" },
  { re: /(步行|行過去|行路|走路|走路过去|步行过去|走路去)/,   en: "walk there" },
  { re: /(Uber|uber)/,                                       en: "Uber ride" },
];

/** Sub-keyword detectors used to disambiguate when the generic mode
 *  keyword is missing — e.g. "call Uber" with no other verb. */
const SECONDARY = [
  { re: /(銅鑼灣|铜锣湾)/, en: "Causeway Bay" },
  { re: /(尖沙咀|尖沙嘴)/, en: "Tsim Sha Tsui" },
  { re: /(中環|中环)/,     en: "Central" },
  { re: /(旺角)/,         en: "Mong Kok" },
  { re: /(太子)/,         en: "Prince Edward" },
  { re: /(天后)/,         en: "Tin Hau" },
  { re: /(北角)/,         en: "North Point" },
  { re: /(觀塘|观塘)/,   en: "Kwun Tong" },
  { re: /(將軍澳|将军澳)/, en: "Tseung Kwan O" },
  { re: /(九龍|九龙)/,   en: "Kowloon" },
  { re: /(長洲|长洲)/,   en: "Cheung Chau" },
  { re: /(大嶼山|大屿山)/, en: "Lantau" },
  { re: /(南丫島|南丫岛)/, en: "Lamma Island" },
  { re: /(梅窩)/,         en: "Mui Wo" },
  { re: /(坪洲)/,         en: "Peng Chau" },
  { re: /(機場|机场)/,   en: "Airport" },
  { re: /(迪士尼)/,       en: "Disneyland" },
  { re: /(海洋公園|海洋公园)/, en: "Ocean Park" },
  { re: /(赤柱)/,         en: "Stanley" },
  { re: /(淺水灣|浅水湾)/, en: "Repulse Bay" },
  { re: /(附近|临近|鄰近|邻近|很近)/, en: "nearby" },
];

/**
 * Build a short English gloss for a HK tourist query, suitable for
 * appending to the Laya state object so the multilingual model sees
 * a discriminative English anchor alongside the raw Chinese text.
 *
 * Returns "" when the query has no CJK characters (pure English stays
 * as-is) or when nothing matches (returns a generic fallback so the
 * model still gets some context).
 *
 * @param {string} query - raw user query, may be TC / SC / EN / mixed
 * @returns {string} gloss, e.g. " (take the MTR, Causeway Bay (銅鑼灣))"
 */
export function buildHKQueryGloss(query) {
  if (typeof query !== "string" || query.length === 0) return "";
  if (!/[\u4e00-\u9fff]/.test(query)) return ""; // pure English → no augmentation
  // Step 1: transport mode (first match wins to avoid landmark re-routing)
  let mode = null;
  for (const { re, en } of TRANSPORT_PRIORITY) {
    if (re.test(query)) { mode = en; break; }
  }
  // Step 2: landmarks/landmarks (informational context)
  const landmarks = [];
  for (const { re, en } of SECONDARY) {
    if (re.test(query)) landmarks.push(en);
  }
  const parts = [];
  if (mode) parts.push(mode);
  for (const lm of landmarks) parts.push(lm);
  if (parts.length === 0) return " (general travel query in Hong Kong)";
  return ` (${parts.join(", ")})`;
}

/**
 * Same as {@link runLayaDecision} but additionally augments the state
 * with an English gloss (if the query contains Chinese) so the Laya
 * model's multilingual encoder gets a discriminative English anchor.
 *
 * Use this wrapper for any decision model that wants to handle both
 * Chinese and English queries fairly.
 *
 * @param {object} state       - context object, must contain a `query` field
 * @param {object} questions   - map of question-key → question definition
 * @param {object} [options]   - forwarded to getLayaInstance()
 * @returns {Promise<object>}  - same shape as runLayaDecision()
 */
export async function runLayaDecisionAutoGloss(state, questions, options = {}) {
  if (state && typeof state === "object" && typeof state.query === "string") {
    const gloss = buildHKQueryGloss(state.query);
    if (gloss) {
      // Inject as a SEPARATE field — never mutate the user's query string.
      state = { ...state, query_en: gloss.trim() };
    }
  }
  return runLayaDecision(state, questions, options);
}

/**
 * Translate-aware wrapper: runs Google Translate on the user's query and
 * passes the English version to Laya, with the detected locale fed back
 * into `state.locale`. This is the strongest countermeasure we have
 * against Laya's encoder-level locale bias.
 *
 * Why this exists:
 *   Laya's multilingual encoder learned a strong locale-as-prior: when
 *   state.locale='en' the encoder pushes toward English outputs no matter
 *   what the query text says. That bias is baked into the weights and
 *   can't be unlearned via instructions (verified in v1–v5 traces).
 *   By sending English text AND setting state.locale to the true
 *   detected locale, we give Laya a self-consistent signal: "this is
 *   a Chinese-speaking user typing a route request" — and the model
 *   discriminates correctly (see scratch/translate-test.mjs).
 *
 * Fallback behaviour:
 *   If GOOGLE_TRANSLATE_API_KEY is unset or the API call fails, the
 *   original query is sent unchanged. translateToEnglish() never throws.
 *
 * @param {object} state       - context object, must contain a `query` field
 * @param {object} questions   - map of question-key → question definition
 * @param {object} [options]   - forwarded to getLayaDecision() and the fetch
 * @param {AbortSignal} [options.signal] - forward to cancel the translate call
 * @returns {Promise<{
 *   result: object,          // what runLayaDecision() returns
 *   translate: {             // diagnostic info about the translate step
 *     englishQuery: string,
 *     detectedLocale: string,
 *     sourceLocale: string|null,
 *     skipped: false | string,
 *     error?: string,
 *   }
 * }>}
 */
export async function runLayaDecisionTranslated(state, questions, options = {}) {
  if (!state || typeof state !== "object" || typeof state.query !== "string") {
    // No query to translate — call Laya directly.
    const result = await runLayaDecision(state, questions, options);
    return {
      result,
      translate: { englishQuery: state?.query ?? "", detectedLocale: "en", sourceLocale: null, skipped: "no-query" },
    };
  }

  const { signal, ...rest } = options;
  const t = await translateToEnglish(state.query, { signal });

  // Build a new state object — never mutate the caller's state.
  // We PRESERVE the original query as `originalQuery` so downstream
  // code (logging, UI display, search) can still see what the user typed,
  // and we set the canonical `query` to the English version so Laya
  // reads English text. `locale` is set to the true detected locale
  // so the encoder doesn't have to guess.
  const translatedState = {
    ...state,
    query: t.englishQuery,
    originalQuery: state.query,
    locale: t.detectedLocale,
  };

  const result = await runLayaDecision(translatedState, questions, rest);
  return { result, translate: t };
}

/**
 * Convenience helpers for common HK Tourist app question shapes.
 * Each returns a pre-built questions object; pass it to runLayaDecision().
 *
 * Mirrored from src/app/laya-test/page.js PRESETS (Sep 2026):
 *   transportMode        ← PRESETS[0] 'transport'
 *   ticketClassification ← PRESETS[1] 'ticket'        (5 categories incl. safety)
 *   poiRanking           ← PRESETS[2] 'poi-ranking'
 *   safetyRisk           ← PRESETS[3] 'safety'         (safety option first)
 *   queryIntent          ← PRESETS[4] 'query-intent'   (intent + transport + needsRoute)
 *
 * NOTE: these are the page.js versions verbatim. They intentionally contain
 * stripped-token placeholders where Chinese vocabulary was simplified for
 * the test UI (e.g. "User says MTR, , , , MTR,"). If you need bilingual
 * encoder-friendly variants with embedded Chinese tokens, see git history
 * (pre-`mirror-page` revision of this file).
 */
export const LayaQuestions = {
  /** Decide the best transport mode for a POI search query. */
  transportMode: {
    transport: {
      type: "choice",
      instructions:
        "Which transport mode does the user's query most strongly imply or request? " +
        "EXPLICIT MENTIONS in the query always win over implied/intuitive preferences. " +
        "If the query literally says  / bus /  → bus. If it says  / MTR / MTR → MTR. " +
        "Only fall back to intuition (e.g. MTR for Central↔Kowloon) when no explicit mode is mentioned.",
      criteria: {
        mtr:   "User says MTR, , , , MTR,  (for MTR), or names an MTR station ().",
        bus:   "User says bus, , , names a bus route (101, 102, 104, 115, 270A, A21, E21), or mentions  / Van / Van /  /  /  / .",
        taxi:  "User says taxi, , , , call a cab, Uber, or DiDi.",
        walk:  "User says walking, on foot, , , within walking distance, or destination is described as very close / nearby.",
        ferry: "User says ferry, , , , , or names a ferry-only destination (Cheung Chau, Lantau, ).",
      },
    },
    urgency: {
      type: "score",
      instructions:
        "How time-sensitive or urgent is this travel request? " +
        "Consider whether the user seems to be in a hurry, commuting, or just browsing casually.",
      criteria: [
        "not urgent — user is casually browsing or planning a future trip",
        "somewhat urgent — user seems to want to leave soon, possibly for a scheduled appointment",
        "urgent — user is actively travelling and needs immediate routing help",
        "critical — user is in an emergency or time-critical situation (e.g. medical, airport flight check-in)",
      ],
    },
    needsWheelchair: {
      type: "noul",
      instructions:
        "Does the user (or the query context) indicate a need for wheelchair-accessible or barrier-free transport options? " +
        "Look for explicit mentions of wheelchair, wheelchair access, accessibility needs, " +
        "or context clues like 'elderly', 'with stroller', 'pram', 'luggage' (airport trips).",
    },
  },

  /** Classify a user support / issue-report ticket. 5-category schema. */
  ticketClassification: {
    category: {
      type: "choice",
      instructions:
        "Which team should handle this ticket? Choose the most appropriate category based on the root cause described.",
      criteria: {
        data:    "wrong bus / minibus times or ETAs, incorrect stop names or locations, " +
                 "missing routes or missing stops, stale or outdated schedules, " +
                 "Cantonese reports like: ETA" +
                 "",
        infra:   "map errors, broken map markers, missing POIs (restaurants, toilets, attractions), " +
                 "geocoding failures (wrong location for an address), " +
                 "Cantonese: ",
        ux:      "ui issues, confusing labels, broken layout, interactions not working, " +
                 "wrong language shown, Cantonese display issues, search not returning results, " +
                 "Cantonese: loadload",
        content: "missing descriptions, bad or inaccurate translations (especially English ↔ Cantonese ↔ Mandarin), " +
                 "incomplete information about a POI (missing opening hours, address, phone), " +
                 "wrong or misleading POI name, Cantonese: ",
        safety:  "actual or potential physical danger to users: " +
                 "broken glass near a stop, flooding at a station, crowd crush risk, assault reports, " +
                 "obstructed pathways, no accessibility ramp when needed, dangerous road conditions. " +
                 "Cantonese: ",
      },
    },
    severity: {
      type: "score",
      instructions:
        "How severe is this issue for users? Consider both frequency of impact and whether it blocks core functionality.",
      criteria: [
        "cosmetic — minor visual glitch, a typo, non-blocking inconvenience",
        "minor — occasional wrong data, minor UI quirk, not blocking most users",
        "moderate — wrong data affecting a significant portion of users, poor UX but functional, wrong translations",
        "blocking — core feature broken, safety hazard, or data is dangerously misleading",
      ],
    },
    isSafetyRisk: {
      type: "noul",
      instructions:
        "Does this report describe an actual or imminent physical safety risk to users on the street or transit system? " +
        "Answer yes if there is: injury, hazard, dangerous road/path condition, crowd danger, or assault. " +
        "Answer no if it is purely a data accuracy or UI usability issue.",
    },
  },

  /** Rank POI search results by relevance + user context. */
  poiRanking: {
    relevance: {
      type: "score",
      instructions:
        "How well does this POI match what the user is actively looking for? " +
        "Score EXCELLENT if it matches all key aspects of the query (category, accessibility, distance). " +
        "Score POOR if it matches only a minor or irrelevant aspect. " +
        "Consider the Hong Kong context: nearby means within 500m in dense urban Tsim Sha Tsui / Central areas, " +
        "but may be 1–2km in suburban areas like Sha Tin or Lantau.",
      criteria: [
        "POOR — POI does not satisfy the user's query at all (e.g. user wants a restaurant but result is a toilet; user wants wheelchair access but POI has none)",
        "FAIR — POI partially satisfies the query, misses one key criterion (e.g. right category but wrong accessibility; close but wrong type)",
        "GOOD — POI satisfies the query well; minor gaps (e.g. within walking distance but slightly off peak hours; right type but not the absolute closest)",
        "EXCELLENT — POI is a near-perfect match: correct category, accessible if needed, within reasonable walking distance, and open or with known good hours",
      ],
    },
    accessibility: {
      type: "score",
      instructions:
        "How accessible is this POI for someone with mobility, wheelchair, or special-access needs? " +
        "Consider: wheelchair ramp/lift, step-free access, accessible toilets, wide doors, ground floor access, " +
        "and proximity to MTR exits or pedestrian crossings. In HK malls this is usually good; street-level POIs vary widely.",
      criteria: [
        "NOT ACCESSIBLE — POI has clear barriers: steps at entrance, no ramp, no lift, narrow doorways, no accessible toilet, 4+ floors without lift",
        "PARTIALLY ACCESSIBLE — Some access features exist but not complete; e.g. lift present but no accessible toilet, or ramp but steep",
        "MOSTLY ACCESSIBLE — POI is accessible for most mobility needs; minor inconveniences only",
        "FULLY ACCESSIBLE — Step-free throughout, accessible toilet, lift/ramp present, wide pathways, MTR-exit-adjacent",
      ],
    },
    isOpenNow: {
      type: "noul",
      instructions:
        "Is this POI likely to be open right now? Use the provided opening hours (in Hong Kong time, UTC+8) and the current time (09:55 AM on a Wednesday). " +
        "Account for Hong Kong mall opening times (typically 10:00–21:00), street-level shops (often 09:00–22:00), " +
        "and tourist attractions (may close Mondays or have specific days off). " +
        "If no opening hours are provided, estimate based on typical HK POI hours.",
    },
  },

  /** Flag a report that may indicate user safety risk.
   *  Same schema as ticketClassification but `safety` is the FIRST option
   *  so Laya is biased toward the safety bucket when in doubt. */
  safetyRisk: {
    category: {
      type: "choice",
      instructions:
        "Which team should handle this ticket? Safety reports always route to safety even if they also involve data or infra issues.",
      criteria: {
        safety:  "physical injuries, hazards, broken glass, flooding, crowd crush, " +
                 "obstructed pathways, no accessibility ramp when needed, dangerous road or footpath conditions. " +
                 "Cantonese: ",
        data:    "wrong bus / minibus times, incorrect stop names, missing routes, stale schedules. " +
                 "Cantonese: ETA",
        infra:   "map errors, broken markers, missing POIs, geocoding failures. " +
                 "Cantonese: ",
        ux:      "ui issues, confusing labels, broken layout, interactions not working. " +
                 "Cantonese: loadload",
        content: "missing descriptions, bad or inaccurate translations, incomplete POI information. " +
                 "Cantonese: ",
      },
    },
    severity: {
      type: "score",
      instructions:
        "How severe is this issue for users? Safety hazards should score at least moderate. " +
        "If the issue describes a hazard that could injure someone, score it as blocking.",
      criteria: [
        "cosmetic — very minor visual issue, no real impact",
        "minor — inconvenience but no safety or data integrity concern",
        "moderate — significant problem affecting many users, or any safety concern that could cause harm if unresolved",
        "blocking — active danger, active safety hazard, or core functionality completely broken",
      ],
    },
    isSafetyRisk: {
      type: "noul",
      instructions:
        "Does this report describe an actual or imminent physical safety risk to users on the street or transit system? " +
        "Answer YES for: broken glass, flooding, crowd crush, assault, blocked emergency exits, " +
        "no accessibility when needed, dangerous road/path. Answer NO for data accuracy or UI issues.",
    },
  },

  /** Classify search-bar query intent (route_planner vs direct_search),
   *  plus the user's transport-mode preference and whether they need a route.
   *  Hard rules in instructions: origin+dest joined by a travel verb
   *  → ALWAYS route_planner; single place + locator verb → ALWAYS direct_search.
   *  recentHistory is background context — the grammar of the CURRENT query decides. */
  queryIntent: {
    intent: {
      type: "choice",
      instructions:
        "Classify the primary intent of this user query in the HK Tourist app context. " +
        "route_planner = user wants a multi-step journey or directions from A to B. " +
        "direct_search = user wants to find, look up, or navigate to a single place, amenity, or category. " +
        "Hard rules (apply BEFORE weighing examples): " +
        "(1) If the query contains BOTH an origin AND a destination joined by a travel verb " +
        "(English: from X to Y / how to get from A to B / to get to X; " +
        "Simplified: XY / XY / XY / X / X; " +
        "Traditional: XY / X / X / XY) " +
        "→ ALWAYS route_planner, regardless of recentHistory. " +
        "(2) If the query names ONE place/amenity and a locator verb " +
        "(English: where is X / nearest X / find X; " +
        "Simplified: X / X / X; " +
        "Traditional: X / X) " +
        "→ ALWAYS direct_search. " +
        "recentHistory is background context only — the grammar of the CURRENT query decides intent.",
      criteria: {
        route_planner:
          "user explicitly describes a journey or asks for directions: " +
          "'how do I get from A to B', 'how to get there', 'what route', 'plan a trip', " +
          "'from X to Y', 'via', 'transfer at', 'change at', 'how long does it take', " +
          "mentions departure AND destination together, " +
          "or uses Cantonese phrases like: XYX" +
          "X " +
          "Simplified Chinese phrases also count, e.g.: " +
          "XYXYX" +
          "" +
          "X",
        direct_search:
          "user wants to find or look up a single place, amenity, category, or status: " +
          "'where is X', 'nearest X', 'show me X near me', 'find X', " +
          "'X address', 'X opening hours', 'is X open', " +
          "or just types a place name, category, or POI name alone " +
          "(e.g. 'toilets', 'Mong Kok MTR', 'Star Ferry', 'K11', 'café nearby'). " +
          "Cantonese phrases like: XXXX" +
          "XXXX " +
          "Simplified Chinese phrases also count, e.g.: " +
          "XXXXX" +
          "XXXX" +
          "XXXXX" +
          "XXX",
      },
    },
    transport: {
      type: "choice",
      instructions:
        "Which transport mode does the user's query most strongly imply or request? " +
        "Use unspecified only when no mode is hinted at.",
      criteria: {
        mtr:         "user mentions MTR, , any MTR station name or exit, " +
                     "a specific MTR line (Tsuen Wan line, Island line, Kwun Tong line, Tung Chung line, East Rail, West Rail, Airport Express, South Lantau), " +
                     "or Cantonese phrases like MTR (for MTR-style heavy rail). " +
                     "Also: 'which MTR station', 'MTR exit', 'nearest MTR', " +
                     "station names like ",
        bus:         "user mentions bus, , a specific bus route number (e.g. 101, 102, 104, 115, 270A, A21, E21, E11), " +
                     "KMB , Citybus , NWFB , , , " +
                     "green minibus ( Van) or red minibus ( Van), " +
                     "or Cantonese like ",
        taxi:        "user mentions taxi, , Uber, DiDi, call taxi, , , " +
                     "or phrases like 'I want to take a taxi', 'call me a cab'.",
        walk:        "user says walking, on foot, within walking distance, nearby, close, " +
                     "or Cantonese like ",
        ferry:       "user mentions Star Ferry , , cross-harbour ferry, " +
                     "Tsing Yi ferry, ferry terminal, ",
        unspecified: "user query gives no strong hint about preferred transport mode. " +
                     "Only choose this if the query is purely informational or too vague to infer anything.",
      },
    },
    needsRoute: {
      type: "noul",
      instructions:
        "Does this query describe or imply travelling from an origin to a destination, " +
        "even if one endpoint is implicit (e.g. 'nearest MTR' implies routing from current location to the nearest MTR station)? " +
        "Answer yes if the user wants to go somewhere, even vaguely.",
    },
  },

  /**
   * Decide which HK Tourist app function the user wants to use.
   *
   * The app exposes five surfaces from the search bar:
   *   - `toilets`   → /toilets        (barrier-free public-toilet finder)
   *   - 6 transport sub-modes (mtr / bus / taxi / walk / ferry / unspecified)
   *                     → /bus-stops    (mode-specific lookup; refined by
   *                                    the post-Laya `applyAppFunctionRule`
   *                                    using the `queryIntent.transport`
   *                                    6-way verdict — if Laya still picks
   *                                    generic "transport" we override)
   *   - `planner`   → /trip-planner   (AI itinerary planning chat)
   *   - `search`    → general place search (attractions, landmarks, POIs)
   *   - `home`      → /               (open the home map for browsing)
   *
   * Returns a per-function probability distribution. The SearchBar UI uses
   * `probabilities[poiType]` as a per-result relevance %, then sorts the
   * unified result list so the highest-confidence rows surface first.
   *
   * Hard rules (apply BEFORE weighing examples):
   *   1. Toilet keywords → ALWAYS toilets, regardless of other words.
   *      English "toilet / restroom / washroom / bathroom";
   *      Cantonese 廁所 / 洗手間; Simplified 厕所 / 卫生间.
   *   2. Transport-only keywords with no place name → transport
   *      (e.g. "MTR", "bus", "的士", "渡輪").
   *   3. Trip-planning phrases → ALWAYS planner
   *      (e.g. "plan a trip", "itinerary", "一日遊", "行程").
   * recentHistory is background context only — the grammar of the CURRENT
   * query decides function.
   */
  appFunction: {
    function: {
      type: "choice",
      instructions:
        "Which HK Tourist app function best matches the user's CURRENT query? " +
        "The app has NINE reachable surfaces from the search bar: " +
        "(1) toilets — public toilet finder (barrier-free supported), " +
        "(2) mtr — MTR / subway station lookup, " +
        "(3) bus — bus stop / terminus lookup (including minibus), " +
        "(4) taxi — taxi stand / rank lookup, " +
        "(5) walk — find a walking-distance destination, " +
        "(6) ferry — ferry pier / terminal lookup, " +
        "(7) unspecified — transport-related but no specific mode, " +
        "(8) planner — AI itinerary planning chat for multi-step trips, " +
        "(9) search — general place / attraction / landmark search, " +
        "(10) home — open the home map for browsing. " +
        "Note: the six transport sub-modes (2-7) are functionally equivalent — " +
        "they all route the user to the /bus-stops page with a mode-specific " +
        "filter chip pre-selected. Choose the sub-mode that best matches the " +
        "user's wording. " +
        "Hard rules (apply BEFORE weighing examples): " +
        "(A) Toilet keywords alone → ALWAYS toilets. Toilet keywords include " +
        "English 'toilet / restroom / washroom / bathroom / WC / loo'; " +
        "Cantonese 廁所 / 洗手間 / 衛生間; Simplified 厕所 / 卫生间 / 洗手间. " +
        "Barrier-free / accessibility hints (wheelchair, 無障礙, 无障碍) boost toilets when present. " +
        "(B) Trip-planning phrases alone → ALWAYS planner. Phrases include " +
        "English 'plan a trip / plan a day / itinerary / day trip / schedule'; " +
        "Cantonese 行程 / 一日遊 / 半日遊 / 旅遊路線 / 計劃行程; " +
        "Simplified 行程 / 一日游 / 半日游 / 旅游路线 / 计划行程. " +
        "(C) When the query is ONLY a transport-mode keyword (MTR / bus / 巴士 / 的士 / taxi / ferry) " +
        "with no specific place → pick the matching sub-mode (mtr / bus / taxi / ferry). " +
        "When transport is implied but no mode is mentioned, pick `unspecified`. " +
        "(D) When the query names ONE attraction / landmark / building / district (Victoria Peak, Star Ferry, 太平山頂, etc.) → search. " +
        "recentHistory is background context only — the grammar of the CURRENT query decides function.",
      criteria: {
        toilets:
          "user wants to find a public toilet or restroom, possibly barrier-free / wheelchair-accessible. " +
          "Keywords: toilet, restroom, washroom, bathroom, WC, loo, public toilet, accessible toilet, barrier-free toilet, " +
          "Cantonese 廁所, 洗手間, 衛生間, 無障礙廁所; Simplified 厕所, 卫生间, 洗手间, 无障碍厕所.",
        // The single "transport" bucket from the Laya appFunction
        // 5-way choice has been split into 6 sub-modes so the
        // SearchBar can render mode-specific labels (e.g. "搵 MTR
        // 嘅站" instead of generic "搵 {query} 嘅交通站點"). The
        // post-Laya `applyAppFunctionRule` in
        // `src/app/api/laya/intent/route.js` refines a generic
        // "transport" pick into the specific mode using the
        // existing `queryIntent.transport` 6-way answer, so the
        // downstream choice is always one of these 6 keys.
        mtr:
          "user wants to find an MTR / subway station or stop, OR mentions " +
          "an MTR line (Tsuen Wan line, Island line, Kwun Tong line, Tung Chung line, " +
          "East Rail, West Rail, Airport Express, South Lantau), OR names a " +
          "specific MTR station. " +
          "Keywords: MTR station, MTR exit, nearest MTR, subway, metro, " +
          "Cantonese 港鐵站, 港鐵, 地鐵, 車站, 港鐵綫, 地鐵綫; " +
          "Simplified 地铁站, 地铁, 车站.",
        bus:
          "user wants to find a bus stop, OR mentions a specific bus route number " +
          "(e.g. 101, 102, 104, 115, 270A, A21, E21, E11), OR mentions a " +
          "bus operator (KMB, Citybus, NWFB, LWB), OR mentions a green/red minibus. " +
          "Keywords: bus stop, bus station, bus terminus, " +
          "Cantonese 巴士站, 巴士, 小巴; Simplified 公交站, 公交, 巴士.",
        taxi:
          "user wants to find a taxi stand or ranks, OR asks to call a taxi. " +
          "Keywords: taxi stand, taxi rank, Uber, DiDi, call a cab, " +
          "Cantonese 的士站, 的士; Simplified 出租车, 打车.",
        walk:
          "user wants to walk on foot / find a walking-distance destination. " +
          "Keywords: walking, on foot, within walking distance, nearby, close, " +
          "Cantonese 步行, 行路; Simplified 步行, 走路.",
        ferry:
          "user wants to find a ferry pier / terminal, OR mentions a ferry-only " +
          "destination (Cheung Chau, Lantau, Peng Chau, Lamma). " +
          "Keywords: ferry pier, ferry terminal, Star Ferry, cross-harbour ferry, " +
          "Cantonese 渡輪碼頭, 渡輪, 天星小輪; Simplified 渡轮码头, 渡轮.",
        unspecified:
          "user query is transport-related but gives no specific hint about " +
          "preferred mode (e.g. 'find me a transit stop', 'any transport near me'). " +
          "Choose this when transport is clearly the right function but no mode " +
          "can be inferred from the query.",
        planner:
          "user wants to PLAN a multi-stop trip or itinerary, often asking for a schedule / day plan / route recommendation. " +
          "Keywords: plan a trip, plan a day, day trip, itinerary, schedule, multi-stop, route plan, " +
          "Cantonese 行程, 一日遊, 半日遊, 旅遊路線, 計劃行程, 行程規劃; " +
          "Simplified 行程, 一日游, 半日游, 旅游路线, 计划行程, 行程规划.",
        search:
          "user wants to FIND or LOOK UP a single place, attraction, landmark, restaurant, hotel, museum, or POI. " +
          "Keywords: a specific place name (Victoria Peak, Star Ferry, Man Mo Temple), a category (museum, restaurant, cafe), " +
          'or a generic look-up intent \u201cwhere is X\u201d, \u201cnearest X\u201d, \u201cfind X\u201d. ' +
          "Cantonese landmark names (太平山頂, 星光大道, 女人街), " +
          "Simplified landmark names (太平山顶, 星光大道, 女人街).",
        home:
          "user wants to OPEN or return to the home map for casual browsing, or the query is too vague to fit any specific function " +
          "(e.g. greetings, slang, or out-of-scope phrases). Choose home as the catch-all.",
      },
    },
  },
};

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