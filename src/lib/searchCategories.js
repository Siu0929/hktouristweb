/**
 * Multilingual category keyword registry for smart search.
 * Detects whether a user query is a generic category search (e.g., "toilet", "廁所")
 * or a specific named-location search.
 */

/**
 * Maps each POI type to its equivalent search keywords across locales.
 * Keywords are matched as exact full-word matches to avoid false positives.
 */
export const CATEGORY_KEYWORDS = {
  toilet: {
    en: ["toilet", "toilets", "washroom", "washrooms", "restroom", "restrooms", "bathroom", "bathrooms", "wc", "loo", "lavatory", "public toilet"],
    "zh-Hant": ["廁所", "公廁", "廁", "洗手間", "洗手間", "化妝間", "洗手間"],
    "zh-Hans": ["厕所", "公厕", "厕", "洗手间", "化妆间"],
  },
  attraction: {
    en: ["attraction", "attractions", "sightseeing", "tourist spot", "tourist spots", "tourist attraction", "tourist attractions", "places to visit", "landmarks", "landmark"],
    "zh-Hant": ["景點", "景點", "旅遊", "觀光", "名勝", "旅遊景點", "打卡"],
    "zh-Hans": ["景点", "景点", "旅游", "观光", "名胜", "旅游景点", "打卡"],
  },
  busStop: {
    en: ["bus", "buses", "bus stop", "bus stops", "bus station", "bus stations", "bus terminal", "bus terminals", "public bus", "public buses"],
    "zh-Hant": ["巴士", "巴士站", "巴士總站", "公車", "公車站", "車站", "巴士路線", "巴士線"],
    "zh-Hans": ["巴士", "巴士站", "巴士总站", "公车", "公交车", "公交站", "车站", "巴士路线"],
  },
};

/**
 * Maps locale codes to their relevant translation arrays.
 * Used to broaden detection across related locales.
 */
const LOCALE_VARIANTS = {
  en: ["en"],
  "zh-Hant": ["zh-Hant"],
  "zh-Hans": ["zh-Hans"],
};

/**
 * Returns the ordered list of locale codes to check for a given locale.
 * Falls back to English if locale not found.
 */
function getLocaleVariants(locale) {
  return LOCALE_VARIANTS[locale] ?? ["en"];
}

/**
 * Normalizes a string for comparison:
 * - Lowercase
 * - Trims whitespace
 * - Removes full-width spaces (U+3000) common in CJK text
 */
function normalize(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/　/g, " ")
    .trim();
}

/**
 * Checks whether the normalized query matches a keyword.
 * Supports exact match and word-boundary prefix/suffix (e.g., "nearby toilet" matches "toilet").
 */
function matchesKeyword(query, keyword) {
  const q = normalize(query);
  const k = normalize(keyword);
  return q === k || q.startsWith(k + " ") || q.endsWith(" " + k) || q.includes(" " + k + " ");
}

/**
 * Detects whether the given query is a category-level search.
 *
 * @param {string} query - The raw search query
 * @param {string} locale - Current locale (en | zh-Hant | zh-Hans)
 * @returns {{ isCategory: true, category: string } | { isCategory: false }}
 */
export function detectCategoryQuery(query, locale = "en") {
  const q = normalize(query);
  if (!q) return { isCategory: false };

  const locales = getLocaleVariants(locale);

  for (const [category, translations] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const loc of locales) {
      const keywords = translations[loc] ?? translations.en ?? [];
      if (keywords.some((kw) => matchesKeyword(q, kw))) {
        return { isCategory: true, category };
      }
    }
  }

  return { isCategory: false };
}

/**
 * Returns the display label key for a category.
 * These map to i18n keys under search.nearby{Category}.
 */
export const CATEGORY_I18N_KEYS = {
  toilet: "search.nearbyToilets",
  attraction: "search.nearbyAttractions",
  busStop: "search.nearbyBusStops",
};

/**
 * Returns the default API types parameter for a given category.
 * Used when a category search should only query one POI type.
 */
export const CATEGORY_TYPES = {
  toilet: ["toilet"],
  attraction: ["attraction"],
  busStop: ["busStop"],
};
