/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  runManagedAutoMemoryDream,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';

export const dreamCommand: SlashCommand = {
  name: 'dream',
  get description() {
    return t('Consolidate managed auto-memory topic files.');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const result = await runManagedAutoMemoryDream(config.getProjectRoot());
    return {
      type: 'message',
      messageType: 'info',
      content: result.systemMessage
        ? `${result.systemMessage}\n${t('Deduplicated entries: {{count}}', {
            count: String(result.dedupedEntries),
          })}`
        : t('Managed auto-memory dream found nothing to improve.'),
    };
  },
};