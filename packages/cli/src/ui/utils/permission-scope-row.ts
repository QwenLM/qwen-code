/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nodePath from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  shortenPath,
  tildeifyPath,
} from '@qwen-code/qwen-code-core/utils/paths.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import {
  clipToWidthFromEnd,
  getCachedStringWidth,
  sanitizeTerminalLine,
  truncateToWidth,
} from './textUtils.js';

export const SCOPE_LABEL_GAP = 4;
export const SAVED_IN_TEMPLATE = 'Saved in {{path}}';

export interface PermissionScopeItem {
  label: string;
  description: string;
  value: SettingScope;
  key: string;
}

/**
 * Columns a numbered selection row leaves for `label + gap + description`:
 * the cursor box (2) and the number box with its trailing margin
 * (`digits + 2`). The ink list and the OpenTUI `DialogSelect` lay rows out the
 * same way, and both clip at the width they compute per render.
 */
export function scopeRowWidth(
  containerWidth: number,
  itemCount: number,
): number {
  return Math.max(0, containerWidth - 2 - (String(itemCount).length + 2));
}

/**
 * The rule-save scope rows. `rowWidth` is the columns this row will actually
 * paint into; budgeting the path from the localized label and the rest of the
 * template keeps the file name visible in every locale and at every terminal
 * width. A fixed character budget sized for English at 80 columns clipped the
 * name away in longer translations and in narrower terminals.
 */
export function permissionScopeItems(rowWidth: number): PermissionScopeItem[] {
  const userLabel = sanitizeTerminalLine(t('User settings'));
  const projectLabel = sanitizeTerminalLine(t('Project settings'));
  return [
    {
      label: projectLabel,
      description: fitScopeDescription(
        sanitizeTerminalLine(t('Checked in at .qwen/settings.json')),
        projectLabel,
        rowWidth,
      ),
      value: SettingScope.Workspace,
      key: 'project',
    },
    {
      label: userLabel,
      description: t(SAVED_IN_TEMPLATE, {
        path: savedSettingsPath(userLabel, rowWidth),
      }),
      value: SettingScope.User,
      key: 'user',
    },
  ];
}

/**
 * Bounds a fixed description to the row, keeping its tail: the Project row's
 * file name is what this dialog exists to show, and the renderer clips with
 * `wrap="truncate"`, which drops the tail instead. The prefix goes first and
 * an ellipsis replaces it, so `.qwen/settings.json` survives a narrow row.
 */
function fitScopeDescription(
  description: string,
  label: string,
  rowWidth: number,
): string {
  const budget = rowWidth - getCachedStringWidth(label) - SCOPE_LABEL_GAP;
  if (getCachedStringWidth(description) <= budget) {
    return description;
  }
  const ellipsis = '…';
  if (budget <= getCachedStringWidth(ellipsis)) {
    return truncateToWidth(description, budget);
  }
  const tail = clipToWidthFromEnd(
    description,
    budget - getCachedStringWidth(ellipsis),
  );
  return `${ellipsis}${tail}`;
}

function savedSettingsPath(label: string, rowWidth: number): string {
  const nonPathWidth = getCachedStringWidth(t(SAVED_IN_TEMPLATE, { path: '' }));
  const budget =
    rowWidth - getCachedStringWidth(label) - SCOPE_LABEL_GAP - nonPathWidth;
  // The path comes from the environment, so strip control characters before it
  // is measured: they paint as nothing (or as a second row) but would still
  // count against the budget shortenPath is given.
  const settingsPath = sanitizeTerminalLine(
    tildeifyPath(Storage.getGlobalSettingsPath()),
  );
  // shortenPath budgets code units, but this row is clipped in display
  // columns: wide characters make a path wider than its length, so charge that
  // overhead first or a path that fits the budget is clipped and loses its
  // file name.
  const widthOverhead =
    getCachedStringWidth(settingsPath) - settingsPath.length;
  const pathBudget = budget - Math.max(0, widthOverhead);
  const shortened =
    pathBudget >= 10 ? shortenPath(settingsPath, pathBudget) : '';
  const name = settingsPath.slice(settingsPath.lastIndexOf(nodePath.sep) + 1);
  // shortenPath always keeps the first segment, which can crowd out the file
  // name this row exists to show; keep the name alone when that happens.
  if (shortened.includes(name)) {
    return shortened;
  }
  const nameOnly = `...${nodePath.sep}${name}`;
  if (getCachedStringWidth(nameOnly) <= budget) {
    return nameOnly;
  }
  // The elided form does not fit, but the bare file name is shorter and may.
  if (getCachedStringWidth(name) <= budget) {
    return name;
  }
  // Not even the bare name fits. Bound the description to the row anyway: an
  // overlong fallback is clipped by the renderer, which then decides what
  // survives instead of this budget.
  return truncateToWidth(nameOnly, budget);
}
