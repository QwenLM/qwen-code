/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import { deleteNestedPropertySafe } from '../../config/settingsUtils.js';
import { validateCustomTheme } from './theme.js';
import { AUTO_THEME_NAME, themeManager } from './theme-manager.js';

/**
 * Persists `ui.theme` in `scope`, reloads the merged custom themes and
 * activates whatever theme is now in effect. Shared by the theme picker
 * (Ink and OpenTUI) and `/theme <name>`, so all of them apply a theme the
 * same way.
 *
 * Nothing is written when system settings pin the theme, since no other
 * scope can override them; `pinnedBySystem` is set instead.
 *
 * An untrusted workspace is left out of the merged settings, so a Workspace
 * write there would never take effect; it goes to User settings instead,
 * like the model picker does.
 *
 * If the settings file can't be saved, nothing changes and `applied` is
 * false. If the new value is the one in effect and can't be activated, the
 * scope's previous value is put back (or the key removed again if the scope
 * had none). A write that another scope overrides is kept as is.
 *
 * Returns the theme in effect, whether it could be activated, and the scope
 * that was written. The selection took effect only when `applied` is true
 * and `effective` equals `themeName`.
 */
export function applyThemeSetting(
  settings: LoadedSettings,
  scope: SettingScope,
  themeName: string,
): {
  effective: string;
  applied: boolean;
  scope: SettingScope;
  pinnedBySystem?: boolean;
} {
  const target =
    scope === SettingScope.Workspace && !settings.isTrusted
      ? SettingScope.User
      : scope;
  const current = settings.merged.ui?.theme ?? AUTO_THEME_NAME;
  if (isThemePinnedBySystem(settings)) {
    return {
      effective: current,
      applied: false,
      scope: target,
      pinnedBySystem: true,
    };
  }
  const previous = settings.forScope(target).settings.ui?.theme;
  if (!writeThemeSetting(settings, target, themeName)) {
    return { effective: current, applied: false, scope: target };
  }
  const effective = activateMergedTheme(settings);
  if (!effective.applied && effective.name === themeName) {
    writeThemeSetting(settings, target, previous);
    activateMergedTheme(settings);
  }
  return {
    effective: effective.name,
    applied: effective.applied,
    scope: target,
  };
}

/** System settings merge last, so a theme set there can't be overridden. */
export function isThemePinnedBySystem(settings: LoadedSettings): boolean {
  return settings.system.settings.ui?.theme !== undefined;
}

/** Saves `ui.theme` in `scope`. Returns false, changing nothing, if the file can't be written. */
function writeThemeSetting(
  settings: LoadedSettings,
  scope: SettingScope,
  value: string | undefined,
): boolean {
  try {
    // The throwing form saves before it touches the in-memory settings.
    settings.setValue(scope, 'ui.theme', value, undefined, {
      throwOnWriteFailure: true,
    });
  } catch {
    return false;
  }
  if (value !== undefined) return true;
  // setValue leaves an own `theme: undefined` key behind, which the merge
  // copies over a lower scope's theme. Drop it so that theme shows through.
  const file = settings.forScope(scope);
  for (const target of [file.settings, file.originalSettings]) {
    deleteNestedPropertySafe(target as Record<string, unknown>, 'ui.theme');
  }
  settings.recomputeMerged();
  return true;
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
  if (isThemePinnedBySystem(settings)) {
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
