/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { SessionService } from '@qwen-code/qwen-code-core';
import { resumeIntoSession } from './resumeSessionHelper.js';

export const resumeCommand: SlashCommand = {
  name: 'resume',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Resume a previous session');
  },
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const sessionId = args?.trim();

    // No session ID provided — open the session picker dialog
    if (!sessionId) {
      return { type: 'dialog', dialog: 'resume' };
    }

    // Session ID provided — resume directly
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No active configuration.'),
      };
    }

    const cwd = config.getTargetDir();
    const sessionService = new SessionService(cwd);
    const sessionData = await sessionService.loadSession(sessionId);

    if (!sessionData) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(`Session not found: ${sessionId}`),
      };
    }

    await resumeIntoSession(context, config, sessionId, sessionData);

    context.ui.addItem(
      {
        type: 'info',
        text: t(`Resumed session ${sessionId}`),
      },
      Date.now(),
    );
  },
};
