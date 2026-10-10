"use client";

import { LOCALE_LABELS } from "@/i18n/locales";
import { useLocale } from "@/contexts/LocaleContext";

export default function LanguageSwitcher() {
  const { locale, locales, setLocale } = useLocale();

  return (
    <label className="relative shrink-0 text-xs text-zinc-600">
      <span className="sr-only">Language</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        className="appearance-none pl-2 pr-6 py-2 sm:pl-2.5 sm:pr-7 sm:py-1.5 rounded-lg sm:rounded bg-white text-zinc-700 text-xs cursor-pointer hover:border-zinc-400 focus:outline-none focus:border-blue-500 transition max-w-22 sm:max-w-none"
        aria-label="Language"
      >
        {locales.map((code) => (
          <option key={code} value={code}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
      <span
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400"
        aria-hidden="true"
      >
        ▾
      </span>
    </label>
  );
}
