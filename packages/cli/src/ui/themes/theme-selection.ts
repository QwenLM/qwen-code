/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import { validateCustomTheme } from './theme.js';
import { AUTO_THEME_NAME, themeManager } from './theme-manager.js';

/**
 * Persists `ui.theme` in `scope`, reloads the merged custom themes and
 * activates whatever theme is now in effect. Shared by the theme picker
 * (Ink and OpenTUI) and `/theme <name>`, so all of them apply a theme the
 * same way.
 *
 * If the theme in effect can't be activated, the previous value in `scope`
 * is put back and the previous theme re-activated, so settings never keep a
 * name that was reported as failed.
 *
 * Returns the theme name in effect and whether it could be activated.
 */
export function applyThemeSetting(
  settings: LoadedSettings,
  scope: SettingScope,
  themeName: string,
): { effective: string; applied: boolean } {
  const previous = settings.forScope(scope).settings.ui?.theme;
  settings.setValue(scope, 'ui.theme', themeName);
  const effective = activateMergedTheme(settings);
  const applied = effective.applied;
  if (!applied) {
    settings.setValue(scope, 'ui.theme', previous);
    activateMergedTheme(settings);
  }
  return { effective: effective.name, applied };
}

function activateMergedTheme(settings: LoadedSettings): {
  name: string;
  applied: boolean;
} {
  if (settings.merged.ui?.customThemes) {
    themeManager.loadCustomThemes(settings.merged.ui.customThemes);
  }
  const name = settings.merged.ui?.theme ?? AUTO_THEME_NAME;
  return { name, applied: themeManager.setActiveTheme(name) };
}

export type ThemeNameResolution =
  | { kind: 'found'; name: string; scope: SettingScope }
  | { kind: 'unknown'; available: string[] }
  | { kind: 'pinned-by-system' };

/**
 * Maps a typed theme name to one the theme manager can activate, and picks
 * the settings file the choice has to be written to for it to take effect.
 *
 * Candidates are `auto`, the built-in themes, and the valid `customThemes`
 * keys in the merged settings (an untrusted workspace contributes none). Keys
 * the theme manager would read as file paths are left out, since they can't
 * be activated by key. An exact match wins over a case-insensitive one.
 *
 * Has no side effects: nothing is loaded or activated here.
 */
export function resolveThemeName(
  settings: LoadedSettings,
  requested: string,
): ThemeNameResolution {
  if (settings.system.settings.ui?.theme !== undefined) {
    return { kind: 'pinned-by-system' };
  }

  const workspaceCustom = settings.isTrusted
    ? (settings.workspace.settings.ui?.customThemes ?? {})
    : {};
  const mergedCustom = settings.merged.ui?.customThemes ?? {};
  const builtIns = themeManager
    .getAvailableThemes()
    .filter((theme) => !theme.isCustom)
    .map((theme) => theme.name);
  const customKeys = Object.entries(mergedCustom)
    .filter(
      ([key, theme]) =>
        !themeManager.isPath(key) && validateCustomTheme(theme).isValid,
    )
    .map(([key]) => key);
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
