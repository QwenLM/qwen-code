/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type AgentViewDetachActionReturn,
  type MessageActionReturn,
  type SlashCommand,
} from './types.js';
import { t } from '../../i18n/index.js';
import { readAgentViewWorkerSidebandEnv } from '../../agent-view/worker-sideband.js';
import { AGENT_VIEW_DISABLED_MESSAGE } from '../../agent-view/feature.js';
import {
  buildBackgroundWorkBlockedMessage,
  hasBlockingBackgroundWork,
} from '../utils/backgroundWorkUtils.js';

export const backgroundCommand: SlashCommand = {
  name: 'background',
  altNames: ['bg'],
  get description() {
    return t('Detach the current Agent View session.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context,
  ): Promise<AgentViewDetachActionReturn | MessageActionReturn> => {
    if (readAgentViewWorkerSidebandEnv() !== undefined) {
      return { type: 'agent_view_detach' };
    }

    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Cannot detach Agent View before configuration is loaded.'),
      };
    }
    if (!config.isAgentViewEnabled()) {
      return {
        type: 'message',
        messageType: 'error',
        content: AGENT_VIEW_DISABLED_MESSAGE,
      };
    }

    if (hasBlockingBackgroundWork(config)) {
      const message = t(
        "Stop the current session's running background tasks before detaching it.",
      );
      return {
        type: 'message',
        messageType: 'error',
        content: buildBackgroundWorkBlockedMessage(config, message),
      };
    }

    const idleGateState = context.ui.agentViewIdleGateStateRef?.current;
    if (idleGateState?.hasPendingUserQuestion) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Cannot detach Agent View while a question is waiting.'),
      };
    }

    if (idleGateState?.hasPendingToolConfirmation) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot detach Agent View while a tool confirmation is pending.',
        ),
      };
    }

    if (idleGateState?.hasPendingCommandConfirmation) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot detach Agent View while a command confirmation is pending.',
        ),
      };
    }

    if (idleGateState?.hasForegroundShell) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot detach Agent View while a foreground shell is active.',
        ),
      };
    }

    if (idleGateState?.hasBackgroundFocusDialog) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot detach Agent View while the background tasks dialog is open.',
        ),
      };
    }

    if (idleGateState?.hasQueuedPrompt) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Cannot detach Agent View while prompts are queued.'),
      };
    }

    if (!context.ui.isIdleRef.current) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Cannot detach Agent View while a turn is running.'),
      };
    }

    const sessionId = config.getSessionId();
    if (!(await config.getSessionService().sessionExists(sessionId))) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Cannot detach Agent View before the session is saved.'),
      };
    }

    return { type: 'agent_view_detach' };
  },
};
