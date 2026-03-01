/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp list' command
import type { CommandModule } from 'yargs';
import { loadSettings } from '../../config/settings.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import {
  MCPServerStatus,
  createTransport,
  ExtensionManager,
} from '@qwen-code/qwen-code-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';

const COLOR_GREEN = '\u001b[32m';
const COLOR_YELLOW = '\u001b[33m';
const COLOR_RED = '\u001b[31m';
const RESET_COLOR = '\u001b[0m';

interface McpServersWithFilters {
  mcpServers: Record<string, MCPServerConfig>;
  allowedServerNames?: Set<string>;
  excludedServerNames?: Set<string>;
}

async function getMcpServersFromConfig(): Promise<McpServersWithFilters> {
  const settings = loadSettings();
  const extensionManager = new ExtensionManager({
    isWorkspaceTrusted: !!isWorkspaceTrusted(settings.merged),
    telemetrySettings: settings.merged.telemetry,
  });
  await extensionManager.refreshCache();
  const extensions = extensionManager.getLoadedExtensions();
  const mcpServers = { ...(settings.merged.mcpServers || {}) };
  for (const extension of extensions) {
    if (extension.isActive) {
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
  }

  return {
    mcpServers,
    allowedServerNames: settings.merged.mcp?.allowed
      ? new Set(settings.merged.mcp.allowed.filter(Boolean))
      : undefined,
    excludedServerNames: settings.merged.mcp?.excluded
      ? new Set(settings.merged.mcp.excluded.filter(Boolean))
      : undefined,
  };
}

async function testMCPConnection(
  serverName: string,
  config: MCPServerConfig,
): Promise<MCPServerStatus> {
  const client = new Client({
    name: 'mcp-test-client',
    version: '0.0.1',
  });

  let transport;
  try {
    // Use the same transport creation logic as core
    transport = await createTransport(serverName, config, false);
  } catch (_error) {
    await client.close();
    return MCPServerStatus.DISCONNECTED;
  }

  try {
    // Attempt actual MCP connection with short timeout
    await client.connect(transport, { timeout: 5000 }); // 5s timeout

    // Test basic MCP protocol by pinging the server
    await client.ping();

    await client.close();
    return MCPServerStatus.CONNECTED;
  } catch (_error) {
    await transport.close();
    return MCPServerStatus.DISCONNECTED;
  }
}

async function getServerStatus(
  serverName: string,
  server: MCPServerConfig,
): Promise<MCPServerStatus> {
  // Test all server types by attempting actual connection
  return await testMCPConnection(serverName, server);
}

function isServerEnabled(
  serverName: string,
  allowedServerNames?: Set<string>,
  excludedServerNames?: Set<string>,
): boolean {
  const isAllowed = !allowedServerNames || allowedServerNames.has(serverName);
  const isExcluded = !!excludedServerNames && excludedServerNames.has(serverName);
  return isAllowed && !isExcluded;
}

export async function listMcpServers(): Promise<void> {
  const { mcpServers, allowedServerNames, excludedServerNames } =
    await getMcpServersFromConfig();
  const serverNames = Object.keys(mcpServers);

  if (serverNames.length === 0) {
    writeStdoutLine('No MCP servers configured.');
    return;
  }

  writeStdoutLine('Configured MCP servers:\n');

  for (const serverName of serverNames) {
    const server = mcpServers[serverName];
    const enabled = isServerEnabled(
      serverName,
      allowedServerNames,
      excludedServerNames,
    );

    let statusIndicator = '';
    let statusText = '';
    if (!enabled) {
      statusIndicator = COLOR_YELLOW + '○' + RESET_COLOR;
      statusText = 'disabled';
    } else {
      const status = await getServerStatus(serverName, server);
      switch (status) {
        case MCPServerStatus.CONNECTED:
          statusIndicator = COLOR_GREEN + '✓' + RESET_COLOR;
          statusText = 'Connected';
          break;
        case MCPServerStatus.CONNECTING:
          statusIndicator = COLOR_YELLOW + '…' + RESET_COLOR;
          statusText = 'Connecting';
          break;
        case MCPServerStatus.DISCONNECTED:
        default:
          statusIndicator = COLOR_RED + '✗' + RESET_COLOR;
          statusText = 'Disconnected';
          break;
      }
    }

    let serverInfo = `${serverName}: `;
    if (server.httpUrl) {
      serverInfo += `${server.httpUrl} (http)`;
    } else if (server.url) {
      serverInfo += `${server.url} (sse)`;
    } else if (server.command) {
      serverInfo += `${server.command} ${server.args?.join(' ') || ''} (stdio)`;
    }

    writeStdoutLine(`${statusIndicator} ${serverInfo} - ${statusText}`);
  }
}

export const listCommand: CommandModule = {
  command: 'list',
  describe: 'List all configured MCP servers',
  handler: async () => {
    await listMcpServers();
  },
};
