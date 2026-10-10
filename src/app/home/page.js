// =============================================================================
// Home Page - Main entry point for the tourist app home screen
// =============================================================================
// This file has been split into multiple modules for easier debugging:
// - constants.js: Shared map config, colors, utilities
// - spots.js: Tourist spots data organized by category
// - api.js: Toilet fetch helpers
// - toilet.js: Toilet-specific helpers
// - components/FilterChip.jsx: Filter chip UI component
// - components/HeroMap.jsx: Main map component
// =============================================================================

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/contexts/LocaleContext";
import {
  Toilet,
  MapPin,
  Bus,
  Train,
  TramFront,
  Lightbulb,
  Loader2,
  Send,
  Sparkles,
  RefreshCw,
  X,
  Bookmark,
  ChevronUp,
  Locate,
  Ship,
} from "lucide-react";

import SearchBar from "@/components/SearchBar";
import {
  addFrequentPlace,
  clearFrequentPlaces,
  removeFrequentPlace,
} from "@/lib/frequentPlaces";

// Import from submodules
import {
  TOILET_DEFAULT_COLOR,
  ATTRACTION_COLOR,
  AI_PLANNER_SUGGESTIONS,
  DESTINATION_SUGGESTIONS,
  getHeroFilters,
} from "./constants";

import { fetchNearbyToilets } from "./api";

// Import components
import FilterChip from "./components/FilterChip";
import HeroMap from "./components/HeroMap";

// =============================================================================
// Hero filter definitions
// =============================================================================
//
// `getHeroFilters(t, icons)` reads the per-category colour + icon from the
// shared `constants.js` registry. Adding a new transport layer means
// updating that registry — this component picks up the new chip without
// any further edits here.
const HERO_FILTER_ICONS = { Toilet, MapPin, Bus, Train, TramFront, Ship };

// =============================================================================
// Main HomePage Component
// =============================================================================

function HomePage() {
  const { locale } = useLocale();
  const t = useTranslations("home");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState(null);
  const [searchResults, setSearchResults] = useState(null);

  // Hero filter chips. Built from the shared registry so adding a new
  // transport layer (e.g. a future "ferries" type) only requires
  // updating `constants.js` — this component picks up the new chip
  // automatically.
  const heroFilters = useMemo(
    () => getHeroFilters(t, HERO_FILTER_ICONS),
    [t]
  );

  // Places state
  const [frequentPlaces, setFrequentPlaces] = useState([]);
  const [nearbyToilets, setNearbyToilets] = useState([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);

  // Places panel state
  const [placesPanelTab, setPlacesPanelTab] = useState("closest");
  const [placesPanelDismissed, setPlacesPanelDismissed] = useState(false);
  const [placesPanelCollapsed, setPlacesPanelCollapsed] = useState(false);

  // AI Planner state
  const [aiPlannerOpen, setAiPlannerOpen] = useState(false);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const aiMessagesEndRef = useRef(null);

  // Destination filter
  const [destination, setDestination] = useState("");

  // =============================================================================
  // Effects
  // =============================================================================

  // Hydrate frequent places from localStorage
  useEffect(() => {
    // Import dynamically to avoid SSR issues
    import("@/lib/frequentPlaces").then(({ readFrequentPlaces }) => {
      setFrequentPlaces(readFrequentPlaces());
    });
  }, []);

  // Scroll AI chat to bottom
  useEffect(() => {
    aiMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [aiMessages]);

  // =============================================================================
  // Handlers
  // =============================================================================

  const handlePinPlace = useCallback((spot) => {
    setFrequentPlaces(addFrequentPlace(spot));
  }, []);

  const handleRemoveFrequentPlace = useCallback((id) => {
    setFrequentPlaces(removeFrequentPlace(id));
  }, []);

  const handleClearFrequentPlaces = useCallback(() => {
    // Wipe the persisted list in localStorage, then sync the local
    // state so the Frequent tab and the settings card update in
    // the same render cycle — without re-querying localStorage
    // (which would race with the `setFrequentPlaces` callback's
    // own re-read path).
    clearFrequentPlaces();
    setFrequentPlaces([]);
  }, []);

  const handleNearbyUpdate = useCallback(({ toilets, loading }) => {
    if (toilets) setNearbyToilets(toilets);
    if (typeof loading === "boolean") setNearbyLoading(loading);
  }, []);

  // Filter toggle
  const handleFilterToggle = useCallback((key) => {
    setActiveFilter((prev) => (prev === key ? null : key));
  }, []);

  // Destination change
  const handleDestinationChange = useCallback((value) => {
    setDestination(value);
  }, []);

  // Places panel tab click
  const handlePlacesPanelTabClick = useCallback((tab) => {
    setPlacesPanelTab(tab);
    setPlacesPanelDismissed(false);
  }, []);

  // =============================================================================
  // AI Planner handlers
  // =============================================================================

  const handleAiSuggestion = (suggestion) => {
    setAiInput(suggestion);
  };

  const handleAiSubmit = async (e) => {
    e?.preventDefault();
    if (!aiInput.trim() || aiLoading) return;

    const userMessage = { role: "user", content: aiInput };
    setAiMessages((prev) => [...prev, userMessage]);
    setAiInput("");
    setAiLoading(true);
    setAiError(null);

    try {
      const response = await fetch("/api/trip-planner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: aiInput }),
      });

      if (!response.ok) throw new Error("Failed to get response");

      const data = await response.json();
      const assistantMessage = { role: "assistant", content: data.response };
      setAiMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setAiError(t("tripPlanner.errorMessage"));
    } finally {
      setAiLoading(false);
    }
  };

  const handleAiKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAiSubmit(e);
    }
  };

  const handleAiReset = () => {
    setAiMessages([]);
    setAiInput("");
    setAiError(null);
  };

  const openAiPlanner = () => {
    setAiPlannerOpen(true);
    setActiveFilter(null);
  };

  const closeAiPlanner = () => {
    setAiPlannerOpen(false);
  };

  // =============================================================================
  // Render
  // =============================================================================

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#f4f6f9]">
      {/* Map container */}
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-0 overflow-hidden">
          <HeroMap
            query={searchQuery}
            activeFilter={activeFilter}
            searchResults={searchResults}
            t={t}
            onPinPlace={handlePinPlace}
            onNearbyUpdate={handleNearbyUpdate}
            onInfoWindowClose={() => {}}
            destination={destination}
            placesPanelTab={placesPanelTab}
            onPlacesPanelTabChange={setPlacesPanelTab}
            placesPanelDismissed={placesPanelDismissed}
            onPlacesPanelDismiss={() => setPlacesPanelDismissed(true)}
            placesPanelCollapsed={placesPanelCollapsed}
            onPlacesPanelCollapsedChange={setPlacesPanelCollapsed}
            onRemoveFrequentPlace={handleRemoveFrequentPlace}
            onClearFrequentPlaces={handleClearFrequentPlaces}
            frequentPlaces={frequentPlaces}
          />
        </div>

        {/* Search bar + filter overlay */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-5 pt-8 transition-all duration-300 md:pr-24 md:pt-10 ${
            !placesPanelDismissed ? "md:pr-129" : ""
          }`}
        >
          <div className="pointer-events-auto w-full max-w-240">
            {/* Search row */}
            <div className="relative">
              <div className="flex items-stretch gap-2">
                <div className="flex-1">
                  <SearchBar
                    query={searchQuery}
                    onQueryChange={setSearchQuery}
                    onResults={setSearchResults}
                    onSelect={(item) => {
                      setSearchQuery(item.name);
                    }}
                    placeholder={t("searchPlaceholder")}
                  />
                </div>
                <button
                  type="button"
                  onClick={openAiPlanner}
                  className="flex shrink-0 items-center gap-2 rounded-[10px] bg-[#eef2ff] px-4 py-3 transition-colors hover:bg-[#e0e7ff]"
                  title={t("aiPlannerAction")}
                >
                  <Lightbulb className="h-5 w-5 shrink-0 text-[#1f2937]" />
                  <span className="hidden text-sm font-semibold text-[#1f2937] md:inline">
                    {t("aiPlannerAction")}
                  </span>
                </button>
              </div>

              {/* AI Planner popup */}
              {aiPlannerOpen && (
                <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.14)]">
                  {/* Popup header */}
                  <div className="flex items-center justify-between border-b border-[#e5e7eb] px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-violet-600" />
                      <span className="text-sm font-semibold text-[#1f2937]">
                        {t("tripPlanner.title")}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {aiMessages.length > 0 && (
                        <button
                          type="button"
                          onClick={handleAiReset}
                          title={t("tripPlanner.reset")}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6b7280] transition-colors hover:bg-[#f3f4f6] hover:text-[#1f2937]"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={closeAiPlanner}
                        title="Close"
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6b7280] transition-colors hover:bg-[#f3f4f6] hover:text-[#1f2937]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Chat messages area */}
                  <div className="max-h-64 overflow-y-auto px-4 py-3">
                    {aiMessages.length === 0 ? (
                      <div className="space-y-4">
                        <p className="text-sm text-[#6b7280]">
                          {t("tripPlanner.welcomeDesc")}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {AI_PLANNER_SUGGESTIONS.map((suggestion, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => handleAiSuggestion(suggestion)}
                              className="rounded-full border border-[#e5e7eb] bg-[#f9fafb] px-3 py-1.5 text-xs font-medium text-[#374151] transition-colors hover:bg-violet-50 hover:border-violet-200 hover:text-violet-700"
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {aiMessages.map((msg, idx) => (
                          <div
                            key={idx}
                            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                                msg.role === "user"
                                  ? "bg-violet-600 text-white"
                                  : "bg-[#f3f4f6] text-[#1f2937]"
                              }`}
                            >
                              <p className="whitespace-pre-wrap">{msg.content}</p>
                            </div>
                          </div>
                        ))}
                        {aiLoading && (
                          <div className="flex items-center gap-2 text-[#6b7280]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span className="text-xs">{t("tripPlanner.generating")}</span>
                          </div>
                        )}
                        {aiError && (
                          <p className="text-xs text-red-600">{aiError}</p>
                        )}
                        <div ref={aiMessagesEndRef} />
                      </div>
                    )}
                  </div>

                  {/* Input area */}
                  <div className="border-t border-[#e5e7eb] px-4 py-3">
                    <form onSubmit={handleAiSubmit} className="flex gap-2">
                      <textarea
                        value={aiInput}
                        onChange={(e) => setAiInput(e.target.value)}
                        onKeyDown={handleAiKeyDown}
                        placeholder={t("tripPlanner.placeholder")}
                        rows={1}
                        disabled={aiLoading}
                        className="flex-1 max-h-24 resize-none rounded-xl border border-[#e5e7eb] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={!aiInput.trim() || aiLoading}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white transition-colors hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </div>
                </div>
              )}
            </div>

            {/* Filter chip row */}
            {!aiPlannerOpen && (
              <div className="mt-3">
                <div
                  className="scrollbar-hide flex gap-2 overflow-x-auto px-1 py-1 md:flex-wrap md:justify-center md:gap-2.5 md:overflow-visible"
                  role="toolbar"
                  aria-label={t("heroFilterAria")}
                >
                  {heroFilters.map((chip) => (
                    <FilterChip
                      key={chip.key}
                      label={t(chip.labelKey)}
                      Icon={chip.Icon}
                      swatch={chip.swatch}
                      active={activeFilter === chip.key}
                      onClick={() => handleFilterToggle(chip.key)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Mobile collapsed-state handle */}
        {placesPanelDismissed && (
          <button
            type="button"
            onClick={() => setPlacesPanelDismissed(false)}
            aria-label={t("bottomSheetShow")}
            title={t("bottomSheetShow")}
            className="md:hidden pointer-events-auto absolute inset-x-0 bottom-3 z-20 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-[#e5e7eb] bg-white/95 px-4 py-2 text-[13px] font-semibold text-[#1f2937] shadow-[0_4px_14px_rgba(0,0,0,0.18)] backdrop-blur transition-all hover:bg-white active:scale-95"
            style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            <ChevronUp className="h-4 w-4 text-[#1E40AF]" />
            <span className="truncate">
              {placesPanelTab === "closest" && t("bottomSheetShowStation")}
              {placesPanelTab === "nearby" && t("bottomSheetShowNearby")}
              {placesPanelTab === "frequent" && t("bottomSheetShowFrequent")}
            </span>
          </button>
        )}

        {/* Icon rail */}
        <div className="absolute right-0 top-0 z-20 hidden md:flex md:inset-y-0">
          <div className="flex w-24 shrink-0 flex-col items-center justify-start border-l border-[#e5e7eb] bg-white pt-4">
            {/* Frequent Places */}
            <button
              type="button"
              onClick={() => handlePlacesPanelTabClick("frequent")}
              title={t("frequentTitle")}
              className={`mb-4 flex flex-col items-center gap-1 rounded-xl p-3 transition-all ${
                placesPanelTab === "frequent" && !placesPanelDismissed
                  ? "bg-[#1E40AF] text-white shadow-[0_2px_6px_rgba(30,64,175,0.3)]"
                  : "text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#1E40AF]"
              }`}
            >
              <Bookmark className="h-6 w-6" />
              <span className="text-[11px] font-semibold leading-tight text-center">
                {t("frequentTitle")}
              </span>
            </button>

            {/* Nearby Places */}
            <button
              type="button"
              onClick={() => handlePlacesPanelTabClick("nearby")}
              title={t("nearbyTitle")}
              className={`mb-4 flex flex-col items-center gap-1 rounded-xl p-3 transition-all ${
                placesPanelTab === "nearby" && !placesPanelDismissed
                  ? "bg-[#1E40AF] text-white shadow-[0_2px_6px_rgba(30,64,175,0.3)]"
                  : "text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#1E40AF]"
              }`}
            >
              <MapPin className="h-6 w-6" />
              <span className="text-[11px] font-semibold leading-tight text-center">
                {t("nearbyTitle")}
              </span>
            </button>

            {/* Closest Station */}
            <button
              type="button"
              onClick={() => handlePlacesPanelTabClick("closest")}
              title={t("bottomSheetStationTitle")}
              className={`flex flex-col items-center gap-1 rounded-xl p-3 transition-all ${
                placesPanelTab === "closest" && !placesPanelDismissed
                  ? "bg-[#1E40AF] text-white shadow-[0_2px_6px_rgba(30,64,175,0.3)]"
                  : "text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#1E40AF]"
              }`}
            >
              <Train className="h-6 w-6" />
              <span className="text-[11px] font-semibold leading-tight text-center">
                {t("bottomSheetStationTitle")}
              </span>
            </button>

            <div className="flex-1" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default HomePage;
