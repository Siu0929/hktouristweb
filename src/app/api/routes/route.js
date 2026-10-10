/**
 * POST /api/routes
 *
 * Server-side proxy for the Google Maps Routes API v2
 * (https://developers.google.com/maps/documentation/routes).
 *
 * The Routes API v2 is a REST/gRPC service that supersedes the legacy
 * Maps JavaScript `google.maps.DirectionsService`. It supports the
 * same travel modes (WALK / DRIVE / TRANSIT / BICYCLE / TWO_WHEELER)
 * and returns an `encodedPolyline` for each route leg, which we hand
 * back to the client for direct rendering onto the map.
 *
 * Why a server proxy rather than calling Routes API directly from the
 * browser:
 *   - Keeps the API key out of network traces beyond the first GET
 *     that loads the JS Maps SDK.
 *   - Lets us normalise the request shape, attach the X-Goog-FieldMask
 *     header in one place, and shield the client from the upstream
 *     REST contract if it ever changes.
 *   - Plays nicely with `next/cache` — repeated "show route" clicks
 *     for the same origin/destination pair can be served from the
 *     edge cache instead of round-tripping to Google every time.
 *
 * Request body (JSON):
 *   origin       { lat:number, lng:number }   required
 *   destination  { lat:number, lng:number }   required
 *   travelMode   'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'TWO_WHEELER'
 *                default 'WALK'. These are Routes API v2 `RouteTravelMode`
 *                values and intentionally differ from the legacy
 *                `google.maps.DirectionsService` enum names.
 *   languageCode BCP-47 code, e.g. 'en' | 'zh-Hant'. Optional.
 *
 * Response:
 *   200  { routes: [...] }     raw Routes API response, trimmed by field mask
 *   400  invalid / missing params
 *   502  upstream Routes API error
 *   503  server not configured with a Google Maps API key
 */

import { CACHE_NEARBY } from "@/lib/apiCache";

const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.viewport.low",
  "routes.viewport.high",
  "routes.legs.duration",
  "routes.legs.distanceMeters",
  "routes.legs.startLocation",
  "routes.legs.endLocation",
].join(",");

const ALLOWED_TRAVEL_MODES = new Set([
  "WALK",
  "DRIVE",
  "TRANSIT",
  "BICYCLE",
  "TWO_WHEELER",
]);

function isValidLatLng(value) {
  if (!value || typeof value !== "object") return false;
  const { lat, lng } = value;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export async function POST(request) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error: "routes_unconfigured",
        detail:
          "Set GOOGLE_MAPS_API_KEY (or NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) in .env.local to enable route plotting.",
      },
      { status: 503 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const { origin, destination, travelMode = "WALK", languageCode } = body ?? {};

  if (!isValidLatLng(origin)) {
    return Response.json(
      { error: "invalid_origin", detail: "origin must be { lat, lng } with numeric values." },
      { status: 400 }
    );
  }
  if (!isValidLatLng(destination)) {
    return Response.json(
      {
        error: "invalid_destination",
        detail: "destination must be { lat, lng } with numeric values.",
      },
      { status: 400 }
    );
  }

  const mode = String(travelMode).toUpperCase();
  if (!ALLOWED_TRAVEL_MODES.has(mode)) {
    return Response.json(
      {
        error: "invalid_travel_mode",
        detail: `travelMode must be one of: ${[...ALLOWED_TRAVEL_MODES].join(", ")}.`,
      },
      { status: 400 }
    );
  }

  const requestBody = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: {
      location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
    },
    travelMode: mode,
    computeAlternativeRoutes: false,
    polylineEncoding: "ENCODED_POLYLINE",
    polylineQuality: "OVERVIEW",
  };
  if (languageCode) {
    requestBody.languageCode = languageCode;
  }

  let upstream;
  try {
    upstream = await fetch(ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(requestBody),
      // Cache successful responses on the Next.js data cache for 5 min
      // and serve stale results for up to an hour while we refetch.
      next: { revalidate: 300, tags: ["routes"] },
    });
  } catch (err) {
    console.error("[/api/routes] upstream fetch failed", err);
    return Response.json(
      { error: "upstream_unreachable", detail: err?.message ?? String(err) },
      { status: 502 }
    );
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch (err) {
    console.error("[/api/routes] upstream returned non-JSON", err);
    return Response.json(
      { error: "upstream_bad_response", detail: err?.message ?? String(err) },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    console.error("[/api/routes] upstream error", upstream.status, payload);
    return Response.json(
      {
        error: "upstream_error",
        status: upstream.status,
        detail: payload?.error?.message ?? payload?.error ?? "Routes API request failed",
      },
      { status: 502 }
    );
  }

  return Response.json(payload, {
    headers: { ...CACHE_NEARBY },
  });
}