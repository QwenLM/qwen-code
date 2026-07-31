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
import {
  BTW_MAX_INPUT_LENGTH,
  buildBtwCacheSafeParams,
  buildBtwPrompt,
  runForkedAgent,
} from '@qwen-code/qwen-code-core';

function formatBtwError(error: unknown): string {
  return t('Failed to answer btw question: {{error}}', {
    error:
      error instanceof Error ? error.message : String(error || 'Unknown error'),
  });
}

function getBtwCacheSafeParams(context: CommandContext) {
  const { config } = context.services;
  if (config) {
    return buildBtwCacheSafeParams(config);
  }
  return null;
}

/**
 * Run a side question using runForkedAgent (cache path).
 *
 * runForkedAgent with cacheSafeParams shares the main conversation's
 * CacheSafeParams (systemInstruction + history) so the fork sees the full
 * conversation context and benefits from prompt-cache hits. Tools are denied
 * at the per-request level (NO_TOOLS) — single-turn, text-only.
 */
async function askBtw(
  context: CommandContext,
  question: string,
  abortSignal: AbortSignal,
): Promise<string> {
  const { config } = context.services;
  if (!config) throw new Error('Config not loaded');

  const cacheSafeParams = getBtwCacheSafeParams(context);
  if (!cacheSafeParams)
    throw new Error(t('No conversation context available for /btw'));

  const result = await runForkedAgent({
    config,
    userMessage: buildBtwPrompt(question),
    cacheSafeParams,
    abortSignal,
  });

  return result.text || t('No response received.');
}

export const btwCommand: SlashCommand = {
  name: 'btw',
  get description() {
    return t(
      'Ask a quick side question without affecting the main conversation',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
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

    if (question.length > BTW_MAX_INPUT_LENGTH) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Question too long (max {{max}} chars)', {
          max: String(BTW_MAX_INPUT_LENGTH),
        }),
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

    const model = config.getModel();
    if (!model) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No model configured.'),
      };
    }

    const executionMode = context.executionMode ?? 'interactive';
    if (executionMode !== 'interactive') {
      try {
        const answer = await askBtw(
          context,
          question,
          context.abortSignal ?? new AbortController().signal,
        );
        return { type: 'message', messageType: 'info', content: answer };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: formatBtwError(error),
        };
      }
    }

    // Interactive mode: use dedicated btwItem state for the fixed bottom area.
    // This does NOT occupy pendingItem, so the main conversation is never blocked.
    // Cancel any previous in-flight btw before starting a new one.
    ui.cancelBtw();

    const btwAbortController = new AbortController();
    const btwSignal = btwAbortController.signal;
    ui.btwAbortControllerRef.current = btwAbortController;

    const pendingItem: HistoryItemBtw = {
      type: MessageType.BTW,
      btw: {
        question,
        answer: '',
        isPending: true,
      },
    };
    ui.setBtwItem(pendingItem);

    // Fire-and-forget: runForkedAgent runs in the background so the main
    // conversation is not blocked while waiting for the btw answer.
    void askBtw(context, question, btwSignal)
      .then((answer) => {
        if (btwSignal.aborted) return;

        ui.btwAbortControllerRef.current = null;
        const completedItem: HistoryItemBtw = {
          type: MessageType.BTW,
          btw: {
            question,
            answer,
            isPending: false,
          },
        };
        ui.setBtwItem(completedItem);
      })
      .catch((error) => {
        if (btwSignal.aborted) return;

        ui.btwAbortControllerRef.current = null;
        ui.setBtwItem(null);
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: formatBtwError(error),
          },
          Date.now(),
        );
      });
  },
};
