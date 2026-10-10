/**
 * GET /api/mtr/route
 *
 * Returns full details for a single MTR line: its metadata plus every
 * station in each boarding direction, hydrated with lat/lng so the
 * client can draw the line on the map without an extra round trip
 * (the MTR-equivalent of `/api/bus-route`).
 *
 * Query params:
 *   routeId - the upstream route key from /api/mtr/routes (required)
 *   locale  - "en" | "zh-Hant" | "zh-Hans" (default: "en")
 *
 * Response:
 *   {
 *     route: { id, route, co, orig, dest, bound, serviceType, ... },
 *     stops: [
 *       { company, seq, stopId, name, nameEn, nameZh, lat, lng }
 *     ]
 *   }
 */
import { CACHE_STATIC } from "@/lib/apiCache";
import {
  getEtaDb,
  getStopsForRoute,
  localisedStopName,
  localisedTerminal,
} from "@/lib/hkBusEta";

export const dynamic = "force-dynamic";

function sanitiseLocale(raw) {
  const value = (raw ?? "en").toLowerCase();
  if (value.startsWith("zh-hant") || value === "zh-tw") return "zh-Hant";
  if (value.startsWith("zh-hans") || value === "zh-cn") return "zh-Hans";
  return "en";
}

export async function GET(request) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);
  const routeId = (searchParams.get("routeId") ?? "").trim();
  const locale = sanitiseLocale(searchParams.get("locale"));

  if (!routeId) {
    return Response.json(
      { error: "Query param `routeId` is required (use a route ID from /api/mtr/routes)" },
      { status: 400 }
    );
  }

  let db;
  try {
    db = await getEtaDb("mtr");
  } catch (err) {
    console.error("[/api/mtr/route] hk-bus-eta fetch failed:", err);
    return Response.json(
      { error: "Failed to load MTR line catalogue" },
      { status: 502 }
    );
  }

  const route = db.routeList?.[routeId];
  if (!route) {
    return Response.json(
      { error: `MTR line "${routeId}" not found` },
      { status: 404 }
    );
  }

  // Walk the cached reverse index for this route, in boarding order.
  const indexed = getStopsForRoute(routeId, "mtr");

  const stops = [];
  const seenStopIds = new Set();
  for (const { stopId, company, seq } of indexed) {
    const stop = db.stopList?.[stopId];
    if (!stop) continue;
    stops.push({
      company,
      seq,
      stopId,
      name: localisedStopName(stop, locale),
      nameEn: stop.name?.en ?? "",
      nameZh: stop.name?.zh ?? "",
      lat: stop.location?.lat ?? null,
      lng: stop.location?.lng ?? null,
    });
    seenStopIds.add(stopId);
  }

  return Response.json(
    {
      queryMs: Date.now() - t0,
      locale,
      route: {
        id: routeId,
        route: route.route,
        co: route.co,
        orig: {
          en: route.orig?.en ?? "",
          zh: route.orig?.zh ?? "",
          display: localisedTerminal(route.orig, locale),
        },
        dest: {
          en: route.dest?.en ?? "",
          zh: route.dest?.zh ?? "",
          display: localisedTerminal(route.dest, locale),
        },
        serviceType: route.serviceType,
        seq: route.seq,
        bound: route.bound,
        fares: route.fares ?? null,
        faresHoliday: route.faresHoliday ?? null,
        jt: route.jt,
        gtfsId: route.gtfsId ?? null,
        stopCount: stops.length,
        uniqueStopCount: seenStopIds.size,
      },
      stops,
    },
    {
      headers: {
        ...CACHE_STATIC,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}