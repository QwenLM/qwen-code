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
  getMCPServerLastError,
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

  // Mirror the real session's allow/exclude gates (see loadCliConfig in
  // config.ts, which reads the same settings.mcp source): without them this
  // throwaway Config still reaches servers the user excluded in settings
  // (`mcp.excluded`) or kept off the `mcp.allowed` list — connections a
  // normal session would never attempt.
  const allowedMcpServers = settings.merged.mcp?.allowed
    ? new Set(settings.merged.mcp.allowed.filter(Boolean))
    : undefined;
  const excludedMcpServers = settings.merged.mcp?.excluded
    ? new Set(settings.merged.mcp.excluded.filter(Boolean))
    : undefined;

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
    allowedMcpServers: allowedMcpServers
      ? Array.from(allowedMcpServers)
      : undefined,
    excludedMcpServers: excludedMcpServers
      ? Array.from(excludedMcpServers)
      : undefined,
    // Mirror a real session's trust gate: discovery skips MCP servers in an
    // untrusted workspace, so the throwaway Config must carry the same trust
    // state. Without it `isTrustedFolder()` defaults to true here, the
    // untrusted-skip reporting below becomes unreachable, and this command
    // would attempt connections a normal session would not (issue #9944).
    trustedFolder: isWorkspaceTrusted(settings.merged).isTrusted ?? true,
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
 * Thrown when discovery deliberately skips a server BEFORE any connection
 * attempt (disabled, `.mcp.json` pending approval, untrusted workspace).
 * Typed so result-aggregating callers can tell a skip from a failed
 * connection attempt: `--all` must not count skips toward its failure total,
 * or one intentionally-skipped server would force exit code 1 forever.
 */
class SkippedConnectionError extends Error {
  readonly skipReason: string;

  constructor(skipReason: string) {
    super(`no connection attempt was made: ${skipReason}`);
    this.name = 'SkippedConnectionError';
    this.skipReason = skipReason;
  }
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
 * Discovery skips some servers deliberately BEFORE any connection attempt —
 * servers off the `mcp.allowed` allow-list, servers in `mcp.excluded`,
 * disabled servers, `.mcp.json` servers pending approval, untrusted
 * workspaces — and `getMCPServerStatus` defaults never-seen servers to
 * DISCONNECTED. Without this check every skip would be reported as a failed
 * connection attempt, sending whoever is debugging to chase networking for a
 * server the client never tried to contact. The skip reasons are cheap and
 * knowable, so report them instead. The allow/exclude gates reuse the same
 * classifier as the tool-not-found path (`getMcpServerUnavailableReason`):
 * an allow-list-blocked server otherwise falls through every branch below
 * and is misreported as a failed connection on every run, and an
 * `mcp.excluded` server is misattributed to the per-server disabled flag
 * (issue #9944). (Budget-refused slots are decided inside the client
 * manager and stay on the generic failure message.)
 */
function describeSkippedConnectionReason(
  config: Config,
  serverName: string,
): string | undefined {
  const unavailableReason = config.getMcpServerUnavailableReason(serverName);
  if (unavailableReason === 'excluded') {
    return 'server is excluded in settings (mcp.excluded)';
  }
  if (unavailableReason === 'not_allowed') {
    return 'server is not in the mcp.allowed list';
  }
  if (config.isMcpServerDisabled(serverName)) {
    return 'server is disabled in settings';
  }
  if (config.isMcpServerPendingApproval(serverName)) {
    return 'server is pending approval (.mcp.json)';
  }
  if (config.isTrustedFolder() === false) {
    return 'workspace folder is not trusted';
  }
  return undefined;
}

/**
 * Runs discovery for one server and verifies that it actually produced a
 * live connection. `discoverToolsForServer` is best-effort and swallows
 * connect errors, so without the status check this command would print
 * "Reconnected successfully" for a server it never reached — e.g. a
 * single-session HTTP server whose only session is held by a running Qwen
 * Code session, or a server that is simply down (issue #9944).
 *
 * When verification fails, the underlying connect cause (ECONNREFUSED, an
 * OAuth 401, a spawn error...) is retrievable via `getMCPServerLastError`:
 * the client records it into the status registry before discovery's
 * best-effort catch swallows it. Append it so the failure output tells the
 * user WHY instead of a bare status enum.
 */
async function discoverAndVerifyConnection(
  config: Config,
  serverName: string,
): Promise<void> {
  const toolRegistry = config.getToolRegistry();
  await toolRegistry.discoverToolsForServer(serverName);
  const status = getMCPServerStatus(serverName);
  if (status !== MCPServerStatus.CONNECTED) {
    const skippedReason = describeSkippedConnectionReason(config, serverName);
    if (skippedReason) {
      throw new SkippedConnectionError(skippedReason);
    }
    const lastError = getMCPServerLastError(serverName);
    throw new Error(
      `connection attempt finished without a live connection (status: ${status})` +
        (lastError ? `: ${lastError}` : ''),
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

  // Shutdown must run on the failure path too: `discoverAndVerifyConnection`
  // throws on a non-CONNECTED status, the handler then `process.exit(1)`s,
  // and `process.exit` does not terminate stdio MCP servers the failed
  // attempt spawned — each retry would orphan another process. Mirror the
  // `--all` try/finally structure (issue #9944).
  let config: Config | undefined;
  try {
    config = await createMinimalConfig();
    await discoverAndVerifyConnection(config, serverName);
    writeStdoutLine(`Successfully reconnected to server "${serverName}".`);
    writeStdoutLine(SESSION_SCOPE_NOTE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The scope note applies to failure exactly as to success — a failed
    // reconnect is precisely when the user's running session still has
    // broken tools and the "separate process" caveat matters. `--all`
    // prints it on failure too; the two paths must stay consistent.
    writeStdoutLine(SESSION_SCOPE_NOTE);
    throw createReconnectError(
      `Failed to reconnect to server "${serverName}": ${message}`,
    );
  } finally {
    if (config) {
      await config.shutdown();
    }
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
        if (error instanceof SkippedConnectionError) {
          // An intentional skip is not a failure — the client never tried to
          // connect. Report it informationally and keep it out of failedCount:
          // counting it would force exit code 1 on every run (alerting
          // `qwen mcp reconnect --all || alert` wrappers forever) even though
          // nothing actually failed.
          writeStdoutLine(`- ${serverName}: Skipped - ${error.skipReason}`);
          continue;
        }
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
