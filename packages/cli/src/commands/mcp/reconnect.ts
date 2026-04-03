/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { loadSettings } from '../../config/settings.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  Config,
  FileDiscoveryService,
  ExtensionManager,
} from '@qwen-code/qwen-code-core';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';

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

async function createMinimalConfig(): Promise<Config> {
  const settings = loadSettings();
  const cwd = process.cwd();
  const fileService = new FileDiscoveryService(cwd);

  const config = new Config({
    sessionId: 'mcp-reconnect',
    targetDir: cwd,
    cwd,
    debugMode: false,
    mcpServers: settings.merged.mcpServers || {},
    fileDiscoveryService: fileService,
    mcpServerCommand: settings.merged.mcp?.serverCommand,
  });

  await config.initialize();

  return config;
}

async function reconnectMcpServer(serverName: string): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();

  if (!mcpServers[serverName]) {
    writeStderrLine(
      `Error: Server "${serverName}" not found in configuration.`,
    );
    process.exit(1);
  }

  writeStdoutLine(`Reconnecting to server "${serverName}"...`);

  try {
    const config = await createMinimalConfig();
    const toolRegistry = config.getToolRegistry();
    await toolRegistry.discoverToolsForServer(serverName);
    writeStdoutLine(`Successfully reconnected to server "${serverName}".`);
    await config.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(
      `Failed to reconnect to server "${serverName}": ${message}`,
    );
    process.exit(1);
  }
}

async function reconnectAllMcpServers(): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();
  const serverNames = Object.keys(mcpServers);

  if (serverNames.length === 0) {
    writeStdoutLine('No MCP servers configured.');
    return;
  }

  writeStdoutLine('Reconnecting to all MCP servers...\n');

  let config: Config | undefined;
  try {
    config = await createMinimalConfig();
    const toolRegistry = config.getToolRegistry();

    for (const serverName of serverNames) {
      try {
        await toolRegistry.discoverToolsForServer(serverName);
        writeStdoutLine(`✓ ${serverName}: Reconnected successfully`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStdoutLine(`✗ ${serverName}: Failed - ${message}`);
      }
    }
  } finally {
    if (config) {
      await config.shutdown();
    }
  }
}

export const reconnectCommand: CommandModule = {
  command: 'reconnect [server-name]',
  describe: 'Reconnect MCP server(s)',
  builder: (yargs) =>
    yargs
      .usage('Usage: qwen mcp reconnect [options] [server-name]')
      .positional('server-name', {
        describe: 'Name of the server to reconnect',
        type: 'string',
      })
      .option('all', {
        alias: 'a',
        describe: 'Reconnect all configured servers',
        type: 'boolean',
        default: false,
      })
      .conflicts('server-name', 'all')
      .check((argv) => {
        const serverName = argv['server-name'];
        const all = argv['all'];
        if (!serverName && !all) {
          throw new Error(
            'Please specify a server name or use --all to reconnect all servers.',
          );
        }
        return true;
      }),
  handler: async (argv) => {
    const serverName = argv['server-name'] as string | undefined;
    const all = argv['all'] as boolean;

    if (all) {
      await reconnectAllMcpServers();
    } else if (serverName) {
      await reconnectMcpServer(serverName);
    }
  },
};
