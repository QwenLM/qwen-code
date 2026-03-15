/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp reconnect' command
import type { CommandModule } from 'yargs';
import { loadSettings } from '../../config/settings.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import {
  MCPServerStatus,
  createTransport,
  ExtensionManager,
} from '@qwen-code/qwen-code-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';

async function getMcpServersFromConfig(): Promise<
  Record<string, MCPServerConfig>
> {
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
  return mcpServers;
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
    transport = await createTransport(serverName, config, false);
  } catch (_error) {
    await client.close();
    return MCPServerStatus.DISCONNECTED;
  }

  try {
    await client.connect(transport, { timeout: 5000 });
    await client.ping();
    await client.close();
    return MCPServerStatus.CONNECTED;
  } catch (_error) {
    await transport.close();
    return MCPServerStatus.DISCONNECTED;
  }
}

async function reconnectMcpServer(serverName: string): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();

  if (!mcpServers[serverName]) {
    writeStderrLine(
      `Error: Server "${serverName}" not found in configuration.`,
    );
    process.exit(1);
  }

  const serverConfig = mcpServers[serverName];

  try {
    const status = await testMCPConnection(serverName, serverConfig);
    if (status === MCPServerStatus.CONNECTED) {
      writeStdoutLine(`Successfully reconnected to server "${serverName}".`);
    } else {
      writeStderrLine(
        `Failed to reconnect to server "${serverName}": Connection could not be established.`,
      );
      process.exit(1);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeStderrLine(
      `Failed to reconnect to server "${serverName}": ${errorMessage}`,
    );
    process.exit(1);
  }
}

async function reconnectAllDisconnectedServers(): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();
  const serverNames = Object.keys(mcpServers);

  if (serverNames.length === 0) {
    writeStdoutLine('No MCP servers configured.');
    return;
  }

  let reconnectedCount = 0;
  let failedCount = 0;
  let alreadyConnectedCount = 0;

  for (const serverName of serverNames) {
    const serverConfig = mcpServers[serverName];
    const status = await testMCPConnection(serverName, serverConfig);

    if (status === MCPServerStatus.CONNECTED) {
      alreadyConnectedCount++;
      continue;
    }

    writeStdoutLine(`Reconnecting to server "${serverName}"...`);

    try {
      const newStatus = await testMCPConnection(serverName, serverConfig);
      if (newStatus === MCPServerStatus.CONNECTED) {
        writeStdoutLine(`Successfully reconnected to server "${serverName}".`);
        reconnectedCount++;
      } else {
        writeStderrLine(`Failed to reconnect to server "${serverName}".`);
        failedCount++;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      writeStderrLine(
        `Failed to reconnect to server "${serverName}": ${errorMessage}`,
      );
      failedCount++;
    }
  }

  writeStdoutLine('');
  writeStdoutLine(
    `Summary: ${reconnectedCount} reconnected, ${alreadyConnectedCount} already connected, ${failedCount} failed.`,
  );

  if (failedCount > 0) {
    process.exit(1);
  }
}

interface ReconnectArgs {
  serverName?: string;
  all: boolean;
}

export const reconnectCommand: CommandModule<object, ReconnectArgs> = {
  command: 'reconnect [serverName]',
  describe: 'Reconnect MCP servers',
  builder: (yargs) =>
    yargs
      .usage('Usage: qwen mcp reconnect [options] [serverName]')
      .positional('serverName', {
        describe: 'Name of the server to reconnect',
        type: 'string',
      })
      .option('all', {
        alias: 'a',
        describe: 'Reconnect all disconnected servers',
        type: 'boolean',
        default: false,
      })
      .check((argv) => {
        if (!argv.serverName && !argv.all) {
          throw new Error('Either specify a server name or use --all flag');
        }
        if (argv.serverName && argv.all) {
          throw new Error('Cannot specify both server name and --all flag');
        }
        return true;
      }),
  handler: async (argv) => {
    if (argv.all) {
      await reconnectAllDisconnectedServers();
    } else if (argv.serverName) {
      await reconnectMcpServer(argv.serverName);
    }
  },
};
