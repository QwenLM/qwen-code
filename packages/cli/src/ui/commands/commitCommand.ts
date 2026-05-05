/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { t } from '../../i18n/index.js';

export const commitCommand: SlashCommand = {
  name: 'commit',
  altNames: ['ci'],
  get description() {
    return t(
      'Create a git commit with the given message. Stages all changes automatically.',
    );
  },
  kind: CommandKind.BUILT_IN,
  argumentHint: '<message>',
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    _context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const trimmed = args.trim();

    if (!trimmed) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Commit message required. Usage: /commit <message>'),
      };
    }

    // Escape double quotes in the message for the shell command.
    const escapedMessage = trimmed.replace(/"/g, '\\"');

    return {
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        description: t('Stage all changes and commit'),
        command: `git add -A && git commit -m "${escapedMessage}"`,
        is_background: false,
      },
    };
  },
};
