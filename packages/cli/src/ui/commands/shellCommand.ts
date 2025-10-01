/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  type ToolActionReturn,
  CommandKind,
} from './types.js';

export const shellCommand: SlashCommand = {
  name: 'shell',
  description: 'run any shell command directly',
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args?: string,
  ): Promise<ToolActionReturn> => {
    const command = (args || '').trim();

    if (!command) {
      return {
        type: 'tool',
        toolName: 'run_shell_command',
        toolArgs: {
          command: 'echo "Usage: /shell <command>"',
          description: 'Show shell command usage',
          is_background: false,
        },
      };
    }

    let finalCommand = command;

    return {
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        command: finalCommand,
        description: `Execute shell command: ${finalCommand}`,
        is_background: false,
      },
    };
  },
};
