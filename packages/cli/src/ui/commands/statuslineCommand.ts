/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  OpenDialogActionReturn,
  SlashCommand,
  SubmitPromptActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

export const statuslineCommand: SlashCommand = {
  name: 'statusline',
  get description() {
    return t("Set up Qwen Code's status line UI");
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (
    context,
    args,
  ): OpenDialogActionReturn | SubmitPromptActionReturn => {
    const prompt = args.trim();
    if (!prompt) {
      return {
        type: 'dialog',
        dialog: 'statusline',
      };
    }

    return {
      type: 'submit_prompt',
      content: [
        {
          text: `Use the Agent tool with subagent_type: "statusline-setup" and this prompt:\n\n${prompt}`,
        },
      ],
      onComplete: async () => {
        context.services.settings.reloadScopeFromDisk(SettingScope.User);
        context.ui.notifyStatusLineReloaded?.();
      },
    };
  },
};
