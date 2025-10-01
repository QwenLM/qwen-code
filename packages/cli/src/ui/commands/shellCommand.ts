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

    // if s is windows, and command is "cd some_dir" command, then append "&& cd" to the command
    const isWindows = process.platform === 'win32';
    let finalCommand = command;
    if (finalCommand.trim().startsWith('cd ')) {
      const dir = finalCommand.trim().slice(3).trim();
      if (dir) {
        if (isWindows) {
          // Append '&& cd' to get current directory after command execution
          finalCommand += ` && cd`;
        } else {
          // For Unix-like systems, use 'pwd' to get current directory
          finalCommand += ` && pwd`;
        }
      }
    }

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
