import { enUS } from "date-fns/locale/en-US";
import { LOCALE_REGISTRY, type LanguageCode } from "./registry";

/** Get the date-fns Locale matching the current i18n language code. */
export function getDateLocale(lang: string): import("date-fns").Locale {
  const entry = LOCALE_REGISTRY[lang as LanguageCode];
  return entry?.dateLocale ?? enUS;
}
