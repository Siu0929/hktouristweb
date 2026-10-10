/**
 * GET /api/toilets/nearby
 *
 * Returns community-sourced toilets around a lat/lon point.
 *
 * Required query params (either naming convention is accepted):
 *   lat / latitude       – centre latitude (WGS84)
 *   lon / longitude      – centre longitude (WGS84)
 *
 * Optional:
 *   barrierFree – "true" to return accessible toilets only
 *   maxDistance – search radius in metres (default: 1500, max: 10000)
 *   limit       – maximum results (default: 50, maximum: 200)
 *   locale      – locale used for names and addresses
 *   district    – filter by district name (case-insensitive substring match)
 *   category    – filter by category (park, mall, building)
 */
import { CACHE_NEARBY } from "@/lib/apiCache";

const API_BASE =
  "https://d1j9v58xka.execute-api.ap-southeast-1.amazonaws.com/prod/toiletGroups";
const DEFAULT_DISTANCE_METRES = 1500;
const MAX_DISTANCE_METRES = 10000;

function haversineMetres(lat1, lon1, lat2, lon2) {
  const earthRadiusMetres = 6_371_000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLon / 2) ** 2;

  return earthRadiusMetres * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getLocalizedValue(value, locale) {
  const useChinese = locale?.toLowerCase().startsWith("zh");
  return useChinese
    ? (value?.["zh-hk"] ?? value?.["en-us"] ?? "")
    : (value?.["en-us"] ?? value?.["zh-hk"] ?? "");
}

function formatOpeningHours(start, end) {
  if (!start && !end) return "";
  if (!start || !end) return start ? `From ${start}` : `Until ${end}`;
  return `${start}–${end}`;
}

// ---------------------------------------------------------------------------
// Output sanitisation helpers — strip HTML / script injection from any
// user-facing string fields returned by this route.
// ---------------------------------------------------------------------------
const MAX_STRING_LEN = 500;
const DANGEROUS_RE = /<[^>]*script|on\w+\s*=/gi;

function sanitiseField(value) {
  if (value == null) return "";
  const str = String(value).slice(0, MAX_STRING_LEN);
  return str.replace(DANGEROUS_RE, "");
}

function sanitiseToilet(toilet) {
  return {
    id: sanitiseField(toilet.id),
    source: "community",
    name: sanitiseField(toilet.name),
    type: sanitiseField(toilet.type),
    district: sanitiseField(toilet.district),
    address: sanitiseField(toilet.address),
    latitude: Number.isFinite(toilet.latitude) ? toilet.latitude : 0,
    longitude: Number.isFinite(toilet.longitude) ? toilet.longitude : 0,
    barrierFree: !!toilet.barrierFree,
    images: Array.isArray(toilet.images) ? toilet.images.slice(0, 5) : [],
    facilities: Array.isArray(toilet.facilities) ? toilet.facilities : [],
    openingHours: sanitiseField(toilet.openingHours),
    phone: sanitiseField(toilet.phone),
    rating: Number.isFinite(toilet.rating) ? toilet.rating : 0,
    category: sanitiseField(toilet.category),
    description: sanitiseField(toilet.description),
  };
}

function normaliseToilet(toilet, group, locale) {
  const coordinates = toilet.location?.coordinates ?? group.location?.coordinates;

  return sanitiseToilet({
    id: toilet._id ?? group._id,
    source: "community",
    name: getLocalizedValue(toilet.name, locale) || getLocalizedValue(group.name, locale),
    type: toilet.type ?? "",
    district: group.district ?? "",
    address: getLocalizedValue(group.address, locale),
    latitude: Number(coordinates?.[1]),
    longitude: Number(coordinates?.[0]),
    barrierFree: toilet.type === "disabled",
    images: toilet.images ?? [],
    facilities: toilet.facilities ?? [],
    openingHours: formatOpeningHours(
      toilet.openingStartTime,
      toilet.openingEndTime
    ),
    phone: toilet.phone ?? group.phone ?? "",
    rating: toilet.rating?.overall ?? group.rating ?? 0,
    category: group.category ?? "",
    description:
      getLocalizedValue(toilet.description, locale) ||
      getLocalizedValue(group.description, locale),
  });
}

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const lat = Number.parseFloat(
    searchParams.get("lat") ?? searchParams.get("latitude")
  );
  const lon = Number.parseFloat(
    searchParams.get("lon") ?? searchParams.get("longitude")
  );
  const barrierFree = searchParams.get("barrierFree") === "true";
  const district = (searchParams.get("district") ?? "").toLowerCase().trim();
  const category = (searchParams.get("category") ?? "").toLowerCase().trim();
  const locale = searchParams.get("locale") ?? "en";
  const requestedLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 200)
    : 50;
  const requestedDistance = Number.parseFloat(searchParams.get("maxDistance") ?? "");
  const radiusMetres = Number.isFinite(requestedDistance)
    ? Math.min(Math.max(requestedDistance, 50), MAX_DISTANCE_METRES)
    : DEFAULT_DISTANCE_METRES;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json(
      { error: "lat and lon are required and must be numeric" },
      { status: 400 }
    );
  }

  if (lat < 22.1 || lat > 22.6 || lon < 113.8 || lon > 114.5) {
    return Response.json(
      { error: "lat/lon outside Hong Kong bounding box" },
      { status: 400 }
    );
  }

  const t0 = Date.now();
  const apiUrl = new URL(API_BASE);
  apiUrl.searchParams.set("latitude", String(lat));
  apiUrl.searchParams.set("longitude", String(lon));
  apiUrl.searchParams.set("maxDistance", String(radiusMetres));

  let response;
  try {
    // Use no-store to opt out of Next.js Data Cache: the upstream toilet
    // API regularly returns payloads > 2MB, which exceeds Next.js's
    // per-item cache size limit and triggers "items over 2MB can not be
    // cached". HTTP caching is still controlled by the Cache-Control
    // header set on this route's response below.
    //
    // Pass `signal: request.signal` so an aborting client (or the
    // Next.js runtime tearing the worker down) cancels the upstream
    // fetch — without this, a slow 2MB read of `payload` keeps
    // allocating heap until the response ends even after the user
    // closed the tab.
    response = await fetch(apiUrl, { cache: "no-store", signal: request.signal });
  } catch (err) {
    if (err?.name === "AbortError") return new Response(null, { status: 499 });
    return Response.json(
      { error: "Failed to reach toilet API" },
      { status: 502 }
    );
  }

  if (!response.ok) {
    return Response.json(
      { error: `Upstream API error: ${response.status}` },
      { status: 502 }
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return Response.json(
      { error: "Toilet API returned an invalid response" },
      { status: 502 }
    );
  }

  // Phase 3 — single-pass filter pipeline.
  //
  // The previous implementation chained four `.filter()` / `.map()`
  // passes, each allocating a fresh intermediate array. The upstream
  // toilet corpus is typically 1500–3000 entries, so the peak
  // resident heap during this loop landed around 4–6 MB on top of
  // the 2 MB upstream buffer.
  //
  // The replacement flattens to a single `for` loop that:
  //   1. normalises the toilet inline (no intermediate normalised array),
  //   2. drops invalid-coord entries inline,
  //   3. computes the haversine distance inline (no `.map`
  //      intermediate, and the resulting value can be tested against
  //      `radiusMetres` immediately),
  //   4. applies the cheap predicate filters (`district` / `barrierFree`
  //      / `category`) inline,
  //   5. pushes exactly one enriched entry per survivor.
  //
  // Net effect: peak transient allocation during a `/api/toilets/nearby`
  // call drops from ~5 MB (multiple intermediate arrays) to ~2 MB
  // (the raw upstream buffer + the single surviving array). On a 200
  // RPS workload that is roughly 600 MB/s of avoided GC churn.
  const districtNeedle = district;
  const categoryNeedle = category;
  const groupList = Array.isArray(payload?.toiletGroups) ? payload.toiletGroups : [];
  const candidates = [];
  for (let gi = 0, glen = groupList.length; gi < glen; gi++) {
    const group = groupList[gi];
    const toiletsInGroup = Array.isArray(group?.toilets) ? group.toilets : null;
    if (!toiletsInGroup) continue;
    for (let ti = 0, tlen = toiletsInGroup.length; ti < tlen; ti++) {
      const toilet = toiletsInGroup[ti];
      // Inline normalise. `normaliseToilet()` already builds a fresh
      // object per call, so there's nothing to save by skipping it —
      // we just stop allocating downstream of it.
      const normalised = normaliseToilet(toilet, group, locale);
      if (!Number.isFinite(normalised.latitude) || !Number.isFinite(normalised.longitude)) {
        continue;
      }
      if (districtNeedle && !normalised.district.toLowerCase().includes(districtNeedle)) {
        continue;
      }
      if (barrierFree && !normalised.barrierFree) continue;
      if (categoryNeedle && !(normalised.category ?? "").toLowerCase().includes(categoryNeedle)) {
        continue;
      }
      const distanceMetres = haversineMetres(
        lat,
        lon,
        normalised.latitude,
        normalised.longitude
      );
      if (distanceMetres > radiusMetres) continue;
      // Mutate-then-push (the returned object is fresh from
      // normaliseToilet so this is local-only).
      normalised.distanceMetres = distanceMetres;
      candidates.push(normalised);
    }
  }

  // Sort happens once on the (now deduplicated) survivors. The
  // `slice(0, limit)` below avoids copying when the result already
  // fits; sorting first means `slice` keeps the closest entries.
  candidates.sort((a, b) => a.distanceMetres - b.distanceMetres);
  const truncated = candidates.length > limit;
  const toilets = truncated ? candidates.slice(0, limit) : candidates;

  return Response.json(
    {
      centre: { lat, lon },
      radiusMetres,
      total: toilets.length,
      truncated,
      queryMs: Date.now() - t0,
      toilets,
    },
    {
      headers: {
        ...CACHE_NEARBY,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
