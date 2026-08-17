/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { isValidSessionId } from '../../config/config.js';
import { t } from '../../i18n/index.js';
import {
  AGENT_VIEW_WORKER_RESUME_MESSAGE,
  isAgentViewWorkerResumeCommandBlocked,
  isManagedAgentViewResumeBlocked,
  MANAGED_AGENT_VIEW_RESUME_MESSAGE,
} from '../../startup/agent-view-resume-guard.js';
import { getAgentViewProjectSessionService } from '../../startup/agent-view-resume-sessions.js';

export const resumeCommand: SlashCommand = {
  name: 'resume',
  altNames: ['continue'],
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  get description() {
    return t('Resume a previous session');
  },
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    if (isAgentViewWorkerResumeCommandBlocked()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(AGENT_VIEW_WORKER_RESUME_MESSAGE),
      };
    }

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
      if (await isManagedAgentViewResumeBlocked(arg)) {
        return {
          type: 'message',
          messageType: 'error',
          content: MANAGED_AGENT_VIEW_RESUME_MESSAGE,
        };
      }
      const sessionService = config.getSessionService();
      const exists =
        (await sessionService.sessionExists(arg)) ||
        Boolean(await getAgentViewProjectSessionExists(arg));
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

async function getAgentViewProjectSessionExists(
  sessionId: string,
): Promise<boolean> {
  const sessionService = await getAgentViewProjectSessionService();
  return sessionService ? sessionService.sessionExists(sessionId) : false;
}
