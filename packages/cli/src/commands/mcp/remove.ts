/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp remove' command
import type { CommandModule } from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { MCPOAuthTokenStorage } from '@qwen-code/qwen-code-core';

async function removeMcpServer(
  name: string,
  options: {
    scope: string;
  },
) {
  const { scope } = options;
  const settingsScope =
    scope === 'user' ? SettingScope.User : SettingScope.Workspace;
  const settings = loadSettings();

  const existingSettings = settings.forScope(settingsScope).settings;
  const mcpServers = existingSettings.mcpServers || {};

  if (!mcpServers[name]) {
    writeStdoutLine(`Server "${name}" not found in ${scope} settings.`);
    return;
  }

  delete mcpServers[name];

  settings.setValue(settingsScope, 'mcpServers', mcpServers);

  // Clean up any stored OAuth tokens for this server
  try {
    const tokenStorage = new MCPOAuthTokenStorage();
    await tokenStorage.deleteCredentials(name);
  } catch {
    // Token cleanup is best-effort; don't fail the remove operation
  }

  writeStdoutLine(`Server "${name}" removed from ${scope} settings.`);
}

export const removeCommand: CommandModule = {
  command: 'remove <name>',
  describe: 'Remove a server',
  builder: (yargs) =>
    yargs
      .usage('Usage: qwen mcp remove [options] <name>')
      .positional('name', {
        describe: 'Name of the server',
        type: 'string',
        demandOption: true,
      })
      .option('scope', {
        alias: 's',
        describe: 'Configuration scope (user or project)',
        type: 'string',
        default: 'user',
        choices: ['user', 'project'],
      }),
  handler: async (argv) => {
    await removeMcpServer(argv['name'] as string, {
      scope: argv['scope'] as string,
    });
  },
};
