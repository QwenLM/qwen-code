/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CacheSafeParams } from './forkedAgent.js';
import type { Config } from '../config/config.js';
import { createDebugLogger } from './debugLogger.js';

export function buildBtwPrompt(question: string): string {
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

export function buildBtwCacheSafeParams(
  config: Config,
): CacheSafeParams | null {
  const geminiClient = config.getGeminiClient();
  try {
    const chat = geminiClient.getChat();
    const generationConfig = chat.getGenerationConfig();
    if (!generationConfig) return null;
    const maxHistoryEntries = 40;
    const history = geminiClient.getHistoryTail(maxHistoryEntries, true);
    return {
      generationConfig,
      history,
      model: config.getModel() ?? '',
      version: 0,
    };
  } catch (err) {
    createDebugLogger('btw').debug(
      `buildBtwCacheSafeParams failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
