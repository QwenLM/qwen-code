/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';

export const dreamCommand: SlashCommand = {
  name: 'dream',
  get description() {
    return t('Consolidate managed auto-memory topic files.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async (context) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    try {
      const result = await config
        .getMemoryManager()
        .runManualDream(config.getProjectRoot(), config, config.getSessionId());
      return {
        type: 'message',
        messageType: 'info',
        content: result.systemMessage ?? t('Dream completed.'),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to process /dream: {{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};
