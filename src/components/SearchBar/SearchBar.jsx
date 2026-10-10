"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Toilet,
  Bus,
  TrainFront,
  CarTaxiFront,
  MapPin,
  X,
  Loader2,
  Accessibility,
  Sparkles,
  History,
} from "lucide-react";
import { useLocale, useTranslations } from "@/contexts/LocaleContext";
import { detectCategoryQuery } from "@/lib/searchCategories";
import {
  useLayaVerdict,
  itemConfidence,
  LayaSuggestions,
} from "@/components/SearchBar/LayaSuggestions";

const TYPE_CONFIG = {
  toilet: { icon: Toilet, color: "#0F766E", label: "Toilets" },
  bus: { icon: Bus, color: "#1E40AF", label: "Bus" },
  train: { icon: TrainFront, color: "#1E40AF", label: "MTR" },
  taxi: { icon: CarTaxiFront, color: "#1E40AF", label: "Taxi" },
  attraction: { icon: MapPin, color: "#C2410C", label: "Attractions" },
};

const TYPE_ORDER = ["attraction", "toilet", "bus", "train", "taxi"];

const RECENT_SEARCHES_KEY = "hktourist:recent-searches";
const MAX_RECENT_SEARCHES = 5;

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readRecentSearches() {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_SEARCHES) : [];
  } catch {
    return [];
  }
}

function writeRecentSearches(searches) {
  if (!isBrowser()) return;
  try {
    const trimmed = [...searches].slice(0, MAX_RECENT_SEARCHES);
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage may be full or disabled — fail silently.
  }
}

function addRecentSearch(term) {
  const trimmed = term.trim();
  if (!trimmed) return;
  const current = readRecentSearches().filter((s) => s !== trimmed);
  writeRecentSearches([trimmed, ...current]);
}

function clearRecentSearches() {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(RECENT_SEARCHES_KEY);
  } catch {
    // ignore
  }
}

export default function SearchBar({
  query: externalQuery,
  onQueryChange,
  userLocation,
  onSelect,
  onResults,
  placeholder = "Search places...",
  className = "",
  autoFocus = false,
}) {
  const t = useTranslations("search");
  const { locale } = useLocale();
  const [internalQuery, setInternalQuery] = useState(externalQuery ?? "");
  const query = externalQuery ?? internalQuery;
  const setQuery = onQueryChange ?? setInternalQuery;
  const [activeTypes] = useState(new Set(TYPE_ORDER));
  const [results, setResults] = useState(null);
  const [recommended, setRecommended] = useState(null);
  const [categorySearch, setCategorySearch] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const abortRef = useRef(null);
  const [recentSearches, setRecentSearches] = useState([]);

  // Laya verdict — owned by LayaSuggestions; we just consume the
  // appFunction probabilities here to sort the search-result list,
  // and the appFunctionChoice + queryType for the Laya button label.
  const { layaLoading, appFnProbs, appFunctionChoice, queryType } = useLayaVerdict({
    query,
    locale,
    userLocation,
    recentSearches,
  });

  // Load recent searches on mount and whenever dropdown opens
  const loadRecentSearches = useCallback(() => {
    setRecentSearches(readRecentSearches());
  }, []);

  useEffect(() => {
    loadRecentSearches();
  }, [loadRecentSearches]);

  const search = useCallback(
    async (keyword, types) => {
      if (!keyword.trim()) {
        setResults(null);
        setRecommended(null);
        setCategorySearch(null);
        setIsLoading(false);
        onResults?.(null);
        return;
      }

      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

      setIsLoading(true);
      try {
        const detection = detectCategoryQuery(keyword, locale);
        setCategorySearch(detection.isCategory ? detection.category : null);

        if (detection.isCategory && userLocation) {
          const params = new URLSearchParams({
            q: keyword,
            category: detection.category,
            types: [...types].join(","),
            limit: "10",
            locale,
            lat: String(userLocation.lat),
            lon: String(userLocation.lng),
          });

          const response = await fetch(`/api/search?${params}`, {
            signal: abortRef.current.signal,
          });
          if (response.ok) {
            const data = await response.json();
            const catResults = data.results?.[detection.category] ?? [];
            setRecommended(catResults.slice(0, 8));
            setResults(data.results);
            onResults?.(data);
          }
        } else {
          setRecommended(null);
          const params = new URLSearchParams({
            q: keyword,
            types: [...types].join(","),
            limit: "15",
            locale,
            ...(userLocation
              ? { lat: String(userLocation.lat), lon: String(userLocation.lng) }
              : {}),
          });

          const response = await fetch(`/api/search?${params}`, {
            signal: abortRef.current.signal,
          });
          if (response.ok) {
            const data = await response.json();
            setResults(data.results);
            onResults?.(data);
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("Search failed:", err);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [locale, userLocation]
  );

  const debouncedSearch = useRef(debounce(search, 300)).current;

  useEffect(() => {
    if (externalQuery !== undefined) {
      setInternalQuery(externalQuery);
    }
  }, [externalQuery]);

  useEffect(() => {
    if (query) {
      debouncedSearch(query, activeTypes);
    } else {
      setResults(null);
      setRecommended(null);
      setCategorySearch(null);
      setIsLoading(false);
    }
  }, [query, activeTypes, debouncedSearch]);

  // ─── Laya verdict lives in LayaSuggestions — this file just consumes ───
  // its `appFnProbs` to sort flatResults. Dropdown UI for the four function
  // buttons is also rendered by LayaSuggestions (see <LayaSuggestions/> below).

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [results]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = useCallback(
    (e) => {
      if (!isOpen) return;

      // Recent searches keyboard navigation (when no query typed)
      if (!query && hasRecent) {
        const recentLen = recentSearches.length;
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setHighlightedIndex((i) => Math.min(i + 1, recentLen - 1));
            break;
          case "ArrowUp":
            e.preventDefault();
            setHighlightedIndex((i) => Math.max(i - 1, -1));
            break;
          case "Enter":
            e.preventDefault();
            if (highlightedIndex >= 0 && recentSearches[highlightedIndex]) {
              const term = recentSearches[highlightedIndex];
              setQuery(term);
              setIsOpen(true);
            }
            break;
          case "Escape":
            setIsOpen(false);
            inputRef.current?.blur();
            break;
        }
        return;
      }

      // Results keyboard navigation — mirrors the UI's actual rendering order
      // (recommended section first, then ranked search results). Reconstructs
      // the flat list from raw state so this callback can live before the
      // useMemo definitions of flatResults / rankedResults.
      const recommendedIds = new Set((recommended ?? []).map((r) => r.id));
      const rankedRaw = (results ? getFlatResults(results, activeTypes, recommended) : []).filter(
        (item) => !recommendedIds.has(item.id)
      );
      const flat = hasRecommended
        ? [
            ...recommended.map((item) => ({ ...item, poiType: categorySearch })),
            ...rankedRaw,
          ]
        : rankedRaw;
      if (flat.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((i) => Math.min(i + 1, flat.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((i) => Math.max(i - 1, -1));
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0 && flat[highlightedIndex]) {
            handleSelect(flat[highlightedIndex]);
          }
          break;
        case "Escape":
          setIsOpen(false);
          inputRef.current?.blur();
          break;
      }
    },
    [isOpen, results, activeTypes, recommended, categorySearch, highlightedIndex, recentSearches]
  );

  const handleSelect = (item) => {
    onSelect?.(item);
    if (!onQueryChange) {
      setQuery("");
    }
    setResults(null);
    setRecommended(null);
    setCategorySearch(null);
    setIsOpen(false);
    // Save search term to recent searches
    if (query.trim()) addRecentSearch(query.trim());
    loadRecentSearches();
    inputRef.current?.focus();
  };

  // ── Laya helper (itemConfidence) lives in ──
  // ── LayaSuggestions — we just call it below to sort flatResults. ──

  function getFlatResults(resultsMap, activeTypesSet, recommendedItems) {
    const items = [];
    if (recommendedItems && recommendedItems.length > 0) {
      for (const item of recommendedItems) {
        items.push({ ...item, poiType: categorySearch });
      }
    }
    for (const type of TYPE_ORDER) {
      if (!activeTypesSet.has(type)) continue;
      if (type === categorySearch && recommendedItems?.length > 0) continue;
      const typeResults = resultsMap?.[type] ?? [];
      for (const item of typeResults) {
        items.push({ ...item, poiType: type });
      }
    }
    return items;
  }

  // Sort flatResults by Laya appFunction confidence (desc) when we have a
  // verdict, so the function the user most likely wants sits at the top of the
  // list. Items without a confidence fall back to their natural type/distance
  // order at the bottom.
  const flatResults = useMemo(() => {
    const list = results ? getFlatResults(results, activeTypes, recommended) : [];
    if (!appFnProbs) return list;
    return list
      .map((item) => ({ item, conf: itemConfidence(item, appFnProbs) }))
      .sort((a, b) => {
        // Both have confidence → high first
        if (a.conf != null && b.conf != null) return b.conf - a.conf;
        // Only one has confidence → it wins
        if (a.conf != null) return -1;
        if (b.conf != null) return 1;
        // Neither → keep original order
        return 0;
      })
      .map(({ item, conf }) =>
        conf != null ? { ...item, _confidence: conf } : item
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, activeTypes, recommended, categorySearch, appFnProbs]);

  // Recommended items are also part of flatResults (they have poiType =
  // categorySearch). Filter them out by id so they only render in the
  // dedicated "Recommended" section above. Without this dedupe they would
  // show up twice — once at the top of the recommended list and again later
  // in the main results after the confidence sort shuffles them around.
  const recommendedIds = useMemo(() => {
    return new Set((recommended ?? []).map((r) => r.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommended]);
  const rankedResults = useMemo(
    () => flatResults.filter((item) => !recommendedIds.has(item.id)),
    [flatResults, recommendedIds]
  );

  // Look up a recommendation item's confidence (it might live in flatResults
  // already — `recommended` itself isn't tagged). Item confidence is also
  // injected by the flatResults sort below, so we read it from `_confidence`
  // when available and otherwise recompute from appFunction.probabilities.
  const hasRecommended = recommended && recommended.length > 0;
  const hasResults = flatResults.length > 0;
  const hasRecent = recentSearches.length > 0;
  // LayaSuggestions returns null until appFnProbs is set, so this is also
  // a safe proxy for "the Laya section has anything to render".
  const hasFunctionSuggestions = appFnProbs != null;
  // Dropdown shows while the input is focused whenever there's something
  // visible: search results, in-flight search, recent searches, or the
  // Laya-ranked function-suggestion buttons.
  const showDropdown =
    isOpen &&
    (hasResults ||
      hasFunctionSuggestions ||
      (query && isLoading) ||
      (!query && hasRecent));

  return (
    <div
      ref={containerRef}
      className={`relative w-full ${className}`}
      onKeyDown={handleKeyDown}
    >
      {/* Search Input */}
      <div className="relative flex items-center">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">
          {isLoading ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Search size={18} />
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition shadow-sm"
          aria-label="Search places"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
        />
        {query && (
          <button
            onClick={() => {
              setQuery("");
              setResults(null);
              setRecommended(null);
              setCategorySearch(null);
              inputRef.current?.focus();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
            aria-label="Clear search"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Suggestions Dropdown */}
      {showDropdown && (
        <div
          className="absolute left-0 right-0 top-full mt-2 bg-white rounded-xl border border-zinc-200 shadow-lg z-50 max-h-80 overflow-y-auto"
          role="listbox"
        >
          {isLoading && !hasResults && (
            <div className="px-4 py-6 text-center text-sm text-zinc-400">
              Searching...
            </div>
          )}

          {!isLoading && !hasResults && query && !hasFunctionSuggestions && (
            <div className="px-4 py-6 text-center text-sm text-zinc-400">
              No results found for &quot;{query}&quot;
            </div>
          )}

          {/* LAYA-ranked search actions — rendered by the
              LayaSuggestions component. The component now shows ONLY
              the top Laya pick (not all 4) and builds a contextual
              label from the user's query + the queryType classifier
              ("元朗" → "搜尋元朗嘅交通站點", "Bus" → "搵Bus嘅站").
              Clicking pushes `/?q=<query>&filter=<chipKey>` so the
              home page picks up the search and centers the map. The
              onPick handler closes the dropdown + saves a recent
              search before navigation. */}
          <LayaSuggestions
            appFunctionChoice={appFunctionChoice}
            queryType={queryType}
            layaLoading={layaLoading}
            t={t}
            query={query}
            onPick={() => {
              setIsOpen(false);
              if (query.trim()) addRecentSearch(query.trim());
            }}
          />

          {/* Recent searches — shown when input is focused but empty */}
          {!query && hasRecent && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide flex items-center justify-between sticky top-0 bg-white border-b border-zinc-100">
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <History size={12} />
                  Recent searches
                </div>
                <button
                  onClick={() => {
                    clearRecentSearches();
                    setRecentSearches([]);
                  }}
                  className="text-xs text-zinc-400 hover:text-zinc-600"
                >
                  Clear
                </button>
              </div>
              {recentSearches.map((term, idx) => (
                <button
                  key={term}
                  onClick={() => {
                    setQuery(term);
                    setIsOpen(true);
                  }}
                  className={`w-full px-3 py-2.5 flex items-center gap-3 text-left transition ${
                    highlightedIndex === idx ? "bg-blue-50" : "hover:bg-zinc-50"
                  }`}
                  role="option"
                  aria-selected={highlightedIndex === idx}
                >
                  <History size={14} className="text-zinc-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-700 truncate">{term}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Recommended Section */}
          {hasRecommended && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5 sticky top-0 bg-blue-50 text-blue-600">
                <Sparkles size={12} />
                {t(`nearby${categorySearch.charAt(0).toUpperCase() + categorySearch.slice(1)}`)}
              </div>
              {recommended.map((item, idx) => {
                const config = TYPE_CONFIG[categorySearch] ?? TYPE_CONFIG.attraction;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleSelect({ ...item, poiType: categorySearch })}
                    className={`w-full px-3 py-2.5 flex items-center gap-3 text-left transition ${
                      highlightedIndex === idx ? "bg-blue-50" : "hover:bg-zinc-50"
                    }`}
                    role="option"
                    aria-selected={highlightedIndex === idx}
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: config.color }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-800 truncate">
                        {item.name}
                      </div>
                      {item.address && (
                        <div className="text-xs text-zinc-400 truncate">
                          {item.address}
                        </div>
                      )}
                      {item.district && (
                        <div className="text-xs text-zinc-400">
                          {item.district}
                        </div>
                      )}
                      {item.distanceMetres != null && (
                        <div className="text-xs text-zinc-400">
                          {item.distanceMetres < 1000
                            ? `${Math.round(item.distanceMetres)}m`
                            : `${(item.distanceMetres / 1000).toFixed(1)}km`}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {item.barrierFree && (
                        <div className="flex items-center gap-1">
                          <Accessibility className="w-3 h-3 text-blue-600" />
                          <span className="text-xs font-semibold text-blue-600">無障礙</span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Search Results Section — already sorted by Laya appFunction
              confidence desc, so the user's most-likely-intended category
              sits at the top of the list. */}
          {hasResults && (
            <div>
              {rankedResults.map((item, idx) => {
                const type = item.poiType;
                const config = TYPE_CONFIG[type];
                if (!config) return null;
                const isHighlighted = highlightedIndex === idx + (hasRecommended ? recommended.length : 0);
                return (
                  <button
                    key={item.id}
                    onClick={() => handleSelect(item)}
                    className={`w-full px-3 py-2.5 flex items-center gap-3 text-left transition ${
                      isHighlighted ? "bg-blue-50" : "hover:bg-zinc-50"
                    }`}
                    role="option"
                    aria-selected={isHighlighted}
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: config.color }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-800 truncate">
                        {item.name}
                      </div>
                      {item.address && (
                        <div className="text-xs text-zinc-400 truncate">
                          {item.address}
                        </div>
                      )}
                      {item.district && (
                        <div className="text-xs text-zinc-400">
                          {item.district}
                        </div>
                      )}
                      {item.distanceMetres != null && (
                        <div className="text-xs text-zinc-400">
                          {item.distanceMetres < 1000
                            ? `${Math.round(item.distanceMetres)}m`
                            : `${(item.distanceMetres / 1000).toFixed(1)}km`}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {item.barrierFree && (
                        <div className="flex items-center gap-1">
                          <Accessibility className="w-3 h-3 text-blue-600" />
                          <span className="text-xs font-semibold text-blue-600">無障礙</span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
