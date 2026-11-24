/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  argumentHint: '[migrate-team]',
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
    if (action !== 'migrate-team') {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /memory migrate-team'),
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
