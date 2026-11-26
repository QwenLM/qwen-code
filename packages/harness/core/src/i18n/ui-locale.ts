/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeLocale, type UiLocale } from '../utils/locale.js';
import { runLogger } from '../utils/runLogger.js';
import type { UiLanguagePreference } from './i18n-service.js';
export function isUiLanguagePreference(
  value: unknown,
): value is UiLanguagePreference {
  return value === 'auto' || value === 'zh-CN' || value === 'en';
}

export function normalizeUiLanguagePreference(
  value: unknown,
): UiLanguagePreference {
  return isUiLanguagePreference(value) ? value : 'en';
}

export function resolveUiLocale(
  preference: unknown,
  env: NodeJS.ProcessEnv = process.env,
  systemLocale?: string,
): UiLocale {
  if (preference === 'zh-CN' || preference === 'en') {
    return preference;
  }

  if (preference === undefined) {
    return 'en';
  }

  if (preference !== 'auto') {
    runLogger.warn('Invalid ui.language setting; falling back to English.');
    return 'en';
  }

  if (systemLocale?.trim()) {
    return normalizeLocale(systemLocale);
  }

  const raw = [
    env['LC_ALL'],
    env['LC_MESSAGES'],
    env['LANG'],
    env['LANGUAGE'],
  ].find((value) => value?.trim());
  if (raw) {
    return normalizeLocale(raw);
  }

  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    return intlLocale ? normalizeLocale(intlLocale) : 'en';
  } catch {
    return 'en';
  }
}
