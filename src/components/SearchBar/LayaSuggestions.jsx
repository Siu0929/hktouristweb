"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Toilet,
  Bus,
  Route,
  Home,
  TrainFront,
  CarTaxiFront,
  Footprints,
  Ship,
} from "lucide-react";

// LAYA-ranked search actions surfaced in the SearchBar dropdown.
// `id` matches the keys in `appFunction.choice` from the Laya verdict
// (post-rule; the 6 transport sub-modes mirror `queryIntent.transport`
// so the SearchBar can render mode-specific labels like "搵 MTR 嘅站").
// `iconKey` picks the lucide-react icon used in the chip. `filterKey`
// is the home-page chip to pre-select on click; `null` means "leave
// the chip selection alone and let the home map text filter handle it"
// — used for district/place queries where the user wants to see
// everything matching the query text, not a single category.
//
// Note: the rendered dropdown only ever shows ONE button — the top
// Laya pick — to avoid the ambiguous "Bus toilets / Bus bus stops"
// menu. This registry is just a lookup table keyed by `id`.
const FUNCTION_BUTTON_KEYS = [
  { id: "toilets",     iconKey: "toilet",  filterKey: "toilets" },
  // 6 transport sub-modes. mtr / bus / taxi have a matching home-page
  // chip; walk / ferry / unspecified fall back to no chip (text filter).
  { id: "mtr",         iconKey: "train",   filterKey: "mtr" },
  { id: "bus",         iconKey: "bus",     filterKey: "bus" },
  { id: "taxi",        iconKey: "taxi",    filterKey: "taxi" },
  { id: "walk",        iconKey: "foot",    filterKey: null },
  { id: "ferry",       iconKey: "ship",    filterKey: null },
  { id: "unspecified", iconKey: "bus",     filterKey: null },
  { id: "planner",     iconKey: "route",   filterKey: null },
  { id: "search",      iconKey: "home",    filterKey: null },
  { id: "home",        iconKey: "home",    filterKey: null },
];

const FUNCTION_ICONS = {
  toilet: Toilet,
  bus: Bus,
  train: TrainFront,
  taxi: CarTaxiFront,
  foot: Footprints,
  ship: Ship,
  route: Route,
  home: Home,
};

/**
 * Build the click-time home-page filter for a Laya function choice.
 *   - toilets            → "toilets" (home page chip exists)
 *   - mtr / bus / taxi   → matching chip (home page has dedicated chips)
 *   - walk / ferry / unspecified → null (no chip; let text filter handle it)
 *   - planner / search / home → null (no chip; user picks manually)
 */
function filterForButton(btnId /* , queryType, query */) {
  if (btnId === "toilets") return "toilets";
  if (btnId === "mtr" || btnId === "bus" || btnId === "taxi") return btnId;
  return null;
}

/**
 * True when the query is exactly a mode keyword for the given
 * functionChoice. Used to suppress the `{query}` interpolation in
 * the button label so "MTR" + `mtr` choice doesn't render as
 * "搵 MTR 嘅 MTR 站" (redundant). For place names ("元朗") the
 * interpolation stays so we get "搵元朗嘅 MTR 站".
 */
function isBareModeKeyword(query, mode) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return false;
  const BARE = {
    mtr:   /^(mtr|港鐵|港铁|地鐵|地铁|subway|metro)$/i,
    bus:   /^(bus|巴士|公交|minibus|小巴)$/i,
    taxi:  /^(taxi|的士|uber|didi|出租車|出租车|計程車|计程车)$/i,
    ferry: /^(ferry|渡輪|渡轮|渡船|天星小輪|天星小轮|star\s+ferry)$/i,
  };
  return BARE[mode]?.test(q) ?? false;
}

/**
 * Build a contextual button label that reads naturally for the user's
 * intent. The label template is selected by (functionChoice, queryType).
 *
 *   functionChoice = "toilets"
 *     district/place → "搵 {query} 嘅公廁"        (Find toilets IN {query})
 *     route/other    → "搵 {query} 附近嘅公廁"    (Find toilets NEAR {query})
 *   functionChoice = "mtr"          → "搵 MTR 站"         (Find MTR stops)
 *                                     (with "{query} 嘅" prefix when the
 *                                      query is a place name, e.g.
 *                                      "搵元朗嘅 MTR 站")
 *   functionChoice = "bus"          → "搵巴士站"
 *   functionChoice = "taxi"         → "搵的士站"
 *   functionChoice = "walk"         → "搵步行路線"
 *   functionChoice = "ferry"        → "搵渡輪碼頭"
 *   functionChoice = "unspecified"  → "搵 {query} 嘅交通站點"  (generic fallback)
 *   functionChoice = "planner"      → "規劃 {query} 嘅行程"   (Plan {query} itinerary)
 *   functionChoice = "search" / "home" → "喺地圖上搵 {query}" (Show {query} on the map)
 *
 * The key is to never let Laya force a button that doesn't fit the
 * query — e.g. user types "Bus", Laya picks `bus`, label says
 * "搵巴士站" (Find Bus stops), not "搵 Bus 嘅公廁".
 */
function buildButtonLabel(query, queryType, functionChoice, t) {
  const q = (query ?? "").trim() || "—";
  const isPlaceContext = queryType === "district" || queryType === "place";
  switch (functionChoice) {
    case "toilets":
      if (isPlaceContext) {
        return t("functionActionToiletsIn", { query: q });
      }
      return t("functionActionToiletsNear", { query: q });
    case "mtr":
      if (isPlaceContext) {
        return t("functionActionTransportMtrIn", { query: q });
      }
      if (isBareModeKeyword(query, "mtr")) {
        return t("functionActionTransportMtr");
      }
      return t("functionActionTransportMtr", { query: q });
    case "bus":
      if (isPlaceContext) {
        return t("functionActionTransportBusIn", { query: q });
      }
      if (isBareModeKeyword(query, "bus")) {
        return t("functionActionTransportBus");
      }
      return t("functionActionTransportBus", { query: q });
    case "taxi":
      if (isPlaceContext) {
        return t("functionActionTransportTaxiIn", { query: q });
      }
      if (isBareModeKeyword(query, "taxi")) {
        return t("functionActionTransportTaxi");
      }
      return t("functionActionTransportTaxi", { query: q });
    case "walk":
      return t("functionActionTransportWalk", { query: q });
    case "ferry":
      if (isPlaceContext) {
        return t("functionActionTransportFerryIn", { query: q });
      }
      if (isBareModeKeyword(query, "ferry")) {
        return t("functionActionTransportFerry");
      }
      return t("functionActionTransportFerry", { query: q });
    case "unspecified":
      if (isPlaceContext) {
        return t("functionActionTransportIn", { query: q });
      }
      if (queryType === "route") {
        return t("functionActionTransportRoute", { query: q });
      }
      return t("functionActionTransportNear", { query: q });
    case "planner":
      return t("functionActionPlanner", { query: q });
    case "search":
    case "home":
    default:
      return t("functionActionHome", { query: q });
  }
}

/**
 * Fetch the Laya verdict for the current query.
 *
 * Server-side only (Laya uses onnxruntime-node), so we hit /api/laya/intent.
 * Longer debounce than the main search because the model is heavier: first
 * call takes ~10s to load weights, subsequent calls ~140ms. Failures are
 * silent — the SearchBar falls back to the natural type/distance order.
 *
 * Returns `{ layaVerdict, appFnProbs, appFunctionChoice, queryType }`:
 *   - `appFnProbs` is a convenience shortcut for the 5-bucket
 *     `appFunction.probabilities` dict; used by `itemConfidence` to
 *     rank search results by Laya's per-function confidence.
 *   - `appFunctionChoice` is the post-rule `appFunction.choice`,
 *     which can be one of 10 keys: toilets, mtr, bus, taxi, walk,
 *     ferry, unspecified, planner, search, home. The SearchBar
 *     uses this to render a mode-specific label.
 *   - `queryType` is the post-rule classifier output (district /
 *     transportMode / route / place / empty).
 */
export function useLayaVerdict({ query, locale, userLocation, recentSearches }) {
  const [layaVerdict, setLayaVerdict] = useState(null);
  const [layaLoading, setLayaLoading] = useState(false);
  const layaAbortRef = useRef(null);
  const debounceTimerRef = useRef(null);

  useEffect(() => {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      setLayaVerdict(null);
      setLayaLoading(false);
      if (layaAbortRef.current) layaAbortRef.current.abort();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      return;
    }

    // Cancel any in-flight request + debounce when query changes
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (layaAbortRef.current) layaAbortRef.current.abort();
    setLayaLoading(false);

    debounceTimerRef.current = setTimeout(async () => {
      setLayaLoading(true);
      const controller = new AbortController();
      layaAbortRef.current = controller;
      try {
        const res = await fetch("/api/laya/intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: trimmed,
            locale,
            userLocation: userLocation
              ? { lat: userLocation.lat, lng: userLocation.lng }
              : null,
            recentHistory: recentSearches.slice(0, 5),
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (!data.error) setLayaVerdict(data);
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          console.warn("[Laya verdict] failed:", err?.message ?? err);
        }
      } finally {
        // Only clear loading if this is still the latest request
        if (layaAbortRef.current === controller) {
          setLayaLoading(false);
        }
      }
    }, 700);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [query, locale, userLocation, recentSearches]);

  return {
    layaVerdict,
    layaLoading,
    appFnProbs: layaVerdict?.appFunction?.probabilities ?? null,
    appFunctionChoice: layaVerdict?.appFunction?.choice ?? null,
    queryType: layaVerdict?.queryType ?? "empty",
  };
}

/**
 * Per-item confidence derived from the Laya appFunction verdict.
 * Maps the result's POI type to the Laya app function that owns it
 * and reads that function's probability from the verdict.
 *
 * The 5-bucket `appFunction.probabilities` (toilets / transport /
 * planner / search / home) is used here for ranking; the 6-way
 * transport-mode split is consulted for the SEARCH BUTTON label
 * but not for the per-result confidence — transport POIs all share
 * the "transport" bucket so the sort stays stable across modes.
 *
 * Returns null when no verdict yet, so the UI hides the % badge and
 * keeps the original type/distance sort. Returns a 0..1 number otherwise.
 *
 * Defaults to `search` for unknown POI types so an unrecognised result
 * still surfaces rather than vanishing from the ranked list.
 */
export function itemConfidence(item, appFnProbs) {
  if (!appFnProbs || typeof appFnProbs !== "object") return null;
  // POI-type → Laya app-function. Unknown types fall through to `search`.
  let fn;
  switch (item.poiType) {
    case "toilet": fn = "toilets"; break;
    case "bus":
    case "train":
    case "taxi":
    case "tram":
    case "ferry-pier":
    case "mtr-rail":
    case "minibus": fn = "transport"; break;
    case "attraction": fn = "search"; break;
    default: fn = "search";
  }
  const raw = appFnProbs[fn];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Dropdown section that renders the single Laya-ranked search-action
 * button. Shows ONLY the top Laya function pick — never the full
 * menu — so the dropdown isn't flooded with irrelevant alternatives
 * like "搵過 Bus 的公廁" when the user typed "Bus".
 *
 * The button is selected by the post-rule `appFunctionChoice` (one
 * of 10 keys: toilets / mtr / bus / taxi / walk / ferry / unspecified
 * / planner / search / home), and the label is built from
 * `query` + `queryType` + `appFunctionChoice` via buildButtonLabel(),
 * giving natural Cantonese/English templates (e.g. "搵 MTR 嘅站",
 * "Show MTR stops near Mong Kok", "搵元朗嘅交通站點").
 *
 * Returns null until the verdict arrives so the section gracefully
 * disappears on first paint or when the query is empty.
 *
 * Clicking pushes `/?q=<query>&filter=<chipKey>` so the home page
 * picks up the search and pans/centers the map. `onPick()` is
 * invoked just before the navigation so SearchBar can persist the
 * query as a recent search and close the dropdown.
 */
export function LayaSuggestions({ appFunctionChoice, queryType, layaLoading, t, query, onPick }) {
  const router = useRouter();

  // Look up the icon / filter for the post-rule Laya choice.
  const primary = useMemo(() => {
    if (!appFunctionChoice) return null;
    const btn = FUNCTION_BUTTON_KEYS.find((b) => b.id === appFunctionChoice);
    if (!btn) return null;
    const Icon = FUNCTION_ICONS[btn.iconKey];
    if (!Icon) return null;
    return { ...btn, Icon };
  }, [appFunctionChoice]);

  // Loading: show pulsing dots while Laya is thinking (debounce + fetch).
  // Once verdict arrives, layaLoading goes false and primary gets set.
  if (layaLoading && !primary) {
    return (
      <div className="px-3 py-2.5 flex items-center gap-2">
        <div className="flex gap-1">
          <span className="block w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="block w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "160ms" }} />
          <span className="block w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "320ms" }} />
        </div>
        <span className="text-xs text-zinc-400">分析緊…</span>
      </div>
    );
  }

  if (!primary) return null;

  const handlePick = () => {
    const trimmed = (query ?? "").trim();
    if (!trimmed) return;
    // Let SearchBar close the dropdown + persist the recent search first.
    onPick?.();
    const params = new URLSearchParams({ q: trimmed });
    const filter = filterForButton(primary.id);
    if (filter) params.set("filter", filter);
    router.push(`/?${params.toString()}`);
  };

  const label = buildButtonLabel(query, queryType, primary.id, t);

  return (
    <div>
      <button
        type="button"
        onClick={handlePick}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left transition hover:bg-violet-50"
        role="option"
        aria-selected="false"
      >
        <div className="w-8 h-8 text-violet-700 flex items-center justify-center shrink-0">
          <primary.Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-800 truncate">
            {label}
          </div>
        </div>
      </button>
    </div>
  );
}
