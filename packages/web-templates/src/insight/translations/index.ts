/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

// Insight Report Translations Index
// Re-exports all translation files and provides a helper to get translations by language

import en from './en.js';
import zh from './zh.js';
import ja from './ja.js';
import pt from './pt.js';
import ru from './ru.js';
import de from './de.js';

export { en, zh, ja, pt, ru, de };

export type SupportedLanguage = 'en' | 'zh' | 'ja' | 'pt' | 'ru' | 'de';

/**
 * Get translations for a specific language
 * @param lang - Language code
 * @returns Translation dictionary
 */
export function getTranslations(
  lang: SupportedLanguage,
): Record<string, string> {
  const translations: Record<SupportedLanguage, Record<string, string>> = {
    en,
    zh,
    ja,
    pt,
    ru,
    de,
  };
  return translations[lang] || en;
}

/**
 * Get language display name
 */
export function getLanguageDisplayName(lang: SupportedLanguage): string {
  const names: Record<SupportedLanguage, string> = {
    en: 'English',
    zh: '中文',
    ja: '日本語',
    pt: 'Português',
    ru: 'Русский',
    de: 'Deutsch',
  };
  return names[lang] || 'English';
}
