/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import { AUTO_THEME_NAME, themeManager } from './theme-manager.js';

/**
 * Persists `ui.theme` in `scope`, reloads the merged custom themes and
 * activates whatever theme is now in effect. Shared by the theme picker
 * (Ink and OpenTUI) and `/theme <name>`, so all of them apply a theme the
 * same way.
 *
 * Returns the theme name in effect and whether it could be activated.
 */
export function applyThemeSetting(
  settings: LoadedSettings,
  scope: SettingScope,
  themeName: string,
): { effective: string; applied: boolean } {
  settings.setValue(scope, 'ui.theme', themeName);
  if (settings.merged.ui?.customThemes) {
    themeManager.loadCustomThemes(settings.merged.ui.customThemes);
  }
  const effective = settings.merged.ui?.theme ?? AUTO_THEME_NAME;
  return { effective, applied: themeManager.setActiveTheme(effective) };
}

export type ThemeNameResolution =
  | { kind: 'found'; name: string; scope: SettingScope }
  | { kind: 'unknown'; available: string[] }
  | { kind: 'pinned-by-system' };

/**
 * Maps a typed theme name to one the theme manager can activate, and picks
 * the settings file the choice has to be written to for it to take effect.
 *
 * Candidates are `auto`, the built-in themes, and the `customThemes` keys
 * that loaded, from user settings and (only when trusted) the workspace.
 * An exact match wins over a case-insensitive one.
 */
export function resolveThemeName(
  settings: LoadedSettings,
  requested: string,
): ThemeNameResolution {
  if (settings.system.settings.ui?.theme !== undefined) {
    return { kind: 'pinned-by-system' };
  }

  const userCustom = settings.user.settings.ui?.customThemes ?? {};
  const workspaceCustom = settings.isTrusted
    ? (settings.workspace.settings.ui?.customThemes ?? {})
    : {};
  if (settings.merged.ui?.customThemes) {
    themeManager.loadCustomThemes(settings.merged.ui.customThemes);
  }
  const builtIns = themeManager
    .getAvailableThemes()
    .filter((theme) => !theme.isCustom)
    .map((theme) => theme.name);
  const customKeys = Object.keys({ ...userCustom, ...workspaceCustom }).filter(
    (key) => themeManager.isCustomTheme(key),
  );
  const available = [...new Set([AUTO_THEME_NAME, ...builtIns, ...customKeys])];

  const name =
    available.find((candidate) => candidate === requested) ??
    available.find(
      (candidate) => candidate.toLowerCase() === requested.toLowerCase(),
    );
  if (!name) {
    return { kind: 'unknown', available };
  }

  const workspaceOwnsTheme =
    settings.isTrusted &&
    (settings.workspace.settings.ui?.theme !== undefined ||
      Object.prototype.hasOwnProperty.call(workspaceCustom, name));
  return {
    kind: 'found',
    name,
    scope: workspaceOwnsTheme ? SettingScope.Workspace : SettingScope.User,
  };
}
