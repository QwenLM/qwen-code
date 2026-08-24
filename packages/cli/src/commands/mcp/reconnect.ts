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
  getMCPServerStatus,
  MCPServerStatus,
} from '@qwen-code/qwen-code-core';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { getPendingGatedMcpServers } from '../../config/mcpApprovals.js';
import { assembleMcpServers } from '../../config/mcpServers.js';
import { getCurrentLanguage } from '../../i18n/index.js';

async function getMcpServersFromConfig(
  extensionManager?: ExtensionManager,
): Promise<Record<string, MCPServerConfig>> {
  const settings = loadSettings();
  const extManager =
    extensionManager ??
    new ExtensionManager({
      isWorkspaceTrusted: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
      telemetrySettings: settings.merged.telemetry,
      locale: getCurrentLanguage(),
    });

  if (!extensionManager) {
    await extManager.refreshCache();
  }
  const extensions = extManager.getLoadedExtensions();
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

async function createMinimalConfig(): Promise<Config> {
  const settings = loadSettings();
  const cwd = process.cwd();
  const fileFiltering = settings.merged.context?.fileFiltering;
  const fileService = new FileDiscoveryService(
    cwd,
    fileFiltering?.customIgnoreFiles,
  );
  const mcpServers = await getMcpServersFromConfig();

  const config = new Config({
    sessionId: 'mcp-reconnect',
    targetDir: cwd,
    cwd,
    debugMode: false,
    chatRecording: false,
    mcpServers,
    pendingMcpServers: getPendingGatedMcpServers(mcpServers, cwd),
    fileDiscoveryService: fileService,
    mcpServerCommand: settings.merged.mcp?.serverCommand,
    ...(fileFiltering !== undefined ? { fileFiltering } : {}),
  });

  // This command runs its own targeted per-server discovery below
  // (`discoverToolsForServer`); it does not need the background incremental
  // pass `initialize()` would otherwise start. Skipping it removes the race
  // where that background pass re-arms health-check timers after
  // `config.shutdown()` and leaves the process hanging (issue #9944).
  await config.initialize({ skipMcpDiscovery: true });

  return config;
}

interface ReconnectError extends Error {
  exitCode: number;
}

/**
 * The reconnect command runs in its own short-lived process: it can verify
 * (and refresh) its own connection, but it has no channel into a running
 * Qwen Code session. Say so plainly in the success output so it is not read
 * as "your running session's MCP tools are back" (issue #9944).
 */
const SESSION_SCOPE_NOTE =
  'Note: this command reconnects in a separate process; it cannot refresh the MCP tools of an already-running Qwen Code session. Restart that session if its tools remain unavailable.';

function createReconnectError(
  message: string,
  exitCode: number = 1,
): ReconnectError {
  const error = new Error(message) as ReconnectError;
  error.exitCode = exitCode;
  return error;
}

/**
 * Runs discovery for one server and verifies that it actually produced a
 * live connection. `discoverToolsForServer` is best-effort and swallows
 * connect errors, so without the status check this command would print
 * "Reconnected successfully" for a server it never reached — e.g. a
 * single-session HTTP server whose only session is held by a running Qwen
 * Code session, or a server that is simply down (issue #9944).
 */
async function discoverAndVerifyConnection(
  config: Config,
  serverName: string,
): Promise<void> {
  const toolRegistry = config.getToolRegistry();
  await toolRegistry.discoverToolsForServer(serverName);
  const status = getMCPServerStatus(serverName);
  if (status !== MCPServerStatus.CONNECTED) {
    throw new Error(
      `connection attempt finished without a live connection (status: ${status})`,
    );
  }
}

async function reconnectMcpServer(serverName: string): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();

  if (!mcpServers[serverName]) {
    throw createReconnectError(
      `Error: Server "${serverName}" not found in configuration.`,
    );
  }

  writeStdoutLine(`Reconnecting to server "${serverName}"...`);

  try {
    const config = await createMinimalConfig();
    await discoverAndVerifyConnection(config, serverName);
    writeStdoutLine(`Successfully reconnected to server "${serverName}".`);
    writeStdoutLine(SESSION_SCOPE_NOTE);
    await config.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createReconnectError(
      `Failed to reconnect to server "${serverName}": ${message}`,
    );
  }
}

async function reconnectAllMcpServers(): Promise<void> {
  const settings = loadSettings();
  const extensionManager = new ExtensionManager({
    isWorkspaceTrusted: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
    telemetrySettings: settings.merged.telemetry,
    locale: getCurrentLanguage(),
  });
  await extensionManager.refreshCache();

  const mcpServers = await getMcpServersFromConfig(extensionManager);
  const serverNames = Object.keys(mcpServers);

  if (serverNames.length === 0) {
    writeStdoutLine('No MCP servers configured.');
    return;
  }

  writeStdoutLine('Reconnecting to all MCP servers...\n');

  let config: Config | undefined;
  let failedCount = 0;
  try {
    config = await createMinimalConfig();

    for (const serverName of serverNames) {
      try {
        await discoverAndVerifyConnection(config, serverName);
        writeStdoutLine(`✓ ${serverName}: Reconnected successfully`);
      } catch (error) {
        failedCount++;
        const message = error instanceof Error ? error.message : String(error);
        writeStdoutLine(`✗ ${serverName}: Failed - ${message}`);
      }
    }
    writeStdoutLine('');
    writeStdoutLine(SESSION_SCOPE_NOTE);
  } finally {
    if (config) {
      await config.shutdown();
    }
  }

  // Per-server errors are caught and reported above; without this throw the
  // handler's `process.exit(exitCode)` never runs and `--all` exits 0 even
  // when some (or all) servers failed verification — the single-server path
  // exits 1 for the identical failure. Wrapper scripts running
  // `qwen mcp reconnect --all || alert` would never alert.
  if (failedCount > 0) {
    throw createReconnectError(
      `Failed to reconnect ${failedCount} of ${serverNames.length} configured server(s).`,
    );
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

    try {
      if (all) {
        await reconnectAllMcpServers();
      } else if (serverName) {
        await reconnectMcpServer(serverName);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exitCode = (error as ReconnectError)?.exitCode ?? 1;
      writeStderrLine(message);
      process.exit(exitCode);
    }
  },
};
