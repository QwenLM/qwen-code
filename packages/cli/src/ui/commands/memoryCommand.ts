/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { createShowMemoryAction } from '../hooks/useShowMemoryCommand.js';
import { MessageType } from '../types.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  argumentHint: '[show|migrate-team]',
  get description() {
    return t('Open the memory manager.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (context, args) => {
    const action = args.trim();
    if (!action) {
      return { type: 'dialog', dialog: 'memory' };
    }
    if (action === 'show') {
      await createShowMemoryAction(
        context.services.config,
        context.services.settings,
        (message) => {
          if (
            message.type !== MessageType.INFO &&
            message.type !== MessageType.ERROR
          ) {
            return;
          }
          context.ui.addItem(
            {
              type: message.type,
              text: sanitizeTerminalText(message.content),
            },
            message.timestamp.getTime(),
          );
        },
      )();
      return;
    }
    if (action !== 'migrate-team') {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /memory [show|migrate-team]'),
      };
    }
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }
    if (!config.getTeamMemoryEnabled() || !config.isTrustedFolder()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Team memory migration requires enabled team memory in a trusted project.',
        ),
      };
    }
    const result = await config.getMemoryManager().scheduleMetadataMigration({
      projectRoot: config.getProjectRoot(),
      scope: 'team',
      config,
    });
    if (result.status === 'skipped') {
      return {
        type: 'message',
        messageType: 'info',
        content:
          result.skippedReason === 'complete'
            ? t('Team memory metadata is already complete.')
            : t('Team memory migration was not started: {{reason}}', {
                reason: result.skippedReason ?? 'unknown',
              }),
      };
    }
    return {
      type: 'message',
      messageType: 'info',
      content: t('Team memory migration started (task {{taskId}}).', {
        taskId: result.taskId ?? 'unknown',
      }),
    };
  },
};
