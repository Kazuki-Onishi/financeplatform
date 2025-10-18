export const AVAILABLE_LOCALES = ["en", "ja"] as const;
export type Locale = (typeof AVAILABLE_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ja";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (AVAILABLE_LOCALES as readonly string[]).includes(value);
}
