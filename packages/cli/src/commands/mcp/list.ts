/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp list' command
import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import {
  MCPServerStatus,
  createTransport,
  isProjectMcpServerPendingApproval,
} from '@qwen-code/qwen-code-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { formatMcpServerInfo, getMcpServersFromConfig } from './servers.js';

const COLOR_GREEN = '\u001b[32m';
const COLOR_YELLOW = '\u001b[33m';
const COLOR_RED = '\u001b[31m';
const RESET_COLOR = '\u001b[0m';

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

export async function listMcpServers(): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();
  const serverNames = Object.keys(mcpServers);

  if (serverNames.length === 0) {
    writeStdoutLine('No MCP servers configured.');
    return;
  }

  writeStdoutLine('MCP servers:\n');

  for (const serverName of serverNames) {
    const server = mcpServers[serverName];

    const pendingApproval = isProjectMcpServerPendingApproval(server);
    const status = pendingApproval
      ? undefined
      : await getServerStatus(serverName, server);

    let statusIndicator = '';
    let statusText = '';
    if (pendingApproval) {
      statusIndicator = COLOR_YELLOW + '?' + RESET_COLOR;
      statusText = 'Pending approval';
    } else {
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

    writeStdoutLine(
      `${statusIndicator} ${formatMcpServerInfo(
        serverName,
        server,
      )} - ${statusText}`,
    );
  }
}

export const listCommand: CommandModule = {
  command: 'list',
  describe: 'List all configured MCP servers',
  handler: async () => {
    await listMcpServers();
  },
};
