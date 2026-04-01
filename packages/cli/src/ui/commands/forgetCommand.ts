/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { forgetManagedAutoMemoryEntries } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';

export const forgetCommand: SlashCommand = {
  name: 'forget',
  get description() {
    return t('Remove matching entries from managed auto-memory.');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    const query = args.trim();
    if (!query) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /forget <memory text to remove>'),
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

    const result = await forgetManagedAutoMemoryEntries(
      config.getProjectRoot(),
      query,
    );
    return {
      type: 'message',
      messageType: 'info',
      content:
        result.systemMessage ??
        t('No managed auto-memory entries matched: {{query}}', { query }),
    };
  },
};
