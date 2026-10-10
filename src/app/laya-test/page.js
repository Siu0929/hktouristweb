"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import {
  Brain,
  Zap,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  X,
  Copy,
  Clock,
  Hash,
  TrendingUp,
  ShieldAlert,
  GitBranch,
  Search,
  Edit3,
  RotateCcw,
} from "lucide-react";

// ─── Preset scenarios ─────────────────────────────────────────────────────────

const PRESETS = [
  {
    id: "ticket",
    label: "Support Ticket Classification",
    description: "Route a user support / issue report to the right team.",
    icon: GitBranch,
    state: {
      subject: "Toilet map marker is in the wrong place",
      body: "The map shows the public toilet at TST Star Ferry Pier in the harbour. It is actually on the concourse above the pier.",
      userId: "u_8821",
      timestamp: "2026-09-22T14:30:00+08:00",
      severity: "moderate",
    },
    questions: {
      category: {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: {
          data:    "incorrect places, wrong descriptions, missing POIs, stale schedules",
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
  },
  {
    id: "poi-ranking",
    label: "POI Relevance Ranking",
    description: "Score a POI result against a user query.",
    icon: TrendingUp,
    state: {
      query: "nearest public toilet with wheelchair access",
      userLocation: { lat: 22.3080, lng: 114.1720 },
      poi: {
        name: "K11 MUSEA — Level B2 Public Toilet",
        category: "mall",
        address: "18 Salisbury Road, Tsim Sha Tsui",
        wheelchairAccess: true,
        distanceMetres: 180,
        openingHours: "10:00–22:00",
        rating: 4.3,
      },
    },
    questions: {
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
  },
  {
    id: "safety",
    label: "Safety Risk Detection",
    description: "Flag a report that may indicate user safety risk.",
    icon: ShieldAlert,
    state: {
      subject: "Broken glass near public toilet entrance",
      body: "There's broken glass all over the ground near the public toilet entrance at Nathan Road near Mong Kok. Someone could get hurt, especially elderly people or children.",
      userId: "u_5591",
      timestamp: "2026-09-22T08:15:00+08:00",
      location: { lat: 22.3183, lng: 114.1698 },
    },
    questions: {
      category: {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: {
          safety:  "injuries, hazards, broken glass, dangerous road conditions",
          data:    "incorrect places, wrong descriptions, missing POIs",
          infra:   "map errors, broken markers, missing POIs, geocoding failures",
          ux:      "ui issues, confusing labels, layout problems",
          content: "missing descriptions, bad translations",
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
  },
  {
    id: "query-intent",
    label: "Query Intent Classification",
    description: "Route a search-bar query: trip planner vs direct POI search.",
    icon: Search,
    state: {
      query: "Best public toilets near Tsim Sha Tsui with wheelchair access",
      userLat: 22.2981,
      userLng: 114.1722,
      locale: "en",
      recentHistory: ["nearest toilet Tsim Sha Tsui", "barrier-free toilet Mong Kok"],
    },
    questions: {
      intent: {
        type: "choice",
        instructions: "What does the user want to do?",
        criteria: {
          trip_planner:
            "user describes a multi-stop journey, asks 'plan a day', 'itinerary', or mentions visiting several places",
          direct_search:
            "user looks up a single place, asks 'where is', 'nearest', 'show me', 'find', or just types a place name or category",
        },
      },
      multilingual: {
        type: "choice",
        instructions: "What language does the user appear to be writing in?",
        criteria: {
          "en": "English",
          "zh-Hans": "Simplified Chinese (简体中文)",
          "zh-Hant": "Traditional Chinese (繁體中文)",
          mixed: "mixed languages, code-switching",
        },
      },
    },
  },
];

// ─── State field editor ───────────────────────────────────────────────────────

/** Flatten a nested state object into dot-pathed leaf fields. */
function flattenState(obj, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenState(value, path));
    } else {
      out.push({
        path,
        type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
        value,
      });
    }
  }
  return out;
}

/** Set a value at a dot-path in an object, cloning along the way. */
function setByPath(obj, path, value) {
  const next = JSON.parse(JSON.stringify(obj));
  const parts = path.split(".");
  const last = parts.pop();
  let cur = next;
  for (const p of parts) {
    cur[p] = cur[p] && typeof cur[p] === "object" && !Array.isArray(cur[p]) ? cur[p] : {};
    cur = cur[p];
  }
  cur[last] = value;
  return next;
}

function stringifyValue(value) {
  return Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
}

function FieldRow({ path, type, value, resetSignal, onChange }) {
  const label = path.split(".").slice(-1)[0];
  // Local "draft" so the user can type freely without committing on every
  // keystroke. We re-derive the draft from props when `path` or `resetSignal`
  // changes — React's documented pattern for syncing state with props during
  // render without an effect (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  const [draft, setDraft] = useState(() => stringifyValue(value));
  const [prevPath, setPrevPath] = useState(path);
  const [prevReset, setPrevReset] = useState(resetSignal);
  if (prevPath !== path || prevReset !== resetSignal) {
    setPrevPath(path);
    setPrevReset(resetSignal);
    setDraft(stringifyValue(value));
  }

  function commit(raw) {
    if (type === "number") {
      const n = Number(raw);
      onChange(Number.isFinite(n) ? n : 0);
    } else if (type === "boolean") {
      onChange(raw === true || raw === "true");
    } else if (type === "array") {
      const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
      onChange(items);
    } else {
      onChange(raw);
    }
  }

  return (
    <label className="block">
      <div className="flex items-center gap-1.5 mb-1">
        <code className="text-[10px] font-mono font-semibold text-zinc-600 bg-zinc-100 px-1.5 py-0.5 rounded">
          {path}
        </code>
        <span className="text-[9px] font-mono text-zinc-400 uppercase">{type}</span>
      </div>
      {type === "boolean" ? (
        <button
          type="button"
          onClick={(e) => commit(e.currentTarget.dataset.val)}
          data-val={(!value).toString()}
          className={`w-full px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
            value
              ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
              : "bg-zinc-50 border-zinc-200 text-zinc-500 hover:bg-zinc-100"
          }`}
        >
          {value ? "true" : "false"}  (click to toggle)
        </button>
      ) : (
        <input
          type={type === "number" ? "number" : "text"}
          step={type === "number" ? "any" : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          className="w-full text-xs border border-zinc-300 rounded-lg px-2.5 py-1.5 bg-white text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-100 transition"
        />
      )}
    </label>
  );
}

function StateEditor({ state, resetSignal, onChange }) {
  const fields = useMemo(() => flattenState(state), [state]);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {fields.map((f) => (
        <FieldRow
          key={f.path}
          path={f.path}
          type={f.type}
          value={f.value}
          resetSignal={resetSignal}
          onChange={(v) => onChange(setByPath(state, f.path, v))}
        />
      ))}
    </div>
  );
}

// ─── Answer renderer ────────────────────────────────────────────────────────────

function ProbabilityBar({ label, value }) {
  const pct = (value * 100).toFixed(1);
  const color = value > 0.5 ? "bg-emerald-500" : value > 0.2 ? "bg-amber-500" : "bg-zinc-300";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="font-medium text-zinc-700">{label}</span>
        <span className="text-zinc-500 font-mono">{pct}%</span>
      </div>
      <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${Math.max(Number(pct), 1)}%` }}
        />
      </div>
    </div>
  );
}

function AnswerBlock({ questionKey, answer }) {
  const [open, setOpen] = useState(true);

  const typeLabel = answer.choice != null ? "choice" : answer.score != null ? "score" : "noul";

  return (
    <div className="border border-zinc-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-zinc-50 transition-colors text-left"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-400 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-semibold text-zinc-900">{questionKey}</code>
            <span className="text-[10px] font-mono font-semibold text-zinc-400 uppercase tracking-wider bg-zinc-100 px-1.5 py-0.5 rounded">
              {typeLabel}
            </span>
          </div>
          {answer.choice != null && (
            <p className="text-xs text-emerald-700 font-semibold mt-0.5">
              → {answer.choice}
            </p>
          )}
          {answer.score != null && (
            <p className="text-xs text-blue-700 font-semibold mt-0.5">
              → score {answer.score.toFixed(4)} (expected level, 0–{answer.distribution?.length ?? "?"})
            </p>
          )}
          {answer.noul != null && (
            <p className="text-xs text-amber-700 font-semibold mt-0.5">
              → P(true) = {answer.noul.toFixed(4)}
            </p>
          )}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 bg-zinc-50 space-y-3">
          {answer.probabilities && (
            <div>
              <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                Probabilities
              </p>
              {Object.entries(answer.probabilities)
                .sort(([, a], [, b]) => b - a)
                .map(([k, v]) => (
                  <ProbabilityBar key={k} label={k} value={v} />
                ))}
            </div>
          )}
          {answer.distribution && (
            <div>
              <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                Distribution (per criteria level)
              </p>
              {answer.distribution.map((p, i) => (
                <ProbabilityBar key={i} label={`level ${i}`} value={p} />
              ))}
            </div>
          )}
          {answer.std != null && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="font-semibold">std:</span>
              <span className="font-mono">{answer.std.toFixed(4)}</span>
            </div>
          )}
          {answer.logProbs != null && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="font-semibold">logProbs:</span>
              <span className="font-mono">{JSON.stringify(answer.logProbs)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LayaTestPage() {
  const [activePreset, setActivePreset] = useState(0);
  const [customState, setCustomState] = useState("");
  const [customQuestions, setCustomQuestions] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [modelWarm, setModelWarm] = useState(false);
  const [editedState, setEditedState] = useState(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const abortRef = useRef(null);

  const preset = PRESETS[activePreset];
  const currentState = editedState ?? preset.state;

  // Reset edits when switching presets. We don't track this in an effect —
  // instead we clear edits whenever the preset selection handler runs.
  const resetEdits = useCallback(() => {
    setEditedState(null);
    setResetSignal((s) => s + 1);
  }, []);

  const selectPreset = useCallback((i) => {
    setActivePreset(i);
    setUseCustom(false);
    setEditedState(null);
    setResult(null);
    setError(null);
  }, []);

  // Warm up the model (GET /api/laya/health)
  const warmup = useCallback(async () => {
    setModelWarm(false);
    try {
      const res = await fetch("/api/laya/health");
      if (res.ok) setModelWarm(true);
    } catch {
      // ignore
    }
  }, []);

  // Run inference
  const runInference = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setResult(null);
    setElapsedMs(null);

    let state, questions;
    if (useCustom) {
      try {
        state = JSON.parse(customState || "{}");
        questions = JSON.parse(customQuestions || "{}");
      } catch (e) {
        setError(`JSON parse error: ${e.message}`);
        setLoading(false);
        return;
      }
    } else {
      state = currentState;
      questions = preset.questions;
    }

    const t0 = Date.now();
    try {
      const res = await fetch("/api/laya", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, questions }),
        signal: controller.signal,
      });
      const ms = Date.now() - t0;
      setElapsedMs(ms);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.detail ?? `HTTP ${res.status}`);
        return;
      }

      const data = await res.json();
      setResult(data);
      setModelWarm(true);
      setHistory((h) => [
        { preset: useCustom ? "custom" : preset.id, state, questions, result: data, ms },
        ...h.slice(0, 19),
      ]);
    } catch (e) {
      if (e.name !== "AbortError") {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, [preset, useCustom, customState, customQuestions, currentState]);

  const copyResult = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [result]);

  const isDirty = editedState !== null && JSON.stringify(editedState) !== JSON.stringify(preset.state);

  return (
    <div className="min-h-dvh bg-zinc-50 flex flex-col">
      {/* Header */}
      <header className="shrink-0 bg-white border-b border-zinc-200 px-4 py-3 flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center justify-center w-8 h-8 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 transition-colors"
        >
          <ChevronDown className="w-4 h-4 rotate-90" />
        </Link>
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-violet-600" />
          <h1 className="text-sm font-bold text-zinc-900">Laya Decision Model — Test Console</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {modelWarm ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              Model warm
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-zinc-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Model cold
            </span>
          )}
          <button
            onClick={warmup}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors"
            title="Warm up the model (runs a health check)"
          >
            <RefreshCw className="w-3 h-3" />
            Warmup
          </button>
          {history.length > 0 && (
            <button
              onClick={() => setShowHistory((s) => !s)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors"
            >
              History ({history.length})
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left panel — scenario config */}
        <aside className="w-80 shrink-0 border-r border-zinc-200 bg-white flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-200">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
              Scenarios
            </p>
            <div className="space-y-1.5">
              {PRESETS.map((p, i) => {
                const Icon = p.icon;
                return (
                  <button
                    key={p.id}
                    onClick={() => selectPreset(i)}
                    className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-left transition-all ${
                      !useCustom && activePreset === i
                        ? "bg-violet-50 border border-violet-200 text-violet-900"
                        : "border border-transparent text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${
                      !useCustom && activePreset === i ? "text-violet-600" : "text-zinc-400"
                    }`} />
                    <div>
                      <p className="text-xs font-semibold leading-tight">{p.label}</p>
                      <p className="text-[10px] text-zinc-400 mt-0.5 leading-snug">{p.description}</p>
                    </div>
                  </button>
                );
              })}
              <button
                onClick={() => {
                  setUseCustom(true);
                  setResult(null);
                  setError(null);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-all text-xs font-semibold ${
                  useCustom
                    ? "bg-violet-50 border border-violet-200 text-violet-900"
                    : "border border-dashed border-zinc-300 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700"
                }`}
              >
                <Zap className={`w-4 h-4 shrink-0 ${useCustom ? "text-violet-600" : "text-zinc-300"}`} />
                Custom state + questions
              </button>
            </div>
          </div>

          {useCustom && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-600 mb-1.5">
                  State (JSON)
                </label>
                <textarea
                  value={customState}
                  onChange={(e) => setCustomState(e.target.value)}
                  rows={6}
                  placeholder='{ "query": "...", "userId": "u_123" }'
                  className="w-full font-mono text-xs border border-zinc-300 rounded-lg p-2.5 bg-zinc-50 text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:border-violet-400 resize-y"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-600 mb-1.5">
                  Questions (JSON)
                </label>
                <textarea
                  value={customQuestions}
                  onChange={(e) => setCustomQuestions(e.target.value)}
                  rows={8}
                  placeholder={`{
  "intent": {
    "type": "choice",
    "instructions": "...",
    "criteria": { "opt1": "...", "opt2": "..." }
  }
}`}
                  className="w-full font-mono text-xs border border-zinc-300 rounded-lg p-2.5 bg-zinc-50 text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:border-violet-400 resize-y"
                />
              </div>
            </div>
          )}

          {!useCustom && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              <div>
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                  Questions (read-only)
                </p>
                <pre className="font-mono text-[10px] text-zinc-700 bg-zinc-50 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-all border border-zinc-100">
                  {JSON.stringify(preset.questions, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </aside>

        {/* Right panel — results */}
        <main className="flex-1 min-h-0 overflow-y-auto">
          {/* Run button bar */}
          <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm border-b border-zinc-200 px-6 py-3 flex items-center gap-3 flex-wrap">
            <button
              onClick={runInference}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white text-sm font-semibold rounded-lg transition-colors disabled:cursor-not-allowed shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Brain className="w-4 h-4" />
                  Run Laya Inference
                </>
              )}
            </button>
            {loading && (
              <button
                onClick={() => { if (abortRef.current) abortRef.current.abort(); }}
                className="flex items-center gap-1.5 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-800 border border-zinc-200 rounded-lg transition-colors"
              >
                <X className="w-3 h-3" />
                Cancel
              </button>
            )}
            {elapsedMs != null && (
              <span className="flex items-center gap-1 text-xs text-zinc-400">
                <Clock className="w-3 h-3" />
                {elapsedMs} ms
              </span>
            )}
            {result?.usage && (
              <span className="flex items-center gap-1 text-xs text-zinc-400">
                <Hash className="w-3 h-3" />
                {result.usage.input_tokens} in / {result.usage.generation_tokens} out
              </span>
            )}
          </div>

          {/* Inputs modifier */}
          {!useCustom && (
            <section className="px-6 pt-5 pb-2">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Edit3 className="w-4 h-4 text-violet-600" />
                  <h2 className="text-sm font-bold text-zinc-900">Inputs</h2>
                  <span className="text-[10px] font-mono text-zinc-400 uppercase">
                    edit any field — Run uses the modified state
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {isDirty && (
                    <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                      modified
                    </span>
                  )}
                  <button
                    onClick={() => setShowRawJson((s) => !s)}
                    className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 border border-zinc-200 rounded-lg px-2.5 py-1 transition-colors"
                  >
                    {showRawJson ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    JSON
                  </button>
                  {isDirty && (
                    <button
                      onClick={resetEdits}
                      className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 border border-zinc-200 rounded-lg px-2.5 py-1 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset
                    </button>
                  )}
                </div>
              </div>
              <StateEditor state={currentState} resetSignal={resetSignal} onChange={setEditedState} />
              {showRawJson && (
                <pre className="mt-3 font-mono text-[10px] text-zinc-700 bg-zinc-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all border border-zinc-200">
                  {JSON.stringify(currentState, null, 2)}
                </pre>
              )}
            </section>
          )}

          {/* Error */}
          {error && (
            <div className="mx-6 mt-4 flex items-start gap-2.5 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Inference failed</p>
                <p className="text-xs text-red-600 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* Result */}
          {result && !error && (
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <p className="text-sm font-semibold text-zinc-900">Decision result</p>
                </div>
                <button
                  onClick={copyResult}
                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800 border border-zinc-200 rounded-lg px-2.5 py-1.5 transition-colors"
                >
                  {copied ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                  {copied ? "Copied!" : "Copy JSON"}
                </button>
              </div>

              {result.answers && (
                <div className="space-y-2">
                  {Object.entries(result.answers).map(([k, v]) => (
                    <AnswerBlock key={k} questionKey={k} answer={v} />
                  ))}
                </div>
              )}

              {result.usage && (
                <div className="flex flex-wrap gap-4 text-xs text-zinc-500 bg-zinc-50 border border-zinc-100 rounded-xl px-4 py-3">
                  <span>
                    <strong className="text-zinc-700">Input tokens:</strong>{" "}
                    {result.usage.input_tokens}
                  </span>
                  {result.usage.generation_tokens != null && (
                    <span>
                      <strong className="text-zinc-700">Generation tokens:</strong>{" "}
                      {result.usage.generation_tokens}
                    </span>
                  )}
                  {result.usage.total_tokens != null && (
                    <span>
                      <strong className="text-zinc-700">Total tokens:</strong>{" "}
                      {result.usage.total_tokens}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!result && !error && !loading && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Brain className="w-12 h-12 text-zinc-200 mb-4" />
              <p className="text-sm font-semibold text-zinc-500">No result yet</p>
              <p className="text-xs text-zinc-400 mt-1 max-w-xs">
                Edit the inputs above and click <strong>Run Laya Inference</strong> to get
                calibrated decisions from the Laya decision model.
              </p>
            </div>
          )}
        </main>

        {/* History sidebar */}
        {showHistory && history.length > 0 && (
          <aside className="w-72 shrink-0 border-l border-zinc-200 bg-white flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-200 flex items-center justify-between">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                History
              </p>
              <button
                onClick={() => setShowHistory(false)}
                className="text-zinc-400 hover:text-zinc-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {history.map((h, i) => (
                <button
                  key={i}
                  onClick={() => {
                    if (h.preset === "custom") {
                      setUseCustom(true);
                      setCustomState(JSON.stringify(h.state, null, 2));
                      setCustomQuestions(JSON.stringify(h.questions, null, 2));
                    } else {
                      setUseCustom(false);
                      setActivePreset(PRESETS.findIndex((p) => p.id === h.preset));
                      setEditedState(h.state);
                    }
                    setResult(h.result);
                    setElapsedMs(h.ms);
                    setShowHistory(false);
                  }}
                  className="w-full text-left p-3 border border-zinc-100 rounded-lg hover:border-zinc-300 hover:bg-zinc-50 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-zinc-700">
                      {h.preset === "custom" ? "Custom" : PRESETS.find((p) => p.id === h.preset)?.label ?? h.preset}
                    </span>
                    <span className="text-[10px] text-zinc-400">{h.ms} ms</span>
                  </div>
                  <p className="text-[10px] text-zinc-400 truncate font-mono">
                    {Object.keys(h.result?.answers ?? {}).join(", ")}
                  </p>
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
