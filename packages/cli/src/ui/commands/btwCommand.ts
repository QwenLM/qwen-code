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
import type { GeminiClient } from '@qwen-code/qwen-code-core';

/**
 * Helper to make the ephemeral generateContent call and extract the answer.
 * Uses a snapshot of the current conversation history as context.
 */
async function askBtw(
  geminiClient: GeminiClient,
  model: string,
  question: string,
  abortSignal: AbortSignal,
): Promise<string> {
  const history = geminiClient.getHistory();

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
    abortSignal,
    model,
  );

  const parts = response.candidates?.[0]?.content?.parts;
  return (
    parts
      ?.map((part) => part.text)
      .filter((text): text is string => typeof text === 'string')
      .join('') || t('No response received.')
  );
}

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
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal ?? new AbortController().signal;

    if (!question) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Please provide a question. Usage: /btw <your question>'),
      };
    }

    const { config } = context.services;
    const { ui } = context;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const geminiClient = config.getGeminiClient();
    const model = config.getModel();

    // ACP mode: return a stream_messages async generator
    if (executionMode === 'acp') {
      const messages = async function* () {
        try {
          yield {
            messageType: 'info' as const,
            content: t('Thinking...'),
          };

          const answer = await askBtw(
            geminiClient,
            model,
            question,
            abortSignal,
          );

          yield {
            messageType: 'info' as const,
            content: `btw> ${question}\n${answer}`,
          };
        } catch (error) {
          yield {
            messageType: 'error' as const,
            content: t('Failed to answer btw question: {{error}}', {
              error: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      };

      return { type: 'stream_messages', messages: messages() };
    }

    // Non-interactive mode: return a simple message result
    if (executionMode === 'non_interactive') {
      try {
        const answer = await askBtw(geminiClient, model, question, abortSignal);
        return {
          type: 'message',
          messageType: 'info',
          content: `btw> ${question}\n${answer}`,
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Failed to answer btw question: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    // Interactive mode: use pending item for spinner, then add to UI history
    if (ui.pendingItem) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Another operation is in progress. Please wait for it to complete.',
        ),
      };
    }

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
      const answer = await askBtw(geminiClient, model, question, abortSignal);

      if (abortSignal.aborted) {
        return;
      }

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
      if (abortSignal.aborted) {
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
