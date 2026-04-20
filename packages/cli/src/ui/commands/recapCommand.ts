/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type SlashCommand,
  type CommandContext,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { generateSessionRecap } from '@qwen-code/qwen-code-core';
import type { HistoryItemAwayRecap } from '../types.js';
import { t } from '../../i18n/index.js';

export const recapCommand: SlashCommand = {
  name: 'recap',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Generate a one-line session recap now');
  },
  action: async (
    context: CommandContext,
  ): Promise<void | SlashCommandActionReturn> => {
    const { config } = context.services;
    const abortSignal = context.abortSignal ?? new AbortController().signal;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    if (context.executionMode === 'interactive') {
      const turnInFlight =
        !context.ui.isIdleRef.current || context.ui.pendingItem !== null;
      if (turnInFlight) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Cannot run /recap while another operation is in progress.',
          ),
        };
      }
    }

    const recap = await generateSessionRecap(config, abortSignal);

    if (abortSignal.aborted) return;

    if (!recap) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('Not enough conversation context for a recap yet.'),
      };
    }

    if (context.executionMode === 'interactive') {
      const item: HistoryItemAwayRecap = {
        type: 'away_recap',
        text: recap.text,
      };
      context.ui.setAwayRecapItem(item);
      return;
    }

    return { type: 'message', messageType: 'info', content: recap.text };
  },
};
