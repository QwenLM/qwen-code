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
  isGatedMcpScope,
  runWithTimeout,
} from '@qwen-code/qwen-code-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { assembleMcpServers } from '../../config/mcpServers.js';
import { loadMcpApprovals } from '../../config/mcpApprovals.js';
import { getCurrentLanguage } from '../../i18n/index.js';

const COLOR_GREEN = '\u001b[32m';
const COLOR_YELLOW = '\u001b[33m';
const COLOR_RED = '\u001b[31m';
const RESET_COLOR = '\u001b[0m';
const MCP_CONNECT_TIMEOUT_MS = 5000;

interface McpConnectionResult {
  status: MCPServerStatus;
  timedOut: boolean;
}

async function getMcpServersFromConfig(): Promise<
  Record<string, MCPServerConfig>
> {
  const settings = loadSettings();
  const extensionManager = new ExtensionManager({
    isWorkspaceTrusted: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
    telemetrySettings: settings.merged.telemetry,
    locale: getCurrentLanguage(),
  });
  await extensionManager.refreshCache();
  const extensions = extensionManager.getLoadedExtensions();
  // Assemble settings + project `.mcp.json` in precedence order (#4615);
  // loading is a pure read — never connects. Extensions fill remaining gaps
  // below, matching `Config.getMcpServers` (extension servers never shadow a
  // configured one).
  const mcpServers: Record<string, MCPServerConfig> = assembleMcpServers(
    settings.merged.mcpServers,
    process.cwd(),
  );
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
  return mcpServers;
}

async function testMCPConnection(
  serverName: string,
  config: MCPServerConfig,
): Promise<McpConnectionResult> {
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
    return { status: MCPServerStatus.DISCONNECTED, timedOut: false };
  }

  try {
    // The SDK timeout only covers initialization after transport.start().
    // Guard the transport startup too so a silent SSE server cannot hang this command.
    await runWithTimeout(
      client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS }),
      MCP_CONNECT_TIMEOUT_MS,
      `MCP connection for ${serverName}`,
    );

    // Test basic MCP protocol by pinging the server
    await client.ping();

    await client.close();
    return { status: MCPServerStatus.CONNECTED, timedOut: false };
  } catch (error) {
    await transport.close();
    return {
      status: MCPServerStatus.DISCONNECTED,
      timedOut:
        error instanceof Error && error.message.startsWith('Timed out after '),
    };
  }
}

async function getServerStatus(
  serverName: string,
  server: MCPServerConfig,
): Promise<McpConnectionResult> {
  // Test all server types by attempting actual connection
  return await testMCPConnection(serverName, server);
}

export async function listMcpServers(): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();
  const serverNames = Object.keys(mcpServers);

  if (serverNames.length === 0) {
    writeStdoutLine('No MCP servers configured.');
    return;
  }

  writeStdoutLine('Configured MCP servers:\n');

  const cwd = process.cwd();
  // Lazily loaded only when a gated (project/workspace) server is present, so
  // the common no-gated-server case never touches the approvals store.
  let approvals: ReturnType<typeof loadMcpApprovals> | undefined;

  for (const serverName of serverNames) {
    const server = mcpServers[serverName];

    let serverInfo = `${serverName}: `;
    if (server.httpUrl) {
      serverInfo += `${server.httpUrl} (http)`;
    } else if (server.url) {
      serverInfo += `${server.url} (sse)`;
    } else if (server.command) {
      serverInfo += `${server.command} ${server.args?.join(' ') || ''} (stdio)`;
    }

    // Gated (project `.mcp.json` / workspace `.qwen/settings.json`) servers that
    // are not approved are listed WITHOUT connecting — inspecting an untrusted
    // config must stay side-effect-free (#4615). Only approved / non-gated
    // servers get a live connection test.
    if (isGatedMcpScope(server.scope)) {
      approvals ??= loadMcpApprovals();
      const state = approvals.getState(cwd, serverName, server);
      if (state !== 'approved') {
        const statusText =
          state === 'rejected' ? 'Rejected' : 'Pending approval';
        writeStdoutLine(
          `${COLOR_YELLOW}●${RESET_COLOR} ${serverInfo} - ${statusText}`,
        );
        continue;
      }
    }

    const { status, timedOut } = await getServerStatus(serverName, server);

    let statusIndicator = '';
    let statusText = '';
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
        statusText = timedOut
          ? `Disconnected (timed out after ${MCP_CONNECT_TIMEOUT_MS}ms)`
          : 'Disconnected';
        break;
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
