/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

// Lightweight i18n system for the Insight report
// Translations are embedded in the HTML at generation time

export type SupportedLanguage = 'en' | 'zh' | 'ja' | 'pt' | 'ru' | 'de';

export interface TranslationDict {
  [key: string]: string;
}

// Built-in translations (embedded at generation time)
let currentLanguage: SupportedLanguage = 'en';
let translations: TranslationDict = {};

/**
 * Initialize translations from window.INSIGHT_TRANSLATIONS
 * Called when the app loads
 */
export function initializeTranslations(
  lang: string,
  trans: Record<string, string>,
): void {
  currentLanguage = lang as SupportedLanguage;
  translations = trans;
}

/**
 * Get current language
 */
export function getCurrentLanguage(): SupportedLanguage {
  return currentLanguage;
}

/**
 * Translate a key with optional interpolation
 * @param key - Translation key (also serves as default English text)
 * @param params - Optional parameters for interpolation {{param}}
 */
export function t(key: string, params?: Record<string, string>): string {
  const translation = translations[key] ?? key;
  return interpolate(translation, params);
}

/**
 * Simple string interpolation
 * Replaces {{key}} with params[key]
 */
function interpolate(
  template: string,
  params?: Record<string, string>,
): string {
  if (!params) return template;
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (match, key) => params[key] ?? match,
  );
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
