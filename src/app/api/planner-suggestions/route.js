/**
 * GET /api/planner-suggestions
 *
 * Returns suggestions for trip planning based on popular tourist
 * combinations of nearby attractions.
 *
 * Query params:
 *   lat      - user latitude
 *   lon      - user longitude
 *   category - optional: "attraction" | "dining" | "nature"
 *   limit    - max suggestions (default: 5)
 *   locale   - locale for response (default: en)
 */
import { CACHE_NEARBY } from "@/lib/apiCache";

const POPULAR_TEMPLATES = [
  {
    id: "peak-to-central",
    name: "Victoria Peak to Central",
    nameZh: "太平山顶到中环",
    description: "Take the Peak Tram down, explore Central",
    descriptionZh: "乘山顶缆车下山，游览中环",
    type: "attraction",
    places: [
      { id: "victoria-peak", name: "Victoria Peak", lat: 22.2697, lng: 114.1447 },
      { id: "central-harbourfront", name: "Central Harbourfront", lat: 22.2833, lng: 114.1603 },
    ],
  },
  {
    id: "temple-tour",
    name: "Temple District Tour",
    nameZh: "寺庙之旅",
    description: "Visit Wong Tai Sin, Chi Lin, and Man Mo temples",
    descriptionZh: "参观黄大仙祠、志莲净苑和文武庙",
    type: "attraction",
    places: [
      { id: "wong-tai-sin", name: "Wong Tai Sin Temple", lat: 22.3722, lng: 114.1936 },
      { id: "chi-lin", name: "Chi Lin Nunnery", lat: 22.3419, lng: 114.1748 },
      { id: "man-mo", name: "Man Mo Temple", lat: 22.2819, lng: 114.1747 },
    ],
  },
  {
    id: "harbour-walk",
    name: "Harbourfront Walk",
    nameZh: "海滨漫步",
    description: "TST Promenade to Central Harbourfront",
    descriptionZh: "尖沙咀海滨到中环海滨",
    type: "nature",
    places: [
      { id: "tst-promenade", name: "Tsim Sha Tsui Promenade", lat: 22.295, lng: 114.1725 },
      { id: "star-ferry", name: "Star Ferry Pier", lat: 22.2936, lng: 114.169 },
      { id: "central-harbourfront", name: "Central Harbourfront", lat: 22.2833, lng: 114.1603 },
    ],
  },
  {
    id: "disneyland-combo",
    name: "Disneyland Day Trip",
    nameZh: "迪士尼一日游",
    description: "A full day at Hong Kong Disneyland",
    descriptionZh: "香港迪士尼乐园一日游",
    type: "attraction",
    places: [
      { id: "disneyland", name: "Hong Kong Disneyland", lat: 22.313, lng: 114.0413 },
    ],
  },
  {
    id: "ocean-park-day",
    name: "Ocean Park Adventure",
    nameZh: "海洋公园之旅",
    description: "Spend the day at Ocean Park",
    descriptionZh: "在海洋公园玩一整天",
    type: "attraction",
    places: [
      { id: "ocean-park", name: "Ocean Park", lat: 22.247, lng: 114.1744 },
    ],
  },
  {
    id: "lantau-buddha",
    name: "Lantau Island Buddha Tour",
    nameZh: "大屿山佛像之旅",
    description: "Visit the Tian Tan Buddha and Po Lin Monastery",
    descriptionZh: "参观天坛大佛和宝莲寺",
    type: "attraction",
    places: [
      { id: "big-buddha", name: "Tian Tan Buddha (Ngong Ping)", lat: 22.2539, lng: 113.9055 },
      { id: "po-lin", name: "Po Lin Monastery", lat: 22.2553, lng: 113.9058 },
    ],
  },
];

const NEARBY_TOILET_HELPER = {
  id: "toilet-helper",
  name: "Restroom Finder",
  nameZh: "找洗手间",
  description: "Find nearby public toilets",
  descriptionZh: "寻找附近公共厕所",
  type: "utility",
};

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

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lon = parseFloat(searchParams.get("lon") ?? "");
  const category = searchParams.get("category") ?? "";
  const requestedLimit = parseInt(searchParams.get("limit") ?? "5", 10);
  const limit = Math.min(Math.max(requestedLimit, 1), 10);
  const locale = searchParams.get("locale") ?? "en";

  const suggestions = [];
  const isChinese = locale?.toLowerCase().startsWith("zh");

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    suggestions.push({
      ...NEARBY_TOILET_HELPER,
      name: isChinese ? NEARBY_TOILET_HELPER.nameZh : NEARBY_TOILET_HELPER.name,
      description: isChinese ? NEARBY_TOILET_HELPER.descriptionZh : NEARBY_TOILET_HELPER.description,
    });
  }

  for (const template of POPULAR_TEMPLATES) {
    if (category && template.type !== category) continue;
    if (suggestions.length >= limit) break;

    suggestions.push({
      id: template.id,
      name: isChinese ? template.nameZh : template.name,
      description: isChinese ? template.descriptionZh : template.description,
      type: template.type,
      places: template.places,
      isTemplate: true,
    });
  }

  // Annotate templates with the distance to their first place so the UI
  // can sort nearest-first when the user has location access.
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    for (const suggestion of suggestions) {
      const firstPlace = suggestion.places?.[0];
      if (firstPlace && Number.isFinite(firstPlace.lat) && Number.isFinite(firstPlace.lng)) {
        suggestion.distanceMetres = haversineMetres(lat, lon, firstPlace.lat, firstPlace.lng);
      }
    }
  }

  suggestions.sort((a, b) => {
    const aDist = a.distanceMetres ?? Infinity;
    const bDist = b.distanceMetres ?? Infinity;
    return aDist - bDist;
  });

  return Response.json(
    {
      suggestions: suggestions.slice(0, limit),
      locale,
      hasLocation: Number.isFinite(lat) && Number.isFinite(lon),
    },
    {
      headers: {
        ...CACHE_NEARBY,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
