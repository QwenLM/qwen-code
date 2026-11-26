/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpCommandOptions } from './options.js';
import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import { BRAND_CLI_BIN } from '@qwen-code/core';
import { Command } from '@commander-js/extra-typings';
import { runTerminalCommand } from '../../app-plugins/commands.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

interface Args {
  name: string;
  session?: boolean;
}

async function handleEnable(
  args: Args,
  commandOptions: McpCommandOptions,
): Promise<void> {
  const provider = await commandOptions.getManagedResourcesProvider?.();
  const managed = (await provider?.readMcpServers())?.find(
    (resource) => resource.name === args.name,
  );
  if (managed && provider) {
    if (!managed.userVisible) throw new Error('MCP server is not available.');
    if (args.session)
      throw new Error(
        'Use the current session MCP control for enterprise session enablement.',
      );
    await provider.setMcpServerEnabled(managed, true);
    process.stdout.write(`MCP server '${managed.name}' enabled.\n`);
    return;
  }
  const { McpServerEnablementManager, canLoadServer, normalizeServerId } =
    await import('../../config/mcp/mcpServerEnablement.js');

  const { getMcpServersFromConfig } = await import('./list.js');
  const { persistentEnableMcpServer } = await import(
    '../../config/localSettings.js'
  );
  const manager = McpServerEnablementManager.getInstance();
  const name = normalizeServerId(args.name);

  const settings = await resolveCommandSettings();

  // Get all servers including extensions
  const mcpServers = await getMcpServersFromConfig(
    settings.merged,
    commandOptions.projectConfigValidator,
  );
  const normalizedServerNames = Object.keys(mcpServers).map(normalizeServerId);
  if (!normalizedServerNames.includes(name)) {
    process.stderr.write(
      `${RED}Error:${RESET} Server '${args.name}' not found. Use '${BRAND_CLI_BIN} mcp' to see available servers.\n`,
    );
    return;
  }

  const result = await canLoadServer(name, {
    allowedList: settings.merged.mcp?.allowed,
    excludedList: settings.merged.mcp?.excluded,
  });

  if (
    !result.allowed &&
    (result.blockType === 'allowlist' || result.blockType === 'excludelist')
  ) {
    process.stderr.write(`${RED}Error:${RESET} ${result.reason}\n`);
    return;
  }

  if (args.session) {
    manager.clearSessionDisable(name);
    process.stdout.write(
      `${GREEN}✓${RESET} Session disable cleared for '${name}'.\n`,
    );
  } else {
    await persistentEnableMcpServer(
      name,
      process.cwd(),
      settings,
      commandOptions.projectConfigValidator,
    );
    process.stdout.write(`${GREEN}✓${RESET} MCP server '${name}' enabled.\n`);
  }
}

export function createEnableCommand(commandOptions: McpCommandOptions = {}) {
  const command = new Command('enable')
    .description('Enable an MCP server')
    .argument('<name>', 'MCP server name to enable')
    .option('--session', 'Clear session-only disable', false);
  command.action(async (name, options) => {
    const action = async () => {
      await handleEnable({ name, session: options.session }, commandOptions);
      return { exitCode: 0 };
    };
    if (commandOptions.getManagedResourcesProvider) {
      await runTerminalCommand(command, action, { components: 'local' });
    } else {
      await action();
      const { exitCli } = await import('../../utils/exitCli.js');
      await exitCli();
    }
  });
  return command;
}
