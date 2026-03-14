/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import type { HistoryItemBtw } from '../types.js';
import { t } from '../../i18n/index.js';

export const btwCommand: SlashCommand = {
  name: 'btw',
  get description() {
    return t(
      'Ask a quick side question without affecting the main conversation',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const question = args.trim();

    if (!question) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Please provide a question. Usage: /btw <your question>'),
      };
    }

    const { config } = context.services;
    const { ui } = context;
    const abortSignal = context.abortSignal;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const geminiClient = config.getGeminiClient();
    if (!geminiClient) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No chat client available.'),
      };
    }

    // Guard against concurrent pending operations
    if (ui.pendingItem) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Another operation is in progress. Please wait for it to complete.',
        ),
      };
    }

    // Show pending state
    const pendingItem: HistoryItemBtw = {
      type: MessageType.BTW,
      btw: {
        question,
        answer: '',
        isPending: true,
      },
    };
    ui.setPendingItem(pendingItem);

    try {
      // Get current conversation history
      const history = geminiClient.getHistory();

      // Make an ephemeral generateContent call with the conversation context
      // but WITHOUT tools — the btw response is purely based on existing context
      const response = await geminiClient.generateContent(
        [
          ...history,
          {
            role: 'user',
            parts: [
              {
                text: `[Side question - answer briefly and concisely, this is a "by the way" question that doesn't need to be part of our main conversation]\n\n${question}`,
              },
            ],
          },
        ],
        {},
        abortSignal ?? new AbortController().signal,
        config.getModel(),
      );

      if (abortSignal?.aborted) {
        return;
      }

      // Extract the response text
      const parts = response.candidates?.[0]?.content?.parts;
      const answer =
        parts
          ?.map((part) => part.text)
          .filter((text): text is string => typeof text === 'string')
          .join('') || t('No response received.');

      // Clear pending and show the completed btw item
      const completedItem: HistoryItemBtw = {
        type: MessageType.BTW,
        btw: {
          question,
          answer,
          isPending: false,
        },
      };
      ui.addItem(completedItem, Date.now());
    } catch (error) {
      if (abortSignal?.aborted) {
        return;
      }

      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to answer btw question: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        },
        Date.now(),
      );
    } finally {
      ui.setPendingItem(null);
    }
  },
};
