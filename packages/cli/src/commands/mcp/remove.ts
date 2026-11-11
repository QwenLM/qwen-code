/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpCommandOptions } from './options.js';
import {
  resolveCommandSettings,
  type CommandSettings,
} from '../../config/createCliSettingsService.js';
// File for 'qwen mcp remove' command
import { Command, Option } from '@commander-js/extra-typings';
import {
  BRAND_CLI_BIN,
  MCPOAuthTokenStorage,
  sessionLogger,
  type MCPServerConfig,
} from '@qwen-code/core';

type Scope = 'user' | 'local' | 'project';

export interface RemoveMcpServerCommandOptions extends McpCommandOptions {
  /** Supply runtime auth ownership for the removed configuration. */
  prepareServerConfig?: (config: MCPServerConfig) => MCPServerConfig;
}

async function describeScopeLocation(
  scope: Scope,
  cwd: string,
  settings: CommandSettings,
): Promise<string> {
  const { getScopeSettingsPath } = await import(
    '../../config/localSettings.js'
  );
  const path = getScopeSettingsPath(scope, cwd, settings);
  switch (scope) {
    case 'user':
      return `User config (${path})`;
    case 'local':
      return `Local config (${path})`;
    case 'project':
      return `Project config (${path})`;
    default:
      return scope;
  }
}

// Cleanup uses the removed entry; historical environment values are unknown.
async function cleanupOauthCredentials(
  name: string,
  config: MCPServerConfig,
  prepareServerConfig?: RemoveMcpServerCommandOptions['prepareServerConfig'],
): Promise<void> {
  // Preserve the configured transport's existing cleanup eligibility.
  if (config.type !== 'http' && config.type !== 'sse') return;
  try {
    const runtimeConfig = prepareServerConfig?.(config) ?? config;
    await MCPOAuthTokenStorage.forServer(name, runtimeConfig).deleteCredentials(
      name,
    );
  } catch (err) {
    // Credential cleanup must not fail an already completed config removal.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Warning: failed to remove stored OAuth credentials for "${name}": ${message}\n`,
    );
  }
}

async function removeMcpServerCommand(
  name: string,
  options: {
    scope: string | undefined;
  },
  commandOptions: RemoveMcpServerCommandOptions,
) {
  const { scope } = options;
  const cwd = process.cwd();
  const settings = await resolveCommandSettings(cwd);
  const { removeMcpServer, findMcpServerScopes, getMcpServersByScope } =
    await import('../../config/localSettings.js');

  // Explicit scope: remove only from that scope, error if not present.
  if (scope) {
    const typedScope = scope as Scope;
    const mcpServers = getMcpServersByScope(
      typedScope,
      cwd,
      settings,
      commandOptions.projectConfigValidator,
    );

    if (!mcpServers[name]) {
      process.stderr.write(
        `Error: No MCP server found with name "${name}" in ${scope} config.\n`,
      );
      sessionLogger.setExitContext({
        reason: 'input_error',
        exit_code: 1,
        message: `No MCP server found with name "${name}" in ${scope} config`,
        source: 'mcp.remove',
      });
      process.exit(1);
    }

    for (const config of removeMcpServer(
      name,
      typedScope,
      cwd,
      settings,
      commandOptions.projectConfigValidator,
    )) {
      await cleanupOauthCredentials(
        name,
        config,
        commandOptions.prepareServerConfig,
      );
    }
    process.stdout.write(
      `Removed MCP server "${name}" from ${scope} config.\n`,
    );
    return;
  }

  // No scope specified: resolve by searching all scopes.
  const scopes = findMcpServerScopes(
    name,
    cwd,
    settings,
    commandOptions.projectConfigValidator,
  );

  if (scopes.length === 0) {
    process.stderr.write(`Error: No MCP server found with name "${name}".\n`);
    sessionLogger.setExitContext({
      reason: 'input_error',
      exit_code: 1,
      message: `No MCP server found with name "${name}"`,
      source: 'mcp.remove',
    });
    process.exit(1);
  }

  if (scopes.length === 1) {
    const foundScope = scopes[0];
    if (!foundScope) {
      process.stderr.write(`Error: No MCP server found with name "${name}".\n`);
      sessionLogger.setExitContext({
        reason: 'input_error',
        exit_code: 1,
        message: `No MCP server found with name "${name}" (empty scope)`,
        source: 'mcp.remove',
      });
      process.exit(1);
    }
    for (const config of removeMcpServer(
      name,
      foundScope,
      cwd,
      settings,
      commandOptions.projectConfigValidator,
    )) {
      await cleanupOauthCredentials(
        name,
        config,
        commandOptions.prepareServerConfig,
      );
    }
    process.stdout.write(
      `Removed MCP server "${name}" from ${foundScope} config.\n`,
    );
    return;
  }

  // Multiple scopes: list them and require the user to specify.
  const lines: string[] = [
    `Error: MCP server "${name}" exists in multiple scopes:`,
  ];
  for (const s of scopes) {
    lines.push(`  - ${await describeScopeLocation(s, cwd, settings)}`);
  }
  lines.push('');
  lines.push('To remove from a specific scope, use:');
  for (const s of scopes) {
    lines.push(`  ${BRAND_CLI_BIN} mcp remove "${name}" -s ${s}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
  sessionLogger.setExitContext({
    reason: 'input_error',
    exit_code: 1,
    message: `MCP server "${name}" exists in multiple scopes`,
    source: 'mcp.remove',
  });
  process.exit(1);
}

export function createRemoveCommand(
  options: RemoveMcpServerCommandOptions = {},
) {
  return new Command('remove')
    .description('Remove a server')
    .argument('<name>', 'Name of the server')
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'Configuration scope (user, local, or project). If not specified, removes from the scope the server is defined in; errors if it exists in multiple scopes.',
      ).choices(['user', 'local', 'project'] as const),
    )
    .action(async (name, commandOptions) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      await removeMcpServerCommand(
        name,
        { scope: commandOptions.scope },
        options,
      );
      await exitCli();
    });
}
