/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { themeManager, AUTO_THEME_NAME } from '../ui/themes/theme-manager.js';
import { type LoadedSettings } from '../config/settings.js';
import { t } from '../i18n/index.js';

/**
 * Validates the configured theme.
 * @param settings The loaded application settings.
 * @returns An error message if the theme is not found, otherwise null.
 */
export function validateTheme(settings: LoadedSettings): string | null {
  const effectiveTheme = settings.merged.ui?.theme;
  if (
    effectiveTheme &&
    effectiveTheme !== AUTO_THEME_NAME &&
    !themeManager.findThemeByName(effectiveTheme)
  ) {
    return t('Theme "{{themeName}}" not found.', {
      themeName: effectiveTheme,
    });
  }
  return null;
}
