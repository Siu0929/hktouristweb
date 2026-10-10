/**
 * Shared helper around the HK Tramways public data.
 *
 * Why a thin wrapper?
 *   The `hongkong-trams` npm package wraps two upstream endpoints on
 *   hktramways.com:
 *
 *     1. `GET /js/googleMap.js` — a static JS file that defines two
 *        arrays of tram stops (`stopsArrayEB` for east-bound and
 *        `stopsArrayWB` for west-bound). Each entry is
 *        `[stopCode, en, tc, sc, lat, lng]`. This is the same
 *        catalogue published by the Hong Kong government on
 *        data.gov.hk (dataset `hktramways-hktramways-tram-stops`),
 *        so we use it as the authoritative source of tram-stop
 *        lat/lng for plotting.
 *
 *     2. `GET /nextTram/geteat.php?stop_code=<code>` — a live PHP
 *        endpoint that returns an XML document of upcoming arrivals
 *        at a stop, formatted as `<metadata stop_code="..." seq="..."
 *        tram_id="..." tram_dest_en="..." tram_dest_tc="..."
 *        dest_stop_code="..." arrive_in_minute="..."
 *        arrive_in_second="..." is_arrived="0|1"
 *        is_last_tram="0|1" eat="Jun 23 2016 10:21AM" />` entries
 *        inside a `<root>` element.
 *
 *   The npm package pulls in legacy deps (`request`, `request-promise`,
 *   `bluebird`, `cheerio`, `xml2js`) — we replicate the upstream calls
 *   with native fetch + a regex/parser pass so the project stays on a
 *   modern stack.
 *
 *   Note on availability: as of Sep 2026 the upstream `/nextTram/getmessage.php`
 *   endpoint reports "The system is currently undergoing an upgrade",
 *   and `/nextTram/geteat.php` returns `<root/>` (empty list) until
 *   the upgrade completes. The API surface below serves an empty
 *   `etas` list during that outage and resumes live data automatically
 *   when the upstream is back, without any code change.
 */

const STOP_LIST_URL = "https://www.hktramways.com/js/googleMap.js";
const ETA_URL = (stopCode) =>
  `https://www.hktramways.com/nextTram/geteat.php?stop_code=${encodeURIComponent(stopCode)}`;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Broadly browser-shaped UA — the upstream rejects empty / curl UAs. */
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "*/*",
};

/**
 * Stop-list cache.
 *
 *   stops      — deduped array (preferred-westbound coordinates)
 *   byCode     — Map<stopCode, stop>
 *   fetchedAt  — ms epoch of last successful upstream fetch
 *   promise    — in-flight fetch (shared by concurrent callers)
 *
 * @type {{
 *   stops: ReturnType<typeof parseStops> | null,
 *   byCode: Map<string, ReturnType<typeof parseStops>[number]> | null,
 *   fetchedAt: number,
 *   promise: Promise<unknown> | null,
 * }}
 */
const stopsCache = {
  stops: null,
  byCode: null,
  fetchedAt: 0,
  promise: null,
};

/**
 * Upstream-stops entry, before we shape it for the API:
 *   stop_code, en_name, tc_name, sc_name, latitude, longitude.
 *
 * The same stop appears once in `stopsArrayEB` and once in
 * `stopsArrayWB` when it serves both directions; for shared stops
 * the coordinates are typically identical (within ~10 m of each
 * other, both anchoring on the road centerline).
 */
/**
 * Map the last character of an upstream `stop_code` to the direction it
 * serves. The official Hong Kong Tramways catalogue uses these suffixes:
 *
 *   W       west-bound only     (e.g. "92W", "HVT_K" — see K below)
 *   E       east-bound only     (e.g. "27E")
 *   T       terminus            (e.g. "KTT", "SKT", "WST")
 *   K       west-bound stop for the Happy Valley loop (HVT_K)
 *   digit   shared stop serving both directions (e.g. "105", "106")
 *
 * Anything else falls back to "east & west".
 */
const WEST_SUFFIXES = new Set(["W", "K"]);
const EAST_SUFFIXES = new Set(["E", "B"]); // "B" is the east-bound HVT variant
const TERMINUS_SUFFIXES = new Set(["T"]);

function classifyDirection(stopCode) {
  const last = stopCode.slice(-1);
  if (TERMINUS_SUFFIXES.has(last)) return "terminus";
  if (WEST_SUFFIXES.has(last)) return "west";
  if (EAST_SUFFIXES.has(last)) return "east";
  if (!Number.isNaN(parseInt(last, 10))) return "east & west";
  return "east & west";
}

/**
 * Decoded sequence of `var stopsArrayEB = [ ... ];` / WB. We slice from
 * the opening `[` to its matching `]` so nested entries don't confuse the
 * boundary finder.
 */
function sliceArrayBody(jsCode, varName) {
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*\\[`);
  const match = re.exec(jsCode);
  if (!match) return "";
  const arrayStart = match.index + match[0].length;
  let depth = 1;
  let inString = false;
  let strCh = "";
  let escaped = false;
  for (let i = arrayStart; i < jsCode.length; i++) {
    const ch = jsCode[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === strCh) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      strCh = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return jsCode.slice(arrayStart, i);
    }
  }
  return "";
}

/**
 * Match a single `[stopCode, en, tc, sc, lat, lng]` entry. Strings are
 * double-quoted and may contain backslash escapes (the upstream uses
 * e.g. `\"Queen\\'s Road East\"`).
 */
const STOP_ENTRY_RE =
  /\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;

function unescape(s) {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Walk the East-bound and West-bound arrays in the upstream JS file and
 * dedupe by stop code. For shared stops, the West-bound coordinate wins
 * (it is conventionally listed first in the file and tends to anchor on
 * the road centerline).
 */
function parseStops(jsCode) {
  const body = (varName) => sliceArrayBody(jsCode, varName);
  const collect = (varName) => {
    const text = body(varName);
    const out = [];
    if (!text) return out;
    const re = new RegExp(STOP_ENTRY_RE.source, "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({
        stop_code: unescape(m[1]),
        en_name: unescape(m[2]),
        tc_name: unescape(m[3]),
        sc_name: unescape(m[4]),
        latitude: Number.parseFloat(m[5]),
        longitude: Number.parseFloat(m[6]),
      });
    }
    return out;
  };

  const eastEntries = collect("stopsArrayEB");
  const westEntries = collect("stopsArrayWB");

  // First pass — collect every (stopCode, lat, lng) tuple.
  // Note the same stop_code can appear in BOTH arrays for shared stops
  // (e.g. "105"), with lat/lng differing by a few metres. We prefer the
  // West-bound coordinate and remember that the stop exists in both
  // directions.
  const seenIn = new Map(); // stopCode -> Set<"EB" | "WB">
  const candidates = new Map(); // stopCode -> {stop_code, en_name, tc_name, sc_name, latitude, longitude}

  const record = (entry, source) => {
    if (!seenIn.has(entry.stop_code)) seenIn.set(entry.stop_code, new Set());
    seenIn.get(entry.stop_code).add(source);
    const existing = candidates.get(entry.stop_code);
    if (!existing || source === "WB") {
      candidates.set(entry.stop_code, entry);
    }
  };

  for (const e of eastEntries) record(e, "EB");
  for (const e of westEntries) record(e, "WB");

  const stops = Array.from(candidates.values()).map((entry) => ({
    ...entry,
    direction: classifyDirection(entry.stop_code),
  }));

  // Stable sort: pure-numeric codes first (105, 106, 110 ...), then
  // alpha-with-suffix codes (27E, 92W, KTT, SKT, ...).
  stops.sort((a, b) => {
    const aDigit = /^\d/.test(a.stop_code);
    const bDigit = /^\d/.test(b.stop_code);
    if (aDigit && !bDigit) return -1;
    if (!aDigit && bDigit) return 1;
    return a.stop_code.localeCompare(b.stop_code);
  });

  return stops;
}

/**
 * Fetch and cache the deduped tram-stop catalogue.
 */
export async function getTramStops() {
  const now = Date.now();
  if (stopsCache.stops && now - stopsCache.fetchedAt < CACHE_TTL_MS) {
    return stopsCache.stops;
  }
  if (stopsCache.promise) return stopsCache.promise;

  stopsCache.promise = (async () => {
    const res = await fetch(STOP_LIST_URL, {
      headers: REQUEST_HEADERS,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(
        `HK Tramways stop list (googleMap.js) returned HTTP ${res.status}`
      );
    }
    const jsCode = await res.text();
    const stops = parseStops(jsCode);
    if (stops.length === 0) {
      throw new Error(
        "HK Tramways stop list returned no entries — upstream JS shape may have changed"
      );
    }
    const byCode = new Map(stops.map((s) => [s.stop_code, s]));
    stopsCache.stops = stops;
    stopsCache.byCode = byCode;
    stopsCache.fetchedAt = Date.now();
    return stops;
  })();

  try {
    return await stopsCache.promise;
  } finally {
    stopsCache.promise = null;
  }
}

/**
 * Look up a single tram stop by its upstream `stop_code` (e.g. `"92W"`,
 * `"KTT"`). Returns `null` when the upstream catalogue does not list it.
 */
export async function getTramStop(stopCode) {
  if (!stopCode) return null;
  if (stopsCache.byCode) {
    return stopsCache.byCode.get(stopCode) ?? null;
  }
  const stops = await getTramStops();
  return stops.find((s) => s.stop_code === stopCode) ?? null;
}

/**
 * Localised stop name. hktramways stores names as `{en_name, tc_name,
 * sc_name}` (en + traditional Chinese + simplified Chinese). We map the
 * app's locale strings ("zh-Hant" / "zh-Hans") onto the upstream pairs.
 */
export function localisedTramStopName(stop, locale) {
  if (!stop) return "";
  const v = String(locale ?? "").toLowerCase();
  if (v.startsWith("zh-hant") || v === "zh-tw") {
    return stop.tc_name || stop.en_name || "";
  }
  if (v.startsWith("zh-hans") || v === "zh-cn") {
    return stop.sc_name || stop.tc_name || stop.en_name || "";
  }
  return stop.en_name || stop.tc_name || "";
}

/**
 * Lean payload the API exposes to clients.
 */
export function serialiseTramStop(stop, locale) {
  return {
    id: stop.stop_code,
    stopCode: stop.stop_code,
    name: localisedTramStopName(stop, locale),
    nameEn: stop.en_name ?? "",
    nameTc: stop.tc_name ?? "",
    nameSc: stop.sc_name ?? "",
    direction: stop.direction ?? "east & west",
    lat: Number.isFinite(stop.latitude) ? stop.latitude : null,
    lng: Number.isFinite(stop.longitude) ? stop.longitude : null,
  };
}

/* ------------------------------------------------------------------ *
 * ETA: parse <metadata .../> attributes out of the upstream XML.
 * ------------------------------------------------------------------ */

const ATTR_RE = /(\w+)="((?:[^"\\]|\\.)*)"/g;

function parseAttrs(blob) {
  const out = {};
  if (!blob) return out;
  const re = new RegExp(ATTR_RE.source, "g");
  let m;
  while ((m = re.exec(blob)) !== null) {
    out[m[1]] = unescape(m[2]);
  }
  return out;
}

/**
 * Pull every `<metadata .../>` element out of an upstream XML payload,
 * returning an array of attribute objects. Tolerates self-closing
 * `<metadata ... />` and the sibling `<metadata ...>` variants.
 */
function parseEtaXml(xml) {
  if (!xml) return [];
  const results = [];
  const re = /<metadata\b([^>]*?)\/?\s*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(parseAttrs(m[1]));
  }
  return results;
}

/**
 * Best-effort ISO conversion of the upstream ETA string. The upstream
 * ships something like `"Jun 23 2016 10:21AM"` (a JS Date.toString format
 * in en-US locale). `Date.parse` accepts that on modern Node.
 */
function etaToIso(rawEta) {
  if (!rawEta) return null;
  const t = Date.parse(rawEta);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Fetch live arrivals for one stop. The upstream endpoint is shared with
 * the `hongkong-trams` package; behaviour is identical (same User-Agent
 * requirement, same XML shape).
 *
 * Returns `[]` (not an error) when the upstream returns `<root/>` —
 * that is the normal response during service outages / planned
 * maintenance (the operator's message endpoint currently surfaces
 * "system is undergoing an upgrade").
 */
export async function getTramEtas(stopCode) {
  const trimmed = String(stopCode ?? "").trim();
  if (!trimmed) {
    throw new Error("getTramEtas: stopCode is required");
  }
  const res = await fetch(ETA_URL(trimmed), {
    headers: REQUEST_HEADERS,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `HK Tramways ETA endpoint returned HTTP ${res.status} for stop "${trimmed}"`
    );
  }
  const xml = await res.text();
  const raw = parseEtaXml(xml);
  return raw.map((r) => ({
    ...r,
    // Upstream spells it `eat` (a typo dating to the original 2016
    // release); expose it as `eta` for downstream readability.
    eta: r.eat ?? r.eta ?? null,
    is_arrived: r.is_arrived === "1" || r.is_arrived === "true",
    is_last_tram: r.is_last_tram === "1" || r.is_last_tram === "true",
    _fetchedAt: new Date().toISOString(),
  }));
}

/**
 * Localised terminus display for a single arrival (e.g. "Kennedy Town
 * Terminus" vs "堅尼地城總站"). The upstream does not ship a
 * simplified-Chinese terminus string, so we fall back from sc → tc → en.
 */
export function localisedTramDestination(arrival, locale) {
  if (!arrival) return "";
  const v = String(locale ?? "").toLowerCase();
  if (v.startsWith("zh-hant") || v === "zh-tw") {
    return arrival.tram_dest_tc || arrival.tram_dest_en || "";
  }
  if (v.startsWith("zh-hans") || v === "zh-cn") {
    return (
      arrival.tram_dest_sc ||
      arrival.tram_dest_tc ||
      arrival.tram_dest_en ||
      ""
    );
  }
  return arrival.tram_dest_en || arrival.tram_dest_tc || "";
}

/**
 * Convert a raw upstream arrival into the lean payload the API exposes
 * to clients. We compute `minutesUntilArrival` from both `arrive_in_minute`
 * (the upstream's headline number) and the parsed ISO `etaIso`, taking
 * whichever is finite.
 */
export function serialiseTramEta(raw, locale) {
  const arriveMin =
    raw.arrive_in_minute != null && raw.arrive_in_minute !== ""
      ? Number.parseInt(raw.arrive_in_minute, 10)
      : null;
  const etaIso = etaToIso(raw.eta);
  const minutesFromIso =
    etaIso != null ? Math.round((Date.parse(etaIso) - Date.now()) / 60000) : null;
  const minutesUntilArrival = Number.isFinite(minutesFromIso)
    ? minutesFromIso
    : Number.isFinite(arriveMin)
    ? arriveMin
    : null;

  return {
    seq: raw.seq ?? null,
    tramId: raw.tram_id ?? null,
    stopCode: raw.stop_code ?? null,
    dest: {
      stopCode: raw.dest_stop_code ?? null,
      en: raw.tram_dest_en ?? "",
      tc: raw.tram_dest_tc ?? "",
      sc: raw.tram_dest_sc ?? "",
      display: localisedTramDestination(raw, locale),
    },
    etaIso,
    etaRaw: raw.eta ?? null,
    minutesUntilArrival: Number.isFinite(minutesUntilArrival)
      ? minutesUntilArrival
      : null,
    isArrived: !!raw.is_arrived,
    isLastTram: !!raw.is_last_tram,
    isRealtime: etaIso != null,
  };
}

/**
 * Force the next call to re-fetch the upstream stop catalogue (mainly for
 * tests / hot reload).
 */
export function _resetTramStopsCache() {
  stopsCache.stops = null;
  stopsCache.byCode = null;
  stopsCache.fetchedAt = 0;
  stopsCache.promise = null;
}
