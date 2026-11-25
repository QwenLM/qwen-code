/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MCPServerStatus,
  coreEvents,
  CoreEvent,
  mcpServerRequiresOAuth,
  type Config,
  type PluginMcpServerStatus,
} from '@qwen-code/core';
import {
  McpServerEnablementManager,
  normalizeServerId,
} from '../../../config/mcp/mcpServerEnablement.js';

/**
 * Project live MCP state onto the status vocabulary rendered under /plugins.
 * The plugin's enabled flag only decides whether a server is disabled; every
 * other state comes from the session MCP manager.
 */
export function collectPluginMcpServerStatuses(
  config: Config | null | undefined,
  serverNames: Iterable<string>,
): Map<string, PluginMcpServerStatus> {
  const statuses = new Map<string, PluginMcpServerStatus>();
  const manager = config?.getMcpClientManager();
  if (!config || !manager) return statuses;

  const names = [...new Set(serverNames)];
  const servers = manager.getMcpServers();
  const displayStates = McpServerEnablementManager.getInstance().getAllDisplayStates(
    names,
    config.getLoadedSettings(),
  );

  for (const name of names) {
    if (!(name in servers)) {
      statuses.set(name, 'pending');
    } else if (displayStates[normalizeServerId(name)]?.enabled === false) {
      statuses.set(name, 'disabled');
    } else if (
      manager.isMcpServerBlockedByHostPolicy(name) ||
      manager.getMcpServerConfigurationError(name)
    ) {
      statuses.set(name, 'failed');
    } else {
      statuses.set(name, toPluginStatus(name, manager.getServerStatus(name)));
    }
  }
  return statuses;
}

function toPluginStatus(
  name: string,
  status: MCPServerStatus,
): PluginMcpServerStatus {
  switch (status) {
    case MCPServerStatus.CONNECTED:
      return 'connected';
    case MCPServerStatus.CONNECTING:
    case MCPServerStatus.DISCONNECTING:
      return 'pending';
    case MCPServerStatus.AUTH_REQUIRED:
      return 'needs-auth';
    case MCPServerStatus.DISABLED:
      return 'disabled';
    case MCPServerStatus.DISCONNECTED:
      return mcpServerRequiresOAuth.has(name) ? 'needs-auth' : 'failed';
    case MCPServerStatus.BLOCKED:
    default:
      return 'failed';
  }
}

/** Subscribe to MCP connection and enablement changes for the given listener. */
export function subscribeToPluginMcpChanges(listener: () => void): () => void {
  coreEvents.on(CoreEvent.McpClientUpdate, listener);
  const unsubscribeEnablement =
    McpServerEnablementManager.getInstance().subscribe(listener);
  return () => {
    coreEvents.off(CoreEvent.McpClientUpdate, listener);
    unsubscribeEnablement();
  };
}
