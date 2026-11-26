/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import type { AppPlugin } from '@qwen-code/cli';

type CommandDeclaration = Pick<AppPlugin, 'getTerminalCommands'>;

const FALLBACK_INSTALL = 'npm i -g @qwen-code/qwen-code@latest';

// 0.28 subcommands that scripts and hosted apps call directly. They are not
// on the new kernel yet, so they explain that instead of failing as unknown.
const UNSUPPORTED_COMMANDS = [
  {
    name: 'serve',
    description: 'Run the Qwen Code server (not supported yet)',
  },
  {
    name: 'channel',
    description: 'Manage messaging channels (not supported yet)',
  },
] as const;

function createUnsupportedCommand(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(() => {
      process.stderr.write(
        `\`qwen ${name}\` is not supported in this version yet. To keep using it, install the 0.28 release: ${FALLBACK_INSTALL}\n`,
      );
      process.exitCode = 1;
    });
}

export function createCommandDeclarations(): readonly CommandDeclaration[] {
  return [
    {
      getTerminalCommands: () =>
        UNSUPPORTED_COMMANDS.map(({ name, description }) =>
          createUnsupportedCommand(name, description),
        ),
    },
  ];
}
