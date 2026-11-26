/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified types for the Installed tab — covers plugins, failed plugins, and
 * MCP servers in a single discriminated union.
 */

import type {
  FailedPluginItem,
  InstalledPluginItem,
  PendingPluginItem,
  PluginMcpServerItem,
  PluginMcpServerStatus,
  PluginRuntimeItem,
} from '@qwen-code/core';

// ---------------------------------------------------------------------------
// Unified item union — rendered by UnifiedInstalledCell
// ---------------------------------------------------------------------------

export type UnifiedPluginItem = InstalledPluginItem;
export type UnifiedFailedPluginItem = FailedPluginItem;
export type McpServerStatus = PluginMcpServerStatus;
export type UnifiedMcpServerItem = PluginMcpServerItem;
export type UnifiedPendingPluginItem = PendingPluginItem;
export type UnifiedInstalledItem = PluginRuntimeItem;

// ---------------------------------------------------------------------------
// Scope grouping for display
// ---------------------------------------------------------------------------

export type ScopeGroup =
  | 'flag'
  | 'project'
  | 'local'
  | 'user'
  | 'builtin'
  | 'removing';

export const SCOPE_GROUP_LABELS: Record<ScopeGroup, string> = {
  flag: 'Flag',
  project: 'Project',
  local: 'Local',
  user: 'User',
  builtin: 'Built-in',
  removing: 'Removing',
};

export const SCOPE_GROUP_ORDER: ScopeGroup[] = [
  'flag',
  'project',
  'local',
  'user',
  'builtin',
  'removing',
];
