/**
 * GET /api/search
 *
 * Unified search endpoint that queries POI data sources:
 * - Toilets (community API)
 * - Tourist attractions (static data)
 *
 * Query params:
 *   q           - search keyword (required)
 *   category    - category search mode: toilet,attraction (optional)
 *                 When set, returns nearby results without keyword filtering
 *   types       - comma-separated POI types: toilet,attraction (default: all)
 *   lat         - user latitude for distance calculation
 *   lon         - user longitude for distance calculation
 *   limit       - max results per type (default: 10)
 *   locale      - locale for names (default: en)
 */
import { detectCategoryQuery } from "@/lib/searchCategories";
import { CACHE_SUGGEST } from "@/lib/apiCache";

const TOURIST_ATTRACTIONS = [
  { id: "victoria-peak", name: "Victoria Peak", category: "attraction", lat: 22.2697, lng: 114.1447 },
  { id: "star-ferry", name: "Star Ferry Pier (TST)", category: "attraction", lat: 22.2936, lng: 114.169 },
  { id: "tst-promenade", name: "Tsim Sha Tsui Promenade", category: "attraction", lat: 22.295, lng: 114.1725 },
  { id: "kowloon-park", name: "Kowloon Park", category: "attraction", lat: 22.3014, lng: 114.1718 },
  { id: "temple-street", name: "Temple Street Night Market", category: "attraction", lat: 22.3041, lng: 114.1727 },
  { id: "man-mo", name: "Man Mo Temple", category: "attraction", lat: 22.2819, lng: 114.1747 },
  { id: "science-museum", name: "Hong Kong Science Museum", category: "attraction", lat: 22.2985, lng: 114.1738 },
  { id: "history-museum", name: "Hong Kong Museum of History", category: "attraction", lat: 22.2996, lng: 114.1753 },
  { id: "disneyland", name: "Hong Kong Disneyland", category: "attraction", lat: 22.313, lng: 114.0413 },
  { id: "ocean-park", name: "Ocean Park", category: "attraction", lat: 22.247, lng: 114.1744 },
  { id: "big-buddha", name: "Tian Tan Buddha (Ngong Ping)", category: "attraction", lat: 22.2539, lng: 113.9055 },
  { id: "po-lin", name: "Po Lin Monastery", category: "attraction", lat: 22.2553, lng: 113.9058 },
  { id: "wong-tai-sin", name: "Wong Tai Sin Temple", category: "attraction", lat: 22.3722, lng: 114.1936 },
  { id: "chi-lin", name: "Chi Lin Nunnery", category: "attraction", lat: 22.3419, lng: 114.1748 },
  { id: "lan-qui-fong", name: "Lan Kwai Fong", category: "attraction", lat: 22.2811, lng: 114.1556 },
  { id: "central-harbourfront", name: "Central Harbourfront", category: "attraction", lat: 22.2833, lng: 114.1603 },
];

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function searchStaticData(items, keyword, lat, lon) {
  const q = keyword.toLowerCase();
  return items
    .filter((item) => item.name.toLowerCase().includes(q))
    .map((item) => ({
      ...item,
      distanceMetres: lat && lon ? haversineMetres(lat, lon, item.lat, item.lng) : null,
    }))
    .sort((a, b) => (a.distanceMetres ?? 0) - (b.distanceMetres ?? 0));
}

async function searchToilets(keyword, lat, lon, limit, locale) {
  if (!lat || !lon) return [];
  const radiusMetres = 5000;
  const url = new URL("https://d1j9v58xka.execute-api.ap-southeast-1.amazonaws.com/prod/toiletGroups");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("maxDistance", String(radiusMetres));

  try {
    const response = await fetch(url, { next: { revalidate: 300 } });
    if (!response.ok) return [];
    const payload = await response.json();
    const q = keyword.toLowerCase();
    return (payload.toiletGroups ?? [])
      .flatMap((group) =>
        (group.toilets ?? []).map((toilet) => ({
          id: toilet._id ?? group._id,
          type: "toilet",
          name: locale?.startsWith("zh")
            ? (toilet.name?.["zh-hk"] || group.name?.["zh-hk"] || toilet.name?.["en-us"] || group.name?.["en-us"] || "")
            : (toilet.name?.["en-us"] || group.name?.["en-us"] || toilet.name?.["zh-hk"] || group.name?.["zh-hk"] || ""),
          lat: Number(toilet.location?.coordinates?.[1] ?? group.location?.coordinates?.[1]),
          lng: Number(toilet.location?.coordinates?.[0] ?? group.location?.coordinates?.[0]),
          barrierFree: toilet.type === "disabled",
          district: group.district ?? "",
          address: locale?.startsWith("zh")
            ? (group.address?.["zh-hk"] || group.address?.["en-us"] || "")
            : (group.address?.["en-us"] || group.address?.["zh-hk"] || ""),
        }))
      )
      .filter((t) => t.name.toLowerCase().includes(q) && Number.isFinite(t.lat))
      .map((toilet) => ({
        ...toilet,
        distanceMetres: haversineMetres(lat, lon, toilet.lat, toilet.lng),
      }))
      .sort((a, b) => a.distanceMetres - b.distanceMetres)
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function searchToiletsNearby(lat, lon, limit, locale) {
  if (!lat || !lon) return [];
  const radiusMetres = 2000;
  const url = new URL("https://d1j9v58xka.execute-api.ap-southeast-1.amazonaws.com/prod/toiletGroups");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("maxDistance", String(radiusMetres));

  try {
    const response = await fetch(url, { next: { revalidate: 300 } });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.toiletGroups ?? [])
      .flatMap((group) =>
        (group.toilets ?? []).map((toilet) => ({
          id: toilet._id ?? group._id,
          type: "toilet",
          name: locale?.startsWith("zh")
            ? (toilet.name?.["zh-hk"] || group.name?.["zh-hk"] || toilet.name?.["en-us"] || group.name?.["en-us"] || "")
            : (toilet.name?.["en-us"] || group.name?.["en-us"] || toilet.name?.["zh-hk"] || group.name?.["zh-hk"] || ""),
          lat: Number(toilet.location?.coordinates?.[1] ?? group.location?.coordinates?.[1]),
          lng: Number(toilet.location?.coordinates?.[0] ?? group.location?.coordinates?.[0]),
          barrierFree: toilet.type === "disabled",
          district: group.district ?? "",
          address: locale?.startsWith("zh")
            ? (group.address?.["zh-hk"] || group.address?.["en-us"] || "")
            : (group.address?.["en-us"] || group.address?.["zh-hk"] || ""),
        }))
      )
      .filter((t) => Number.isFinite(t.lat))
      .map((toilet) => ({
        ...toilet,
        distanceMetres: haversineMetres(lat, lon, toilet.lat, toilet.lng),
      }))
      .sort((a, b) => a.distanceMetres - b.distanceMetres)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const keyword = (searchParams.get("q") ?? "").trim();
  const categoryParam = searchParams.get("category") ?? null;
  const typesParam = searchParams.get("types") ?? "toilet,attraction";
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lon = parseFloat(searchParams.get("lon") ?? "");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10), 20);
  const locale = searchParams.get("locale") ?? "en";

  const types = new Set(typesParam.split(",").map((t) => t.trim().toLowerCase()));
  const t0 = Date.now();

  // If category param is provided, enter category/nearby search mode
  if (categoryParam) {
    const category = categoryParam.toLowerCase();
    const results = [];

    if (category === "toilet" && types.has("toilet")) {
      const nearby = await searchToiletsNearby(lat, lon, limit, locale);
      results.push(...nearby);
    } else if (category === "attraction" && types.has("attraction")) {
      const withDistance = TOURIST_ATTRACTIONS.map((attr) => ({
        ...attr,
        distanceMetres: lat && lon ? haversineMetres(lat, lon, attr.lat, attr.lng) : null,
      }))
        .sort((a, b) => (a.distanceMetres ?? 0) - (b.distanceMetres ?? 0))
        .slice(0, limit);
      results.push(...withDistance);
    }

    return Response.json(
      {
        keyword,
        category,
        total: results.length,
        queryMs: Date.now() - t0,
        results: { [category]: results },
      },
      {
        headers: {
          ...CACHE_SUGGEST,
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Normal keyword-based search
  if (!keyword) {
    return Response.json({ error: "q (keyword) is required" }, { status: 400 });
  }

  const promises = [];

  if (types.has("toilet")) {
    promises.push(
      searchToilets(keyword, lat, lon, limit, locale).then((results) => ({
        type: "toilet",
        results,
      }))
    );
  }

  if (types.has("attraction")) {
    const results = searchStaticData(TOURIST_ATTRACTIONS, keyword, lat, lon).slice(0, limit);
    promises.push(Promise.resolve({ type: "attraction", results }));
  }

  const typeResults = await Promise.all(promises);
  const resultMap = {};
  let total = 0;

  for (const { type, results: items } of typeResults) {
    resultMap[type] = items;
    total += items.length;
  }

  return Response.json(
    {
      keyword,
      total,
      queryMs: Date.now() - t0,
      results: resultMap,
    },
    {
      headers: {
        ...CACHE_SUGGEST,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
