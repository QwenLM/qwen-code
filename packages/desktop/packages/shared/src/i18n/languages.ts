import { LOCALE_REGISTRY, type LanguageCode } from "./registry";

export type { LanguageCode } from "./registry";

export interface LanguageConfig {
  nativeName: string;
}

/** All supported language codes, derived from the locale registry. */
export const SUPPORTED_LANGUAGE_CODES: readonly LanguageCode[] = Object.keys(
  LOCALE_REGISTRY,
) as LanguageCode[];

/** Language display metadata, derived from the locale registry. */
export const LANGUAGES: Record<LanguageCode, LanguageConfig> =
  Object.fromEntries(
    Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [
      code,
      { nativeName: entry.nativeName },
    ]),
  ) as Record<LanguageCode, LanguageConfig>;
