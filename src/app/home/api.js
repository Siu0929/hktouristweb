// =============================================================================
// API fetch functions for toilet + bus-stop POIs
// =============================================================================

import {
  HOME_NEARBY_TOILET_RADIUS_M,
  HOME_NEARBY_TOILET_LIMIT,
  HOME_NEARBY_BUS_STOP_RADIUS_M,
  HOME_NEARBY_BUS_STOP_LIMIT,
  HOME_NEARBY_MTR_STATION_RADIUS_M,
  HOME_NEARBY_MTR_STATION_LIMIT,
  HOME_NEARBY_LIGHTRAIL_STOP_RADIUS_M,
  HOME_NEARBY_LIGHTRAIL_STOP_LIMIT,
  HOME_NEARBY_FERRY_PIER_RADIUS_M,
  HOME_NEARBY_FERRY_PIER_LIMIT,
  HOME_NEARBY_TRAM_STOP_RADIUS_M,
  HOME_NEARBY_TRAM_STOP_LIMIT,
} from "./constants";

// =============================================================================
// Toilet API
// =============================================================================

/**
 * Fetch nearby community toilets. Returns a normalised array of
 * { id, name, lat, lng, address, barrierFree } or [] on failure.
 * Pass `maxDistance` (metres) to override the default radius.
 */
export async function fetchNearbyToilets({ lat, lon, locale, maxDistance }) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    maxDistance: String(maxDistance ?? HOME_NEARBY_TOILET_RADIUS_M),
    limit: String(HOME_NEARBY_TOILET_LIMIT),
    locale,
  });
  const res = await fetch(`/api/toilets/nearby?${params}`);
  if (!res.ok) throw new Error(`toilets API ${res.status}`);
  const data = await res.json();
  return (data.toilets ?? [])
    .filter((t) => Number.isFinite(t.latitude) && Number.isFinite(t.longitude))
    .map((t) => ({
      id: `toilet-${t.id}`,
      name: t.name || t.address || t.id,
      category: "toilets",
      lat: t.latitude,
      lng: t.longitude,
      barrierFree: !!t.barrierFree,
      address: t.address ?? "",
      distanceMetres:
        typeof t.distanceMetres === "number" ? t.distanceMetres : null,
    }));
}

/**
 * Normalize toilet data from API response.
 */
export function normalizeToilet(t) {
  return {
    id: `toilet-${t.id}`,
    name: t.name || t.address || t.id,
    category: "toilets",
    lat: t.latitude,
    lng: t.longitude,
    barrierFree: !!t.barrierFree,
    address: t.address ?? "",
    distanceMetres: typeof t.distanceMetres === "number" ? t.distanceMetres : null,
  };
}

// =============================================================================
// Bus stop API
// =============================================================================

/**
 * Fetch nearby bus stops from /api/bus-stops. Returns a normalised array
 * of { id, name, nameEn, nameZh, lat, lng, distanceMetres } or [] on
 * failure. The upstream route catalogue already excludes MTR and Light
 * Rail — see @/lib/hkBusEta.
 *
 * Pass `maxDistance` (metres) to override the default radius, and
 * `company` (csv) to restrict to one or more operators (kmb, ctb, …).
 */
export async function fetchNearbyBusStops({
  lat,
  lon,
  locale,
  maxDistance,
  company,
  limit,
}) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    maxDistance: String(maxDistance ?? HOME_NEARBY_BUS_STOP_RADIUS_M),
    limit: String(limit ?? HOME_NEARBY_BUS_STOP_LIMIT),
    locale: locale ?? "en",
  });
  if (company) params.set("company", company);
  const res = await fetch(`/api/bus-stops?${params}`);
  if (!res.ok) throw new Error(`bus-stops API ${res.status}`);
  const data = await res.json();
  return (data.stops ?? [])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({
      id: `bus-${s.id}`,
      upstreamId: s.id,
      name: s.name || s.nameEn || s.nameZh || s.id,
      nameEn: s.nameEn ?? "",
      nameZh: s.nameZh ?? "",
      category: "busStops",
      lat: s.lat,
      lng: s.lng,
      distanceMetres:
        typeof s.distanceMetres === "number" ? s.distanceMetres : null,
    }));
}

/**
 * Normalize a single bus stop record (used when re-hydrating from
 * search results or saved frequent places).
 */
export function normalizeBusStop(stop) {
  return {
    id: `bus-${stop.id}`,
    upstreamId: stop.id ?? stop.upstreamId,
    name: stop.name || stop.nameEn || stop.nameZh || stop.id,
    nameEn: stop.nameEn ?? "",
    nameZh: stop.nameZh ?? "",
    category: "busStops",
    lat: stop.lat,
    lng: stop.lng,
    distanceMetres:
      typeof stop.distanceMetres === "number" ? stop.distanceMetres : null,
  };
}

// =============================================================================
// MTR station API
// =============================================================================

/**
 * Fetch nearby MTR stations from /api/mtr/stops. Returns a normalised
 * array of `{ id, name, nameEn, nameZh, lat, lng, lines, distanceMetres }`
 * or `[]` on failure. `lines` is the de-duplicated list of MTR line codes
 * that touch the station (e.g. ["TWL", "TKL"] for a junction station).
 *
 * Pass `maxDistance` (metres) to override the default radius and
 * `line` (csv) to restrict to specific MTR lines (e.g. "TWL" or
 * "TWL,ISL").
 */
export async function fetchNearbyMtrStops({
  lat,
  lon,
  locale,
  maxDistance,
  line,
  limit,
}) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    maxDistance: String(maxDistance ?? HOME_NEARBY_MTR_STATION_RADIUS_M),
    limit: String(limit ?? HOME_NEARBY_MTR_STATION_LIMIT),
    locale: locale ?? "en",
  });
  if (line) params.set("line", line);
  const res = await fetch(`/api/mtr/stops?${params}`);
  if (!res.ok) throw new Error(`mtr/stops API ${res.status}`);
  const data = await res.json();
  return (data.stops ?? [])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({
      id: `mtr-${s.id}`,
      upstreamId: s.id,
      name: s.name || s.nameEn || s.nameZh || s.id,
      nameEn: s.nameEn ?? "",
      nameZh: s.nameZh ?? "",
      category: "mtrStations",
      lat: s.lat,
      lng: s.lng,
      lines: Array.isArray(s.lines) ? s.lines : [],
      distanceMetres:
        typeof s.distanceMetres === "number" ? s.distanceMetres : null,
    }));
}

/**
 * Normalize a single MTR station record (used when re-hydrating from
 * search results or saved frequent places).
 */
export function normalizeMtrStation(stop) {
  return {
    id: `mtr-${stop.id}`,
    upstreamId: stop.id ?? stop.upstreamId,
    name: stop.name || stop.nameEn || stop.nameZh || stop.id,
    nameEn: stop.nameEn ?? "",
    nameZh: stop.nameZh ?? "",
    category: "mtrStations",
    lat: stop.lat,
    lng: stop.lng,
    lines: Array.isArray(stop.lines) ? stop.lines : [],
    distanceMetres:
      typeof stop.distanceMetres === "number" ? stop.distanceMetres : null,
  };
}

// =============================================================================
// Light Rail stop API
// =============================================================================

/**
 * Fetch nearby Light Rail stops from /api/lightrail/stops. Mirrors
 * `fetchNearbyBusStops`. Returns a normalised array of
 * `{ id, name, nameEn, nameZh, lat, lng, routes, distanceMetres }` or
 * `[]` on failure. `routes` is the de-duplicated list of Light Rail
 * route numbers that touch the stop (e.g. ["505", "614P"]).
 *
 * Pass `maxDistance` (metres) to override the default radius and
 * `line` (csv) to restrict to specific Light Rail route numbers
 * (e.g. "505" or "505,610").
 */
export async function fetchNearbyLightRailStops({
  lat,
  lon,
  locale,
  maxDistance,
  line,
  limit,
}) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    maxDistance: String(maxDistance ?? HOME_NEARBY_LIGHTRAIL_STOP_RADIUS_M),
    limit: String(limit ?? HOME_NEARBY_LIGHTRAIL_STOP_LIMIT),
    locale: locale ?? "en",
  });
  if (line) params.set("line", line);
  const res = await fetch(`/api/lightrail/stops?${params}`);
  if (!res.ok) throw new Error(`lightrail/stops API ${res.status}`);
  const data = await res.json();
  return (data.stops ?? [])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({
      id: `lightrail-${s.id}`,
      upstreamId: s.id,
      name: s.name || s.nameEn || s.nameZh || s.id,
      nameEn: s.nameEn ?? "",
      nameZh: s.nameZh ?? "",
      category: "lightRailStops",
      lat: s.lat,
      lng: s.lng,
      routes: Array.isArray(s.routes) ? s.routes : [],
      distanceMetres:
        typeof s.distanceMetres === "number" ? s.distanceMetres : null,
    }));
}

/**
 * Normalize a single Light Rail stop record.
 */
export function normalizeLightRailStop(stop) {
  return {
    id: `lightrail-${stop.id}`,
    upstreamId: stop.id ?? stop.upstreamId,
    name: stop.name || stop.nameEn || stop.nameZh || stop.id,
    nameEn: stop.nameEn ?? "",
    nameZh: stop.nameZh ?? "",
    category: "lightRailStops",
    lat: stop.lat,
    lng: stop.lng,
    routes: Array.isArray(stop.routes) ? stop.routes : [],
    distanceMetres:
      typeof stop.distanceMetres === "number" ? stop.distanceMetres : null,
  };
}

// =============================================================================
// Ferry pier API
// =============================================================================

/**
 * Fetch nearby ferry piers from /api/ferry/stops. Returns a normalised
 * array of
 * `{ id, name, nameEn, nameZh, lat, lng, companies, distanceMetres }` or
 * `[]` on failure. `companies` is the de-duplicated list of ferry
 * operators that touch the pier (e.g. ["sunferry", "hkkf"]).
 *
 * Pass `maxDistance` (metres) to override the default radius and
 * `company` (csv) to restrict to specific ferry operators (e.g.
 * "sunferry" or "sunferry,hkkf").
 */
export async function fetchNearbyFerryPiers({
  lat,
  lon,
  locale,
  maxDistance,
  company,
  limit,
}) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    maxDistance: String(maxDistance ?? HOME_NEARBY_FERRY_PIER_RADIUS_M),
    limit: String(limit ?? HOME_NEARBY_FERRY_PIER_LIMIT),
    locale: locale ?? "en",
  });
  if (company) params.set("company", company);
  const res = await fetch(`/api/ferry/stops?${params}`);
  if (!res.ok) throw new Error(`ferry/stops API ${res.status}`);
  const data = await res.json();
  return (data.stops ?? [])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({
      id: `ferry-${s.id}`,
      upstreamId: s.id,
      name: s.name || s.nameEn || s.nameZh || s.id,
      nameEn: s.nameEn ?? "",
      nameZh: s.nameZh ?? "",
      category: "ferryPiers",
      lat: s.lat,
      lng: s.lng,
      companies: Array.isArray(s.companies) ? s.companies : [],
      distanceMetres:
        typeof s.distanceMetres === "number" ? s.distanceMetres : null,
    }));
}

/**
 * Normalize a single ferry pier record (used when re-hydrating from
 * search results or saved frequent places).
 */
export function normalizeFerryPier(stop) {
  return {
    id: `ferry-${stop.id}`,
    upstreamId: stop.id ?? stop.upstreamId,
    name: stop.name || stop.nameEn || stop.nameZh || stop.id,
    nameEn: stop.nameEn ?? "",
    nameZh: stop.nameZh ?? "",
    category: "ferryPiers",
    lat: stop.lat,
    lng: stop.lng,
    companies: Array.isArray(stop.companies) ? stop.companies : [],
    distanceMetres:
      typeof stop.distanceMetres === "number" ? stop.distanceMetres : null,
  };
}

// =============================================================================
// Spot helpers
// =============================================================================

/**
 * Check if a spot is a toilet.
 */
export function isToiletSpot(spot) {
  return spot?.category === "toilets";
}

/**
 * Check if a spot is a bus stop.
 */
export function isBusStopSpot(spot) {
  return spot?.category === "busStops";
}

/**
 * Check if a spot is an MTR station.
 */
export function isMtrStationSpot(spot) {
  return spot?.category === "mtrStations";
}

/**
 * Check if a spot is a Light Rail stop.
 */
export function isLightRailStopSpot(spot) {
  return spot?.category === "lightRailStops";
}

/**
 * Check if a spot is a ferry pier.
 */
export function isFerryPierSpot(spot) {
  return spot?.category === "ferryPiers";
}

/**
 * Check if a spot is a HK Tramways (Ding Ding) tram stop.
 */
export function isTramStopSpot(spot) {
  return spot?.category === "tramStops";
}

/**
 * Check if a spot is one of the public-transport categories (bus stop,
 * MTR station, Light Rail stop, ferry pier, or HK Tramways tram stop).
 * Used by the closest-station tab in the bottom sheet so all five
 * transport layers feed the same "closest station" lookup.
 */
export function isTransportSpot(spot) {
  return (
    isBusStopSpot(spot) ||
    isMtrStationSpot(spot) ||
    isLightRailStopSpot(spot) ||
    isFerryPierSpot(spot) ||
    isTramStopSpot(spot)
  );
}

/**
 * Get the top N toilet spots from a list.
 */
export function getTopNToilets(spots, n = 5) {
  return spots.filter((s) => s.category === "toilets").slice(0, n);
}

/**
 * Get the top N bus stop spots from a list.
 */
export function getTopNBusStops(spots, n = 5) {
  return spots.filter((s) => s.category === "busStops").slice(0, n);
}

/**
 * Get the top N MTR station spots from a list.
 */
export function getTopNMtrStations(spots, n = 10) {
  return spots.filter((s) => s.category === "mtrStations").slice(0, n);
}

/**
 * Get the top N Light Rail stop spots from a list.
 */
export function getTopNLightRailStops(spots, n = 10) {
  return spots.filter((s) => s.category === "lightRailStops").slice(0, n);
}

/**
 * Get the top N ferry pier spots from a list.
 */
export function getTopNFerryPiers(spots, n = 10) {
  return spots.filter((s) => s.category === "ferryPiers").slice(0, n);
}

// =============================================================================
// HK Tramways tram stop API
// =============================================================================

/**
 * Fetch nearby HK Tramways (the Hong Kong Island "Ding Ding") stops
 * from /api/tram/stops. Returns a normalised array of
 * `{ id, name, nameEn, nameTc, nameSc, lat, lng, direction, distanceMetres }`
 * or `[]` on failure. `direction` is one of
 * `"east" | "west" | "east & west" | "terminus"` — derived from the
 * upstream `stop_code` suffix (see @/lib/hkTramways).
 *
 * The upstream catalogue is shared across all of Hong Kong Island, so
 * callers typically also pass a generous `maxDistance`. The default
 * radius constant (`HOME_NEARBY_TRAM_STOP_RADIUS_M`) is tuned for the
 * home map's zoom curve.
 */
export async function fetchNearbyTramStops({
  lat,
  lon,
  locale,
  maxDistance,
  limit,
}) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    maxDistance: String(maxDistance ?? HOME_NEARBY_TRAM_STOP_RADIUS_M),
    limit: String(limit ?? HOME_NEARBY_TRAM_STOP_LIMIT),
    locale: locale ?? "en",
  });
  const res = await fetch(`/api/tram/stops?${params}`);
  if (!res.ok) throw new Error(`tram/stops API ${res.status}`);
  const data = await res.json();
  return (data.stops ?? [])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({
      id: `tram-${s.id}`,
      upstreamId: s.id,
      name: s.name || s.nameEn || s.nameTc || s.id,
      nameEn: s.nameEn ?? "",
      nameTc: s.nameTc ?? "",
      nameSc: s.nameSc ?? "",
      category: "tramStops",
      lat: s.lat,
      lng: s.lng,
      direction: s.direction ?? "east & west",
      distanceMetres:
        typeof s.distanceMetres === "number" ? s.distanceMetres : null,
    }));
}

/**
 * Normalize a single HK Tramways stop record.
 */
export function normalizeTramStop(stop) {
  return {
    id: `tram-${stop.id}`,
    upstreamId: stop.id ?? stop.upstreamId,
    name: stop.name || stop.nameEn || stop.nameTc || stop.id,
    nameEn: stop.nameEn ?? "",
    nameTc: stop.nameTc ?? "",
    nameSc: stop.nameSc ?? "",
    category: "tramStops",
    lat: stop.lat,
    lng: stop.lng,
    direction: stop.direction ?? "east & west",
    distanceMetres:
      typeof stop.distanceMetres === "number" ? stop.distanceMetres : null,
  };
}

/**
 * Get the top N tram stop spots from a list.
 */
export function getTopNTramStops(spots, n = 20) {
  return spots.filter((s) => s.category === "tramStops").slice(0, n);
}
