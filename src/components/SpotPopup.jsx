"use client";

import {
  Toilet,
  MapPin,
  Bus,
  Train,
  TramFront,
  Ship,
  Bookmark,
  Loader2,
  Navigation,
  X,
  Footprints,
} from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import {
  addFrequentPlace,
  removeFrequentPlace,
  readFrequentPlaces,
} from "@/lib/frequentPlaces";
import { useLocale, useTranslations } from "@/contexts/LocaleContext";
import { pickRouteBadge } from "@/lib/transportColors";
import {
  routeDurationMinutes,
  routeDistanceLabel,
} from "@/lib/routesApi";
import { distanceMetres } from "@/app/home/constants";

// Walking routes are only useful up to a sensible on-foot radius:
// beyond this, the user almost certainly wants a transit option
// rather than a 30-minute pedestrian polyline. The button is hidden
// on the popup tag once the spot is farther than this from the
// user's current location.
const ROUTE_BUTTON_MAX_DISTANCE_METRES = 2500;

const DETAIL_PAGE_BY_CATEGORY = {
  toilets: { href: "/toilets", titleKey: "openToiletsPage" },
};

function detailLinkForSpot(spot) {
  const entry = DETAIL_PAGE_BY_CATEGORY[spot.category];
  if (!entry) return null;
  const params = new URLSearchParams({
    lat: String(spot.lat),
    lon: String(spot.lng),
  });
  return `${entry.href}?${params.toString()}`;
}

const CATEGORY_ICON = {
  toilets: Toilet,
  attractions: MapPin,
  busStops: Bus,
  mtrStations: Train,
  lightRailStops: TramFront,
  ferryPiers: Ship,
  tramStops: TramFront,
};

// Endpoint overrides for the ETA panel. Bus stops talk to /api/bus-eta,
// ferry piers to /api/ferry/eta, MTR stations to /api/mtr/eta, Light
// Rail stops to /api/lightrail/eta, and HK Tramways tram stops to
// /api/tram/eta.
//
// Note: bus / MTR / Light Rail / ferry all share the same shape
//   { stop, routes: [{ routeId, routeNo, dest, etas: [...] }] }
// but /api/tram/eta uses a flat shape
//   { stop, etas: [{ tramId, dest, minutesUntilArrival, ... }] }
// because each tram is one vehicle with one destination rather than
// one shared route. `EtasPanel` adapts both shapes — see
// `normaliseEtaResponse()` below.
const ETA_ENDPOINT_BY_CATEGORY = {
  busStops: { endpoint: "/api/bus-eta", errorKey: "tripPlanner.errorMessage" },
  mtrStations: { endpoint: "/api/mtr/eta", errorKey: "tripPlanner.errorMessage" },
  lightRailStops: { endpoint: "/api/lightrail/eta", errorKey: "tripPlanner.errorMessage" },
  ferryPiers: { endpoint: "/api/ferry/eta", errorKey: "tripPlanner.errorMessage" },
  tramStops: { endpoint: "/api/tram/eta", errorKey: "tripPlanner.errorMessage" },
};

// Map a spot's category to the i18n label key shown beneath the name
// in the popup. Without these branches every non-toilet / non-bus
// category falls through to "categoryAttractions" and the user sees an
// MTR station labeled "Attractions" — which is exactly the bug this
// registry was added to fix.
function categoryLabelKey(spot) {
  if (spot.category === "toilets") return "categoryToilets";
  if (spot.category === "busStops") return "categoryBusStops";
  if (spot.category === "mtrStations") return "categoryMtrStations";
  if (spot.category === "lightRailStops") return "categoryLightRailStops";
  if (spot.category === "ferryPiers") return "categoryFerryPiers";
  if (spot.category === "tramStops") return "categoryTramStops";
  return "categoryAttractions";
}

function formatEtaMinutes(min, locale) {
  if (min == null) return "—";
  // Always render with the same "X 分鐘" / "X min" shape as the
  // second/third ETA chips, so the highlighted "bus tag" chip
  // matches the rest of the schedule row visually. The previous
  // "即將" / "Due" label broke the row's rhythm because the leading
  // chip was the only one without a number; with this change every
  // chip uses the identical "{min} 分鐘" pattern (clamped at 0 so a
  // bus already at the stop never prints a negative value).
  const clamped = Math.max(0, Math.round(min));
  return locale?.startsWith("zh") ? `${clamped} 分鐘` : `${clamped} min`;
}

/**
 * Normalise the heterogeneous ETA response shapes into a single
 * "routes" array. Bus / MTR / Light Rail / ferry already use
 *   { routes: [{ routeId, routeNo, dest, etas: [...] }] }
 * so we keep that as-is. HK Tramways uses a flat shape
 *   { etas: [{ tramId, dest, minutesUntilArrival, ... }] }
 * which we adapt by synthesising one synthetic "route" per physical
 * tram — the destination and ETA come from the upstream record
 * directly, and `routeNo` is left null so the renderer hides the
 * route-number badge for tram rows.
 */
function normaliseEtaResponse(data) {
  if (Array.isArray(data?.routes) && data.routes.length > 0) {
    return { isFlat: false, routes: data.routes };
  }
  if (Array.isArray(data?.etas)) {
    const routes = data.etas
      .filter((e) => e != null)
      .map((e, idx) => ({
        routeId: e.tramId ?? `tram-eta-${idx}`,
        routeNo: null,
        dest: e.dest,
        etas: [
          {
            minutes:
              e.minutesUntilArrival != null && Number.isFinite(e.minutesUntilArrival)
                ? e.minutesUntilArrival
                : null,
            isRealtime: !!e.isRealtime,
            eta: e.etaIso ?? null,
          },
        ],
        _isFlat: true,
      }));
    return { isFlat: true, routes };
  }
  return { isFlat: false, routes: [] };
}

function EtasPanel({ endpoint, stopId, locale, t }) {
  const [loading, setLoading] = useState(true);
  const [routes, setRoutes] = useState([]);
  const [isFlat, setIsFlat] = useState(false);
  const [maintenanceHint, setMaintenanceHint] = useState(null);
  const [error, setError] = useState(null);
  // MTR (and the other rail modes) publish a list of upcoming trains
  // per line, while bus routes usually only carry the next vehicle.
  // Detect MTR via the endpoint path so we can fan each line out into
  // multiple ETA chips ("further schedules") without affecting the
  // single-ETA rendering for buses / ferries / trams.
  const showAllSchedules = typeof endpoint === "string" && endpoint.includes("/mtr/");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMaintenanceHint(null);
    const params = new URLSearchParams({ stop: stopId, limit: "8" });
    if (locale) params.set("locale", locale);
    fetch(`${endpoint}?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`eta ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const normalised = normaliseEtaResponse(data);
        setRoutes(normalised.routes);
        setIsFlat(normalised.isFlat);
        // Surface the operator's "system undergoing an upgrade"
        // notice (set by /api/tram/eta on HK Tramways) instead of
        // the generic "no arrivals" line, so the user knows the
        // outage is upstream and not a bug in the app.
        if (typeof data?.upstreamNote === "string" && data.upstreamNote) {
          setMaintenanceHint(t("tripPlanner.upstreamMaintenance"));
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, stopId, locale, t]);

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 0",
          fontSize: 12,
          color: "#6b7280",
        }}
      >
        <Loader2 size={12} className="animate-spin" />
        <span>{t("nearbyLoadingPill")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "6px 0", fontSize: 12, color: "#991b1b" }}>
        {t("tripPlanner.errorMessage")}
      </div>
    );
  }

  if (routes.length === 0) {
    return (
      <div
        style={{
          padding: "6px 0",
          fontSize: 12,
          color: maintenanceHint ? "#92400e" : "#6b7280",
          background: maintenanceHint ? "#fef3c7" : "transparent",
          borderRadius: maintenanceHint ? 6 : 0,
          padding: maintenanceHint ? "8px 10px" : "6px 0",
        }}
      >
        {maintenanceHint ?? t("nearbyEmptyTitle")}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          // Fill the entire vertical space remaining in the bottom
          // sheet below the station header. The previous `maxHeight:
          // 140` constraint left a blank band of ~80px between the
          // last route row and the bottom edge of the 320px sheet;
          // removing it (and giving the wrapper `flex: 1` / `minHeight:
          // 0` so the inner scroll kicks in when more than ~6 routes
          // are visible) makes the bus / ferry / tram schedule list
          // read as the body of the sheet, like the Google Maps app
          // where the list of arrivals takes the whole card body.
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        {routes.slice(0, 8).map((r) => {
          // Sort so the soonest arrival is always first; drop entries
          // we couldn't parse a `minutes` from (these come back from
          // the upstream as `null` when the schedule is past last
          // train).
          const allEtas = (r.etas ?? [])
            .filter((e) => e && e.minutes != null)
            .slice()
            .sort((a, b) => a.minutes - b.minutes);
          // Cap MTR schedules so a long off-peak gap (5+ trains) doesn't
          // blow out the popup width. Two entries is the right balance:
          // still enough to show "further schedules" without scrolling,
          // but leaves enough room on the row's left side for both the
          // line badge ("TWL" / "TCL" / etc.) and the destination to
          // render without clipping. With three entries the chip strip
          // reserved ~150px on the right and the destination span
          // collapsed to roughly a single Chinese character; dropping
          // to two reclaims enough width for the full terminus name.
          const etasToShow = showAllSchedules ? allEtas.slice(0, 2) : allEtas.slice(0, 1);
          // No length slice here any more — the destination span now
          // allows up to two lines (`-webkit-line-clamp: 2`) so the
          // full terminus name is preserved and wraps cleanly on
          // narrow viewports instead of being truncated to a single
          // character before the renderer even sees it.
          const destText =
            r.dest?.display || r.dest?.en || r.dest?.tc || r.dest?.sc || "";
          const routeBadge = pickRouteBadge({
            routeNo: r.routeNo,
            company: r.co?.[0] ?? r.company,
          });
          return (
            <li
              key={r.routeId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                // Allow the ETA chip strip to drop onto a second line
                // when the destination needs the full width to render
                // without clipping. Without `flex-wrap` the chip strip
                // (which is `flex-shrink: 0`) reserved its full ~150px
                // on the right, leaving the destination with ~30px
                // — not enough for even a single Chinese character.
                // `margin-left: auto` on the chip strip keeps it
                // right-aligned on both rows: on a single row it gets
                // pushed to the right edge; on a wrapped row it sits
                // at the right end of the new line.
                flexWrap: "wrap",
                padding: "4px 8px",
                background: "#f9fafb",
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                {r.routeNo != null && r.routeNo !== "" && (
                  <span
                    style={{
                      display: "inline-block",
                      minWidth: 28,
                      padding: "1px 6px",
                      borderRadius: 6,
                      background: routeBadge.bg,
                      color: routeBadge.textColor,
                      fontWeight: 700,
                      fontSize: 11,
                      textAlign: "center",
                      flexShrink: 0,
                    }}
                  >
                    {routeBadge.label}
                  </span>
                )}
                <span
                  style={{
                    color: "#374151",
                    fontWeight: 500,
                    // Allow the terminus to wrap onto a second line
                    // when the row is narrow (e.g. on mobile, or when
                    // three ETA chips crowd the right edge). The
                    // previous `whiteSpace: nowrap` + `text-overflow:
                    // ellipsis` combination clipped names like
                    // "堅尼地城" down to a single character "荃"
                    // whenever the row's available width was below
                    // ~110px, which made the row read as "荃 → …"
                    // with no idea where the bus was actually going.
                    // Cap at 2 lines so a very long name never blows
                    // out the row height, and use `overflow-wrap:
                    // anywhere` so mixed Chinese / English strings
                    // break cleanly without overflowing.
                    overflowWrap: "anywhere",
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 2,
                    lineClamp: 2,
                    overflow: "hidden",
                    minWidth: 0,
                    flex: 1,
                  }}
                  title={destText}
                >
                  {isFlat && !destText ? "Tram" : destText}
                </span>
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  flexShrink: 0,
                  // Right-align the chip strip on both the inline row
                  // and the wrapped row. See the comment on the
                  // `<li>` for why `flex-wrap: wrap` is enabled.
                  marginLeft: "auto",
                }}
              >
                {etasToShow.length === 0 && (
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      color: "#9ca3af",
                    }}
                  >
                    —
                  </span>
                )}
                {etasToShow.map((eta, idx) => (
                  <span
                    key={`${r.routeId}-eta-${idx}`}
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: idx === 0 ? 700 : 500,
                      color: idx === 0 ? "#1D4ED8" : "#6b7280",
                      padding: "1px 6px",
                      borderRadius: 6,
                      background: idx === 0 ? "#dbeafe" : "transparent",
                      fontSize: 11,
                      minWidth: 36,
                      textAlign: "center",
                    }}
                    title={eta.eta ? new Date(eta.eta).toLocaleString() : undefined}
                  >
                    {formatEtaMinutes(eta.minutes, locale)}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SpotPopupContent({
  spot,
  onClose,
  onInfoWindowClose,
  getSpotColor,
  onShowRoute,
  activeRouteStationKey,
  userLocation,
  // Result of the most recent successful Routes API v2 walk fetch
  // (`{ key, duration, distanceMeters }`). Rendered as the
  // "🚶 5 min · 350 m" pill on this station info display box ONLY
  // when its `key` matches `activeRouteStationKey` — that's the
  // single place on the screen where the time / distance now
  // surfaces, because the closest-station tab in PlacesPanel no
  // longer shows it. `null` whenever no route is on screen.
  routeInfo = null,
}) {
  const { locale } = useLocale();
  const t = useTranslations("home");
  const [isPinned, setIsPinned] = useState(() => {
    if (typeof window === "undefined") return false;
    const frequent = readFrequentPlaces();
    return frequent.some((p) => p.id === spot.id);
  });

  const handlePin = useCallback(() => {
    if (isPinned) {
      removeFrequentPlace(spot.id);
      setIsPinned(false);
    } else {
      addFrequentPlace(spot);
      setIsPinned(true);
    }
  }, [isPinned, spot]);

  const handleDetailLink = detailLinkForSpot(spot);
  const spotColor = getSpotColor ? getSpotColor(spot, true) : "#ef4444";

  const Icon = CATEGORY_ICON[spot.category] ?? MapPin;
  const etaConfig = ETA_ENDPOINT_BY_CATEGORY[spot.category];
  const isBusStop = spot.category === "busStops";
  const isFerryPier = spot.category === "ferryPiers";
  const isMtrStation = spot.category === "mtrStations";
  const isLightRailStop = spot.category === "lightRailStops";
  const isTramStop = spot.category === "tramStops";
  const isToilet = spot.category === "toilets";
  const upstreamId = spot.upstreamId || (typeof spot.id === "string" && spot.id.startsWith("bus-") ? spot.id.slice(4) : spot.id);
  // Mirror the route key that `HeroMap.handleShowRoute` derives so the
  // button can tell whether the currently-drawn polyline belongs to
  // this specific spot. The format there is
  //   `${category}:${upstreamId ?? id ?? "?"}`
  // and we use the same fallback chain here. For toilets the
  // fallback resolves to the CSDI `id` because `upstreamId` is
  // typically not set on a toilet record — each toilet has a unique
  // id, so `toilets:<id>` is unique per spot.
  const routeKey = `${spot.category ?? "unknown"}:${spot.upstreamId ?? spot.id ?? "?"}`;
  const isRouteActive = activeRouteStationKey === routeKey;
  // Any spot with a stable lat/lng can host a walking route. The
  // five transport categories gate the `EtasPanel` below, but the
  // route button itself is independent of ETA: we just need a
  // destination to walk to. Toilets are included here so tapping a
  // toilet tag draws the walking route on the map — the affordance
  // is the same "Show route on map" / "Hide route" toggle the user
  // sees on bus / MTR / ferry / light-rail / tram popups, and the
  // active-state highlight reuses the same red `…-active` variant.
  //
  // Beyond ROUTE_BUTTON_MAX_DISTANCE_METRES a pedestrian polyline
  // is no longer the right answer (the user almost certainly wants
  // a transit option instead), so the button is hidden on the tag.
  // We only have access to a true user-relative distance when
  // `userLocation` is set; if geolocation is unavailable we keep
  // the button visible rather than silently dropping the
  // affordance.
  const isWithinRouteRange =
    !userLocation ||
    (Number.isFinite(spot.lat) &&
      Number.isFinite(spot.lng) &&
      distanceMetres(
        { lat: userLocation.lat, lon: userLocation.lon },
        { lat: spot.lat, lon: spot.lng }
      ) <= ROUTE_BUTTON_MAX_DISTANCE_METRES);
  const canShowRoute =
    (isBusStop ||
      isFerryPier ||
      isMtrStation ||
      isLightRailStop ||
      isTramStop ||
      isToilet) &&
    typeof onShowRoute === "function" &&
    isWithinRouteRange;

  return (
    <div
      style={{
        // Flex column so the header (icon + name + route button)
        // keeps its natural height while the EtasPanel below it can
        // claim the rest of the bottom sheet via `flex: 1`. Without
        // this the list area is just as tall as its content and
        // leaves an empty band at the bottom of the 320px sheet.
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "white",
        borderRadius: "12px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
        padding: "16px",
        minWidth: "240px",
        maxWidth: "320px",
        fontFamily: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "8px",
          marginBottom: "12px",
          // Keep the header at its natural height; let the EtasPanel
          // below claim the remaining vertical space with `flex: 1`.
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
          <div
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "10px",
              backgroundColor: spotColor + "20",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon size={18} color={spotColor} />
          </div>
          <div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#111827",
                lineHeight: 1.3,
              }}
            >
              {spot.name}
            </div>
          </div>
        </div>

        {/* Right-aligned cluster: time / distance pill (only when a
            route is active for this spot) sits IMMEDIATELY to the
            left of the navigate button, both inside the same flex
            row so they share a baseline. Wrapping the two in their
            own group keeps the long station name on the left
            constrained by `flex: 1` and the cluster flush right via
            `flex-shrink: 0`, so a wide station name can wrap onto a
            second line without pushing the controls off-card. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
          }}
        >
          {canShowRoute &&
            isRouteActive &&
            routeInfo &&
            routeInfo.key === routeKey && (() => {
              // Time / distance readout for the currently-drawn
              // walking route. The ONLY place on the screen where
              // the route's time / distance now surface — the
              // closest-station tab in PlacesPanel intentionally
              // stopped rendering the same pill, so tapping a
              // station card's navigate button (which opens this
              // sheet AND draws the route) is the way the user gets
              // the walking ETA. We guard on `isRouteActive` so the
              // badge only appears when the active polyline belongs
              // to THIS spot (not when the user happens to have a
              // route drawn for some other stop while reading this
              // popup).
              const walkingMinutes = routeDurationMinutes(
                routeInfo.duration
              );
              if (walkingMinutes == null) return null;
              const distance = routeDistanceLabel(
                routeInfo.distanceMeters
              );
              const minLabel = `${walkingMinutes} ${t(
                "bottomSheetStationMin"
              )}`;
              return (
                <span
                  // Rounded mint pill, matching the visual the
                  // closest-station card used to render so users
                  // moving between the two surfaces read the same
                  // data the same way. The icon has been swapped
                  // from an emoji to a lucide `Footprints` glyph so
                  // the pill no longer depends on system emoji
                  // rendering (which varied between iOS / Android /
                  // desktop web).
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 8px",
                    borderRadius: 999,
                    background: "#ecfdf5",
                    color: "#047857",
                    fontSize: 12,
                    fontWeight: 600,
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                  title={distance ? `${minLabel} · ${distance}` : minLabel}
                  aria-label={
                    distance ? `${minLabel} · ${distance}` : minLabel
                  }
                >
                  <Footprints size={12} strokeWidth={2.25} />
                  <span>
                    {minLabel}
                    {distance ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        {distance}
                      </>
                    ) : null}
                  </span>
                </span>
              );
            })()}
          {canShowRoute && (
            <button
              type="button"
              // Reuse the PlacesPanel route button's class so the two
              // affordances read identically across the bottom sheet
              // card and the per-stop popup. The "active" variant flips
              // the fill to red and shows an X icon, signalling that a
              // second tap will dismiss the polyline currently drawn
              // on the map.
              className={`places-panel-station-navigate${
                isRouteActive ? " places-panel-station-navigate-active" : ""
              }`}
              aria-label={
                isRouteActive
                  ? t("bottomSheetStationHideRoute")
                  : t("bottomSheetStationShowRoute")
              }
              aria-pressed={isRouteActive}
              title={
                isRouteActive
                  ? t("bottomSheetStationHideRoute")
                  : t("bottomSheetStationShowRoute")
              }
              onClick={(e) => {
                // Stop the click before it reaches the map's marker
                // listeners — otherwise tapping the button can also
                // count as a click on the underlying marker dot.
                e.stopPropagation();
                onShowRoute(spot);
              }}
            >
              {isRouteActive ? (
                <X className="h-3.5 w-3.5" />
              ) : (
                <Navigation className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {(isBusStop || isFerryPier || isMtrStation || isLightRailStop || isTramStop) && etaConfig && (
        <EtasPanel
          endpoint={etaConfig.endpoint}
          stopId={upstreamId}
          locale={locale}
          t={t}
        />
      )}
    </div>
  );
}

export default function SpotPopup({
  spot,
  onClose,
  onInfoWindowClose,
  getSpotColor,
  onShowRoute,
  activeRouteStationKey,
  userLocation,
  // Result of the most recent successful Routes API v2 walk fetch
  // (`{ key, duration, distanceMeters }`). `null` whenever no
  // route is on screen. Forwarded verbatim to `SpotPopupContent`
  // so the time / distance readout can render under the header
  // when THIS spot owns the active route.
  routeInfo = null,
}) {
  // The popup used to live inside the Google Map's overlay layer
  // (`OverlayView`), anchored to the marker's lat/lng so it floated
  // on top of the dot. We now render it as a bottom sheet that
  // sits above the original bottom tab box (`.places-panel`) —
  // matching the Google Maps app structure where tapping a place
  // opens a details sheet on top of the bottom navigation.
  //
  // Because the sheet is a sibling of the map (not a map overlay),
  // map gesture isolation is no longer needed: scroll/touch events
  // on the sheet never reach the map container in the first place.
  if (!spot) return null;

  return (
    <div
      className="spot-popup-bottom-sheet"
      role="dialog"
      aria-label={spot.name}
    >
      <button
        type="button"
        className="spot-popup-bottom-sheet-handle"
        aria-label={onClose ? "Close" : undefined}
        title="Close"
        onClick={onClose}
      />
      <div className="spot-popup-bottom-sheet-content">
        <SpotPopupContent
          spot={spot}
          onClose={onClose}
          onInfoWindowClose={onInfoWindowClose}
          getSpotColor={getSpotColor}
          onShowRoute={onShowRoute}
          activeRouteStationKey={activeRouteStationKey}
          userLocation={userLocation}
          routeInfo={routeInfo}
        />
      </div>
    </div>
  );
}
