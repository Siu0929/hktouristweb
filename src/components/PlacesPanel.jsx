"use client";

/**
 * PlacesPanel — unified "lists" surface for the home page.
 *
 * - On mobile (< md): renders as a bottom sheet at the bottom of the map
 *   with a drag handle and rounded top corners.
 * - On desktop (>= md): renders as a right sidebar to the LEFT of the
 *   vertical icon rail. Full height, fixed width.
 *
 * Three tabs are available in both layouts:
 *   - Closest Station   → top 5 nearest bus stops / MTR stations / Light
 *                          Rail stops / ferry piers / tram stops, each
 *                          rendered as its own card with live ETAs.
 *                          The selector behind this tab swaps any card
 *                          whose ETA fetch came back empty for the next
 *                          candidate that has arrivals, so the tab
 *                          stays useful when the literal closest stops
 *                          are not currently in service.
 *   - Nearby            → top 5 toilets by distance
 *   - Frequent          → user-pinned places from localStorage
 *
 * Tab state can be controlled externally (`tab` + `onTabChange`) so the
 * vertical icon rail on the right can also switch tabs. The `dismissed`
 * prop collapses the panel entirely (mobile dismiss button, desktop close
 * button).
 *
 * Bottom-sheet height is controlled externally (`height` +
 * `onHeightChange`) and snaps to one of three positions:
 *   - "closed"   → 48 px   (handle bar only)
 *   - "default"  → 400 px  (current production height)
 *   - "expanded" → 800 px  (twice the default)
 * Drag the gray handle at the top of the sheet up/down to switch
 * positions. On release the height snaps to the nearest of the three
 * positions; the sheet can never land outside them. See
 * `useBottomPanelDrag` for the drag mechanics.
 */

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  Toilet,
  MapPin,
  Loader2,
  X,
  Navigation,
  Bus,
  Train,
  TramFront,
  Ship,
  Bookmark,
  Settings,
} from "lucide-react";
import { pickRouteBadge } from "@/lib/transportColors";
import { useLocale } from "@/contexts/LocaleContext";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import {
  useBottomPanelDrag,
} from "@/hooks/useBottomPanelDrag";

const NEARBY_ROW_STYLE = {
  toilets: { Icon: Toilet, iconBg: "bg-[#f0fdfa]", iconColor: "#0F766E" },
};

const FREQUENT_PLACE_STYLE = {
  attractions: { Icon: MapPin, iconBg: "bg-[#fff7ed]", iconColor: "#C2410C" },
  toilets: { Icon: Toilet, iconBg: "bg-[#f0fdfa]", iconColor: "#0F766E" },
  // Transport category pins — kept in sync with the popup tag in
  // SpotPopup.jsx (`CATEGORY_ICON`) so a station saved as a frequent
  // place renders with the same glyph + colour as on the map and in
  // the popup tag. Without these, every transport category used to
  // silently fall back to the generic MapPin, which made the bottom
  // "Frequent Places" box disagree with the popup tag it mirrors.
  busStops: { Icon: Bus, iconBg: "bg-[#eff6ff]", iconColor: "#1D4ED8" },
  mtrStations: { Icon: Train, iconBg: "bg-[#fef2f2]", iconColor: "#DC2626" },
  lightRailStops: { Icon: TramFront, iconBg: "bg-[#f5f3ff]", iconColor: "#7C3AED" },
  ferryPiers: { Icon: Ship, iconBg: "bg-[#ecfeff]", iconColor: "#0891B2" },
  tramStops: { Icon: TramFront, iconBg: "bg-[#ecfdf5]", iconColor: "#00734B" },
};

const NEARBY_MAX_ITEMS = 5;
const FREQUENT_MAX_ITEMS = 10;
const CLOSEST_STATIONS_LIMIT = 5;
const STATION_CARD_ETA_MAX_ITEMS = 3;
const STATION_ETA_REFRESH_MS = 30_000;

// Open the device's default map app with directions to the spot. We
// delegate to Google Maps via a universal `dir/` URL so it works whether
// the user has the Google Maps app, Apple Maps (it auto-falls back) or
// just the web. The destination accepts lat,lng plus a label which the
// maps app displays as the destination name.
function openNavigation(spot) {
  if (!spot || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) {
    return;
  }
  const params = new URLSearchParams({
    api: "1",
    destination: `${spot.lat},${spot.lng}`,
    travelmode: "transit",
  });
  const url = `https://www.google.com/maps/dir/?${params.toString()}`;
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

// Map a spot's category to the upstream ETA endpoint and the icon shown
// in the closest-station header. Bus stops use /api/bus-eta, ferry
// piers use /api/ferry/eta, MTR stations use /api/mtr/eta, Light Rail
// stops use /api/lightrail/eta, and HK Tramways tram stops use
// /api/tram/eta.
const ETA_HEADER_BY_CATEGORY = {
  busStops: { endpoint: "/api/bus-eta", Icon: Bus },
  mtrStations: { endpoint: "/api/mtr/eta", Icon: Train },
  lightRailStops: { endpoint: "/api/lightrail/eta", Icon: TramFront },
  ferryPiers: { endpoint: "/api/ferry/eta", Icon: Ship },
  tramStops: { endpoint: "/api/tram/eta", Icon: TramFront },
};

function etaRouteEndpoint(spot) {
  const cfg = ETA_HEADER_BY_CATEGORY[spot?.category];
  if (cfg) return cfg.endpoint;
  return "/api/bus-eta";
}

function etaHeaderIcon(spot) {
  const cfg = ETA_HEADER_BY_CATEGORY[spot?.category];
  if (cfg) return cfg.Icon;
  return Bus;
}

function spotDistanceMetres(spot) {
  if (!spot) return Number.POSITIVE_INFINITY;
  if (typeof spot.distanceMetres === "number") return spot.distanceMetres;
  if (typeof spot.distanceKm === "number") return spot.distanceKm * 1000;
  return Number.POSITIVE_INFINITY;
}

function formatDistance(metres, t) {
  if (typeof metres !== "number" || !Number.isFinite(metres)) return "";
  if (metres < 1000) {
    return t("bottomSheetStationDistanceMeters", { meters: Math.round(metres) });
  }
  return t("bottomSheetStationDistanceKm", {
    km: (metres / 1000).toFixed(metres < 10000 ? 1 : 0),
  });
}

// The route-number pill (colour + label) inside the ETA list is
// built by `pickRouteBadge` from `@/lib/transportColors`. That
// helper knows the per-MTR-line palette plus the KMB / Citybus /
// NLB / LRT Feeder swatches.

// Tab icons: each entry maps to a `lucide-react` icon that we render
// instead of the old text label, so the bottom-sheet tab bar stays
// compact on mobile and lines up cleanly with the icon rail on
// desktop. The settings tab intentionally trails the rest so users
// don't trip over it while panning around the map.
const TABS = [
  { key: "closest", labelKey: "bottomSheetStationTitle", shortLabelKey: "tabLabelClosest", Icon: Train },
  { key: "nearby", labelKey: "nearbyTitle", shortLabelKey: "tabLabelNearby", Icon: MapPin },
  { key: "frequent", labelKey: "frequentTitle", shortLabelKey: "tabLabelFrequent", Icon: Bookmark },
  { key: "settings", labelKey: "settingsTitle", shortLabelKey: "tabLabelSettings", Icon: Settings },
];

export default function PlacesPanel({
  t,
  closestStations = [],
  loading = false,
  selectedId,
  onSelect,
  onShowRoute,
  activeRouteStationKey = null,
  // Dual-action callback used to centre the map on a chosen spot
  // and open its popup in one tap. The caller (HeroMap) both
  // selects the spot (so the SpotPopup tag opens) AND pans the
  // map so the stop sits in the middle of the viewport.
  //
  // Used by:
  //   - The Closest Station tab's tile click — so tapping a stop
  //     re-centres the map on that stop. Previously this tab's
  //     tile only called `onSelect`, so a user who had panned
  //     away from their location (e.g. while exploring) would
  //     open a popup dangling at the edge of the viewport with
  //     no marker visible. Using the same dual-action path as
  //     the Frequent tab keeps the two lists consistent.
  //   - The Frequent Places tab's "show on map" action on every
  //     pinned place (so the popup opens at the stop, not at
  //     a stale off-screen coordinate).
  onMapFocus,
  nearbyToilets = [],
  frequentPlaces = [],
  onClearFrequent,
  tab: controlledTab,
  onTabChange,
  // 3-position height state for the mobile bottom sheet. Reads the
  // same enum ('closed' | 'default' | 'expanded') as the SpotPopup
  // so dragging either handle keeps both sheets in lockstep.
  // Desktop sidebar (>= md) ignores this — it always uses the full
  // viewport height.
  height = "default",
  onHeightChange,
}) {
  const [internalTab, setInternalTab] = useState("closest");
  const activeTab = controlledTab ?? internalTab;

  // Read the active app locale so the ETA fetches below can pass it
  // through to the upstream endpoints. Without `locale`, every
  // `/api/<transport>/eta` call falls back to English for the
  // `dest.display` field — which is why the bottom card used to
  // show "KENNEDY TOWN…" while the popup (which already passes
  // locale from `EtasPanel`) showed "堅尼地城…" in the same app
  // session.
  const { locale: appLocale } = useLocale();

  const setActiveTab = (newTab) => {
    if (controlledTab === undefined) setInternalTab(newTab);
    if (typeof onTabChange === "function") onTabChange(newTab);
  };

  // Ref to the sheet's outer DOM node. The drag hook writes the
  // live drag height to `sheet.style.height` so the pointer moves
  // are reflected on-screen without a React render in the middle of
  // the gesture.
  const sheetRef = useRef(null);

  // Drag handlers for the gray handle at the top of the mobile
  // sheet. Reads the current `height` as the starting position;
  // calls `onHeightChange` with the snapped key on release. A pure
  // tap (no drag past the threshold) collapses the sheet to the
  // "closed" position — same UX as the previous tap-to-dismiss
  // behaviour, just expressed through the new 3-position state
  // instead of a separate `dismissed` boolean. HeroMap unmounts
  // the panel at "closed" and the home page shows the "Show
  // Closest Places" button so the user can recover.
  const {
    onPointerDown: onHandlePointerDown,
    onPointerMove: onHandlePointerMove,
    onPointerUp: onHandlePointerUp,
    onPointerCancel: onHandlePointerCancel,
    isDragging: isHandleDragging,
  } = useBottomPanelDrag({
    height,
    onHeightChange,
    // Tapping the handle (with no drag) collapses the sheet.
    // Always snap to "closed" on tap — HeroMap renders the panel
    // out of the DOM at that height, and the home page swaps in
    // the "Show Closest Places" button. The user can re-open
    // either from that button or from the right-rail icons.
    onClick: () => {
      if (height !== "closed" && typeof onHeightChange === "function") {
        onHeightChange("closed");
      }
    },
    sheetRef,
  });

  // ----- Closest-station ETA fetching -----
  // Fetches /api/<transport>/eta for every station in the candidate
  // pool (see HeroMap — wider than the displayed card count, so the
  // swap selector below always has fresh data for any replacement).
  // Stores per-station arrivals keyed by `${category}:${upstreamId}`
  // — each station gets its own { loading, error, arrivals } slot so
  // the cards refresh independently and one slow upstream call
  // doesn't blank the others.
  // Re-fetches the whole batch every STATION_ETA_REFRESH_MS so the
  // times stay current (the upstream is a "live" feed). Cancellable
  // via a flag so a quick map pan doesn't leak stale responses into
  // the UI.
  const [stationEtas, setStationEtas] = useState({});

  // Inline "are you sure?" toggle for the destructive
  // "clear all frequent places" control in the Settings tab.
  // Keeping it local to the panel means the confirmation lifecycle
  // resets cleanly when the tab is re-mounted — no orphaned state.
  const [confirmClearFrequent, setConfirmClearFrequent] = useState(false);

  // Reset the inline confirmation whenever `frequentPlaces`
  // changes — clears the "are you sure?" prompt after a successful
  // deletion or when the list refreshes for any other reason,
  // so a half-decided confirmation from a previous state doesn't
  // leak into the next render.
  useEffect(() => {
    setConfirmClearFrequent(false);
  }, [frequentPlaces]);

  const handleConfirmClearFrequent = useCallback(() => {
    if (typeof onClearFrequent === "function") {
      onClearFrequent();
    }
    setConfirmClearFrequent(false);
  }, [onClearFrequent]);

  const stationKey = useCallback((station) => {
    return `${station?.category ?? "unknown"}:${station?.upstreamId ?? "?"}`;
  }, []);

  // Flatten the raw ETA payload from any of the upstream endpoints
  // (bus / mtr / lightrail / ferry / tram) into the shared arrival
  // shape this UI consumes.
  const flattenEtaPayload = useCallback((data) => {
    const arrivals = [];

    // Standard shape: { routes: [{ routeId, routeNo, company, co, dest, etas: [...] }] }
    for (const route of data?.routes ?? []) {
      for (const eta of route.etas ?? []) {
        if (eta?.minutes == null) continue;
        arrivals.push({
          key: `${route.routeId}-${eta.eta ?? eta.minutes}-${arrivals.length}`,
          routeId: route.routeId,
          routeNo: route.routeNo,
          // Keep the full `co` list so `pickRouteBadge` can prefer the
          // official first operator (`co[0]`) on joint KMB↔CTB routes.
          // Without it, the bottom panel uses the per-stop `company`
          // (whichever company was first in stopRoutes for that stop),
          // which can disagree with the popup that uses `co[0]` — e.g.
          // route 904 / 914 / 970 etc. paint as KMB red in the popup
          // but Citybus yellow in the bottom card.
          co: Array.isArray(route.co) ? route.co : null,
          company: route.company,
          dest:
            route.dest?.display ||
            route.dest?.en ||
            route.dest?.zh ||
            "",
          minutes: eta.minutes,
          isRealtime: !!eta.isRealtime,
        });
      }
    }

    // Flat shape (HK Tramways): { etas: [{ tramId, dest, minutesUntilArrival, ... }] }
    if (arrivals.length === 0 && Array.isArray(data?.etas)) {
      for (const eta of data.etas) {
        if (eta?.minutesUntilArrival == null) continue;
        arrivals.push({
          key: `${eta.tramId ?? "eta"}-${eta.etaIso ?? eta.minutesUntilArrival}-${arrivals.length}`,
          routeId: eta.tramId ?? null,
          routeNo: null,
          company: "tram",
          dest:
            eta.dest?.display ||
            eta.dest?.en ||
            eta.dest?.tc ||
            eta.dest?.sc ||
            "",
          minutes: eta.minutesUntilArrival,
          isRealtime: !!eta.isRealtime,
        });
      }
    }

    arrivals.sort((a, b) => a.minutes - b.minutes);
    return arrivals;
  }, []);

  const fetchStationEta = useCallback(
    async (station) => {
      const key = stationKey(station);
      const stopId = station?.upstreamId;
      if (!stopId) {
        return { key, state: { loading: false, error: null, arrivals: [] } };
      }
      const endpoint = etaRouteEndpoint(station);
      try {
        // Pass the app locale so `dest.display` returned by the
        // upstream /api/<transport>/eta endpoints matches the user's
        // language (e.g. "堅尼地城(卑路乍灣)" instead of "KENNEDY
        // TOWN (BELCHER BAY)" when the app is in zh-Hant). Every
        // ETA endpoint — bus / mtr / lightrail / ferry / tram —
        // accepts `locale` and forwards it into `localisedTerminal()`
        // for the destination label.
        const params = new URLSearchParams({ stop: stopId });
        if (appLocale) params.set("locale", appLocale);
        const res = await fetch(`${endpoint}?${params}`);
        if (!res.ok) throw new Error(`${endpoint} ${res.status}`);
        const data = await res.json();
        const arrivals = flattenEtaPayload(data);
        return { key, state: { loading: false, error: null, arrivals } };
      } catch (err) {
        return {
          key,
          state: {
            loading: false,
            error: err?.message ?? String(err),
            arrivals: [],
          },
        };
      }
    },
    [appLocale, flattenEtaPayload, stationKey]
  );

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    // `closestStations` is a candidate pool (see HeroMap) — wider
    // than the number of cards we actually render. We fetch ETAs for
    // every candidate so the closest-stations filter below has the
    // data it needs to either keep the closest stop or drop it in
    // favour of the next-nearest one that has arrivals. The refresh
    // interval still re-runs every STATION_ETA_REFRESH_MS so the
    // times stay current (the upstream is a "live" feed).
    const candidates = Array.isArray(closestStations)
      ? closestStations
      : [];

    // Initial loading state for every slot so the cards can show their
    // spinner immediately. Old keys (stations that fell out of the
    // candidate pool) are cleared on the next pass.
    setStationEtas((prev) => {
      const next = {};
      for (const station of candidates) {
        const key = stationKey(station);
        next[key] = prev[key] ?? { loading: true, error: null, arrivals: [] };
        if (!next[key].loading && next[key].arrivals.length === 0) {
          next[key] = { loading: true, error: null, arrivals: [] };
        }
      }
      return next;
    });

    const run = async () => {
      if (cancelled || candidates.length === 0) return;
      const results = await Promise.all(candidates.map(fetchStationEta));
      if (cancelled) return;
      setStationEtas((prev) => {
        const next = { ...prev };
        for (const { key, state } of results) {
          next[key] = state;
        }
        return next;
      });
    };

    run();
    timer = setInterval(run, STATION_ETA_REFRESH_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [closestStations, fetchStationEta, stationKey]);

  // Pick which stations the Closest Station tab should actually
  // render. We start with the top CLOSEST_STATIONS_LIMIT nearest
  // candidates. Once their ETA fetches have resolved, every station
  // (closest or further down the pool) whose ETA came back empty
  // is hidden from the list — the tab is meant to surface live
  // transit data, so a station with no time data is not useful next
  // to stations that have arrivals. We re-fill the list (still in
  // distance order) from the wider candidate pool up to
  // CLOSEST_STATIONS_LIMIT, so the tab stays useful when the
  // literal closest stops are currently out of service.
  //
  // Behaviour summary:
  //   - While any of the closest slots is still loading: keep them
  //     visible (their spinners indicate in-flight data).
  //   - Once all closest slots have loaded: drop every station
  //     without arrivals, then refill the list from the wider
  //     candidate pool (in distance order) until we hit
  //     CLOSEST_STATIONS_LIMIT. Empty slots are simply removed from
  //     the grid — no "No ETA" placeholder is rendered.
  //   - If nothing in the pool has arrivals, the list is empty and
  //     the renderer falls back to the existing tab-wide empty
  //     state.
  const displayedStations = useMemo(() => {
    const candidates = Array.isArray(closestStations)
      ? closestStations
      : [];
    if (candidates.length === 0) return [];

    const limit = Math.min(CLOSEST_STATIONS_LIMIT, candidates.length);
    const closestSubset = candidates.slice(0, limit);

    // Hold the filter until every closest slot has at least started
    // a fetch — otherwise we'd briefly blank cards that are about
    // to populate. Once they've all reported back (loading === false
    // — whether the result was an arrival list, an empty list, or
    // an error), the filter is safe.
    const allClosestResolved = closestSubset.every((s) => {
      const eta = stationEtas[stationKey(s)];
      return eta != null && eta.loading === false;
    });
    if (!allClosestResolved) return closestSubset;

    // Walk the full candidate pool in distance order, picking only
    // stations whose ETA fetch resolved with at least one arrival.
    // We skip candidates that are still loading or came back empty
    // (including errored fetches — `arrivals` stays `[]` in that
    // case): showing fewer cards is better than flashing a "No ETA"
    // placeholder for a station that has no live transit data.
    const hasArrivals = (station) => {
      const eta = stationEtas[stationKey(station)];
      return eta && Array.isArray(eta.arrivals) && eta.arrivals.length > 0;
    };

    const result = [];
    for (const candidate of candidates) {
      if (result.length >= limit) break;
      if (!hasArrivals(candidate)) continue;
      result.push(candidate);
    }
    return result;
  }, [closestStations, stationEtas, stationKey]);

  // Top 5 nearby — toilets sorted by distance.
  const topNearby = useMemo(() => {
    const all = [...nearbyToilets]
      .map((spot, idx) => ({
        spot,
        key: `${spot.id ?? `toilet-${idx}`}`,
        distanceMetres: spotDistanceMetres(spot),
      }))
      .sort((a, b) => a.distanceMetres - b.distanceMetres)
      .slice(0, NEARBY_MAX_ITEMS);
    return all;
  }, [nearbyToilets]);

  const topFrequent = useMemo(
    () => (Array.isArray(frequentPlaces) ? frequentPlaces.slice(0, FREQUENT_MAX_ITEMS) : []),
    [frequentPlaces]
  );

  // The `dismissed` early-return is gone — HeroMap now wraps us in
  // a `bottomPanelHeight !== "closed"` conditional so the entire
  // panel is unmounted in the hidden state. By the time we reach
  // this render we're guaranteed to be visible at default or
  // expanded; the `places-panel-${height}` class on the root div
  // still flips between the two heights for CSS.

  // ----- Closest Station tab -----
  // Renders one card per top-5 closest station inside the same
  // horizontal scroll container used by the nearby / frequent tabs.
  // Each card uses the existing `.places-panel-card` visual (240px
  // wide, fills the panel's vertical height) and shows a header with
  // the transport icon, station name and distance, a navigate
  // button, and a small stack of the next few ETAs pulled from
  // `stationEtas`. Empty state matches the previous behaviour.
  //
  // The station list comes from `displayedStations` rather than the
  // raw `closestStations` prop — that selector already applies the
  // "swap empty slot with the next station that has arrivals" rule
  // described above.
  const renderClosestContent = () => {
    const stations = displayedStations;

    if (stations.length === 0) {
      return (
        <div className="places-panel-station-empty">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[10px] bg-[#f3f4f6]">
            <Bus className="h-6 w-6 text-[#6b7280]" />
          </div>
          <p className="mt-3 text-sm font-semibold text-[#1f2937]">
            {t("bottomSheetStationEmpty")}
          </p>
          <p className="mt-1 text-[12px] text-[#6b7280]">
            {t("bottomSheetStationEmptyDesc")}
          </p>
        </div>
      );
    }

    return (
      <div className="places-panel-station-list">
        {stations.map((station) => {
          const key = stationKey(station);
          const eta = stationEtas[key] ?? { loading: true, error: null, arrivals: [] };
          const arrivals = (eta.arrivals ?? []).slice(0, STATION_CARD_ETA_MAX_ITEMS);
          const HeaderIcon = etaHeaderIcon(station);

          return (
            <div
              key={key}
              className="places-panel-station-tile"
              onClick={() => {
                // Tapping a station card both opens the popup
                // AND re-centres the map on the stop, replacing
                // the user's position as the viewport's centre.
                // Mirrors the Frequent tab's "show on map" action
                // (see `handleMapFocus` above) so the closest
                // stops list behaves the same way regardless of
                // how far the user has panned before tapping.
                // Falls back to a plain `onSelect` when the parent
                // didn't wire `onMapFocus`, so the tile still does
                // something useful (just no recentre).
                if (typeof onMapFocus === "function") {
                  onMapFocus(station);
                } else if (typeof onSelect === "function") {
                  onSelect(station);
                }
              }}
            >
              <div className="places-panel-station-tile-header">
                <div className="places-panel-station-icon">
                  <HeaderIcon className="h-4 w-4 text-white" strokeWidth={2.5} />
                </div>
                <div className="places-panel-station-info">
                  <div className="places-panel-station-name" title={station.name}>
                    {station.name || t("nearbyUnnamed")}
                  </div>
                </div>
                <button
                  type="button"
                  className={`places-panel-station-navigate${
                    activeRouteStationKey === key
                      ? " places-panel-station-navigate-active"
                      : ""
                  }`}
                  aria-label={
                    activeRouteStationKey === key
                      ? t("bottomSheetStationHideRoute")
                      : t("bottomSheetStationShowRoute")
                  }
                  aria-pressed={activeRouteStationKey === key}
                  title={
                    activeRouteStationKey === key
                      ? t("bottomSheetStationHideRoute")
                      : t("bottomSheetStationShowRoute")
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    // Pressing the navigate button now performs two
                    // actions in one tap:
                    //   1. Open the station info display box for this
                    //      stop (`.spot-popup-bottom-sheet`) so the
                    //      user lands on the same sheet that's used
                    //      when they tap a marker — that's where the
                    //      time / distance readout lives, not on
                    //      this card.
                    //   2. Draw (or clear) the in-app walking route
                    //      along the polyline already wired up to
                    //      `onShowRoute`.
                    //
                    // The two actions are wired to the same `key`
                    // (`${category}:${upstreamId}`) so the
                    // SpotPopup's "active" highlight + the route's
                    // red polyline toggle in lockstep — tapping the
                    // button again (route is already active) still
                    // dismisses both at once via
                    // `handleShowRoute`'s internal toggle.
                    if (typeof onMapFocus === "function") {
                      onMapFocus(station);
                    } else if (typeof onSelect === "function") {
                      onSelect(station);
                    }
                    if (typeof onShowRoute === "function") {
                      onShowRoute(station);
                    } else if (typeof openNavigation === "function") {
                      openNavigation(station);
                    }
                  }}
                >
                  {activeRouteStationKey === key ? (
                    <X className="h-3.5 w-3.5" />
                  ) : (
                    <Navigation className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>

              <div className="places-panel-station-eta-header">
                <span className="places-panel-station-eta-title">
                  {t("bottomSheetStationEtaTitle")}
                </span>
                {eta.loading && (
                  <Loader2 className="h-3 w-3 animate-spin text-[#6b7280]" />
                )}
              </div>

              <div className="places-panel-station-eta-list">
                {arrivals.length === 0 && !eta.loading && (
                  <div className="places-panel-station-no-eta">
                    {eta.error
                      ? t("tripPlanner.errorMessage")
                      : t("bottomSheetStationNoEta")}
                  </div>
                )}
                {arrivals.map((arr) => {
                  // Match the popup's badge logic — prefer the route's
                  // official first operator (`co[0]`) so a joint
                  // KMB↔CTB cross-harbour route (904, 914, 970, …)
                  // paints consistently in the popup and in this
                  // bottom card. Falls back to the per-stop `company`
                  // for non-joint routes.
                  const badge = pickRouteBadge({
                    routeNo: arr.routeNo,
                    company: Array.isArray(arr.co) && arr.co.length > 0
                      ? arr.co[0]
                      : arr.company,
                  });
                  return (
                    <div
                      key={arr.key}
                      className="places-panel-station-eta-row"
                    >
                      {badge.label != null && badge.label !== "" && (
                        <span
                          className="places-panel-station-eta-route"
                          style={{ background: badge.bg, color: badge.textColor }}
                        >
                          {badge.label}
                        </span>
                      )}
                      <span
                        className="places-panel-station-eta-dest"
                        title={arr.dest}
                      >
                        {arr.dest}
                      </span>
                      <span className="places-panel-station-eta-min">
                        {arr.minutes <= 0
                          ? t("bottomSheetStationArriving")
                          : `${arr.minutes} ${t("bottomSheetStationMin")}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderNearbyContent = () => {
    if (topNearby.length === 0) {
      return (
        <div className="places-panel-empty">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[10px] bg-[#f3f4f6]">
            <Loader2
              className={`h-6 w-6 text-[#6b7280] ${loading ? "animate-spin" : ""}`}
            />
          </div>
          <p className="mt-3 text-sm font-semibold text-[#1f2937]">
            {loading ? t("nearbyLoadingTitle") : t("nearbyEmptyTitle")}
          </p>
          <p className="mt-1 text-[12px] text-[#6b7280]">
            {loading ? t("nearbyLoadingDesc") : t("nearbyEmptyDesc")}
          </p>
          {!loading && (
            <p className="mt-1 text-[12px] text-[#9ca3af]">
              {t("nearbyEmptyAction")}
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="flex gap-3">
        {topNearby.map(({ spot, key }) => {
          const style = NEARBY_ROW_STYLE.toilets;
          const Icon = style.Icon;

          return (
            <div key={key} className="places-panel-tile">
              <div
                className={`places-panel-tile-icon ${style.iconBg}`}
                style={{ color: style.iconColor }}
              >
                <Icon className="h-9 w-9" strokeWidth={1.6} />
              </div>
              <p
                className="places-panel-tile-name"
                title={spot.name || spot.address || t("nearbyUnnamed")}
              >
                {spot.name || spot.address || t("nearbyUnnamed")}
              </p>
              <div className="places-panel-tile-actions">
                <button
                  type="button"
                  className="places-panel-tile-action"
                  onClick={() => {
                    if (typeof onSelect === "function") onSelect(spot);
                  }}
                >
                  <MapPin className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="places-panel-tile-action places-panel-tile-action--primary"
                  onClick={() => openNavigation(spot)}
                >
                  <Navigation className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderFrequentContent = () => {
    if (topFrequent.length === 0) {
      return (
        <div className="places-panel-empty">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[10px] bg-[#f3f4f6]">
            <MapPin className="h-6 w-6 text-[#6b7280]" />
          </div>
          <p className="mt-3 text-sm font-semibold text-[#1f2937]">
            {t("frequentEmptyTitle")}
          </p>
          <p className="mt-1 text-[12px] text-[#6b7280]">
            {t("frequentEmptyDesc")}
          </p>
        </div>
      );
    }

    // Same tile format as the nearby tab (renderNearbyContent):
    // every pinned place — regardless of category — renders as a
    // uniform `.places-panel-tile` (icon block + name + MapPin +
    // Navigation actions) inside a single horizontal flex row.
    // Previously bus stops used a wider `.places-panel-station-tile`
    // header layout, which broke the visual rhythm between the
    // nearby and frequent tabs.
    //
    // The MapPin action prefers `onMapFocus` (centres the map on
    // the pinned place AND opens its popup) and falls back to
    // `onSelect` if the parent didn't wire `onMapFocus`. We keep
    // the focus behaviour because user-pinned places can sit
    // anywhere on the map and would otherwise open a popup
    // off-screen. The Navigation action mirrors the nearby tab.
    const handleMapFocus = (place) => {
      if (typeof onMapFocus === "function") {
        onMapFocus(place);
      } else if (typeof onSelect === "function") {
        onSelect(place);
      }
    };

    return (
      <div className="flex gap-3">
        {topFrequent.map((place) => {
          const style =
            FREQUENT_PLACE_STYLE[place.category] ??
            FREQUENT_PLACE_STYLE.attractions;
          const Icon = style.Icon;

          return (
            <div key={place.id} className="places-panel-tile">
              <div
                className={`places-panel-tile-icon ${style.iconBg}`}
                style={{ color: style.iconColor }}
              >
                <Icon className="h-9 w-9" strokeWidth={1.6} />
              </div>
              <p
                className="places-panel-tile-name"
                title={place.name}
              >
                {place.name}
              </p>
              <div className="places-panel-tile-actions">
                <button
                  type="button"
                  className="places-panel-tile-action"
                  onClick={() => handleMapFocus(place)}
                >
                  <MapPin className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="places-panel-tile-action places-panel-tile-action--primary"
                  onClick={() => openNavigation(place)}
                >
                  <Navigation className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Settings tab: deliberately kept light — language picker and a
  // destructive "clear frequent places" control. We could grow this
  // later (units, default transport filter, recenter on launch,
  // etc.) without having to revisit the bottom sheet structure.
  //
  // The "clear" confirmation state and effect live at the top of
  // the component alongside the other hooks — only the rendering
  // below reads them.

  const renderSettingsContent = () => {
    const frequentCount = Array.isArray(frequentPlaces) ? frequentPlaces.length : 0;
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="rounded-[10px] border border-[#e5e7eb] bg-white p-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-[#6b7280]">
            <Settings className="h-3.5 w-3.5" />
            {t("settingsLanguageLabel")}
          </div>
          <div className="mt-2">
            <LanguageSwitcher />
          </div>
        </div>

        <div className="rounded-[10px] border border-[#e5e7eb] bg-white p-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-[#6b7280]">
            <Bookmark className="h-3.5 w-3.5" />
            {t("settingsFrequentHeading")}
          </div>
          <p className="mt-2 text-sm text-[#1f2937]">
            {t("settingsFrequentCount", { count: frequentCount })}
          </p>
          {confirmClearFrequent ? (
            <div className="mt-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] p-3">
              <p className="text-[13px] text-[#7f1d1d]">
                {t("settingsFrequentClearConfirm")}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleConfirmClearFrequent}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                  disabled={frequentCount === 0}
                >
                  {t("settingsFrequentClearYes")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearFrequent(false)}
                  className="rounded-md border border-[#e5e7eb] bg-white px-3 py-1.5 text-xs font-semibold text-[#1f2937] transition-colors hover:bg-[#f3f4f6]"
                >
                  {t("settingsFrequentClearNo")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClearFrequent(true)}
              disabled={frequentCount === 0}
              className="mt-3 rounded-md border border-[#fecaca] bg-[#fef2f2] px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settingsFrequentClear")}
            </button>
          )}
        </div>
      </div>
    );
  };

  const currentTab = TABS.find((tt) => tt.key === activeTab) ?? TABS[0];

  // Compose the sheet class list. `.places-panel` always sits on
  // the root; the modifier classes pick the height position
  // (`closed` / `expanded`) and re-add the dragging cursor. The
  // `hidden` modifier on the content area is left to CSS — we no
  // longer toggle it via JS, because the height jump on snap from
  // "closed" to "default" reveals the content as the panel grows
  // (CSS transition handles it).
  const panelClassName = `places-panel places-panel-${height}`;

  return (
    <div
      ref={sheetRef}
      className={panelClassName}
      role="region"
      aria-label={t(currentTab.labelKey)}
      // Mark the data-state so CSS can react to the current height
      // without re-deriving it from a class list. Kept in sync with
      // the class above; useful for debugging and for any selector
      // that prefers data-attributes.
      data-panel-height={height}
    >
      <div
        className="places-panel-handle md:hidden"
        role="button"
        aria-label={t("bottomSheetSizeHandle")}
        title={t("bottomSheetSizeHandle")}
        data-dragging={isHandleDragging ? "true" : undefined}
        // Pointer-event handlers drive the drag-to-resize gesture.
        // A tap (no movement past ~4 px) is forwarded to the click
        // handler in the hook, which collapses / re-expands the
        // sheet — matches the previous tap-to-collapse UX.
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
      />

      <div className="places-panel-tabs" role="tablist">
        {TABS.map((tab) => {
          const TabIcon = tab.Icon;
          // Use `shortLabelKey` for the inline label rendered under
          // the icon (the four tabs share the available width on
          // mobile, so the full `labelKey` strings like "Closest
          // Station" / "Frequent Places" would clip or wrap
          // awkwardly). The full label still drives the
          // accessibility name and tooltip so screen readers and
          // mouse-hover see the descriptive title.
          const shortLabel = tab.shortLabelKey ? t(tab.shortLabelKey) : t(tab.labelKey);
          const fullLabel = t(tab.labelKey);
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-label={fullLabel}
              title={fullLabel}
              className={`places-panel-tab places-panel-tab-icon ${
                activeTab === tab.key ? "places-panel-tab-active" : ""
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {/* Stack the icon on top and the short label below.
                  `places-panel-tab-icon` is now a flex column
                  (see globals.css) so the two children land
                  vertically with the icon centred above the text. */}
              {TabIcon && <TabIcon className="h-5 w-5" strokeWidth={2.25} aria-hidden="true" />}
              {shortLabel && (
                <span className="places-panel-tab-label">{shortLabel}</span>
              )}
            </button>
          );
        })}
      </div>

      <div
        className={`places-panel-content ${height === "closed" ? "hidden" : ""}`}
        // aria-hidden keeps the tab content out of the a11y tree
        // while the sheet is collapsed to the handle bar only.
        aria-hidden={height === "closed"}
      >
        {activeTab === "closest" && renderClosestContent()}
        {activeTab === "nearby" && renderNearbyContent()}
        {activeTab === "frequent" && renderFrequentContent()}
        {activeTab === "settings" && renderSettingsContent()}
      </div>
    </div>
  );
}
