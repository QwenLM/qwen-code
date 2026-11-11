/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/** Locales the CLI resolves UI-facing copy for. */
export type UiLocale = 'zh-CN' | 'en';

/**
 * Resolve a normalized UI locale from a raw locale string (or the environment).
 *
 * Precedence mirrors the standard locale field: LC_ALL > LC_MESSAGES > LANG >
 * LANGUAGE. The charset/modifier suffix (`.UTF-8`, `@euro`) and region are
 * stripped down to the language subtag. Chinese maps to `zh-CN`, everything
 * else falls back to `en`. Missing or blank values also default to `en`.
 */
export function normalizeLocale(raw?: string): UiLocale {
  const value =
    raw ??
    process.env['LC_ALL'] ??
    process.env['LC_MESSAGES'] ??
    process.env['LANG'] ??
    process.env['LANGUAGE'];

  if (!value || value.trim() === '') {
    return 'en';
  }

  // Drop charset (".UTF-8") and modifier ("@euro"), normalize separators.
  const lang = value
    .split(/[.@]/)[0]
    .replace('_', '-')
    .trim()
    .toLowerCase();

  if (lang.startsWith('zh')) return 'zh-CN';
  return 'en';
}
