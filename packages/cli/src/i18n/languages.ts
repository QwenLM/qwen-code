/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

export type SupportedLanguage =
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ru'
  | 'de'
  | 'ja'
  | 'pt'
  | 'fr'
  | 'ca'
  | string;

export interface LanguageDefinition {
  /** The internal locale code used by the i18n system (e.g., 'en', 'zh'). */
  code: SupportedLanguage;
  /** The standard name used in UI settings (e.g., 'en-US', 'zh-CN'). */
  id: string;
  /** The full English name of the language (e.g., 'English', 'Chinese'). */
  fullName: string;
  /** The native name of the language (e.g., 'English', '中文'). */
  nativeName?: string;
  /**
   * Whether tooling should require this locale to keep exact key parity with
   * en.js. Locales maintained in-tree can opt in as they reach full coverage.
   */
  strictParity?: boolean;
}

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
  {
    code: 'en',
    id: 'en-US',
    fullName: 'English',
    nativeName: 'English',
  },
  {
    code: 'zh-TW',
    id: 'zh-TW',
    fullName: 'Traditional Chinese',
    nativeName: '繁體中文',
    strictParity: true,
  },
  {
    code: 'zh',
    id: 'zh-CN',
    fullName: 'Chinese',
    nativeName: '中文',
    strictParity: true,
  },
  {
    code: 'ru',
    id: 'ru-RU',
    fullName: 'Russian',
    nativeName: 'Русский',
  },
  {
    code: 'de',
    id: 'de-DE',
    fullName: 'German',
    nativeName: 'Deutsch',
  },
  {
    code: 'ja',
    id: 'ja-JP',
    fullName: 'Japanese',
    nativeName: '日本語',
  },
  {
    code: 'pt',
    id: 'pt-BR',
    fullName: 'Portuguese',
    nativeName: 'Português',
  },
  {
    code: 'fr',
    id: 'fr-FR',
    fullName: 'French',
    nativeName: 'Français',
  },
  {
    code: 'ca',
    id: 'ca-ES',
    fullName: 'Catalan',
    nativeName: 'Català',
  },
];

function normalizeLanguageCandidate(input: string): string {
  return input.trim().replace(/_/g, '-').toLowerCase();
}

function matchesLocaleToken(candidate: string, token: string): boolean {
  return (
    candidate === token ||
    candidate.startsWith(`${token}-`) ||
    candidate.startsWith(`${token}.`) ||
    candidate.startsWith(`${token}@`)
  );
}

function getMatchedLocaleTokenLength(
  candidate: string,
  language: LanguageDefinition,
): number | undefined {
  const code = language.code.toLowerCase();
  const id = language.id.toLowerCase();

  if (matchesLocaleToken(candidate, id)) {
    return id.length;
  }

  if (matchesLocaleToken(candidate, code)) {
    return code.length;
  }

  return undefined;
}

/**
 * Resolves a language alias or locale ID to a supported canonical locale code.
 * Returns undefined for unsupported values so callers can preserve custom codes.
 */
export function resolveSupportedLanguage(
  input: string,
): SupportedLanguage | undefined {
  const normalized = normalizeLanguageCandidate(input);
  if (!normalized) {
    return undefined;
  }

  let bestMatch: { code: SupportedLanguage; tokenLength: number } | undefined;

  for (const language of SUPPORTED_LANGUAGES) {
    if (
      normalized === language.fullName.toLowerCase() ||
      (language.nativeName && normalized === language.nativeName.toLowerCase())
    ) {
      return language.code;
    }

    const tokenLength = getMatchedLocaleTokenLength(normalized, language);
    if (
      tokenLength !== undefined &&
      (!bestMatch || tokenLength > bestMatch.tokenLength)
    ) {
      bestMatch = { code: language.code, tokenLength };
    }
  }

  return bestMatch?.code;
}

/**
 * Maps a locale code to its English language name.
 * Used for LLM output language instructions.
 */
export function getLanguageNameFromLocale(locale: SupportedLanguage): string {
  const resolved = resolveSupportedLanguage(locale);
  const lang = resolved
    ? SUPPORTED_LANGUAGES.find((language) => language.code === resolved)
    : undefined;
  return lang?.fullName || 'English';
}

/**
 * Maps a UI locale to an English language name for dynamic translation prompts.
 * Unknown custom locale codes fall back to Intl.DisplayNames, then the raw code,
 * so custom language packs do not accidentally request English translations.
 */
export function getLanguageNameForTranslationTarget(
  locale: SupportedLanguage,
): string {
  const resolved = resolveSupportedLanguage(locale);
  const lang = resolved
    ? SUPPORTED_LANGUAGES.find((language) => language.code === resolved)
    : undefined;
  if (lang) {
    return lang.fullName;
  }

  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    const displayName = displayNames.of(locale);
    if (displayName) {
      return displayName;
    }
  } catch {
    // Fall through to raw locale.
  }

  return locale;
}

/**
 * Gets the language options for the settings schema.
 */
export function getLanguageSettingsOptions(): Array<{
  value: string;
  label: string;
}> {
  return [
    { value: 'auto', label: 'Auto (detect from system)' },
    ...SUPPORTED_LANGUAGES.map((l) => ({
      value: l.code,
      label: l.nativeName
        ? `${l.nativeName} (${l.fullName})`
        : `${l.fullName} (${l.id})`,
    })),
  ];
}

/**
 * Gets a string containing all supported language IDs (e.g., "en-US|zh-CN").
 */
export function getSupportedLanguageIds(separator = '|'): string {
  return SUPPORTED_LANGUAGES.map((l) => l.id).join(separator);
}
