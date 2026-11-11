/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp list' command
import type { McpCommandOptions } from './options.js';
import { Command } from '@commander-js/extra-typings';
import { createCliSettingsService } from '../../config/createCliSettingsService.js';
import {
  MCPServerStatus,
  McpClientContext,
  createTransport,
  runLogger,
  expandMcpEnvVars,
  mcpServerRequiresOAuth,
  isAuthenticationError,
  McpAuthorizationRequiredError,
} from '@qwen-code/core';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '@qwen-code/core';
import type { MergedSettings, SettingSource } from '../../config/settings.js';

function needsAuthentication(error: unknown): boolean {
  return (
    isAuthenticationError(error) ||
    error instanceof McpAuthorizationRequiredError
  );
}

export async function getMcpServersFromConfig(
  settings?: MergedSettings,
  validator?: McpCommandOptions['projectConfigValidator'],
): Promise<Record<string, MCPServerConfig>> {
  if (!settings) {
    const { resolveCommandSettings } = await import(
      '../../config/createCliSettingsService.js'
    );
    settings = (await resolveCommandSettings()).merged;
  }

  const { loadProjectMcpJson } = await import(
    '../../config/mcp/projectMcpJson.js'
  );
  const projectMcpServers = loadProjectMcpJson(process.cwd(), validator);
  const mcpServers = { ...settings.mcpServers, ...projectMcpServers };

  return mcpServers;
}

const MCP_LIST_DEFAULT_TIMEOUT_MSEC = 5000;

async function testMCPConnection(
  serverName: string,
  config: MCPServerConfig,
  isTrusted: boolean,
  activeSettings: MergedSettings,
): Promise<MCPServerStatus> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const chalk = (await import('chalk')).default;
  // SECURITY: Only test connection if workspace is trusted or if it's a remote server.
  // stdio servers execute local commands and must never run in untrusted workspaces.
  const isStdio = !!config.command;
  if (isStdio && !isTrusted) {
    return MCPServerStatus.DISCONNECTED;
  }

  const client = new Client({
    name: 'mcp-test-client',
    version: '0.0.1',
  });

  const mcpContext = new McpClientContext({
    sanitizationConfig: {
      enableEnvironmentVariableRedaction: true,
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: activeSettings.advanced.excludedEnvVars,
    },
    emitDiagnostic: (
      severity: 'info' | 'warning' | 'error',
      message: string,
      error?: unknown,
      serverName?: string,
    ) => {
      // In non-interactive list, we log everything through runLogger for consistency
      if (severity === 'error') {
        runLogger.error(
          chalk.red(`Error${serverName ? ` (${serverName})` : ''}: ${message}`),
          error,
        );
      } else if (severity === 'warning') {
        runLogger.warn(
          chalk.yellow(
            `Warning${serverName ? ` (${serverName})` : ''}: ${message}`,
          ),
          error,
        );
      } else {
        runLogger.log(message, error);
      }
    },
    isTrustedFolder: () => isTrusted,
  });

  let transport;
  try {
    // Use the same transport creation logic as core
    transport = await createTransport(serverName, config, false, mcpContext);
  } catch (error) {
    if (needsAuthentication(error)) {
      mcpServerRequiresOAuth.set(serverName, true);
    }
    await client.close();
    return MCPServerStatus.DISCONNECTED;
  }

  try {
    // Attempt actual MCP connection with short timeout to keep the list
    // command responsive.
    await client.connect(transport, {
      timeout: MCP_LIST_DEFAULT_TIMEOUT_MSEC,
    });

    // Test basic MCP protocol by pinging the server.
    // A minimal server may legitimately not implement ping (Method not found);
    // a successful connect() still proves it is usable. Any other failure
    // (connection dropped, timeout) means the server is not actually reachable.
    try {
      await client.ping({ timeout: MCP_LIST_DEFAULT_TIMEOUT_MSEC });
    } catch (e) {
      if (needsAuthentication(e)) {
        throw e;
      }
      if (!(e instanceof McpError) || e.code !== ErrorCode.MethodNotFound) {
        throw e;
      }
      runLogger.debug(
        `MCP ping not implemented for ${serverName}, but connect succeeded`,
        e,
      );
    }

    await client.close();
    mcpServerRequiresOAuth.delete(serverName);
    return MCPServerStatus.CONNECTED;
  } catch (error) {
    if (needsAuthentication(error)) {
      mcpServerRequiresOAuth.set(serverName, true);
    }
    await transport.close();
    return MCPServerStatus.DISCONNECTED;
  }
}

export async function getServerStatus(
  serverName: string,
  server: MCPServerConfig,
  isTrusted: boolean,
  activeSettings: MergedSettings,
): Promise<MCPServerStatus> {
  const { canLoadServer, McpServerEnablementManager, normalizeServerId } =
    await import('../../config/mcp/index.js');
  const mcpEnablementManager = McpServerEnablementManager.getInstance();
  const loadResult = await canLoadServer(serverName, {
    allowedList: activeSettings.mcp?.allowed,
    excludedList: activeSettings.mcp?.excluded,
    enablement: {
      isSessionDisabled: (id) => mcpEnablementManager.isSessionDisabled(id),
      isFileEnabled: async (id) => {
        const configured = Object.entries(activeSettings.mcpServers).find(
          ([name]) => normalizeServerId(name) === normalizeServerId(id),
        );
        return configured?.[1].disabled !== true;
      },
    },
    serverDisabled: server.disabled,
  });

  if (!loadResult.allowed) {
    if (
      loadResult.blockType === 'allowlist' ||
      loadResult.blockType === 'excludelist'
    ) {
      return MCPServerStatus.BLOCKED;
    }
    return MCPServerStatus.DISABLED;
  }

  // Test all server types by attempting actual connection
  return testMCPConnection(serverName, server, isTrusted, activeSettings);
}

export interface McpCommandContext {
  readonly settings: MergedSettings;
  readonly isTrusted: boolean;
  readonly mcpServers: Record<string, MCPServerConfig>;
}

export async function loadMcpCommandContext(
  settingSources?: readonly SettingSource[],
  validator?: McpCommandOptions['projectConfigValidator'],
): Promise<McpCommandContext> {
  const { getFlagSettingsInput, restoreLoadedEnvironment } = await import(
    '../../config/settings.js'
  );
  // Command discovery already loaded legacy .env values. Reapply only the
  // environment permitted by this command's sources and project trust.
  restoreLoadedEnvironment();
  const service = await createCliSettingsService();
  const {
    merged: settings,
    isTrusted,
    errors,
  } = service.resolve({
    projectPath: process.cwd(),
    sources: settingSources,
    flagSettings: getFlagSettingsInput(),
  });
  for (const error of errors)
    runLogger.warn(`Error in ${error.path}: ${error.message}`);

  return {
    settings,
    isTrusted,
    mcpServers: await getMcpServersFromConfig(settings, validator),
  };
}

export async function listMcpServers(
  settingSources?: readonly SettingSource[],
  validator?: McpCommandOptions['projectConfigValidator'],
): Promise<void> {
  const chalk = (await import('chalk')).default;
  const {
    mcpServers,
    settings: activeSettings,
    isTrusted,
  } = await loadMcpCommandContext(settingSources, validator);
  const serverNames = Object.keys(mcpServers);

  if (serverNames.length === 0) {
    process.stdout.write('No MCP servers configured.\n');
    return;
  }

  process.stdout.write('Configured MCP servers:\n\n');

  for (const serverName of serverNames) {
    const server = mcpServers[serverName];

    const status = await getServerStatus(
      serverName,
      server,
      isTrusted,
      activeSettings,
    );

    let statusIndicator = '';
    let statusText = '';
    switch (status) {
      case MCPServerStatus.CONNECTED:
        statusIndicator = chalk.green('✓');
        statusText = 'Connected';
        break;
      case MCPServerStatus.CONNECTING:
        statusIndicator = chalk.yellow('…');
        statusText = 'Connecting';
        break;
      case MCPServerStatus.BLOCKED:
        statusIndicator = chalk.red('⛔');
        statusText = 'Blocked';
        break;
      case MCPServerStatus.DISABLED:
        statusIndicator = chalk.gray('○');
        statusText = 'Disabled';
        break;
      case MCPServerStatus.DISCONNECTED:
      default:
        if (mcpServerRequiresOAuth.has(serverName)) {
          statusIndicator = chalk.yellow('🔑');
          statusText = 'Needs authentication';
        } else {
          statusIndicator = chalk.red('✗');
          statusText = 'Disconnected';
        }
        break;
    }

    let serverInfo =
      serverName +
      (server.plugin?.name ? ` (from ${server.plugin.name})` : '') +
      ': ';
    if (server.url) {
      const type = server.type || 'http';
      const expandedUrl = expandMcpEnvVars(server.url, process.env);
      serverInfo += `${expandedUrl} (${type})`;
    } else if (server.command) {
      serverInfo += `${server.command} ${server.args?.join(' ') || ''} (stdio)`;
    }

    const connectionInfo =
      status === MCPServerStatus.CONNECTED ? ' · Direct MCP Server' : '';
    process.stdout.write(
      `${statusIndicator} ${serverInfo} - ${statusText}${connectionInfo}\n`,
    );
  }
}

export function createListCommand(commandOptions: McpCommandOptions = {}) {
  return new Command('list')
    .description('List all configured MCP servers')
    .action(async (_options, command) => {
      const { settingSources: rawSources } = command.optsWithGlobals() as {
        settingSources?: string[];
      };
      const settingSources = rawSources
        ?.flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter((value): value is SettingSource =>
          ['user', 'project', 'local'].includes(value),
        );
      const { exitCli } = await import('../../utils/exitCli.js');
      await listMcpServers(
        settingSources,
        commandOptions.projectConfigValidator,
      );
      await exitCli();
    });
}
