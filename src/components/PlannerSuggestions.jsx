"use client";

import { useCallback, useEffect, useState } from "react";
import { Lightbulb, MapPin, Navigation, Loader2, X, Plus } from "lucide-react";
import { useLocale } from "@/contexts/LocaleContext";

const TYPE_COLORS = {
  attraction: "#C2410C",
  transport: "#1E40AF",
  nature: "#22c55e",
  utility: "#f97316",
};

const TYPE_ICONS = {
  attraction: MapPin,
  transport: Navigation,
  nature: MapPin,
  utility: MapPin,
};

export default function PlannerSuggestions({
  userLocation,
  onSelectSuggestion,
  onAddToTrip,
  maxItems = 5,
  className = "",
}) {
  const { locale } = useLocale();
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (!userLocation?.lat || !userLocation?.lng) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const params = new URLSearchParams({
      lat: String(userLocation.lat),
      lon: String(userLocation.lng),
      limit: String(maxItems),
      locale,
    });

    fetch(`/api/planner-suggestions?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        // Defensively normalise: the API returns { suggestions: [...] }
        // but handle any unexpected shape gracefully.
        const list = Array.isArray(data?.suggestions)
          ? data.suggestions
          : Array.isArray(data) ? data : [];
        setSuggestions(list);
      })
      .catch((err) => {
        console.error("Failed to fetch suggestions:", err);
        // Don't leave the UI stuck — show an empty state rather than stale data.
        setSuggestions([]);
      })
      .finally(() => setLoading(false));
  }, [userLocation, locale, maxItems]);

  const handleSelect = useCallback(
    (suggestion) => {
      if (suggestion.place) {
        onSelectSuggestion?.(suggestion.place);
      } else if (suggestion.isTemplate && suggestion.places?.length > 0) {
        onSelectSuggestion?.(suggestion.places[0]);
      }
    },
    [onSelectSuggestion]
  );

  const handleAddToTrip = useCallback(
    (suggestion, e) => {
      e?.stopPropagation();
      onAddToTrip?.(suggestion);
    },
    [onAddToTrip]
  );

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-3 ${className}`}>
        <Loader2 size={16} className="animate-spin text-zinc-400" />
        <span className="ml-2 text-sm text-zinc-400">Loading suggestions...</span>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return null;
  }

  const displayedSuggestions = isExpanded ? suggestions : suggestions.slice(0, maxItems);
  const hasMore = suggestions.length > maxItems;

  return (
    <div className={`bg-white rounded-xl border border-zinc-200 shadow-sm ${className}`}>
      <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb size={16} className="text-amber-500" />
          <span className="text-sm font-semibold text-zinc-800">Trip Suggestions</span>
        </div>
        {hasMore && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            {isExpanded ? "Show less" : `+${suggestions.length - maxItems} more`}
          </button>
        )}
      </div>

      <div className="p-2 space-y-1">
        {displayedSuggestions.map((suggestion) => {
          const IconComponent = TYPE_ICONS[suggestion.type] || MapPin;
          const color = TYPE_COLORS[suggestion.type] || "#6b7280";

          return (
            <div
              key={suggestion.id}
              onClick={() => handleSelect(suggestion)}
              className="group flex items-center gap-3 p-2.5 rounded-lg hover:bg-zinc-50 cursor-pointer transition"
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${color}15` }}
              >
                <IconComponent size={14} style={{ color }} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-zinc-800 truncate">
                  {suggestion.name}
                </div>
                <div className="text-xs text-zinc-400 truncate">
                  {suggestion.description}
                </div>
                {suggestion.distanceMetres != null && (
                  <div className="text-xs text-zinc-400">
                    {suggestion.distanceMetres < 1000
                      ? `${Math.round(suggestion.distanceMetres)}m away`
                      : `${(suggestion.distanceMetres / 1000).toFixed(1)}km away`}
                  </div>
                )}
              </div>

              {suggestion.places?.length > 1 && (
                <span className="text-xs bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded">
                  {suggestion.places.length} stops
                </span>
              )}

              {onAddToTrip && (
                <button
                  onClick={(e) => handleAddToTrip(suggestion, e)}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition"
                  title="Add to trip"
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
