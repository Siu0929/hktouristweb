"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createTranslator, getMessages } from "@/i18n";
import { DEFAULT_LOCALE, LOCALES, normalizeLocale } from "@/i18n/locales";

const STORAGE_KEY = "hktourist-locale";

const LocaleContext = createContext(null);

function readStoredLocale() {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  return normalizeLocale(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_LOCALE);
}

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLocaleState(readStoredLocale());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const messages = getMessages(locale);
    document.documentElement.lang = locale;
    document.title = messages.meta.title;
    localStorage.setItem(STORAGE_KEY, locale);
  }, [locale, ready]);

  const setLocale = useCallback((nextLocale) => {
    setLocaleState(normalizeLocale(nextLocale));
  }, []);

  const value = useMemo(() => {
    const messages = getMessages(locale);
    const t = createTranslator(locale);
    return { locale, locales: LOCALES, messages, setLocale, t };
  }, [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}

export function useTranslations(namespace) {
  const { t } = useLocale();
  return useCallback(
    (key, params) => t(namespace ? `${namespace}.${key}` : key, params),
    [namespace, t]
  );
}
