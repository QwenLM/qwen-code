/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

export type SupportedLanguage =
  | 'en'
  | 'zh'
  | 'ru'
  | 'de'
  | 'ja'
  | 'pt'
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
}

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
  {
    code: 'en',
    id: 'en-US',
    fullName: 'English',
    nativeName: 'English',
  },
  {
    code: 'zh',
    id: 'zh-CN',
    fullName: 'Chinese',
    nativeName: '中文',
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
];

/**
 * Maps a locale code to its English language name.
 * Used for LLM output language instructions.
 */
export function getLanguageNameFromLocale(locale: SupportedLanguage): string {
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === locale);
  return lang?.fullName || 'English';
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
