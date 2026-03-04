/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { InsightData } from './types';

/**
 * Get the translation for a key from the insight data.
 * Falls back to the key itself if no translation is found.
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  const data = window.INSIGHT_DATA as InsightData | undefined;
  const translations = data?.translations || {};
  let translation = translations[key] || key;

  // Replace parameters
  if (params) {
    Object.entries(params).forEach(([paramKey, value]) => {
      translation = translation.replace(
        new RegExp(`\\{\\{${paramKey}\\}\\}`, 'g'),
        String(value),
      );
    });
  }

  return translation;
}

/**
 * Get the current language code from the insight data.
 * Defaults to 'en' if not specified.
 */
export function getCurrentLanguage(): string {
  const data = window.INSIGHT_DATA as InsightData | undefined;
  return data?.language || 'en';
}
