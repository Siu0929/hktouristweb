"use client";

/**
 * MapControls — overlay that sits on top of the hero map and lets the
 * user pick a "To" destination so only relevant places are surfaced.
 *
 * This is purely presentational: the parent owns the state (destination)
 * and decides how those bits feed into the marker pipeline.
 */

import { useEffect, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";

export default function MapControls({
  t,
  destination,
  onDestinationChange,
  destinationSuggestions = [],
}) {
  const [draft, setDraft] = useState(destination ?? "");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);

  // Keep the local input in sync when the parent clears/updates destination.
  useEffect(() => {
    setDraft(destination ?? "");
  }, [destination]);

  // Close the suggestion popover when the user clicks outside the pill.
  useEffect(() => {
    if (!showSuggestions) return undefined;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [showSuggestions]);

  const submit = (value) => {
    const next = (value ?? "").trim();
    setDraft(next);
    setShowSuggestions(false);
    if (typeof onDestinationChange === "function") {
      onDestinationChange(next);
    }
  };

  const filteredSuggestions = draft
    ? destinationSuggestions
        .filter((s) => s.toLowerCase().includes(draft.toLowerCase()))
        .slice(0, 6)
    : destinationSuggestions.slice(0, 6);

  return (
    <div
      className="absolute right-5 top-5 z-20 flex flex-col items-end gap-2 pointer-events-none"
      style={{ maxWidth: "min(360px, calc(100vw - 40px))" }}
    >
      {/* "To:" destination pill — pops a tiny suggestion list when focused. */}
      <div
        ref={wrapRef}
        className="pointer-events-auto relative"
        style={{ minWidth: 220 }}
      >
        <form
          className="hk-destination-pill"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          <MapPin className="h-3.5 w-3.5 shrink-0 text-[#1E40AF]" />
          <span className="text-[#6b7280] font-semibold">
            {t("mapDestinationLabel")}
          </span>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            placeholder={t("mapDestinationPlaceholder")}
            aria-label={t("mapDestinationLabel")}
          />
          {draft && (
            <button
              type="button"
              aria-label={t("mapDestinationClear")}
              title={t("mapDestinationClear")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#1f2937]"
              onClick={() => submit("")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </form>

        {showSuggestions && filteredSuggestions.length > 0 && (
          <div
            className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-[#e5e7eb] bg-white shadow-[0_8px_20px_rgba(0,0,0,0.12)]"
            role="listbox"
          >
            {filteredSuggestions.map((s) => (
              <button
                key={s}
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-[#1f2937] hover:bg-[#f3f4f6]"
                onClick={() => submit(s)}
              >
                <MapPin className="h-3 w-3 shrink-0 text-[#1E40AF]" />
                <span className="truncate">{s}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
