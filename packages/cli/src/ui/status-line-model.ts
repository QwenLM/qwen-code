/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope, type LoadedSettings } from '../config/settings.js';
import type { MultiSelectItem } from './components/shared/MultiSelect.js';
import {
  DEFAULT_STATUS_LINE_PRESET_CONFIG,
  normalizeStatusLinePresetConfig,
  orderStatusLinePresetItems,
  STATUS_LINE_PRESET_ITEMS,
  type StatusLinePresetConfig,
  type StatusLinePresetItemId,
} from './statusLinePresets.js';

type StatusLineOption =
  | { kind: 'theme-colors' }
  | { kind: 'separator' }
  | { kind: 'item'; id: StatusLinePresetItemId };

export const THEME_COLORS_KEY = 'theme-colors';
const DESCRIPTION_COLUMN = 24;
// border + paddingY + title + subtitle + search + margins + footer
export const STATUS_LINE_DIALOG_FIXED_ROWS = 12;
export const STATUS_LINE_DIALOG_MIN_ITEMS = 4;
export const STATUS_LINE_COMPOSER_ROWS = 7;

export const STATUS_LINE_OPTIONS: Array<MultiSelectItem<StatusLineOption>> = [
  {
    key: THEME_COLORS_KEY,
    value: { kind: 'theme-colors' },
    label: `${'Use theme colors'.padEnd(DESCRIPTION_COLUMN)} Apply colors from the active /theme`,
  },
  {
    key: 'statusline-separator',
    value: { kind: 'separator' },
    label: '─'.repeat(23),
    disabled: true,
    separator: true,
  },
  ...STATUS_LINE_PRESET_ITEMS.map((item) => ({
    key: item.id,
    value: { kind: 'item' as const, id: item.id },
    label: `${item.label.padEnd(DESCRIPTION_COLUMN)} ${item.description}`,
  })),
];

export function buildInitialSelectedKeys(settings: LoadedSettings): string[] {
  const preset =
    normalizeStatusLinePresetConfig(settings.merged.ui?.statusLine) ??
    DEFAULT_STATUS_LINE_PRESET_CONFIG;
  return [
    ...(preset.useThemeColors ? [THEME_COLORS_KEY] : []),
    ...preset.items,
  ];
}

export function buildConfigFromKeys(
  keys: readonly string[],
  settings: LoadedSettings,
): StatusLinePresetConfig {
  const selected = new Set(keys);
  const old = settings.forScope(getEffectiveStatusLineScope(settings)).settings
    .ui?.statusLine;

  return {
    type: 'preset',
    useThemeColors: selected.has(THEME_COLORS_KEY),
    items: orderStatusLinePresetItems(keys),
    ...(typeof old?.hideContextIndicator === 'boolean'
      ? { hideContextIndicator: old.hideContextIndicator }
      : {}),
  };
}

export function getEffectiveStatusLineScope(
  settings: LoadedSettings,
): SettingScope {
  if (settings.forScope(SettingScope.System).settings.ui?.statusLine) {
    return SettingScope.System;
  }
  if (
    settings.isTrusted &&
    settings.forScope(SettingScope.Workspace).settings.ui?.statusLine
  ) {
    return SettingScope.Workspace;
  }
  return SettingScope.User;
}
