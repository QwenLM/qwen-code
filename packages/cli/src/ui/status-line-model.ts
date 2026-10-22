/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import type { StatusLineState } from './hooks/useStatusLine.js';
import type { MultiSelectItem } from './components/shared/MultiSelect.js';
import {
  aggregateModelTokens,
  buildStatusLinePresetData,
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
// border + paddingY + title + subtitle + search + margins + preview + footer
export const STATUS_LINE_DIALOG_FIXED_ROWS = 15;

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
): StatusLinePresetConfig {
  const selected = new Set(keys);

  return {
    type: 'preset',
    useThemeColors: selected.has(THEME_COLORS_KEY),
    items: orderStatusLinePresetItems(keys),
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

export function getPreviewData(
  config: Config,
  uiState: Pick<
    StatusLineState,
    'sessionStats' | 'branchName' | 'streamingState'
  >,
) {
  const stats = uiState.sessionStats;
  const metrics = stats.metrics;
  const { totalInputTokens, totalOutputTokens } = aggregateModelTokens(metrics);
  const contentGeneratorConfig = config.getContentGeneratorConfig();

  return buildStatusLinePresetData({
    sessionId: stats.sessionId,
    version: config.getCliVersion(),
    modelDisplayName: config.getModelDisplayName(),
    reasoning: contentGeneratorConfig?.reasoning,
    currentDir: config.getTargetDir(),
    branch: uiState.branchName,
    contextWindowSize: contentGeneratorConfig?.contextWindowSize || 0,
    currentUsage: stats.lastPromptTokenCount,
    totalInputTokens,
    totalOutputTokens,
    totalLinesAdded: metrics.files.totalLinesAdded,
    totalLinesRemoved: metrics.files.totalLinesRemoved,
    streamingState: uiState.streamingState,
  });
}
