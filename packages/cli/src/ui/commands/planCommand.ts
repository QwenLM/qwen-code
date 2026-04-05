/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
  type MessageActionReturn,
  type SubmitPromptActionReturn,
} from './types.js';
import { t } from '../../i18n/index.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';

export const planCommand: SlashCommand = {
  name: 'plan',
  get description() {
    return t('Switch to plan mode or execute the current plan');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn | SubmitPromptActionReturn> => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration is not available.'),
      };
    }

    const trimmedArgs = args.trim();
    const currentMode = config.getApprovalMode();

    if (trimmedArgs === 'execute') {
      if (currentMode !== ApprovalMode.PLAN) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Not in plan mode. Use "/plan" to enter plan mode first.'),
        };
      }
      try {
        config.setApprovalMode(ApprovalMode.DEFAULT);
      } catch (e) {
        return {
          type: 'message',
          messageType: 'error',
          content: (e as Error).message,
        };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: t('Exited plan mode. The agent will now execute the plan.'),
      };
    }

    if (currentMode !== ApprovalMode.PLAN) {
      try {
        config.setApprovalMode(ApprovalMode.PLAN);
      } catch (e) {
        return {
          type: 'message',
          messageType: 'error',
          content: (e as Error).message,
        };
      }

      if (trimmedArgs) {
        return {
          type: 'submit_prompt',
          content: [{ text: trimmedArgs }],
        };
      }

      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Enabled plan mode. The agent will analyze and plan without executing tools.',
        ),
      };
    }

    // Already in plan mode
    if (trimmedArgs) {
      return {
        type: 'submit_prompt',
        content: [{ text: trimmedArgs }],
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'Already in plan mode. Use "/plan execute" to execute the plan.',
      ),
    };
  },
};
