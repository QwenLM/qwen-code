/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isAutoThemeSetting,
  themeManager,
} from '../ui/themes/theme-manager.js';
import { type LoadedSettings } from '../config/settings.js';

/**
 * Validates the configured theme.
 * @param settings The loaded application settings.
 * @returns An error message if the theme is not found, otherwise null.
 */
export function validateTheme(settings: LoadedSettings): string | null {
  const effectiveTheme = settings.merged.ui.theme;
  // 'auto' is a setting value rather than a registered theme; it always
  // resolves to a real one at render time.
  if (isAutoThemeSetting(effectiveTheme)) {
    return null;
  }
  if (effectiveTheme && !themeManager.findThemeByName(effectiveTheme)) {
    return `Theme "${effectiveTheme}" not found.`;
  }
  return null;
}
