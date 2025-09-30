"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import en from "@/locales/en.json";
import ja from "@/locales/ja.json";
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, type Locale, isLocale } from "./index";

type TranslationsRecord = typeof en;
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};
const TRANSLATIONS: Record<Locale, DeepPartial<TranslationsRecord>> = {
  en,
  ja,
};

type LocaleContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function resolveObjectPath(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in current) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - dynamic lookup
      return current[segment];
    }
    return undefined;
  }, source);
}

function interpolate(template: string, variables?: Record<string, string | number>): string {
  if (!variables) {
    return template;
  }
  return Object.entries(variables).reduce((result, [key, value]) => {
    const pattern = new RegExp(`{${key}}`, "g");
    return result.replace(pattern, String(value));
  }, template);
}

export interface I18nProviderProps {
  children: ReactNode;
  initialLocale?: string | null;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const startingLocale = isLocale(initialLocale) ? initialLocale : DEFAULT_LOCALE;
  const [locale, setLocale] = useState<Locale>(startingLocale);

  const setLocaleSafe = useCallback((next: Locale) => {
    if (isLocale(next)) {
      setLocale(next);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem("locale", next);
        } catch {
          // ignore persistence failures
        }
      }
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale: setLocaleSafe,
    }),
    [locale, setLocaleSafe],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within an I18nProvider");
  }
  return context;
}

export type TranslateFn = (key: string, variables?: Record<string, string | number>) => string;

export function useTranslations(namespace?: string): TranslateFn {
  const { locale } = useLocale();

  return useCallback<TranslateFn>(
    (key, variables) => {
      const dictionary = TRANSLATIONS[locale] ?? TRANSLATIONS[DEFAULT_LOCALE];
      const lookupPath = namespace ? `${namespace}.${key}`.split(".") : key.split(".");
      const resolved = resolveObjectPath(dictionary, lookupPath);

      if (typeof resolved === "string") {
        return interpolate(resolved, variables);
      }

      return interpolate(key, variables);
    },
    [locale, namespace],
  );
}

export { AVAILABLE_LOCALES };
