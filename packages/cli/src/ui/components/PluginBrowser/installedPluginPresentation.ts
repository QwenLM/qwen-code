/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildPluginDetailFields,
  getPluginScope,
  SCOPE_LABELS,
  type PluginDetailField,
} from './pluginDetailsHelpers.js';
import { formatErrorMessage } from './PluginErrors.js';
import {
  SCOPE_GROUP_LABELS,
  SCOPE_GROUP_ORDER,
  type UnifiedInstalledItem,
  type ScopeGroup,
} from './unifiedTypes.js';

/** Complete display data for an installed row. Product rules are resolved before rendering. */
export interface InstalledPluginPresentation {
  groupLabel: string;
  groupOrder: number;
  scopeLabel: string;
  shadowedByLabel?: string;
  fields: PluginDetailField[];
  toggleDisabledReason?: string;
  uninstallDisabledReason?: string;
  showPath: boolean;
  errorMessages: string[];
}

export function getInstalledItemScope(item: UnifiedInstalledItem): string {
  switch (item.type) {
    case 'plugin':
      return item.installScope ?? getPluginScope(item.plugin);
    case 'pending-plugin':
      return item.scope;
    case 'mcp-server':
      return item.parentScope || 'user';
    case 'failed-plugin':
    default:
      return 'user';
  }
}

export function buildInstalledPluginPresentation(
  item: UnifiedInstalledItem,
): InstalledPluginPresentation {
  const scope = getInstalledItemScope(item);
  const group = (
    item.type === 'plugin' && item.pendingRemoval ? 'removing' : scope
  ) as ScopeGroup;
  const order = SCOPE_GROUP_ORDER.indexOf(group);
  const shadowedBy = 'shadowedBy' in item ? item.shadowedBy : undefined;
  return {
    groupLabel: SCOPE_GROUP_LABELS[group] ?? scope,
    groupOrder: order < 0 ? SCOPE_GROUP_ORDER.length : order,
    scopeLabel: SCOPE_LABELS[scope] ?? scope,
    shadowedByLabel: shadowedBy
      ? (SCOPE_LABELS[shadowedBy] ?? shadowedBy)
      : undefined,
    fields:
      item.type === 'plugin'
        ? buildPluginDetailFields(
            item.plugin,
            item.isEnabled,
            item.installScope,
            item.canToggle !== false,
          )
        : [],
    showPath: true,
    errorMessages:
      item.type === 'failed-plugin' ? item.errors.map(formatErrorMessage) : [],
  };
}
