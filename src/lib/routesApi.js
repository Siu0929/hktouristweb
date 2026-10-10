/**
 * Client-side wrapper around the Google Maps Routes API v2 proxy at
 * /api/routes. Replaces the legacy `google.maps.DirectionsService` /
 * `google.maps.DirectionsRenderer` pair with a direct REST call that
 * returns the route as an encoded polyline.
 *
 * The encoded polyline (`polyline.encodedPolyline` on each `Route`
 * returned by Routes API v2) is in Google's standard "Encoded Polyline
 * Algorithm Format" (precision 5e-5), the same format the
 * `google.maps.geometry.encoding.decodePath` helper inside the
 * `geometry` JS library already understands — which we already load
 * in `lib/googleMaps.js`, so no extra dependency is required.
 *
 * See https://developers.google.com/maps/documentation/routes for the
 * upstream REST contract.
 */

/**
 * @typedef {Object} LatLngInput
 * @property {number} lat
 * @property {number} lng
 * @property {number} [lon]   backwards-compatible alias for `lng`
 */

/**
 * Routes API v2 `RouteTravelMode` enum values. Note these differ from
 * the legacy `google.maps.DirectionsService` / `TravelMode` enum:
 * `WALK` (not `WALKING`), `DRIVE` (not `DRIVING`), `BICYCLE`
 * (not `BICYCLING`). `TRANSIT` and `TWO_WHEELER` keep the same name.
 * See https://developers.google.com/maps/documentation/routes/reference/rest/v2/RouteTravelMode.
 *
 * @typedef {'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'TWO_WHEELER'} TravelMode
 */

/**
 * @typedef {Object} RouteLegView
 * @property {number} distanceMeters
 * @property {string} duration           e.g. "612s"
 * @property {{ latitude: number, longitude: number }} startLocation
 * @property {{ latitude: number, longitude: number }} endLocation
 */

/**
 * @typedef {Object} DecodedRoute
 * @property {number} distanceMeters
 * @property {string} duration
 * @property {Array<{ lat: number, lng: number }>} path
 * @property {RouteLegView[]} legs
 * @property {{ low: { latitude: number, longitude: number }, high: { latitude: number, longitude: number } } | null} viewport
 */

/**
 * Normalise any caller-supplied LatLng to the { lat, lng } shape we
 * ship to the Routes API. Some upstream feed records use `lng`,
 * others `lon`; this lets callers pass either without thinking about
 * it.
 *
 * @param {LatLngInput | null | undefined} value
 * @returns {{ lat: number, lng: number } | null}
 */
function normaliseLatLng(value) {
  if (!value || typeof value !== "object") return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng ?? value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Decode an encoded Google polyline string into an array of
 * {lat, lng} pairs using the JS Maps API's `geometry` library.
 * Returns an empty array if the decoder isn't available or the
 * string is empty.
 *
 * @param {string | null | undefined} encoded
 * @returns {Array<{ lat: number, lng: number }>}
 */
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== "string") return [];
  if (
    typeof window === "undefined" ||
    !window.google?.maps?.geometry?.encoding?.decodePath
  ) {
    return [];
  }
  try {
    const path = window.google.maps.geometry.encoding.decodePath(encoded);
    return path.map((latLng) => ({
      lat: latLng.lat(),
      lng: latLng.lng(),
    }));
  } catch {
    return [];
  }
}

/**
 * Build a LatLngBounds-compatible object for `map.fitBounds()` from a
 * Routes API `viewport`. Returns null if the viewport is missing or
 * malformed so the caller can fall back to deriving bounds from the
 * decoded path.
 *
 * @param {any} viewport
 * @returns {{ low: { latitude: number, longitude: number }, high: { latitude: number, longitude: number } } | null}
 */
function normaliseViewport(viewport) {
  if (!viewport?.low || !viewport?.high) return null;
  const low = viewport.low;
  const high = viewport.high;
  if (
    !Number.isFinite(low.latitude) ||
    !Number.isFinite(low.longitude) ||
    !Number.isFinite(high.latitude) ||
    !Number.isFinite(high.longitude)
  ) {
    return null;
  }
  return { low, high };
}

/**
 * Fetch a route from the user's position to the destination dot
 * using Routes API v2.
 *
 * @param {Object} args
 * @param {LatLngInput} args.origin
 * @param {LatLngInput} args.destination
 * @param {TravelMode} [args.travelMode='WALK']
 * @param {string} [args.languageCode]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ routes: DecodedRoute[] }>}
 * @throws {Error} with `.code` set when the request fails for a known reason
 */
export async function fetchRoute({
  origin,
  destination,
  travelMode = "WALK",
  languageCode,
  signal,
} = {}) {
  const safeOrigin = normaliseLatLng(origin);
  const safeDestination = normaliseLatLng(destination);
  if (!safeOrigin) {
    const err = new Error("origin must be { lat, lng } with numeric values.");
    err.code = "invalid_origin";
    throw err;
  }
  if (!safeDestination) {
    const err = new Error("destination must be { lat, lng } with numeric values.");
    err.code = "invalid_destination";
    throw err;
  }

  let response;
  try {
    response = await fetch("/api/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: safeOrigin,
        destination: safeDestination,
        travelMode,
        ...(languageCode ? { languageCode } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const wrapped = new Error(err?.message ?? "Network error contacting /api/routes");
    wrapped.code = "network_error";
    throw wrapped;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const err = new Error(`/api/routes returned a non-JSON body (status ${response.status}).`);
    err.code = "bad_response";
    throw err;
  }

  if (!response.ok || payload?.error) {
    const err = new Error(
      payload?.detail ?? payload?.error ?? `/api/routes failed with status ${response.status}.`
    );
    err.code = payload?.error ?? "upstream_error";
    throw err;
  }

  const rawRoutes = Array.isArray(payload?.routes) ? payload.routes : [];
  const routes = rawRoutes.map((route) => ({
    distanceMeters: route?.distanceMeters ?? 0,
    duration: route?.duration ?? "",
    path: decodePolyline(route?.polyline?.encodedPolyline),
    legs: Array.isArray(route?.legs)
      ? route.legs.map((leg) => ({
          distanceMeters: leg?.distanceMeters ?? 0,
          duration: leg?.duration ?? "",
          startLocation: leg?.startLocation?.latLng ?? leg?.startLocation ?? null,
          endLocation: leg?.endLocation?.latLng ?? leg?.endLocation ?? null,
        }))
      : [],
    viewport: normaliseViewport(route?.viewport),
  }));

  return { routes };
}

/**
 * Convert a Routes API `duration` string (e.g. "612s") into the
 * number of whole minutes (rounded, with a floor of 1 so a 5-second
 * walk doesn't display as "0 min"). Returns null when the input
 * can't be parsed. Used by the closest-station card to render the
 * walking-time pill next to the active route button.
 *
 * @param {string | null | undefined} duration
 * @returns {number | null}
 */
export function routeDurationMinutes(duration) {
  if (!duration || typeof duration !== "string") return null;
  const seconds = Number(duration.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * Convert a Routes API `distanceMeters` integer into a compact
 * string suitable for inline display next to the walking-time
 * pill. Sub-kilometre distances keep their precision (e.g.
 * "350 m"); anything ≥ 1 km is shown with one decimal place
 * ("2.3 km"). Returns null for invalid inputs.
 *
 * @param {number | null | undefined} meters
 * @returns {string | null}
 */
export function routeDistanceLabel(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return null;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Convert a Routes API viewport (lat/lng pairs) into a
 * `google.maps.LatLngBounds` instance the map can fit to. Returns
 * null if the geometry library isn't available or the viewport is
 * malformed.
 *
 * @param {{ low: { latitude: number, longitude: number }, high: { latitude: number, longitude: number } } | null | undefined} viewport
 * @returns {google.maps.LatLngBounds | null}
 */
export function viewportToBounds(viewport) {
  if (
    typeof window === "undefined" ||
    !window.google?.maps?.LatLngBounds ||
    !viewport
  ) {
    return null;
  }
  return new window.google.maps.LatLngBounds(
    { lat: viewport.low.latitude, lng: viewport.low.longitude },
    { lat: viewport.high.latitude, lng: viewport.high.longitude }
  );
}

/**
 * Derive a `google.maps.LatLngBounds` from a decoded path. Used as a
 * fallback when the API didn't return a viewport (rare, but
 * possible for very short routes) or when geometry decoding
 * happens outside the JS Maps SDK context.
 *
 * @param {Array<{ lat: number, lng: number }>} path
 * @returns {google.maps.LatLngBounds | null}
 */
export function pathToBounds(path) {
  if (
    typeof window === "undefined" ||
    !window.google?.maps?.LatLngBounds ||
    !Array.isArray(path) ||
    path.length === 0
  ) {
    return null;
  }
  const bounds = new window.google.maps.LatLngBounds();
  for (const point of path) {
    bounds.extend({ lat: point.lat, lng: point.lng });
  }
  return bounds;
}