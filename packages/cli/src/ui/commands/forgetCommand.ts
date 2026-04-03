/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  forgetManagedAutoMemoryMatches,
  selectManagedAutoMemoryForgetCandidates,
} from '@qwen-code/qwen-code-core';
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
    const trimmedArgs = args.trim();
    const apply = trimmedArgs.startsWith('--apply ');
    const query = apply
      ? trimmedArgs.slice('--apply '.length).trim()
      : trimmedArgs;
    if (!query) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /forget [--apply] <memory text to remove>'),
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

    if (!apply) {
      const selection = await selectManagedAutoMemoryForgetCandidates(
        config.getProjectRoot(),
        query,
        { config },
      );
      return {
        type: 'message',
        messageType: 'info',
        content:
          selection.matches.length > 0
            ? [
                t('Forget preview (strategy={{strategy}}):', {
                  strategy: selection.strategy,
                }),
                ...(selection.reasoning ? [selection.reasoning] : []),
                ...selection.matches.map(
                  (match, index) =>
                    `${index + 1}. ${match.topic}: ${match.summary}`,
                ),
                '',
                t('Run /forget --apply {{query}} to apply these removals.', {
                  query,
                }),
              ].join('\n')
            : t('No managed auto-memory entries matched: {{query}}', { query }),
      };
    }

    const selection = await selectManagedAutoMemoryForgetCandidates(
      config.getProjectRoot(),
      query,
      { config },
    );
    const result = await forgetManagedAutoMemoryMatches(
      config.getProjectRoot(),
      selection.matches,
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
