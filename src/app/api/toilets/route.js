/**
 * GET /api/toilets
 *
 * Proxies the community toilet API.
 * Server-side cached for 1 hour.
 *
 * Optional query params:
 *   latitude  – center lat for proximity search  (default: 22.285, central HK)
 *   longitude – center lng for proximity search  (default: 114.158)
 *   maxDistance – max metres from center         (default: 5000)
 *   district   – filter by district code (substring, case-insensitive)
 *   barrierFree – "true" to only return accessible facilities
 *   category   – filter by category (park, mall, building)
 */
export const dynamic = "force-static";
export const revalidate = 3600;

import { CACHE_STATIC } from "@/lib/apiCache";

const API_BASE = "https://d1j9v58xka.execute-api.ap-southeast-1.amazonaws.com/prod/toiletGroups";

function normaliseToilet(toilet, group) {
  const locale = "en";
  const isZh = locale === "zh";

  const nameField = toilet.name?.["en-us"] ?? toilet.name?.["zh-hk"] ?? "";
  const groupName = group.name?.["en-us"] ?? group.name?.["zh-hk"] ?? "";
  const addressField =
    (group.address?.["en-us"] ?? group.address?.["zh-hk"] ?? "");

  const barrierFree = toilet.type === "disabled";

  const openingHours = formatOpeningHours(
    toilet.openingStartTime,
    toilet.openingEndTime
  );

  return {
    id: toilet._id,
    name: nameField || groupName,
    type: toilet.type,
    district: group.district ?? "",
    address: addressField,
    latitude: toilet.location?.coordinates?.[1] ?? group.location?.coordinates?.[1] ?? 0,
    longitude: toilet.location?.coordinates?.[0] ?? group.location?.coordinates?.[0] ?? 0,
    barrierFree,
    images: toilet.images ?? [],
    facilities: toilet.facilities ?? [],
    openingHours,
    phone: toilet.phone ?? group.phone ?? "",
    rating: toilet.rating?.overall ?? 0,
    category: group.category ?? "",
    description: toilet.description?.["en-us"] ?? toilet.description?.["zh-hk"] ?? "",
  };
}

function formatOpeningHours(start, end) {
  if (!start && !end) return "";
  if (!start || !end) return start ? `From ${start}` : `Until ${end}`;
  return `${start}–${end}`;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const latitude = searchParams.get("latitude") ?? "22.285";
  const longitude = searchParams.get("longitude") ?? "114.158";
  const maxDistance = searchParams.get("maxDistance") ?? "1000";
  const district = (searchParams.get("district") ?? "").toLowerCase().trim();
  const barrierFree = searchParams.get("barrierFree") === "true";
  const category = (searchParams.get("category") ?? "").toLowerCase().trim();

  const t0 = Date.now();

  const apiUrl = `${API_BASE}?latitude=${latitude}&longitude=${longitude}&maxDistance=${maxDistance}`;
  let data;
  try {
    data = await fetch(apiUrl, { next: { revalidate: 3600 } });
  } catch {
    return Response.json({ error: "Failed to reach toilet API" }, { status: 502 });
  }

  if (!data.ok) {
    return Response.json({ error: `Upstream API error: ${data.status}` }, { status: 502 });
  }

  const json = await data.json();
  const groups = json.toiletGroups ?? [];

  let toilets = [];
  for (const group of groups) {
    for (const toilet of group.toilets ?? []) {
      toilets.push(normaliseToilet(toilet, group));
    }
  }

  if (district) {
    toilets = toilets.filter((t) =>
      t.district.toLowerCase().includes(district)
    );
  }

  if (barrierFree) {
    toilets = toilets.filter((t) => t.barrierFree);
  }

  if (category) {
    toilets = toilets.filter((t) =>
      (t.category ?? "").toLowerCase().includes(category)
    );
  }

  const ms = Date.now() - t0;

  return Response.json(
    {
      total: toilets.length,
      filter: { district: district || null, barrierFree, category: category || null, latitude, longitude, maxDistance },
      queryMs: ms,
      toilets,
    },
    {
      headers: {
        ...CACHE_STATIC,
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
