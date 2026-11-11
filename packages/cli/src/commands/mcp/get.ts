/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp get' command
import type { McpCommandOptions } from './options.js';
import { Command, Option } from '@commander-js/extra-typings';
import {
  BRAND_CLI_BIN,
  MCPServerStatus,
  runLogger,
  type MCPServerConfig,
  expandMcpEnvVars,
  mcpServerRequiresOAuth,
} from '@qwen-code/core';
import { createCliSettingsService } from '../../config/createCliSettingsService.js';
import type { MergedSettings, SettingSource } from '../../config/settings.js';

type Scope = 'user' | 'local' | 'project';

// Search local first (personal overrides), then project (.mcp.json), then user.
const SEARCH_ORDER: readonly Scope[] = ['local', 'project', 'user'] as const;

function scopeLabel(scope: Scope): string {
  switch (scope) {
    case 'local':
      return 'Local config (private to you in this project)';
    case 'project':
      return 'Project config (shared in this project)';
    case 'user':
      return 'User config (available in all your projects)';
    default:
      return scope;
  }
}

async function statusToText(
  status: MCPServerStatus,
  serverName: string,
): Promise<string> {
  const chalk = (await import('chalk')).default;
  switch (status) {
    case MCPServerStatus.CONNECTED:
      return `${chalk.green('✓')} Connected`;
    case MCPServerStatus.CONNECTING:
      return `${chalk.yellow('…')} Connecting`;
    case MCPServerStatus.BLOCKED:
      return `${chalk.red('⛔')} Blocked`;
    case MCPServerStatus.DISABLED:
      return `${chalk.gray('○')} Disabled`;
    case MCPServerStatus.DISCONNECTED:
    default:
      if (mcpServerRequiresOAuth.has(serverName)) {
        return `${chalk.yellow('🔑')} Needs authentication`;
      }
      return `${chalk.red('✗')} Disconnected`;
  }
}

async function printSummary(
  name: string,
  scope: Scope,
  server: MCPServerConfig,
  location: string,
  settings: MergedSettings,
  isTrusted: boolean,
): Promise<void> {
  const { getServerStatus } = await import('./list.js');
  const status = await getServerStatus(name, server, isTrusted, settings);

  const lines: string[] = [];
  lines.push(`${name}:`);
  lines.push(`  Scope: ${scopeLabel(scope)}`);
  lines.push(`  Location: ${location}`);
  lines.push(`  Status: ${await statusToText(status, name)}`);

  const type = server.type ?? (server.command ? 'stdio' : 'http');
  lines.push(`  Type: ${type}`);
  if (status === MCPServerStatus.CONNECTED) {
    lines.push(`  Connection: Direct MCP Server`);
  }

  if (type === 'sse' || type === 'http') {
    if (server.url) {
      const expandedUrl = expandMcpEnvVars(server.url, process.env);
      lines.push(`  URL: ${expandedUrl}`);
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push('  Headers:');
      for (const [k, v] of Object.entries(server.headers)) {
        lines.push(`    ${k}: ${expandMcpEnvVars(v, process.env)}`);
      }
    }
    if (server.oauth) {
      const parts: string[] = [];
      if (server.oauth.clientId) parts.push('client_id configured');
      if (server.oauth.clientSecret) parts.push('client_secret configured');
      if (server.oauth.callbackPort !== undefined) {
        parts.push(`callback_port ${server.oauth.callbackPort}`);
      }
      if (parts.length > 0) {
        lines.push(`  OAuth: ${parts.join(', ')}`);
      }
    }
  } else {
    if (server.command) lines.push(`  Command: ${server.command}`);
    const args = Array.isArray(server.args) ? server.args : [];
    lines.push(`  Args: ${args.join(' ')}`);
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push('  Environment:');
      for (const [k, v] of Object.entries(server.env)) {
        lines.push(`    ${k}=${v}`);
      }
    }
  }

  lines.push('');
  lines.push(
    `To remove this server, run: ${BRAND_CLI_BIN} mcp remove "${name}" -s ${scope}`,
  );

  process.stdout.write(`${lines.join('\n')}\n`);
}

function printJson(name: string, server: MCPServerConfig): void {
  process.stdout.write(`${JSON.stringify({ [name]: server }, null, 2)}\n`);
}

export interface ResolvedMcpServer {
  readonly name: string;
  readonly scope: Scope;
  readonly server: MCPServerConfig;
  readonly location: string;
  readonly settings: MergedSettings;
  readonly isTrusted: boolean;
}

export async function resolveMcpServerForCommand(
  name: string,
  options: {
    scope: string | undefined;
    settingSources?: readonly SettingSource[];
    projectConfigValidator?: McpCommandOptions['projectConfigValidator'];
  },
): Promise<ResolvedMcpServer | undefined> {
  const cwd = process.cwd();
  const { getFlagSettingsInput, restoreLoadedEnvironment } = await import(
    '../../config/settings.js'
  );
  const { loadProjectMcpJson, getProjectMcpJsonPath } = await import(
    '../../config/mcp/projectMcpJson.js'
  );
  restoreLoadedEnvironment();
  const service = await createCliSettingsService();
  const loaded = service.resolve({
    projectPath: cwd,
    sources: options.settingSources,
    flagSettings: getFlagSettingsInput(),
  });
  for (const error of loaded.errors)
    runLogger.warn(`Error in ${error.path}: ${error.message}`);

  // Preserve scope lookup rather than selecting from the merged runtime view.
  // Project .mcp.json remains independent of settings source selection.
  for (const candidate of options.scope
    ? [options.scope as Scope]
    : SEARCH_ORDER) {
    const servers = {
      ...loaded[candidate].settings.mcpServers,
      ...(candidate === 'project'
        ? loadProjectMcpJson(cwd, options.projectConfigValidator)
        : {}),
    };
    if (servers[name]) {
      return {
        name,
        scope: candidate,
        server: servers[name] as MCPServerConfig,
        location:
          candidate === 'project'
            ? getProjectMcpJsonPath(cwd)
            : loaded[candidate].path,
        settings: loaded.merged,
        isTrusted: loaded.isTrusted,
      };
    }
  }
  return undefined;
}

async function getMcpServer(
  name: string,
  options: {
    scope: string | undefined;
    json: boolean;
    settingSources?: readonly SettingSource[];
    projectConfigValidator?: McpCommandOptions['projectConfigValidator'];
  },
) {
  const resolved = await resolveMcpServerForCommand(name, options);
  if (!resolved) {
    process.stdout.write(
      `Server "${name}" not found in ${options.scope ?? 'any'} settings.\n`,
    );
    return;
  }

  if (options.json) {
    printJson(name, resolved.server);
    return;
  }

  await printSummary(
    name,
    resolved.scope,
    resolved.server,
    resolved.location,
    resolved.settings,
    resolved.isTrusted,
  );
}

export function createGetCommand(commandOptions: McpCommandOptions = {}) {
  return new Command('get')
    .description(
      'Get details about an MCP server. Prints a summary of the final effective configuration by default.',
    )
    .argument('<name>', 'Name of the server')
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'Only look up the server in a specific scope (user, local, or project). Defaults to the first scope the server is defined in.',
      ).choices(['user', 'local', 'project'] as const),
    )
    .option(
      '--json',
      'Print the raw stored config for the server as JSON instead of the summary view',
      false,
    )
    .action(async (name, options, command) => {
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
      await getMcpServer(name, {
        projectConfigValidator: commandOptions.projectConfigValidator,
        scope: options.scope,
        json: options.json,
        settingSources,
      });
      await exitCli();
    });
}
