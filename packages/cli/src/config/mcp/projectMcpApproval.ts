/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Project-level MCP server approval system.
 *
 * MCP servers from project-level sources (Project settings.json,
 * Local settings.local.json, and .mcp.json) require explicit
 * user approval before they can connect. This module provides:
 *
 * - Status determination (approved / rejected / pending)
 * - Filtering of MCP servers by approval status
 * - Persistence of approval decisions to User scope settings
 */

import type { MCPServerConfig } from '@qwen-code/core';
import type { LoadedSettings } from '../settings.js';
import type { MergedSettings } from '../settingsSchema.js';
import type { CommandSettings } from '../createCliSettingsService.js';
import { SettingScope } from '../settings.js';
import { normalizeServerId } from './mcpServerEnablement.js';

export type ProjectMcpServerStatus = 'approved' | 'rejected' | 'pending';

/**
 * Identify which server names are project-level (i.e. require approval).
 *
 * A server is project-level if:
 * 1. It appears in Project or Local scope but NOT in User scope, OR
 * 2. It comes from .mcp.json
 */
export function getProjectMcpServerNames(
  loaded: LoadedSettings,
  mcpJsonServers?: Record<string, MCPServerConfig>,
): Set<string> {
  const projectNames = new Set<string>();

  const userServers = loaded.user.settings.mcpServers ?? {};
  const projectServers = loaded.project.settings.mcpServers ?? {};
  const localServers = loaded.local.settings.mcpServers ?? {};

  const userServerNamesNormalized = new Set(
    Object.keys(userServers).map(normalizeServerId),
  );

  // Project scope servers not in User scope
  for (const name of Object.keys(projectServers)) {
    if (!userServerNamesNormalized.has(normalizeServerId(name))) {
      projectNames.add(normalizeServerId(name));
    }
  }

  // Local scope servers not in User scope
  for (const name of Object.keys(localServers)) {
    if (!userServerNamesNormalized.has(normalizeServerId(name))) {
      projectNames.add(normalizeServerId(name));
    }
  }

  // All .mcp.json servers
  if (mcpJsonServers) {
    for (const name of Object.keys(mcpJsonServers)) {
      projectNames.add(normalizeServerId(name));
    }
  }

  return projectNames;
}

/**
 * Determine the approval status of a single project-level MCP server.
 */
export function getProjectMcpServerStatus(
  serverName: string,
  mcpSettings: MergedSettings['mcp'],
): ProjectMcpServerStatus {
  const normalizedName = normalizeServerId(serverName);

  // Check rejected list first
  if (
    mcpSettings?.disabledProjectMcpServers?.some(
      (name) => normalizeServerId(name) === normalizedName,
    )
  ) {
    return 'rejected';
  }

  // Check approved list or enable-all flag
  if (
    mcpSettings?.enableAllProjectMcpServers ||
    mcpSettings?.enabledProjectMcpServers?.some(
      (name) => normalizeServerId(name) === normalizedName,
    )
  ) {
    return 'approved';
  }

  return 'pending';
}

/**
 * Filter MCP servers by approval status. Only servers whose names appear
 * in `projectServerNames` are subject to approval; all others pass through.
 *
 * In non-interactive mode, all non-rejected project servers are auto-approved.
 */
export function filterMcpServersByApproval(
  mcpServers: Record<string, MCPServerConfig>,
  projectServerNames: Set<string>,
  mcpSettings: MergedSettings['mcp'],
  isNonInteractive: boolean,
): {
  approved: Record<string, MCPServerConfig>;
  pending: Record<string, MCPServerConfig>;
} {
  const approved: Record<string, MCPServerConfig> = {};
  const pending: Record<string, MCPServerConfig> = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    if (!projectServerNames.has(normalizeServerId(name))) {
      // Not a project server — always approved (user-level)
      approved[name] = config;
      continue;
    }

    const status = getProjectMcpServerStatus(name, mcpSettings);

    if (status === 'approved') {
      approved[name] = config;
    } else if (status === 'rejected') {
      // Rejected servers are excluded from both maps
    } else {
      // Pending
      if (isNonInteractive) {
        approved[name] = config;
      } else {
        pending[name] = config;
      }
    }
  }

  return { approved, pending };
}

/**
 * Approve a specific project MCP server.
 * Adds to enabledProjectMcpServers and removes from disabledProjectMcpServers
 * in User scope.
 */
export function approveProjectMcpServer(
  serverName: string,
  loaded: CommandSettings,
): boolean {
  const normalizedName = normalizeServerId(serverName);
  return loaded.mutateScope(
    SettingScope.User,
    (editor) => {
      const disabled = stringArray(
        editor.get('mcp.disabledProjectMcpServers'),
      );
      editor.set(
        'mcp.disabledProjectMcpServers',
        disabled.filter(
          (name) => normalizeServerId(name) !== normalizedName,
        ),
      );

      const enabled = stringArray(
        editor.get('mcp.enabledProjectMcpServers'),
      );
      if (
        !enabled.some((name) => normalizeServerId(name) === normalizedName)
      ) {
        editor.set('mcp.enabledProjectMcpServers', [...enabled, serverName]);
      }
    },
  );
}

/**
 * Reject a specific project MCP server.
 * Adds to disabledProjectMcpServers and removes from enabledProjectMcpServers
 * in User scope.
 */
export function rejectProjectMcpServer(
  serverName: string,
  loaded: CommandSettings,
): boolean {
  const normalizedName = normalizeServerId(serverName);
  return loaded.mutateScope(
    SettingScope.User,
    (editor) => {
      const enabled = stringArray(
        editor.get('mcp.enabledProjectMcpServers'),
      );
      editor.set(
        'mcp.enabledProjectMcpServers',
        enabled.filter((name) => normalizeServerId(name) !== normalizedName),
      );

      const disabled = stringArray(
        editor.get('mcp.disabledProjectMcpServers'),
      );
      if (
        !disabled.some((name) => normalizeServerId(name) === normalizedName)
      ) {
        editor.set('mcp.disabledProjectMcpServers', [
          ...disabled,
          serverName,
        ]);
      }
    },
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Approve all project MCP servers (current and future).
 * Sets enableAllProjectMcpServers to true in User scope.
 */
export function approveAllProjectMcpServers(
  loaded: CommandSettings,
): boolean {
  return loaded.setValue(
    SettingScope.User,
    'mcp.enableAllProjectMcpServers',
    true,
  );
}

/**
 * Reset all project-level MCP server approval/rejection choices.
 * Clears enabledProjectMcpServers, disabledProjectMcpServers, and
 * enableAllProjectMcpServers in User scope so that the user will be
 * re-prompted on next startup.
 */
export function resetProjectMcpChoices(
  loaded: CommandSettings,
): boolean {
  return loaded.mutateScope(
    SettingScope.User,
    (editor) => {
      editor.set('mcp.enabledProjectMcpServers', []);
      editor.set('mcp.disabledProjectMcpServers', []);
      editor.set('mcp.enableAllProjectMcpServers', false);
    },
  );
}
