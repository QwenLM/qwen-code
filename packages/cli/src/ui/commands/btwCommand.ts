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
import { runForkedAgent } from '@qwen-code/qwen-code-core';

function formatBtwError(error: unknown): string {
  return t('Failed to answer btw question: {{error}}', {
    error:
      error instanceof Error ? error.message : String(error || 'Unknown error'),
  });
}

const BTW_SYSTEM_PROMPT = [
  'You are a separate, lightweight agent spawned to answer a single side question.',
  'The main conversation continues independently in the background.',
  '',
  'Rules:',
  '- Answer the question directly and concisely in a single response.',
  '- Do NOT reference being interrupted or what you were "previously doing".',
  '- You have NO tools available — you cannot read files, run commands, or take any actions.',
  '- You can ONLY use information already present in the conversation context.',
  '- NEVER promise to look something up or investigate further.',
  '- If you do not know the answer, say so.',
].join('\n');

/**
 * Run a side question using a forked agent.
 *
 * Mirrors Claude Code's runSideQuestion() design:
 * - tools: [] (all tools denied — no file I/O, no shell)
 * - maxTurns: 1 (single response, no follow-up turns)
 */
async function askBtw(
  context: CommandContext,
  question: string,
  abortSignal: AbortSignal,
): Promise<string> {
  const { config } = context.services;
  if (!config) throw new Error('Config not loaded');

  const result = await runForkedAgent({
    name: 'btw-side-question',
    config,
    systemPrompt: BTW_SYSTEM_PROMPT,
    taskPrompt: question,
    tools: [], // deny all tools — single-turn text answer only
    maxTurns: 1,
    abortSignal,
  });

  if (result.status === 'cancelled') {
    throw new Error('Cancelled');
  }
  return result.finalText || t('No response received.');
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

    // ACP mode: return a stream_messages async generator
    if (executionMode === 'acp') {
      const messages = async function* () {
        try {
          yield {
            messageType: 'info' as const,
            content: t('Thinking...'),
          };

          const answer = await askBtw(context, question, abortSignal);

          yield {
            messageType: 'info' as const,
            content: `btw> ${question}\n${answer}`,
          };
        } catch (error) {
          yield {
            messageType: 'error' as const,
            content: formatBtwError(error),
          };
        }
      };

      return { type: 'stream_messages', messages: messages() };
    }

    // Non-interactive mode: return a simple message result
    if (executionMode === 'non_interactive') {
      try {
        const answer = await askBtw(context, question, abortSignal);
        return {
          type: 'message',
          messageType: 'info',
          content: `btw> ${question}\n${answer}`,
        };
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
