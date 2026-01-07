/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

export type SupportedLanguage = 'en' | 'zh' | 'ru' | 'de' | string;

export interface LanguageDefinition {
  /** The internal locale code used by the i18n system (e.g., 'en', 'zh'). */
  code: SupportedLanguage;
  /** The standard name used in UI settings (e.g., 'en-US', 'zh-CN'). */
  id: string;
  /** The full English name of the language (e.g., 'English', 'Chinese'). */
  fullName: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
  {
    code: 'en',
    id: 'en-US',
    fullName: 'English',
  },
  {
    code: 'zh',
    id: 'zh-CN',
    fullName: 'Chinese',
  },
  {
    code: 'ru',
    id: 'ru-RU',
    fullName: 'Russian',
  },
  {
    code: 'de',
    id: 'de-DE',
    fullName: 'German',
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
