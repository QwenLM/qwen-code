/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { CacheSafeParams } from '../agents/forkedAgent.js';
import type { Config } from '../config/config.js';
import { createDebugLogger } from './debugLogger.js';

const logger = createDebugLogger('btw');

/** Maximum input length (chars) accepted by btw routes and slash command. */
export const BTW_MAX_INPUT_LENGTH = 4096;

export function buildBtwPrompt(question: string): string {
  return `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`;
}

/**
 * Snapshot of the main conversation for a side question, followed by earlier
 * side-question exchanges. `fullHistory` takes the whole curated history so
 * the fork's request prefix matches the main agent's; otherwise only the
 * 40-entry tail a default forked chat keeps is cloned.
 */
export function buildBtwCacheSafeParams(
  config: Config,
  exchanges: ReadonlyArray<{ question: string; response: string }> = [],
  options: { fullHistory?: boolean } = {},
): CacheSafeParams | null {
  const llmClient = config.getLlmClient();
  try {
    const chat = llmClient.getChat();
    const generationConfig = chat.getGenerationConfig();
    if (!generationConfig) return null;
    const history: Content[] = options.fullHistory
      ? chat.getHistory(true)
      : chat.getHistoryTail(40, true);
    for (const exchange of exchanges) {
      history.push(
        { role: 'user', parts: [{ text: exchange.question }] },
        { role: 'model', parts: [{ text: exchange.response }] },
      );
    }
    return {
      generationConfig: structuredClone(generationConfig),
      history,
      model: config.getModel() ?? '',
      version: 0,
    };
  } catch (err) {
    logger.debug(
      `buildBtwCacheSafeParams failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
