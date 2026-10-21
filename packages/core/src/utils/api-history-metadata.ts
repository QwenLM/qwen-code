/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

const API_HISTORY_PROMPT_ID = Symbol('apiHistoryPromptId');

type IdentifiedContent = Content & {
  [API_HISTORY_PROMPT_ID]?: string;
};

export function cloneApiHistory(history: Content[]): Content[] {
  // structuredClone drops the non-serialized prompt and context boundaries.
  return history.map((content) => ({
    ...content,
    ...structuredClone(content),
  }));
}

export function markApiHistoryPrompt(
  content: Content,
  promptId: unknown,
): void {
  if (typeof promptId === 'string' && promptId.length > 0) {
    (content as IdentifiedContent)[API_HISTORY_PROMPT_ID] = promptId;
  }
}

export function getApiHistoryPromptId(content: Content): string | undefined {
  return (content as IdentifiedContent)[API_HISTORY_PROMPT_ID];
}
