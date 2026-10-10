// =============================================================================
// HeroMap Component
// Main map component that renders markers for attractions and toilets,
// and handles the PlacesPanel.
// =============================================================================

"use client";

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GoogleMap, useJsApiLoader } from "@react-google-maps/api";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { useLocale } from "@/contexts/LocaleContext";
import { Loader2, Locate, Toilet, MapPin, Bus, Train, TramFront, Ship } from "lucide-react";

import { GOOGLE_MAPS_LIBRARIES } from "@/lib/googleMaps";
import { attachMarkerHover } from "@/lib/mapHover";
import {
  fetchRoute,
  viewportToBounds,
  pathToBounds,
} from "@/lib/routesApi";
import PlacesPanel from "@/components/PlacesPanel";
import SpotPopup from "@/components/SpotPopup";

// Import from parent directory modules
import {
  HK_CENTER,
  MAP_CONTAINER_STYLE,
  DEFAULT_MAP_OPTIONS,
  DEFAULT_ZOOM,
  SPOT_MARKER_SIZE_SELECTED,
  CLUSTER_MARKER_SIZE,
  MAJOR_MARKER_SIZE,
  PULSE_RING_PX,
  radiusForZoom,
  getSpotColor,
  markerSizeForSpot,
  categoryLabel,
  CATEGORY_ICON_NAME,
  // Pre-existing constant kept for transport-stop pile-up handling.
  // `TRANSPORT_OVERLAP_CLUSTER_GRID_PX` is what the clusterer grid
  // algorithm actually uses, so we feed it through as `gridSize`
  // below.
  TRANSPORT_OVERLAP_CLUSTER_GRID_PX,
  // Cap above the home page's default zoom (18) so overlapping
  // transit stops cluster on the first frame, not just after the
  // user zooms out — see the constant's doc-comment for details.
  MAX_CLUSTER_ZOOM,
} from "../constants";

import {
  fetchNearbyToilets,
  fetchNearbyBusStops,
  fetchNearbyMtrStops,
  fetchNearbyLightRailStops,
  fetchNearbyFerryPiers,
  fetchNearbyTramStops,
} from "../api";

import { TOURIST_SPOTS } from "../spots";

// Module-level cache for the per-marker icon SVG strings.
//
// `renderToStaticMarkup(createElement(IconComponent, …))` runs once
// per marker per rebuild; with ~900 markers on the home map that's a
// noticeable frame-cost during gestures. Each (iconName, size) pair
// produces a deterministic string, so we memoize at module scope and
// reuse the cached HTML across every marker and every rebuild.
const ICON_COMPONENT_BY_NAME = {
  Toilet,
  MapPin,
  Bus,
  Train,
  TramFront,
  Ship,
};
const ICON_SVG_CACHE = new Map();

function iconSvgMarkup(name, size) {
  const key = `${name}:${size}`;
  const cached = ICON_SVG_CACHE.get(key);
  if (cached !== undefined) return cached;
  const Component = ICON_COMPONENT_BY_NAME[name] ?? MapPin;
  const html = renderToStaticMarkup(
    createElement(Component, { size, strokeWidth: 2.5 })
  );
  ICON_SVG_CACHE.set(key, html);
  return html;
}

// Phase 4 (memory): hard cap on per-category nearby-spot slots in
// `HeroMap`. The map carries six nearby-spot arrays (`nearbyToilets`,
// `nearbyBusStops`, `nearbyMtrStations`, `nearbyLightRailStops`,
// `nearbyFerryPiers`, `nearbyTramStops`). Each entry is a spot object
// with ~10 fields (id, name, lat/lng, distanceMetres, category,
// upstreamId, etc.) — at the upstream API's `limit=200` default,
// that's ~1.2 MB resident per category, 7 MB across all six slots.
//
// `MAX_NEARBY_PER_CATEGORY` mirrors the upstream `limit=200` ceiling
// that the server already enforces, so under normal use it has no
// effect. It guards against a future change (or an upstream API
// returning more than `limit`) that would push a single slot above
// the cap, and keeps the React state graph predictable for
// measurement purposes.
const MAX_NEARBY_PER_CATEGORY = 200;

/**
 * Phase 4 helper — trim an array to `MAX_NEARBY_PER_CATEGORY`. Pure
 * function, no React state — call before passing the array to a
 * setter.
 */
function capNearby(items) {
  if (!Array.isArray(items)) return [];
  return items.length > MAX_NEARBY_PER_CATEGORY
    ? items.slice(0, MAX_NEARBY_PER_CATEGORY)
    : items;
}

/**
 * HeroMap - Main map component for the home page
 */
export default function HeroMap({
  query,
  activeFilter,
  searchResults,
  t,
  onPinPlace,
  onNearbyUpdate,
  onInfoWindowClose,
  destination,
  placesPanelTab,
  onPlacesPanelTabChange,
  placesPanelDismissed,
  onPlacesPanelDismiss,
  placesPanelCollapsed,
  onPlacesPanelCollapsedChange,
  onRemoveFrequentPlace,
  onClearFrequentPlaces,
  frequentPlaces,
}) {
  const { locale } = useLocale();
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
    libraries: GOOGLE_MAPS_LIBRARIES,
  });

  const mapRef = useRef(null);
  const markersRef = useRef({ clusterer: null, markers: [], byId: new Map() });
  const userMarkerRef = useRef(null);
  // Routes API v2 renders the walking line as a plain
  // `google.maps.Polyline` whose vertices we decode from the
  // `polyline.encodedPolyline` field returned by /api/routes. We
  // keep both the polyline and an in-flight AbortController on refs
  // so a quick second click can cancel the previous request before
  // its setPath() call stomps on the newer result.
  const routePolylineRef = useRef(null);
  const routeAbortRef = useRef(null);
  const didCenterOnUserRef = useRef(false);
  const nearbyFetchId = useRef(0);
  const busStopFetchId = useRef(0);
  const mtrStopFetchId = useRef(0);
  const lightRailStopFetchId = useRef(0);
  const ferryPierFetchId = useRef(0);
  const tramStopFetchId = useRef(0);
  const programmaticMoveRef = useRef(false);
  const lastQueriedCentreRef = useRef(null);
  // Mirror of `selected` so the marker effect (which intentionally
  // omits `selected` from its deps, see "Marker rendering" below)
  // can read the current selection via a ref without re-running the
  // effect on every tap.
  const selectedRef = useRef(null);
  // Tracks the previously-selected spot id so the selection-resize
  // effect can revert only that one dot back to its unselected
  // appearance, instead of restyling every marker on the map.
  const prevSelectedIdRef = useRef(null);
  // True while the user is mid-gesture (panning or pinch-zooming).
  // Used by the `idle` listener to coalesce the burst of
  // zoom_changed events into a single nearby-refresh on settle.
  const gesturingRef = useRef(false);
  // Increments every time the marker effect finishes a rebuild.
  // The selection-styling effect listens to this so a nearby-fetch
  // result that rebuilds the marker array still re-applies the
  // current selection to the freshly-created dots (otherwise a tap
  // that was already selected would briefly lose its highlight).
  const [markersBuiltVersion, setMarkersBuiltVersion] = useState(0);
  const [selected, setSelected] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  // Tracks whether `handleMapLoad` has fired, i.e. the underlying
  // `google.maps.Map` instance has been instantiated and `mapRef`
  // is populated. The "center on user first time" effect needs
  // both `userLocation` and a live map instance before it can call
  // `panTo`; watching `userLocation` alone races against the
  // Google Maps script load (geolocation typically resolves first,
  // leaving `mapRef.current === null` and the early-return path
  // never re-firing).
  const [isMapReady, setIsMapReady] = useState(false);
  // `routeStationKey` tracks which station's in-app walking route
  // is currently drawn on the map. When the user clicks the
  // top-right route button on a card we set this to that station's
  // key (`${category}:${upstreamId}`); when the same button is
  // clicked again we clear it so the polyline disappears.
  // `null` means "no route currently shown".
  const [routeStationKey, setRouteStationKey] = useState(null);
  // Companion to `routeStationKey`: the time / distance the Routes
  // API reported for the active walking polyline, surfaced by
  // `PlacesPanel` as a small "🚶 5 min · 350 m" pill next to the
  // navigate button. `null` whenever no route is on screen OR the
  // last request failed (toggle-off / cancelled / empty path /
  // upstream error). `key` mirrors `routeStationKey` so the panel
  // can match it to the right station card.
  const [routeInfo, setRouteInfo] = useState(null);
  const [nearbyToilets, setNearbyToilets] = useState([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyQuery, setNearbyQuery] = useState(null);
  const [nearbyBusStops, setNearbyBusStops] = useState([]);
  const [busStopsLoading, setBusStopsLoading] = useState(false);
  const [nearbyMtrStations, setNearbyMtrStations] = useState([]);
  const [mtrStationsLoading, setMtrStationsLoading] = useState(false);
  const [nearbyLightRailStops, setNearbyLightRailStops] = useState([]);
  const [lightRailStopsLoading, setLightRailStopsLoading] = useState(false);
  const [nearbyFerryPiers, setNearbyFerryPiers] = useState([]);
  const [ferryPiersLoading, setFerryPiersLoading] = useState(false);
  const [nearbyTramStops, setNearbyTramStops] = useState([]);
  const [tramStopsLoading, setTramStopsLoading] = useState(false);

  // Import icon components dynamically
  // Keep `selectedRef` in sync so the marker effect (which omits
  // `selected` from its deps) can read the current selection
  // through a ref instead of forcing a full marker rebuild on
  // every tap.
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  // Same trick for the resolved `displayedSpot` — it's derived
  // from a handful of upstream sources (active spot / focused
  // frequent place) and is the value the close handler needs to
  // decide whether the active route belongs to the spot being
  // dismissed. Reading from a ref keeps the helper independent
  // of `displayedSpot`'s identity churn.
  const displayedSpotRef = useRef(null);

  // Merge search results with nearby spots for display on map
  const searchResultSpots = useMemo(() => {
    if (!searchResults || !searchResults.results) return [];
    const spots = [];
    for (const [type, items] of Object.entries(searchResults.results)) {
      for (const item of items) {
        spots.push({
          id: item.id || `${type}-${Math.random()}`,
          name: item.name,
          category: type === "attraction" ? "attractions" : type,
          lat: item.lat,
          lng: item.lng,
          address: item.address,
          district: item.district,
          barrierFree: item.barrierFree,
          distanceMetres: item.distanceMetres,
          poiType: type,
        });
      }
    }
    return spots;
  }, [searchResults]);

  const nearbySpots = useMemo(
    () => [
      ...nearbyToilets,
      ...nearbyBusStops,
      ...nearbyMtrStations,
      ...nearbyLightRailStops,
      ...nearbyFerryPiers,
      ...nearbyTramStops,
    ],
    [
      nearbyToilets,
      nearbyBusStops,
      nearbyMtrStations,
      nearbyLightRailStops,
      nearbyFerryPiers,
      nearbyTramStops,
    ]
  );

  const allSpotsWithSearch = useMemo(
    () => [...nearbySpots, ...searchResultSpots, ...TOURIST_SPOTS],
    [nearbySpots, searchResultSpots]
  );

  // Compute the resolved spot here (BEFORE the early-return
  // branches below) so the sync effect below it is called
  // unconditionally on every render. Putting the computation /
  // effect after the `!isLoaded` early return made the hook
  // appear only after the Google Maps script finished loading,
  // which violates the Rules of Hooks.
  const activeSpot = allSpotsWithSearch.find((s) => s.id === selected);
  // When the user focuses a frequent bus stop from the bottom-sheet
  // panel, the spot may live OUTSIDE the current map viewport (e.g.
  // they pinned a bus stop at home, then panned to work). In that
  // state the spot isn't in `allSpotsWithSearch`, so the lookup
  // above returns nothing and the popup tag would never show.
  //
  // Fall back to the frequent-places list so the popup still renders
  // for the just-focused stop. The map marker for out-of-view stops
  // still doesn't exist on the map (it would have to be fetched
  // first), but the popup overlays the stop's last-known coordinates
  // which is exactly what the user asked for via the bottom-sheet
  // button — a tap that says "show me this stop".
  const focusedFrequentSpot =
    activeSpot == null && selected
      ? frequentPlaces.find((p) => p.id === selected) ?? null
      : null;
  const displayedSpot = activeSpot ?? focusedFrequentSpot;
  useEffect(() => {
    displayedSpotRef.current = displayedSpot ?? null;
  }, [displayedSpot]);

  const normalizedQuery = query.trim().toLowerCase();
  const normalizedDestination = destination.trim().toLowerCase();

  // Filter predicate for hero filter chips
  const matchesHeroFilter = (spot, filterKey) => {
    if (!filterKey) return true;
    switch (filterKey) {
      case "toilets":
        return spot.category === "toilets";
      case "attractions":
        return spot.category === "attractions";
      case "busStops":
        return spot.category === "busStops";
      case "mtrStations":
        return spot.category === "mtrStations";
      case "lightRailStops":
        return spot.category === "lightRailStops";
      case "ferryPiers":
        return spot.category === "ferryPiers";
      case "tramStops":
        return spot.category === "tramStops";
      default:
        return true;
    }
  };

  // Filter pipeline
  const visibleSpots = useMemo(() => {
    let pool = activeFilter
      ? allSpotsWithSearch.filter((s) => matchesHeroFilter(s, activeFilter))
      : allSpotsWithSearch;

    if (!normalizedQuery) return pool;
    return pool.filter((s) => {
      const label = categoryLabel(s.category, t).toLowerCase();
      return (
        s.name.toLowerCase().includes(normalizedQuery) ||
        label.includes(normalizedQuery)
      );
    });
  }, [normalizedQuery, t, allSpotsWithSearch, activeFilter]);

  // The N closest transport stops (or stations) near the user's map
  // centre. Drives the "Closest Station" tab in the bottom sheet,
  // which renders each result as its own horizontally-scrolling card
  // and fires one /api/<type>/eta request per card.
  //
  // The candidate pool passed to PlacesPanel is intentionally larger
  // than the displayed card count. PlacesPanel renders the top
  // CLOSEST_STATIONS_LIMIT (5) cards, and swaps any station whose
  // live ETA fetch came back with zero arrivals for the next-nearest
  // candidate that DOES have arrivals. Keeping ~3× the displayed
  // count here gives the swap selector enough room to find a useful
  // replacement in dense areas (e.g. Mong Kok, where dozens of bus
  // stops sit within walking distance but only a subset run services
  // at any given moment).
  //
  // Searches the already-fetched nearby pools for bus stops, MTR
  // stations, Light Rail stops, ferry piers, and HK Tramways tram
  // stops, then returns the nearest CLOSEST_STATIONS_CANDIDATES_LIMIT
  // entries that have valid coordinates. Falls back to `[]` when all
  // catalogues are empty (e.g. before the first nearby query
  // resolves).
  const CLOSEST_STATIONS_CANDIDATES_LIMIT = 15;
  const closestStations = useMemo(() => {
    const pools = [
      nearbyBusStops,
      nearbyMtrStations,
      nearbyLightRailStops,
      nearbyFerryPiers,
      nearbyTramStops,
    ];
    const merged = pools.flat().filter(
      (s) =>
        Number.isFinite(s?.lat) &&
        Number.isFinite(s?.lng) &&
        typeof s.upstreamId === "string"
    );
    if (merged.length === 0) return [];
    const sorted = [...merged].sort((a, b) => {
      const da =
        typeof a.distanceMetres === "number"
          ? a.distanceMetres
          : Number.POSITIVE_INFINITY;
      const db =
        typeof b.distanceMetres === "number"
          ? b.distanceMetres
          : Number.POSITIVE_INFINITY;
      return da - db;
    });
    return sorted.slice(0, CLOSEST_STATIONS_CANDIDATES_LIMIT);
  }, [
    nearbyBusStops,
    nearbyMtrStations,
    nearbyLightRailStops,
    nearbyFerryPiers,
    nearbyTramStops,
  ]);

  const handleMapLoad = useCallback((map) => {
    mapRef.current = map;
    setIsMapReady(true);

    // Create the route polyline here, while we already know the map
    // instance exists. Previously this lived in a separate `useEffect`
    // that depended on `isLoaded` alone; that effect's body
    // short-circuited on `!mapRef.current` because `mapRef` is a ref
    // and therefore not a reactive trigger — by the time the map was
    // ready, the effect had already run once with the wrong shape and
    // would never re-run, so the polyline was never instantiated and
    // `handleShowRoute` silently bailed on its `if (!polyline)
    // return;` guard, leaving the navigate button a no-op. Adding
    // `isMapReady` to the dep list would have fixed the bug too, but
    // it would also leave us with a redundant effect that just
    // watches for a state we set right here. Instantiating the
    // polyline directly on map load keeps the responsibility local
    // and removes one effect from the render cycle.
    if (
      window.google?.maps?.Polyline &&
      !routePolylineRef.current
    ) {
      routePolylineRef.current = new window.google.maps.Polyline({
        // Initially detached — handleShowRoute() calls setMap() when
        // it has a decoded path to render. Stroking is identical to
        // the previous DirectionsRenderer defaults so the visual
        // upgrade is invisible to the user.
        path: [],
        geodesic: true,
        strokeColor: "#1a73e8",
        strokeOpacity: 0.9,
        strokeWeight: 5,
        clickable: false,
      });
    }

    // The previous implementation wired `onDragEnd` and
    // `onZoomChanged` (continuous during pinch-zoom) to a single
    // handler that scheduled a nearby-refetch on every event. That
    // produced a thundering herd of fetches during a single gesture.
    //
    // Replace that with Google's native listeners: flag the gesture
    // as in-flight on `dragstart` / `zoom_changed`, and flush a
    // single fetch on `idle` (fires once when the map settles).
    if (window.google?.maps?.event) {
      map.addListener("dragstart", () => {
        gesturingRef.current = true;
      });
      map.addListener("zoom_changed", () => {
        gesturingRef.current = true;
        const zoom = map.getZoom();
        const center = map.getCenter();
        console.log("[HeroMap] zoom_changed", {
          zoom,
          lat: center?.lat(),
          lng: center?.lng(),
        });
      });
      map.addListener("idle", () => {
        gesturingRef.current = false;
        flushNearbyQueryFromMapRef.current?.();
      });
    }
  }, []);

  // Component-level unmount cleanup. We do NOT touch the polyline
  // on normal re-renders (the lazy-init effect above already keeps
  // a single instance alive), but on a true unmount we should tear
  // down the in-flight request and detach the polyline from the
  // map so nothing leaks between page navigations.
  useEffect(() => {
    return () => {
      if (routeAbortRef.current) {
        routeAbortRef.current.abort();
        routeAbortRef.current = null;
      }
      if (routePolylineRef.current) {
        routePolylineRef.current.setMap(null);
        routePolylineRef.current = null;
      }
      setRouteInfo(null);
    };
  }, []);

  // Geolocation
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Draw (or clear) the in-app walking route from the user's current
  // location to the selected destination dot. Called by the
  // top-right route button on every closest-station card and (in
  // the future) any destination the user picks on the map.
  //
  // Powered by the Google Maps Routes API v2 via the /api/routes
  // proxy (see src/lib/routesApi.js). The proxy returns the route
  // as an `encodedPolyline` that we decode through the `geometry`
  // library and hand to `routePolylineRef.current.setPath()`.
  //
  // Behaviour:
  //   - If the same destination is requested twice in a row, the
  //     route is cleared (toggle).
  //   - If a different destination is requested, the existing
  //     polyline is replaced with the new one (any in-flight
  //     request is aborted first to avoid a stale setPath()).
  //   - Walking is the default travel mode — the closest-station
  //     tab is by definition short-distance and "stations within
  //     walking distance" is what users typically want to confirm.
  //   - Origin falls back to the map centre if geolocation is
  //     unavailable (e.g. permission denied), so the button still
  //     does something useful in that case.
  const handleShowRoute = useCallback(
    async (station) => {
      if (!isLoaded || !mapRef.current) return;
      if (
        !station ||
        !Number.isFinite(station.lat) ||
        !Number.isFinite(station.lng)
      ) {
        return;
      }
      const key = `${station.category ?? "unknown"}:${station.upstreamId ?? station.id ?? "?"}`;
      const polyline = routePolylineRef.current;
      if (!polyline) return;

      // Toggle off when the same destination is requested again.
      if (routeStationKey === key) {
        if (routeAbortRef.current) {
          routeAbortRef.current.abort();
          routeAbortRef.current = null;
        }
        polyline.setMap(null);
        polyline.setPath([]);
        setRouteStationKey(null);
        setRouteInfo(null);
        return;
      }

      const origin = userLocation
        ? { lat: userLocation.lat, lng: userLocation.lon }
        : mapRef.current.getCenter()?.toJSON();
      if (!origin) return;

      // Cancel any in-flight route request before we kick off a new
      // one — otherwise a slow first response could overwrite the
      // second click's result.
      if (routeAbortRef.current) {
        routeAbortRef.current.abort();
      }
      const controller = new AbortController();
      routeAbortRef.current = controller;

      try {
        const { routes } = await fetchRoute({
          origin,
          destination: { lat: station.lat, lng: station.lng },
          travelMode: "WALK",
          signal: controller.signal,
        });
        // Bail out if a newer click already replaced us while we
        // were waiting on the network.
        if (routeAbortRef.current !== controller) return;

        const firstRoute = routes[0];
        if (!firstRoute || firstRoute.path.length === 0) {
          // Walking failed (e.g. no pedestrian path) — clear any
          // existing route and surface the failure by leaving
          // routeStationKey as null so the next click retries.
          polyline.setMap(null);
          polyline.setPath([]);
          setRouteStationKey(null);
          setRouteInfo(null);
          return;
        }

        polyline.setPath(firstRoute.path);
        polyline.setMap(mapRef.current);
        // Fit the map to the route so the user can see both ends
        // and every turn in between. Prefer the viewport the API
        // returned (covers neighbouring geometry Google picked);
        // fall back to the bounds of the decoded path when none
        // is supplied. `fitBounds` alone would pinch the camera
        // in to the tightest zoom that still contains the
        // polyline, which on a short walking route leaves the
        // user staring at a single street with no context.
        // Stepping the zoom out by 1 stop gives the polyline
        // breathing room — and because `setZoom` is called in
        // the same tick as `fitBounds`, Google Maps collapses
        // the two into a single smooth pan/zoom motion instead
        // of playing "zoom in, then shrink" back to back. (The
        // earlier implementation waited for an `idle` event
        // before stepping out, which produced exactly that
        // two-step animation and felt jerky.)
        const bounds = viewportToBounds(firstRoute.viewport) ?? pathToBounds(firstRoute.path);
        if (bounds) {
          const map = mapRef.current;
          map.fitBounds(bounds);
          // `fitBounds` updates the internal target zoom
          // synchronously even though the visible animation is
          // async, so `getZoom()` right after the call returns
          // the would-be natural zoom for these bounds. We then
          // rewrite that target to "natural minus 1" in the same
          // animation frame; the two motions merge into one.
          const naturalZoom = map.getZoom();
          if (typeof naturalZoom === "number") {
            map.setZoom(Math.max(naturalZoom - 1, 1));
          }
        }
        setRouteStationKey(key);
        // Surface the time / distance the API returned so the
        // station card can render a "🚶 5 min · 350 m" pill next
        // to the navigate button. `routeInfo.key` deliberately
        // echoes `routeStationKey` so the card can match it to
        // the right station.
        setRouteInfo({
          key,
          duration: firstRoute.duration,
          distanceMeters: firstRoute.distanceMeters,
        });
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (routeAbortRef.current !== controller) return;
        console.error("[HeroMap] fetchRoute failed", err);
        polyline.setMap(null);
        polyline.setPath([]);
        setRouteStationKey(null);
        setRouteInfo(null);
      }
    },
    [isLoaded, userLocation, routeStationKey]
  );

  // Dismiss the currently-selected spot's tag (and, if the in-app
  // route was drawn for that exact spot, the route too). Used by
  // the SpotPopup's close button, the map-click-to-dismiss
  // handler, and the marker toggle so all three paths behave
  // identically: the tag disappears together with its polyline.
  // Routes drawn for a *different* stop (e.g. one still visible
  // from the bottom-sheet tab) are left alone — the close action
  // is scoped to the spot being dismissed.
  const dismissSelectedSpot = useCallback(() => {
    const current = selectedRef.current;
    if (current == null) return;
    setSelected(null);
    if (typeof onInfoWindowClose === "function") {
      onInfoWindowClose();
    }
    const spot = displayedSpotRef.current;
    if (
      spot &&
      routeStationKey ===
        `${spot.category ?? "unknown"}:${spot.upstreamId ?? spot.id ?? "?"}`
    ) {
      // Reuse the same toggle path the card / popup button takes
      // when the user clicks the active route again — guarantees
      // the polyline, abort controller, and `routeInfo` are all
      // torn down in lockstep.
      handleShowRoute(spot);
    }
  }, [handleShowRoute, onInfoWindowClose, routeStationKey]);

  const activeQuery = useMemo(() => {
    if (nearbyQuery) return nearbyQuery;
    if (userLocation) {
      return { lat: userLocation.lat, lon: userLocation.lon, zoom: DEFAULT_ZOOM };
    }
    return null;
  }, [nearbyQuery, userLocation]);

  // Nearby update callback ref
  const onNearbyUpdateRef = useRef(onNearbyUpdate);
  useEffect(() => {
    onNearbyUpdateRef.current = onNearbyUpdate;
  }, [onNearbyUpdate]);

  // Fetch nearby toilets
  useEffect(() => {
    if (!activeQuery) {
      lastQueriedCentreRef.current = null;
      setNearbyToilets([]);
      setNearbyLoading(false);
      if (typeof onNearbyUpdateRef.current === "function") {
        onNearbyUpdateRef.current({ toilets: [], loading: false });
      }
      return;
    }
    const fetchId = ++nearbyFetchId.current;
    lastQueriedCentreRef.current = {
      lat: activeQuery.lat,
      lon: activeQuery.lon,
      zoom: activeQuery.zoom,
    };
    setNearbyLoading(true);
    if (typeof onNearbyUpdateRef.current === "function") {
      onNearbyUpdateRef.current({ toilets: [], loading: true });
    }
    (async () => {
      try {
        const toilets = await fetchNearbyToilets({
          lat: activeQuery.lat,
          lon: activeQuery.lon,
          locale,
          maxDistance: radiusForZoom(activeQuery.zoom),
        });
        if (fetchId !== nearbyFetchId.current) return;
        setNearbyToilets(capNearby(toilets));
        if (typeof onNearbyUpdateRef.current === "function") {
          onNearbyUpdateRef.current({ toilets, loading: false });
        }
      } catch {
        if (fetchId !== nearbyFetchId.current) return;
        setNearbyToilets([]);
        if (typeof onNearbyUpdateRef.current === "function") {
          onNearbyUpdateRef.current({ toilets: [], loading: false });
        }
      } finally {
        if (fetchId === nearbyFetchId.current) setNearbyLoading(false);
      }
    })();
  }, [activeQuery, locale]);

  // Fetch nearby bus stops whenever the map moves. Mirrors the toilet
  // fetch logic so the two layers stay in lockstep — both refresh on
  // pan / zoom and both clear when there's no centre to query.
  useEffect(() => {
    if (!activeQuery) {
      setNearbyBusStops([]);
      setBusStopsLoading(false);
      return;
    }
    const fetchId = ++busStopFetchId.current;
    setBusStopsLoading(true);
    (async () => {
      try {
        const stops = await fetchNearbyBusStops({
          lat: activeQuery.lat,
          lon: activeQuery.lon,
          locale,
          maxDistance: radiusForZoom(activeQuery.zoom),
        });
        if (fetchId !== busStopFetchId.current) return;
        setNearbyBusStops(capNearby(stops));
      } catch {
        if (fetchId !== busStopFetchId.current) return;
        setNearbyBusStops([]);
      } finally {
        if (fetchId === busStopFetchId.current) setBusStopsLoading(false);
      }
    })();
  }, [activeQuery, locale]);

  // Fetch nearby MTR stations whenever the map moves.
  useEffect(() => {
    if (!activeQuery) {
      setNearbyMtrStations([]);
      setMtrStationsLoading(false);
      return;
    }
    const fetchId = ++mtrStopFetchId.current;
    setMtrStationsLoading(true);
    (async () => {
      try {
        const stations = await fetchNearbyMtrStops({
          lat: activeQuery.lat,
          lon: activeQuery.lon,
          locale,
          maxDistance: radiusForZoom(activeQuery.zoom),
        });
        if (fetchId !== mtrStopFetchId.current) return;
        setNearbyMtrStations(capNearby(stations));
      } catch {
        if (fetchId !== mtrStopFetchId.current) return;
        setNearbyMtrStations([]);
      } finally {
        if (fetchId === mtrStopFetchId.current) setMtrStationsLoading(false);
      }
    })();
  }, [activeQuery, locale]);

  // Fetch nearby Light Rail stops whenever the map moves.
  useEffect(() => {
    if (!activeQuery) {
      setNearbyLightRailStops([]);
      setLightRailStopsLoading(false);
      return;
    }
    const fetchId = ++lightRailStopFetchId.current;
    setLightRailStopsLoading(true);
    (async () => {
      try {
        const stops = await fetchNearbyLightRailStops({
          lat: activeQuery.lat,
          lon: activeQuery.lon,
          locale,
          maxDistance: radiusForZoom(activeQuery.zoom),
        });
        if (fetchId !== lightRailStopFetchId.current) return;
        setNearbyLightRailStops(capNearby(stops));
      } catch {
        if (fetchId !== lightRailStopFetchId.current) return;
        setNearbyLightRailStops([]);
      } finally {
        if (fetchId === lightRailStopFetchId.current) setLightRailStopsLoading(false);
      }
    })();
  }, [activeQuery, locale]);

  // Fetch nearby ferry piers whenever the map moves.
  useEffect(() => {
    if (!activeQuery) {
      setNearbyFerryPiers([]);
      setFerryPiersLoading(false);
      return;
    }
    const fetchId = ++ferryPierFetchId.current;
    setFerryPiersLoading(true);
    (async () => {
      try {
        const piers = await fetchNearbyFerryPiers({
          lat: activeQuery.lat,
          lon: activeQuery.lon,
          locale,
          maxDistance: radiusForZoom(activeQuery.zoom),
        });
        if (fetchId !== ferryPierFetchId.current) return;
        setNearbyFerryPiers(capNearby(piers));
      } catch {
        if (fetchId !== ferryPierFetchId.current) return;
        setNearbyFerryPiers([]);
      } finally {
        if (fetchId === ferryPierFetchId.current) setFerryPiersLoading(false);
      }
    })();
  }, [activeQuery, locale]);

  // Fetch nearby HK Tramways (Ding Ding) tram stops whenever the map
  // moves. Trams run exclusively on the Hong Kong Island north shore
  // between Kennedy Town and Shau Kei Wan (plus the Happy Valley
  // loop), so this list is small and stable. We keep the radius wide
  // — trams span ~13 km end-to-end, and the user can pan anywhere.
  useEffect(() => {
    if (!activeQuery) {
      setNearbyTramStops([]);
      setTramStopsLoading(false);
      return;
    }
    const fetchId = ++tramStopFetchId.current;
    setTramStopsLoading(true);
    (async () => {
      try {
        const stops = await fetchNearbyTramStops({
          lat: activeQuery.lat,
          lon: activeQuery.lon,
          locale,
          maxDistance: radiusForZoom(activeQuery.zoom),
        });
        if (fetchId !== tramStopFetchId.current) return;
        setNearbyTramStops(capNearby(stops));
      } catch {
        if (fetchId !== tramStopFetchId.current) return;
        setNearbyTramStops([]);
      } finally {
        if (fetchId === tramStopFetchId.current) setTramStopsLoading(false);
      }
    })();
  }, [activeQuery, locale]);

  // Map view → nearby-refresh flush.
  //
  // Replaces the previous `handleMapViewChanged`, which was wired to
  // `onDragEnd` / `onZoomChanged` (continuous during pinch-zoom) and
  // therefore fired once per intermediate frame during a single
  // gesture. The new wiring (see `handleMapLoad`) calls this from
  // Google's `idle` event, which fires exactly once when the map
  // settles, so we coalesce each gesture into one fetch.
  //
  // Returns early on programmatic moves (`panTo` after a marker
  // click) so a tap doesn't also trigger a background refresh.
  const flushNearbyQueryFromMap = useCallback(() => {
    if (programmaticMoveRef.current) {
      programmaticMoveRef.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    const center = map.getCenter();
    if (!center) return;
    const lat = center.lat();
    const lon = center.lng();
    const zoom = map.getZoom();
    const last = lastQueriedCentreRef.current;
    if (last) {
      const movedFar =
        Math.sqrt(Math.pow(lat - last.lat, 2) + Math.pow(lon - last.lon, 2)) * 111000 >= 200;
      const zoomChanged =
        zoom != null &&
        last.zoom != null &&
        Math.abs(zoom - last.zoom) >= 0.75;
      if (!movedFar && !zoomChanged) return;
    }
    setNearbyQuery({ lat, lon, zoom });
  }, []);

  // The `idle` listener is attached in `handleMapLoad` (runs once)
  // and needs to invoke the *latest* `flushNearbyQueryFromMap`. We
  // mirror the function on a ref so the long-lived listener doesn't
  // capture a stale closure.
  const flushNearbyQueryFromMapRef = useRef(flushNearbyQueryFromMap);
  useEffect(() => {
    flushNearbyQueryFromMapRef.current = flushNearbyQueryFromMap;
  }, [flushNearbyQueryFromMap]);

  // Map click handler
  const handleMapClick = useCallback(() => {
    if (selected == null) return;
    dismissSelectedSpot();
  }, [selected, dismissSelectedSpot]);

  // Re-center on user
  const handleRecenterOnUser = useCallback(() => {
    const map = mapRef.current;
    if (!map || !userLocation) return;
    programmaticMoveRef.current = true;
    map.panTo({ lat: userLocation.lat, lng: userLocation.lon });
    map.setZoom(DEFAULT_ZOOM);
    lastQueriedCentreRef.current = {
      lat: userLocation.lat,
      lon: userLocation.lon,
      zoom: DEFAULT_ZOOM,
    };
    setNearbyQuery(null);
  }, [userLocation]);

  // Cluster chip click handler.
  //
  // The `MarkerClusterer` library's default behaviour is
  // `map.fitBounds(cluster.bounds)`, which zooms in to whatever
  // level is required to fit the cluster's bounds. For a small
  // pile — two bus stops on opposite corners of one junction —
  // those bounds are tiny, so the default click shot the camera
  // from the home page's natural zoom (DEFAULT_ZOOM = 18) all the
  // way up to 20/21, leaving the user staring at building façades
  // with the cluster still on top of them.
  //
  // Override the default so the cluster chip behaves like the
  // "center on user" button: pan to the cluster's position and
  // lock the zoom at DEFAULT_ZOOM. The pile is now centred in the
  // viewport at the same zoom the rest of the home page uses, so
  // any nearby stops on adjacent corners are still readable and
  // the user can pinch-zoom further on their own terms.
  const handleClusterClick = useCallback((_event, cluster, map) => {
    if (!map) return;
    const position = cluster.position;
    if (!position) return;
    const lat = position.lat();
    const lng = position.lng();
    programmaticMoveRef.current = true;
    map.panTo({ lat, lng });
    map.setZoom(DEFAULT_ZOOM);
    lastQueriedCentreRef.current = {
      lat,
      lon: lng,
      zoom: DEFAULT_ZOOM,
    };
  }, []);

  // Pan to first match on query change
  const firstMatch = visibleSpots[0];
  useEffect(() => {
    if (!mapRef.current || !firstMatch) return;
    programmaticMoveRef.current = true;
    mapRef.current.panTo({ lat: firstMatch.lat, lng: firstMatch.lng });
    mapRef.current.setZoom(Math.max(mapRef.current.getZoom() ?? 14, 18));
  }, [normalizedQuery]);

  // Clear any in-app route when the bottom sheet is dismissed, so
  // the polyline does not linger after the user closes the panel.
  useEffect(() => {
    if (!placesPanelDismissed) return;
    if (routeAbortRef.current) {
      routeAbortRef.current.abort();
      routeAbortRef.current = null;
    }
    if (routePolylineRef.current) {
      routePolylineRef.current.setMap(null);
      routePolylineRef.current.setPath([]);
    }
    setRouteStationKey(null);
    setRouteInfo(null);
  }, [placesPanelDismissed]);

  // Center on user first time
  //
  // Re-runs when EITHER `userLocation` or `isMapReady` flips. The
  // previous version only watched `userLocation`, which raced the
  // Google Maps script load: when geolocation resolved first, the
  // effect early-returned on `!mapRef.current` and never re-fired
  // once the map instance arrived (refs aren't reactive deps).
  // Watching `isMapReady` (a state set in `handleMapLoad`) gives
  // the effect a second trigger so the centering still happens in
  // the common case where the user's GPS fix arrives before the
  // Maps JS bundle finishes parsing.
  useEffect(() => {
    if (!userLocation || !isMapReady || !mapRef.current) return;
    if (didCenterOnUserRef.current) return;
    didCenterOnUserRef.current = true;
    programmaticMoveRef.current = true;
    mapRef.current.panTo({ lat: userLocation.lat, lng: userLocation.lon });
    mapRef.current.setZoom(18);
  }, [userLocation, isMapReady]);

  // User location marker
  useEffect(() => {
    if (!isLoaded || !mapRef.current || !window.google?.maps?.marker?.AdvancedMarkerElement) return;
    const map = mapRef.current;

    if (!userLocation) {
      if (userMarkerRef.current) {
        userMarkerRef.current.map = null;
        userMarkerRef.current = null;
      }
      return;
    }

    const el = document.createElement("div");
    el.style.cssText = `
      width:14px;height:14px;border-radius:50%;
      background:#1a73e8;border:2px solid #fff;
      box-shadow:0 0 0 3px rgba(26,115,232,0.18);
    `;

    if (userMarkerRef.current) {
      userMarkerRef.current.position = { lat: userLocation.lat, lng: userLocation.lon };
      userMarkerRef.current.content = el;
    } else {
      userMarkerRef.current = new window.google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: userLocation.lat, lng: userLocation.lon },
        content: el,
        zIndex: 999,
      });
    }
  }, [userLocation, isLoaded]);

  const mapCenter = useMemo(
    () => (userLocation ? { lat: userLocation.lat, lng: userLocation.lon } : HK_CENTER),
    [userLocation]
  );

  // Marker rendering
  //
  // Performance notes:
  //  - `selected` is intentionally NOT in the deps list. A tap used
  //    to rebuild every marker; selection now updates the two
  //    affected dots imperatively in the next effect.
  //  - We keep a `byId` Map alongside the markers array so the
  //    selection-update effect can find a marker in O(1) instead of
  //    scanning the array on every tap.
  //  - On every nearby-refresh the previous implementation
  //    tore down the clusterer and re-created every dot from
  //    scratch. That destruction-and-recreation cycle is what
  //    produced the visible flash during pinch-zoom (idle fired
  //    → fetch returned → ALL dots vanished → ALL dots re-appeared,
  //    even the ones whose data hadn't changed). We now diff the
  //    old and new spot sets and only call `addMarkers` /
  //    `removeMarkers` on the still-alive clusterer, so the ~95%
  //    of pins whose id survives the fetch stay glued to the map
  //    without a single repaint.
  useEffect(() => {
    if (!isLoaded || !mapRef.current) return;
    if (!window.google?.maps?.marker?.AdvancedMarkerElement) return;
    const map = mapRef.current;

    // Builds the dot DOM in its UNSELECTED state. Selection styling
    // is applied imperatively by the effect below; keeping this
    // function pure avoids re-running it on every selection toggle.
    const createMarkerElement = (spot) => {
      const color = getSpotColor(spot, false);
      const size = markerSizeForSpot(spot, false);
      const IconName = CATEGORY_ICON_NAME[spot.category] ?? "MapPin";
      const isSearched = false;

      const wrap = document.createElement("div");
      wrap.style.cssText = `
        position:relative;
        width:${Math.max(size, PULSE_RING_PX)}px;
        height:${Math.max(size, PULSE_RING_PX)}px;
        display:flex;
        align-items:center;
        justify-content:center;
        pointer-events:none;
      `;

      const el = document.createElement("div");
      el.style.cssText = `
        position:relative;
        width:${size}px;
        height:${size}px;
        border-radius:50%;
        background:${color};
        border:2px solid #fff;
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:center;
        box-sizing:border-box;
        box-shadow:${isSearched ? "0 0 0 4px rgba(239,68,68,0.25), 0 4px 10px rgba(0,0,0,0.25)" : "0 1px 3px rgba(0,0,0,0.18)"};
        pointer-events:auto;
        transition:width 0.15s ease, height 0.15s ease, box-shadow 0.15s ease;
      `;

      const iconSize = Math.round(size * 0.62);
      const wrapper = document.createElement("div");
      wrapper.style.cssText = `
        width:${iconSize}px;
        height:${iconSize}px;
        display:flex;
        align-items:center;
        justify-content:center;
        pointer-events:none;
        color:#fff;
      `;
      wrapper.innerHTML = iconSvgMarkup(IconName, iconSize);
      el.appendChild(wrapper);

      attachMarkerHover(el, {
        name: spot.name,
        categoryLabel: categoryLabel(spot.category, t),
        categoryColor: color,
      });

      wrap.appendChild(el);
      return wrap;
    };

    // Build a marker for a single spot. Shared between the initial
    // setup path and the incremental-update path so the two stay
    // wire-identical (same hover tooltip, same click handler, same
    // AdvancedMarkerElement options).
    const buildMarker = (spot) => {
      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: spot.lat, lng: spot.lng },
        content: createMarkerElement(spot),
        title: spot.name,
      });
      marker.spot = spot;
      marker.addListener("gmp-click", () => {
        // Read through the ref so this long-lived listener sees the
        // latest selection without rebuilding the markers array.
        const prev = selectedRef.current;
        if (prev === spot.id) {
          // Tapping the active marker a second time dismisses the
          // tag — and, if the route was drawn for *this* spot, the
          // polyline too. Using the shared helper keeps the
          // close-dismiss-route behaviour consistent with the X
          // button on the popup and clicking the map background.
          dismissSelectedSpot();
        } else {
          setSelected(spot.id);
        }
        if (mapRef.current) {
          programmaticMoveRef.current = true;
          mapRef.current.panTo({ lat: spot.lat, lng: spot.lng });
        }
        if (typeof onPinPlace === "function") {
          onPinPlace(spot);
        }
      });
      return marker;
    };

    const makeClusterRenderer = () => ({
      render: ({ count, position, markers: clusterMarkers }) => {
        const firstSpot = clusterMarkers[0]?.spot;
        const color = firstSpot ? getSpotColor(firstSpot, false) : "#C2410C";
        // Clustered dots use the group icon (the category icon of the
        // first grouped spot) and shrink the dot to 3/4 of the
        // configured cluster size so the icon sits inside at roughly
        // the same visual weight as a single-marker dot.
        //
        // Add an explicit count badge so the user can tell at a
        // glance whether a pile-up has 3 stops or 12. Without it
        // a cluster is indistinguishable from a single marker, and
        // tapping either one zooms into the same pile — exactly
        // the "dots piled up, group them" request this renderer
        // exists for. The badge sits below-and-right of the icon,
        // inside the cluster circle's white border, so it stays
        // legible against both light and satellite basemaps.
        const size = CLUSTER_MARKER_SIZE;
        const IconName = firstSpot
          ? CATEGORY_ICON_NAME[firstSpot.category] ?? "MapPin"
          : "MapPin";
        const el = document.createElement("div");
        el.style.cssText = `
            position:relative;
            width:${size}px;
            height:${size}px;
            border-radius:50%;
            background:${color};
            border:2px solid #fff;
            cursor:pointer;
            display:flex;
            align-items:center;
            justify-content:center;
            box-sizing:border-box;
            box-shadow:0 2px 6px rgba(0,0,0,0.25);
          `;
        const iconSize = Math.round(size * 0.5);
        const wrapper = document.createElement("div");
        wrapper.style.cssText = `
          width:${iconSize}px;
          height:${iconSize}px;
          display:flex;
          align-items:center;
          justify-content:center;
          pointer-events:none;
          color:#fff;
        `;
        wrapper.innerHTML = iconSvgMarkup(IconName, iconSize);
        el.appendChild(wrapper);

        // Count badge — fixed-size chip with the cluster count,
        // or "10+" once the pile exceeds nine (matches the visual
        // convention Google Maps itself uses). Anchored to the
        // bottom-right so it doesn't cover the icon.
        const badge = document.createElement("div");
        const label = count > 9 ? "10+" : String(count);
        badge.textContent = label;
        badge.style.cssText = `
          position:absolute;
          right:-4px;
          bottom:-4px;
          min-width:18px;
          height:18px;
          padding:0 5px;
          border-radius:9px;
          background:#fff;
          color:${color};
          font-size:11px;
          font-weight:700;
          line-height:18px;
          text-align:center;
          box-shadow:0 1px 3px rgba(0,0,0,0.35);
          border:1px solid ${color};
          font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
          letter-spacing:0;
          pointer-events:none;
        `;
        el.appendChild(badge);

        return new window.google.maps.marker.AdvancedMarkerElement({
          map,
          position,
          content: el,
          title: firstSpot?.name
            ? `${count} ${categoryLabel(firstSpot.category, t)}`
            : `${count} stops`,
        });
      },
    });

    const prevClusterer = markersRef.current.clusterer;
    const prevById = markersRef.current.byId;

    // First-time setup: no clusterer yet, build the clusterer and
    // every dot in a single pass. We still need this path because
    // `MarkerClusterer` only accepts its initial marker set via the
    // constructor — there's no "add the first batch" entry point.
    if (!prevClusterer) {
      const markers = visibleSpots.map(buildMarker);
      const clusterer = new MarkerClusterer({
        map,
        markers,
        // Cluster up to zoom MAX_CLUSTER_ZOOM (19) — one level above
        // the page's DEFAULT_ZOOM (18). The previous value (17) left
        // every "same intersection, multiple stops" pile shown as a
        // raw stack of identical-coloured dots the moment the map
        // landed. Bumping the cap means the grouping takes effect on
        // the initial render, while still letting a user who has
        // pinched into a specific junction see each bus stop on its
        // own corner. See `MAX_CLUSTER_ZOOM` doc-comment.
        maxZoom: MAX_CLUSTER_ZOOM,
        // Cluster even pairs of overlapping dots. The previous value
        // (5) let 2–4 transit stops at the same intersection render
        // as a small pile — visually noisy and tappable only on the
        // top dot. Pairing (2) collapses the common case of "two
        // bus stops on opposite corners of one junction" into one
        // tappable group with a count badge (see renderer below).
        minClusterSize: 2,
        // Grid side length, in pixels, used by the grid algorithm
        // to bucket nearby markers. The default (60) is too wide
        // for the densely packed Hong Kong bus-stop catalogue —
        // two stops 50px apart would render as siblings, not a
        // cluster. `TRANSPORT_OVERLAP_CLUSTER_GRID_PX` (24) is the
        // pre-existing constant for this exact case; using it here
        // keeps the clusterer config in lockstep with the rest of
        // the code that imported it for overlap handling.
        gridSize: TRANSPORT_OVERLAP_CLUSTER_GRID_PX,
        renderer: makeClusterRenderer(),
        // See `handleClusterClick` above — replaces the library's
        // default `map.fitBounds(cluster.bounds)` zoom-in with a
        // pan + DEFAULT_ZOOM so the cluster chip stays on the
        // home page's natural zoom level instead of flying to the
        // max.
        onClusterClick: handleClusterClick,
      });
      const byId = new Map();
      for (const marker of markers) {
        if (marker.spot?.id) byId.set(marker.spot.id, marker);
      }
      markersRef.current = { clusterer, markers, byId };
      // Tell the selection-styling effect that a fresh marker set is
      // ready, so it can re-apply the current selection (the effect's
      // primary `[selected]` dep didn't change, so it wouldn't fire
      // on its own).
      setMarkersBuiltVersion((v) => v + 1);
      return;
    }

    // Incremental update path — the clusterer is already alive and
    // owns its own marker set. Diff old vs new spots, then push only
    // the deltas through the clusterer's `addMarkers` /
    // `removeMarkers` entry points. Pins that survive the fetch stay
    // on the map untouched, which is what removes the zoom flash.
    const newSpotById = new Map();
    for (const spot of visibleSpots) {
      newSpotById.set(spot.id, spot);
    }

    const markersToRemove = [];
    for (const [id, marker] of prevById) {
      if (!newSpotById.has(id)) {
        markersToRemove.push(marker);
      }
    }

    const spotsToAdd = [];
    for (const spot of visibleSpots) {
      if (!prevById.has(spot.id)) {
        spotsToAdd.push(spot);
      }
    }

    // Nothing actually changed (e.g. the fetch returned an identical
    // payload, or the only effect was a query-string flip that
    // filtered an already-empty pool). Bail out before touching the
    // clusterer so we don't pay for a redundant `render()`.
    if (markersToRemove.length === 0 && spotsToAdd.length === 0) return;

    const newMarkers = spotsToAdd.map(buildMarker);

    if (markersToRemove.length > 0) {
      prevClusterer.removeMarkers(markersToRemove);
    }
    if (newMarkers.length > 0) {
      prevClusterer.addMarkers(newMarkers);
    }

    const newById = new Map(prevById);
    for (const m of markersToRemove) {
      if (m.spot?.id) newById.delete(m.spot.id);
    }
    for (const m of newMarkers) {
      if (m.spot?.id) newById.set(m.spot.id, m);
    }

    const survivingMarkers = markersRef.current.markers.filter(
      (m) => !markersToRemove.includes(m)
    );

    markersRef.current = {
      clusterer: prevClusterer,
      markers: [...survivingMarkers, ...newMarkers],
      byId: newById,
    };
    setMarkersBuiltVersion((v) => v + 1);
  }, [isLoaded, visibleSpots, onPinPlace, t, handleClusterClick]);

  // Targeted selection styling — updates ONLY the previously-selected
  // and newly-selected dots instead of restyling every marker.
  //
  // The marker array is rebuilt only when `visibleSpots` itself
  // changes (the previous effect), so on a tap this effect is the
  // sole place where selection styling flips.
  useEffect(() => {
    const byId = markersRef.current.byId;
    if (!byId || byId.size === 0) return;
    const prevId = prevSelectedIdRef.current;
    prevSelectedIdRef.current = selected;
    if (prevId === selected) return;

    const applyStyle = (spotId, isSelected) => {
      if (spotId == null) return;
      const marker = byId.get(spotId);
      if (!marker || !marker.content || !marker.spot) return;
      const dot = marker.content.firstElementChild;
      if (!dot) return;
      const color = getSpotColor(marker.spot, isSelected);
      const size = markerSizeForSpot(marker.spot, isSelected);
      dot.style.background = color;
      dot.style.width = `${size}px`;
      dot.style.height = `${size}px`;
      dot.style.boxShadow = isSelected
        ? "0 0 0 4px rgba(239,68,68,0.25), 0 4px 10px rgba(0,0,0,0.25)"
        : "0 1px 3px rgba(0,0,0,0.18)";

      const ring = marker.content.querySelector(".hk-marker-pulse-ring");
      if (isSelected && !ring) {
        const newRing = document.createElement("div");
        newRing.className = "hk-marker-pulse-ring";
        // Offset the ring to the top-left of the dot.
        // shiftX = -50% + (-25% of size) = top-left corner of the dot
        const ringLeft = `calc(50% - ${Math.round(size * 0.50)}px)`;
        const ringTop = `calc(50% - ${Math.round(size * 0.50)}px)`;
        newRing.style.cssText = `position:absolute;width:${size}px;height:${size}px;left:${ringLeft};top:${ringTop};transform:translate(0,0);`;
        marker.content.appendChild(newRing);
      } else if (!isSelected && ring) {
        ring.remove();
      }

      const svgWrap = dot.firstElementChild;
      if (svgWrap) {
        const iconSize = Math.round(size * 0.62);
        svgWrap.style.width = `${iconSize}px`;
        svgWrap.style.height = `${iconSize}px`;
        const svg = svgWrap.querySelector("svg");
        if (svg) {
          svg.setAttribute("width", String(iconSize));
          svg.setAttribute("height", String(iconSize));
        }
      }
    };

    if (prevId != null) applyStyle(prevId, false);
    if (selected != null) applyStyle(selected, true);
  }, [selected, markersBuiltVersion]);

  // Loading and error states
  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#f3f4f6] p-6 text-center">
        <p className="text-sm text-[#92400e]">{t("mapMissingKey")}</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#fee2e2] p-6 text-center">
        <p className="text-sm text-[#991b1b]">{t("mapLoadError")}</p>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#e5e7eb]">
        <p className="text-sm text-[#6b7280]">{t("mapLoading")}</p>
      </div>
    );
  }

  return (
    <>
      <GoogleMap
        mapContainerStyle={MAP_CONTAINER_STYLE}
        center={mapCenter}
        zoom={DEFAULT_ZOOM}
        options={DEFAULT_MAP_OPTIONS}
        onLoad={handleMapLoad}
        onClick={handleMapClick}
      />

      {/* Loading hint */}
      {activeQuery && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-5">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-white/80 px-3.5 py-1.5 text-[11px] text-[#374151] shadow-[0_1px_3px_rgba(0,0,0,0.08)] backdrop-blur">
            {nearbyLoading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#1E40AF]" />
                <span className="font-semibold">{t("mapRefreshing")}</span>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* PlacesPanel */}
      <PlacesPanel
        t={t}
        closestStations={closestStations}
        loading={nearbyLoading}
        selectedId={selected}
        onSelect={(spot) => setSelected(spot.id)}
        onMapFocus={(spot) => {
          if (!spot) return;
          if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) return;
          // Dual action the Frequent tab's bus-stop CTA expects:
          //   1. Set the spot as the active selection so the
          //      SpotPopup bottom sheet is rendered on top of the
          //      PlacesPanel (the original bottom tab box).
          //   2. Pan the map so the stop sits in the middle of the
          //      viewport (without triggering a nearby refresh).
          // We also raise the zoom a notch over the current level
          // (clamped at 18) so the marker is clearly readable after
          // the pan — the previous behaviour on the Closest tab was
          // to keep the existing zoom, which works for that tab
          // because the user is already centred on their location.
          setSelected(spot.id);
          if (mapRef.current) {
            const map = mapRef.current;
            programmaticMoveRef.current = true;
            map.panTo({ lat: spot.lat, lng: spot.lng });
            const currentZoom = map.getZoom?.();
            if (typeof currentZoom === "number") {
              map.setZoom(Math.min(Math.max(currentZoom, 15), 18));
            }
          }
        }}
        onShowRoute={handleShowRoute}
        activeRouteStationKey={routeStationKey}
        routeInfo={routeInfo}
        nearbyToilets={nearbyToilets}
        frequentPlaces={frequentPlaces}
        onRemoveFrequent={onRemoveFrequentPlace}
        onClearFrequent={onClearFrequentPlaces}
        dismissed={placesPanelDismissed}
        onDismiss={onPlacesPanelDismiss}
        tab={placesPanelTab}
        onTabChange={onPlacesPanelTabChange}
        isCollapsed={placesPanelCollapsed}
        onToggleCollapse={onPlacesPanelCollapsedChange}
      />

      {/* SpotPopup as a bottom box on top of PlacesPanel — matches
          the Google Maps app structure where tapping a marker
          opens a details sheet above the bottom navigation. The
          sheet is positioned by its own CSS (`.spot-popup-bottom-sheet`)
          rather than anchored to the marker's lat/lng via
          OverlayView, so it doesn't move when the map pans and
          sits in a consistent spot regardless of which marker
          was tapped.

          Rendered AFTER PlacesPanel so it sits on top in the
          stacking order. The CSS class uses a higher z-index
          (.spot-popup-bottom-sheet = z-40 vs .places-panel = z-30)
          for the same reason. */}
      {displayedSpot && (
        <SpotPopup
          spot={displayedSpot}
          onClose={dismissSelectedSpot}
          onInfoWindowClose={onInfoWindowClose}
          getSpotColor={getSpotColor}
          onShowRoute={handleShowRoute}
          activeRouteStationKey={routeStationKey}
          // Time / distance readout for the currently-drawn walking
          // route now renders ONLY inside this sheet (not on the
          // closest-station tab's card). Forwarding `routeInfo`
          // here lets `SpotPopupContent` decide whether its own
          // route pill should appear, gated on the spot being the
          // owner of the active polyline.
          routeInfo={routeInfo}
          userLocation={userLocation}
        />
      )}

      {/* Recent on my location button */}
      {!!userLocation && !placesPanelDismissed && (
        <button
          type="button"
          onClick={handleRecenterOnUser}
          aria-label={t("mapRecenterAria")}
          title={t("mapRecenterAria")}
          className="places-panel-recenter-float md:hidden"
        >
          <Locate className="h-4 w-4" />
        </button>
      )}
    </>
  );
}
