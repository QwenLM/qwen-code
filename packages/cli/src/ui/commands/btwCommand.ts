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
import type { Content } from '@google/genai';

function makeBtwPromptId(sessionId: string): string {
  return `${sessionId}########btw-${Date.now()}`;
}

function formatBtwError(error: unknown): string {
  return t('Failed to answer btw question: {{error}}', {
    error:
      error instanceof Error ? error.message : String(error || 'Unknown error'),
  });
}

// Keep only the most recent history messages to limit token usage for side
// questions. MAX_BTW_HISTORY_MESSAGES caps the number of history Content
// entries included as context before the /btw question is appended.
const MAX_BTW_HISTORY_MESSAGES = 20;

function trimHistory(history: Content[]): Content[] {
  if (history.length <= MAX_BTW_HISTORY_MESSAGES) {
    return history;
  }
  // Slice from the end, ensuring we start on a 'user' message so the
  // alternating user/model pattern is preserved.
  const sliced = history.slice(-MAX_BTW_HISTORY_MESSAGES);
  if (sliced[0]?.role === 'model' && sliced.length > 1) {
    return sliced.slice(1);
  }
  return sliced;
}

/**
 * Helper to make the ephemeral generateContent call and extract the answer.
 * Uses a snapshot of the current conversation history as context.
 */
async function askBtw(
  geminiClient: GeminiClient,
  model: string,
  question: string,
  abortSignal: AbortSignal,
  promptId: string,
): Promise<string> {
  const history = trimHistory(geminiClient.getHistory(true));

  // Side-question guidance sent as a user message (not a system instruction).
  // Inspired by Claude Code's design:
  // - Emphasizes direct answering without tools
  // - Clarifies the isolated nature of the side question
  // - Prevents the model from promising actions it can't take
  const response = await geminiClient.generateContent(
    [
      ...history,
      {
        role: 'user',
        parts: [
          {
            text: `[This is a side question - answer directly and concisely.

IMPORTANT:
- You are a separate, lightweight agent spawned to answer this one question
- The main conversation continues independently in the background
- Do NOT reference being interrupted or what you were "previously doing"

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response in a single turn
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question directly with the information you have.]

${question}`,
          },
        ],
      },
    ],
    {},
    abortSignal,
    model,
    promptId,
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

    const geminiClient = config.getGeminiClient();
    const model = config.getModel();
    const sessionId = config.getSessionId();

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

    // Fire-and-forget: run the API call in the background so the main
    // conversation is not blocked while waiting for the btw answer.
    const btwPromptId = makeBtwPromptId(sessionId);
    void askBtw(geminiClient, model, question, btwSignal, btwPromptId)
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
