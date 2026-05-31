/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { ExtensionManager } from '@qwen-code/qwen-code-core';
import {
  loadProjectMcpServers,
  mergeProjectMcpServers,
} from '../../config/projectMcpConfig.js';
import { loadSettings } from '../../config/settings.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';

export async function getMcpServersFromConfig(): Promise<
  Record<string, MCPServerConfig>
> {
  const settings = loadSettings();
  const extensionManager = new ExtensionManager({
    isWorkspaceTrusted: !!isWorkspaceTrusted(settings.merged),
    telemetrySettings: settings.merged.telemetry,
  });
  await extensionManager.refreshCache();

  const mcpServers = mergeProjectMcpServers(
    settings.merged.mcpServers || {},
    loadProjectMcpServers(),
  );

  for (const extension of extensionManager.getLoadedExtensions()) {
    if (!extension.isActive) {
      continue;
    }
    Object.entries(extension.config.mcpServers || {}).forEach(
      ([key, server]) => {
        if (mcpServers[key]) {
          return;
        }
        mcpServers[key] = {
          ...server,
          extensionName: extension.config.name,
        };
      },
    );
  }

  return mcpServers;
}

export function stripProjectMetadata(server: MCPServerConfig): MCPServerConfig {
  const config = { ...server } as Record<string, unknown>;
  delete config['source'];
  delete config['pendingApproval'];
  delete config['projectConfigPath'];
  return config as MCPServerConfig;
}

const APPROVED_PROJECT_MCP_FIELDS = [
  'command',
  'args',
  'url',
  'httpUrl',
  'tcp',
  'timeout',
  'description',
  'includeTools',
  'excludeTools',
  'oauth',
  'type',
  'discoveryTimeoutMs',
] as const satisfies ReadonlyArray<keyof MCPServerConfig>;

export function toApprovedMcpServerConfig(
  server: MCPServerConfig,
): MCPServerConfig {
  const config: Record<string, unknown> = {};
  for (const field of APPROVED_PROJECT_MCP_FIELDS) {
    const value = server[field];
    if (value !== undefined) {
      config[field] = value;
    }
  }
  return config as MCPServerConfig;
}

export function formatMcpServerInfo(
  serverName: string,
  server: MCPServerConfig,
): string {
  let serverInfo = `${serverName}: `;
  if (server.httpUrl) {
    serverInfo += `${server.httpUrl} (http)`;
  } else if (server.url) {
    serverInfo += `${server.url} (sse)`;
  } else if (server.command) {
    serverInfo += `${server.command} ${server.args?.join(' ') || ''} (stdio)`;
  }
  return serverInfo;
}
