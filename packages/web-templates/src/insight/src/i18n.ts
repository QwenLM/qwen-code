/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-browser translation utility for the insight report.
 * Reads translations from window.INSIGHT_TRANSLATIONS (injected by TemplateRenderer).
 * Mirrors the CLI's t() function with {{param}} interpolation support.
 */

const translations: Record<string, string> =
  typeof window !== 'undefined' && window.INSIGHT_TRANSLATIONS
    ? window.INSIGHT_TRANSLATIONS
    : {};

/**
 * Translate a key with optional parameter interpolation.
 * @param key - The translation key (insight_* keys from CLI locale files)
 * @param params - Optional object with {{key}} -> value replacements
 * @returns Translated string, or the key itself if not found
 */
export function ti(key: string, params?: Record<string, string>): string {
  let text = translations[key] ?? key;

  if (params) {
    Object.entries(params).forEach(([paramKey, value]) => {
      text = text.replace(new RegExp(`{{${paramKey}}}`, 'g'), String(value));
    });
  }

  return text;
}

/**
 * Convenience alias matching the convention used by React components.
 */
export const t = ti;

/**
 * Get the current UI language code.
 */
export function getInsightLanguage(): string {
  return (typeof window !== 'undefined' && window.INSIGHT_LANGUAGE) || 'en';
}
