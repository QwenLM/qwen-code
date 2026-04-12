/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { isValidSessionId } from '../../config/config.js';
import { t } from '../../i18n/index.js';

export const resumeCommand: SlashCommand = {
  name: 'resume',
  altNames: ['continue'],
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Resume a previous session');
  },
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const arg = args.trim();

    // No argument — show picker
    if (!arg) {
      return { type: 'dialog', dialog: 'resume' };
    }

    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config is not available.'),
      };
    }

    // Try as session UUID
    if (isValidSessionId(arg)) {
      const sessionService = config.getSessionService();
      const exists = await sessionService.sessionExists(arg);
      if (exists) {
        return { type: 'dialog', dialog: 'resume', sessionId: arg };
      }
      return {
        type: 'message',
        messageType: 'error',
        content: t('No session found with ID "{{id}}".', { id: arg }),
      };
    }

    // Try as custom title
    const sessionService = config.getSessionService();
    const matches = await sessionService.findSessionsByTitle(arg);

    if (matches.length === 1) {
      return {
        type: 'dialog',
        dialog: 'resume',
        sessionId: matches[0].sessionId,
      };
    }

    if (matches.length > 1) {
      // Multiple matches — show picker with only the matching sessions
      return { type: 'dialog', dialog: 'resume', matchedSessions: matches };
    }

    return {
      type: 'message',
      messageType: 'error',
      content: t('No session found with title "{{title}}".', { title: arg }),
    };
  },
};
