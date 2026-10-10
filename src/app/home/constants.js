// =============================================================================
// Shared constants for the Home page
// =============================================================================

// Map configuration
export const HK_CENTER = { lat: 22.302711, lng: 114.177216 };
export const MAP_CONTAINER_STYLE = { width: "100%", height: "100%" };
export const DEFAULT_MAP_OPTIONS = {
  mapId: process.env.NEXT_PUBLIC_MAP_ID,
  disableDefaultUI: true,
};
export const DEFAULT_ZOOM = 18;

// Marker sizing tiers
export const SPOT_MARKER_SIZE = 20;
export const SPOT_MARKER_SIZE_SELECTED = 30;
export const CLUSTER_MARKER_SIZE = 40;
export const PRIMARY_MARKER_SIZE = 30;
export const MAJOR_MARKER_SIZE = 22;
export const MINOR_MARKER_SIZE = 12;
export const MINOR_MARKER_MIN_ZOOM = 16;
export const MINOR_MARKER_MAX_DISTANCE_M = 600;
export const PULSE_RING_PX = 36;
export const TRANSPORT_OVERLAP_CLUSTER_THRESHOLD_M = 1300;
export const TRANSPORT_OVERLAP_CLUSTER_GRID_PX = 24;
// Maximum zoom level at which the clusterer still groups nearby
// markers. Past `MAX_CLUSTER_ZOOM`, every marker renders on its own
// so the user can spot the exact stop on a building / street corner.
// Default-zoom is 18 (see `DEFAULT_ZOOM`); setting the cap at 19
// means clusters persist at every zoom level the home page uses by
// default, while still letting the user spread markers out when
// they pinch-zoom into a specific junction.
export const MAX_CLUSTER_ZOOM = 20;

// =============================================================================
// Colors per category
// =============================================================================

export const SELECTED_COLOR = "#ef4444";
export const ATTRACTION_COLOR = "#C2410C";

export const TOILET_DEFAULT_COLOR = "#0F766E";
export const TOILET_BARRIER_FREE_COLOR = "#0F766E";

export const BUS_STOP_COLOR = "#1D4ED8";
export const MTR_STATION_COLOR = "#DC2626";
export const LIGHTRAIL_STOP_COLOR = "#7C3AED";
export const FERRY_PIER_COLOR = "#0891B2";
export const TRAM_STOP_COLOR = "#00734B"; // HK Tramways green

export const DEFAULT_CATEGORY_COLOR = {
  attractions: ATTRACTION_COLOR,
  toilets: TOILET_DEFAULT_COLOR,
  busStops: BUS_STOP_COLOR,
  mtrStations: MTR_STATION_COLOR,
  lightRailStops: LIGHTRAIL_STOP_COLOR,
  ferryPiers: FERRY_PIER_COLOR,
  tramStops: TRAM_STOP_COLOR,
};

// =============================================================================
// Category labels and detail page mapping
// =============================================================================

export const CATEGORY_LABEL_KEYS = {
  attractions: "categoryAttractions",
  toilets: "categoryToilets",
  busStops: "categoryBusStops",
  mtrStations: "categoryMtrStations",
  lightRailStops: "categoryLightRailStops",
  ferryPiers: "categoryFerryPiers",
  tramStops: "categoryTramStops",
};

export const DETAIL_PAGE_BY_CATEGORY = {
  toilets: { href: "/toilets", titleKey: "openToiletsPage" },
};

// =============================================================================
// Nearby search radius defaults
// =============================================================================

export const HOME_NEARBY_TOILET_RADIUS_M = 1500;
export const HOME_NEARBY_TOILET_LIMIT = 60;

export const HOME_NEARBY_BUS_STOP_RADIUS_M = 1500;
export const HOME_NEARBY_BUS_STOP_LIMIT = 200;

export const HOME_NEARBY_MTR_STATION_RADIUS_M = 2000;
export const HOME_NEARBY_MTR_STATION_LIMIT = 80;

export const HOME_NEARBY_LIGHTRAIL_STOP_RADIUS_M = 2000;
export const HOME_NEARBY_LIGHTRAIL_STOP_LIMIT = 120;

export const HOME_NEARBY_FERRY_PIER_RADIUS_M = 2500;
export const HOME_NEARBY_FERRY_PIER_LIMIT = 80;

export const HOME_NEARBY_TRAM_STOP_RADIUS_M = 2500;
export const HOME_NEARBY_TRAM_STOP_LIMIT = 150;

// =============================================================================
// Map move refresh tunables
// =============================================================================

export const HOME_MAP_MOVE_REFRESH_DISTANCE = 200; // metres
export const HOME_MIN_MAP_RADIUS = 250; // metres (most zoomed in)
export const HOME_MAX_MAP_RADIUS = 8000; // metres (most zoomed out)

// =============================================================================
// Utility functions
// =============================================================================

/**
 * Map Google Maps zoom (0–21) to a comfortable toilet search radius.
 */
export function radiusForZoom(zoom) {
  if (!Number.isFinite(zoom)) return HOME_NEARBY_TOILET_RADIUS_M;
  const clamped = Math.max(8, Math.min(20, zoom));
  const t = (20 - clamped) / 12;
  const eased = t * t * (3 - 2 * t);
  return Math.round(
    HOME_MIN_MAP_RADIUS + (HOME_MAX_MAP_RADIUS - HOME_MIN_MAP_RADIUS) * eased
  );
}

/**
 * Haversine distance between two lat/lon points in metres.
 */
export function distanceMetres(from, to) {
  const earthRadiusMetres = 6_371_000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLon = toRadians(to.lon - from.lon);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(deltaLon / 2) ** 2;
  return earthRadiusMetres * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Get the category label translation key.
 */
export function categoryLabel(category, t) {
  return t(CATEGORY_LABEL_KEYS[category]);
}

/**
 * Build a detail-page link for a given spot.
 */
export function detailLinkForSpot(spot) {
  const entry = DETAIL_PAGE_BY_CATEGORY[spot.category];
  if (!entry) return null;
  const params = new URLSearchParams({
    lat: String(spot.lat),
    lon: String(spot.lng),
  });
  if (spot.id) params.set("focus", spot.id);
  return `${entry.href}?${params.toString()}`;
}

/**
 * Get the spot color based on category and selection state.
 */
export function getSpotColor(spot, isSelected) {
  if (isSelected) return SELECTED_COLOR;
  if (spot.category === "toilets") {
    return spot.barrierFree ? TOILET_BARRIER_FREE_COLOR : TOILET_DEFAULT_COLOR;
  }
  if (spot.category === "busStops") {
    return BUS_STOP_COLOR;
  }
  if (spot.category === "mtrStations") {
    return MTR_STATION_COLOR;
  }
  if (spot.category === "lightRailStops") {
    return LIGHTRAIL_STOP_COLOR;
  }
  if (spot.category === "ferryPiers") {
    return FERRY_PIER_COLOR;
  }
  if (spot.category === "tramStops") {
    return TRAM_STOP_COLOR;
  }
  return ATTRACTION_COLOR;
}

/**
 * Get the marker size in pixels based on selection state.
 */
export function markerSizeForSpot(spot, isSelected) {
  if (isSelected) return SPOT_MARKER_SIZE_SELECTED;
  return MAJOR_MARKER_SIZE;
}

// =============================================================================
// Hero filter chip definitions
// =============================================================================

/**
 * Map each category to the lucide-react icon name used for both the
 * filter chip and the marker glyph. Adding a new category that needs a
 * marker icon means adding one entry here.
 */
const CATEGORY_ICON_NAME = {
  toilets: "Toilet",
  attractions: "MapPin",
  busStops: "Bus",
  mtrStations: "Train",
  lightRailStops: "TramFront",
  ferryPiers: "Ship",
  tramStops: "TramFront",
};

export function getHeroFilters(t, icons) {
  const entries = [
    "toilets",
    "attractions",
    "busStops",
    "mtrStations",
    "lightRailStops",
    "ferryPiers",
    "tramStops",
  ];
  return entries.map((category) => ({
    key: category,
    labelKey: CATEGORY_LABEL_KEYS[category],
    Icon: icons?.[CATEGORY_ICON_NAME[category]] ?? null,
    swatch: DEFAULT_CATEGORY_COLOR[category],
  }));
}

// Re-export for the marker renderer so it picks the same icon per
// category as the filter chip.
export { CATEGORY_ICON_NAME };

// =============================================================================
// AI Planner suggestions
// =============================================================================

export const AI_PLANNER_SUGGESTIONS = [
  "Plan a family-friendly day in Hong Kong",
  "Best spots for street food in Mong Kok",
  "Hiking trails in the New Territories",
  "Romantic evening in Central",
];

// =============================================================================
// Destination suggestions
// =============================================================================

export const DESTINATION_SUGGESTIONS = [
  "Central",
  "Tsim Sha Tsui",
  "Mong Kok",
  "Causeway Bay",
  "Hong Kong Disneyland",
  "Ocean Park",
  "Victoria Peak",
  "Wong Tai Sin",
  "Airport",
];
