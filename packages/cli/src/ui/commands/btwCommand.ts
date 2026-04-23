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
import { getCacheSafeParams, runForkedAgent } from '@qwen-code/qwen-code-core';

function formatBtwError(error: unknown): string {
  return t('Failed to answer btw question: {{error}}', {
    error:
      error instanceof Error ? error.message : String(error || 'Unknown error'),
  });
}

/**
 * Wrap the user's side question with constraints so the model knows it must
 * answer without tools in a single response.
 *
 * The system-reminder is embedded in the user message rather than overriding
 * systemInstruction, because runForkedAgent inherits systemInstruction from
 * CacheSafeParams (changing it would bust the prompt cache).
 */
function buildBtwPrompt(question: string): string {
  return [
    '<system-reminder>',
    'This is a side question from the user. Answer directly in a single response.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You have NO tools available — you cannot read files, run commands, or take any actions.',
    '- You can ONLY use information already present in the conversation context.',
    '- NEVER promise to look something up or investigate further.',
    '- If you do not know the answer, say so.',
    '- The main conversation is NOT interrupted; you are a separate, lightweight fork.',
    '</system-reminder>',
    '',
    question,
  ].join('\n');
}

function getBtwCacheSafeParams(
  context: CommandContext,
): ReturnType<typeof getCacheSafeParams> {
  const geminiClient = context.services.config?.getGeminiClient();
  if (
    geminiClient &&
    typeof geminiClient === 'object' &&
    typeof geminiClient.getChat === 'function' &&
    typeof geminiClient.getHistory === 'function'
  ) {
    const chat = geminiClient.getChat();
    if (
      chat &&
      typeof chat === 'object' &&
      typeof chat.getGenerationConfig === 'function'
    ) {
      const generationConfig = chat.getGenerationConfig();
      if (generationConfig) {
        const fullHistory = geminiClient.getHistory(true);
        const maxHistoryEntries = 40;
        const history =
          fullHistory.length > maxHistoryEntries
            ? fullHistory.slice(-maxHistoryEntries)
            : fullHistory;

        return {
          generationConfig,
          history,
          model: context.services.config?.getModel() ?? '',
          version: 0,
        };
      }
    }
  }

  return getCacheSafeParams();
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
  supportedModes: ['interactive'] as const,
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
