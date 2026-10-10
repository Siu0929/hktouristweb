export const LOCALES = ["zh-Hant", "zh-Hans", "en"];
export const DEFAULT_LOCALE = "zh-Hant";

export const LOCALE_LABELS = {
  "zh-Hant": "繁體中文",
  "zh-Hans": "简体中文",
  en: "English",
};

export function isValidLocale(locale) {
  return LOCALES.includes(locale);
}

export function normalizeLocale(locale) {
  return isValidLocale(locale) ? locale : DEFAULT_LOCALE;
}
