import { IntlMessageFormat } from "intl-messageformat";
import en from "./messages/en.json";
import zhHant from "./messages/zh-Hant.json";
import zhHans from "./messages/zh-Hans.json";
import { DEFAULT_LOCALE, normalizeLocale } from "./locales";

const MESSAGES = {
  en,
  "zh-Hant": zhHant,
  "zh-Hans": zhHans,
};

export function getMessages(locale) {
  return MESSAGES[normalizeLocale(locale)] ?? MESSAGES[DEFAULT_LOCALE];
}

function getNestedValue(obj, path) {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

// Match ICU placeholders such as `{name}`, `{count, plural, ...}`.
// We need the curly-brace-aware regex because a `plural` arm contains
// nested `{...}` blocks (e.g. `{count, plural, one {# line} other {# lines}}`).
const ICU_PLACEHOLDER = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
const TOKEN_PLACEHOLDER = /\{(\w+)\}/g;

function formatIcu(template, locale, params) {
  // `IntlMessageFormat` parses ICU MessageFormat. It throws on malformed
  // input, so we fall back to the raw template if it fails.
  try {
    const fmt = new IntlMessageFormat(template, locale);
    return fmt.format(params ?? {});
  } catch {
    return template;
  }
}

export function translate(messages, key, params = {}) {
  let value = getNestedValue(messages, key);
  if (value == null) return key;
  if (typeof value !== "string") return value;

  // ICU syntax (`{count, plural, ...}`, `{gender, select, ...}`) starts with
  // `{token,` — delegate to IntlMessageFormat. Simple `{token}` substitutions
  // are handled below with a tiny regex.
  const hasIcuSyntax = ICU_PLACEHOLDER.test(value) && /\{(\w+)\s*,/.test(value);
  ICU_PLACEHOLDER.lastIndex = 0;

  if (hasIcuSyntax) {
    return formatIcu(value, messages.__locale ?? "en", params);
  }

  return value.replace(TOKEN_PLACEHOLDER, (_, token) => {
    const replacement = params[token];
    return replacement != null ? String(replacement) : `{${token}}`;
  });
}

export function createTranslator(locale) {
  const messages = getMessages(locale);
  // Attach the resolved locale so `translate` can pass it to IntlMessageFormat
  // for locale-aware plural rules (e.g. English uses `one`/`other`, Chinese
  // uses `other`).
  const enriched = { ...messages, __locale: normalizeLocale(locale) || DEFAULT_LOCALE };
  return (key, params) => translate(enriched, key, params);
}
