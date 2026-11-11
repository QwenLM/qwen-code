/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, CommandContext } from './types.js';
import type { SubmitPromptActionReturn } from '@qwen-code/core';
import { CommandKind } from './types.js';

/**
 * The `/statusline` command.
 *
 * This is a "prompt" style command: it submits a prompt to the main agent
 * instructing it to spawn the `statusline-setup` sub-agent which reads
 * the user's shell configs, creates statusline scripts, and updates
 * settings.json.
 */
export const statuslineCommand: SlashCommand = {
  name: 'statusline',
  description:
    "Set up a custom status line. Uses a sub-agent to read your shell config and create a statusline script that's updated after each response.",
  kind: CommandKind.BUILT_IN,
  autoExecute: false,

  action: (
    context: CommandContext,
    args?: string,
  ): SubmitPromptActionReturn => {
    const prompt =
      args?.trim() || 'Configure my statusLine from my shell PS1 configuration';

    return {
      type: 'submit_prompt',
      content: [
        {
          text: `Please use the "statusline-setup" tool with the following request: "${prompt}"`,
        },
      ],
    };
  },
};
