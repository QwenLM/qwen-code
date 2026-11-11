/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { ConfigLoadError } from '@qwen-code/core';
import type { SettingsDialogItem } from './SettingsListPanel.js';

export const ERROR_KEY_PREFIX = '__error__:';

/**
 * Build a map of warning-severity errors keyed by name, for ⚠ indicator display
 * on normal list items.
 */
export function buildWarningsByName(
  errors: readonly ConfigLoadError[],
): Map<string, ConfigLoadError> {
  const map = new Map<string, ConfigLoadError>();
  for (const err of errors) {
    if (err.severity === 'warning' && err.name) {
      map.set(err.name, err);
    }
  }
  return map;
}

/**
 * Build greyed-out list items for fatal (non-warning) load errors that belong
 * to the currently active source tab.
 *
 * @param getTabKeyForSource - maps a ConfigLoadError.source string to the
 *   browser's tab key (each browser has its own source→tab mapping).
 */
export function buildErrorListItems(
  errors: readonly ConfigLoadError[],
  activeSourceTab: string,
  getTabKeyForSource: (source: string | undefined) => string | null,
): SettingsDialogItem[] {
  const items: SettingsDialogItem[] = [];
  for (const err of errors) {
    if (err.severity === 'warning') continue;
    const tabKey = getTabKeyForSource(err.source);
    if (tabKey !== activeSourceTab) continue;
    const errName = err.name || path.basename(err.filePath);
    items.push({
      key: `${ERROR_KEY_PREFIX}${err.filePath}`,
      label: `⚠ ${errName}`,
      description: err.message,
      type: 'boolean' as const,
      displayValue: 'load error',
      isGreyedOut: true,
      rawValue: false,
    });
  }
  return items;
}

/**
 * Handle Enter keypress on an `__error__:` list item by opening the
 * ConfigErrorDetailView. Returns true if the item was an error item
 * (consumed the keypress), false otherwise.
 */
export function handleErrorItemKeyPress(
  itemKey: string,
  errors: readonly ConfigLoadError[],
  openConfigErrorDetail: (error: ConfigLoadError, label: string) => void,
  label: string,
): boolean {
  if (!itemKey.startsWith(ERROR_KEY_PREFIX)) return false;
  const errFilePath = itemKey.slice(ERROR_KEY_PREFIX.length);
  const err = errors.find((e) => e.filePath === errFilePath);
  if (err) openConfigErrorDetail(err, label);
  return true;
}
