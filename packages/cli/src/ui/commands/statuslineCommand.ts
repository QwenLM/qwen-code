/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SubmitPromptActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const statuslineCommand: SlashCommand = {
  name: 'statusline',
  get description() {
    return t("Set up Qwen Code's status line UI");
  },
  kind: CommandKind.BUILT_IN,
  action: (_context, args): SubmitPromptActionReturn => {
    const prompt =
      args.trim() || 'Configure my statusLine from my shell PS1 configuration';
    return {
      type: 'submit_prompt',
      content: [
        {
          text: `Create an Agent with subagent_type "statusline-setup" and the following prompt:\n\n${prompt}`,
        },
      ],
    };
  },
};
