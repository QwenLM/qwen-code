/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp disable' command
import type { CommandModule } from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

async function disableMcpServer(
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
  const excluded = existingSettings.mcp?.excluded || [];

  if (excluded.includes(name)) {
    writeStdoutLine(
      `Server "${name}" is already disabled in ${scope} settings.`,
    );
    return;
  }

  settings.setValue(settingsScope, 'mcp.excluded', [...excluded, name]);
  writeStdoutLine(`Server "${name}" disabled in ${scope} settings.`);
}

export const disableCommand: CommandModule = {
  command: 'disable <name>',
  describe: 'Disable a server by adding it to mcp.excluded',
  builder: (yargs) =>
    yargs
      .usage('Usage: qwen mcp disable [options] <name>')
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
    await disableMcpServer(argv['name'] as string, {
      scope: argv['scope'] as string,
    });
  },
};
