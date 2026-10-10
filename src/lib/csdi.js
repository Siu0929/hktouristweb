/**
 * CSDI WFS API client for Hong Kong government spatial datasets.
 *
 * Endpoints (verified, no API key required):
 *   - FEHD: https://portal.csdi.gov.hk/server/services/common/fehd_rcd_1629969687926_30590/MapServer/WFSServer
 *   - AFCD: https://portal.csdi.gov.hk/server/services/common/afcd_rcd_1635136427551_29173/MapServer/WFSServer
 */

const WFS_BASE = "https://portal.csdi.gov.hk/server/services/common";
const FEHD_DSID = "fehd_rcd_1629969687926_30590";
const AFCD_DSID = "afcd_rcd_1635136427551_29173";

/** Build a CSDI WFS GetFeature URL */
function wfsUrl(datasetId, { typeName, count = 1000, startIndex = 0, bbox, filter } = {}) {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    outputFormat: "GeoJSON",
    srsName: "EPSG:4326",
    resultType: "results",
    count: String(count),
    startIndex: String(startIndex),
  });
  if (bbox) params.set("bbox", bbox);
  return `${WFS_BASE}/${datasetId}/MapServer/WFSServer?${params.toString()}`;
}

async function fetchWfs(url) {
  const res = await fetch(url, {
    next: { revalidate: 3600 },
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WFS fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Fetch all FEHD facilities (toilets + refuse points + markets + etc.) */
export async function fetchAllFEHDFacilities() {
  const url = wfsUrl(FEHD_DSID, { typeName: "csdi:FEHD_FACI", count: 2000 });
  const data = await fetchWfs(url);
  return data?.features ?? [];
}

/** Fetch all country-park toilets (AFCD) */
export async function fetchAllCountryParkToilets() {
  const url = wfsUrl(AFCD_DSID, { typeName: "csdi:Toilets_Toilets_Ext_GDB", count: 500 });
  const data = await fetchWfs(url);
  return data?.features ?? [];
}

/** Fetch FEHD facilities within a bounding box (WGS84) */
export async function fetchFEHDByBBox(minLat, minLon, maxLat, maxLon) {
  const bbox = `${minLat},${minLon},${maxLat},${maxLon},EPSG:4326`;
  const url = wfsUrl(FEHD_DSID, { typeName: "csdi:FEHD_FACI", count: 1000, bbox });
  const data = await fetchWfs(url);
  return data?.features ?? [];
}

/** Fetch AFCD toilets within a bounding box */
export async function fetchAFCDByBBox(minLat, minLon, maxLat, maxLon) {
  const bbox = `${minLat},${minLon},${maxLat},${maxLon},EPSG:4326`;
  const url = wfsUrl(AFCD_DSID, { typeName: "csdi:Toilets_Toilets_Ext_GDB", count: 500, bbox });
  const data = await fetchWfs(url);
  return data?.features ?? [];
}

// ---------------------------------------------------------------------------
// Client-side helpers (for use directly in browser components)
// ---------------------------------------------------------------------------

export const CLIENT_WFS = {
  FEHD: `${WFS_BASE}/${FEHD_DSID}/MapServer/WFSServer`,
  AFCD: `${WFS_BASE}/${AFCD_DSID}/MapServer/WFSServer`,
};

export function clientWfsUrl(dataset, { typeName, count = 500, bbox } = {}) {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    outputFormat: "GeoJSON",
    srsName: "EPSG:4326",
    resultType: "results",
    count: String(count),
  });
  if (bbox) params.set("bbox", bbox);
  return `${dataset}?${params.toString()}`;
}

export const TOILET_TYPE_NAMES = [
  "PUBLIC TOILETS",
  "ACCESSIBLE UNISEX TOILETS",
  "AQUA PRIVY",
];

/** Return true if the FEHD facility is a toilet (not a refuse point, market, etc.) */
export function isToilet(record) {
  const cat = record.properties?.SEARCH02_EN ?? "";
  return TOILET_TYPE_NAMES.some((t) => cat.includes(t));
}

/** Normalise a GeoJSON feature into a clean toilet object */
export function normaliseFEHD(record, locale = "en") {
  const p = record.properties ?? {};
  const useChinese = locale === "zh-Hant" || locale === "zh-Hans";
  return {
    id: `fehd-${p.OBJECTID ?? record.id}`,
    source: "FEHD",
    name: useChinese
      ? (p.NAME_TC ?? p.NAME_EN ?? "Public Toilet")
      : (p.NAME_EN ?? p.NAME_TC ?? "Public Toilet"),
    address: useChinese
      ? (p.ADDRESS_TC ?? p.ADDRESS_EN ?? "")
      : (p.ADDRESS_EN ?? p.ADDRESS_TC ?? ""),
    district: useChinese
      ? (p.SEARCH01_TC ?? p.SEARCH01_EN ?? "")
      : (p.SEARCH01_EN ?? p.SEARCH01_TC ?? ""),
    category: useChinese
      ? (p.SEARCH02_TC ?? p.SEARCH02_EN ?? "")
      : (p.SEARCH02_EN ?? p.SEARCH02_TC ?? ""),
    hours: useChinese
      ? (p.NSEARCH04_TC ?? p.NSEARCH04_EN ?? "")
      : (p.NSEARCH04_EN ?? p.NSEARCH04_TC ?? ""),
    lat: parseFloat(p.LATITUDE) || record.geometry?.coordinates[1],
    lon: parseFloat(p.LONGITUDE) || record.geometry?.coordinates[0],
    barrierFree: /ACCESSIBLE/i.test(p.SEARCH02_EN ?? ""),
  };
}

export function normaliseAFCD(record, locale = "en") {
  const p = record.properties ?? {};
  const useChinese = locale === "zh-Hant" || locale === "zh-Hans";
  return {
    id: `afcd-${p.OBJECTID ?? record.id}`,
    source: "AFCD",
    name: useChinese
      ? (p.FACILITY_NAME_TC ?? p.FACILITY_NAME_EN ?? "Country Park Toilet")
      : (p.FACILITY_NAME_EN ?? p.FACILITY_NAME_TC ?? "Country Park Toilet"),
    address: "",
    district: useChinese
      ? (p.COUNTRY_PARK_TC ?? p.COUNTRY_PARK_EN ?? "")
      : (p.COUNTRY_PARK_EN ?? p.COUNTRY_PARK_TC ?? ""),
    category: useChinese
      ? (p.TYPE_TC ?? p.TYPE_EN ?? "")
      : (p.TYPE_EN ?? p.TYPE_TC ?? ""),
    hours: "",
    lat: record.geometry?.coordinates[1],
    lon: record.geometry?.coordinates[0],
    barrierFree: p.BARRIER_FREE_FAC === "Y",
  };
}
