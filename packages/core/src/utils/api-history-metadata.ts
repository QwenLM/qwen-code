/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

const API_HISTORY_PROMPT_ID = Symbol('apiHistoryPromptId');
const DIRECTORY_CONTEXT = Symbol('directoryContext');

type IdentifiedContent = Content & {
  [API_HISTORY_PROMPT_ID]?: string;
  [DIRECTORY_CONTEXT]?: boolean;
};

export function markApiHistoryDirectoryContext(content: Content): Content {
  (content as IdentifiedContent)[DIRECTORY_CONTEXT] = true;
  return content;
}

export function clearApiHistoryDirectoryContext(content: Content): void {
  delete (content as IdentifiedContent)[DIRECTORY_CONTEXT];
}

export function isApiHistoryDirectoryContext(content: Content): boolean {
  return (
    content.role === 'user' &&
    (content as IdentifiedContent)[DIRECTORY_CONTEXT] === true &&
    content.parts?.every((part) => typeof part.text === 'string') === true &&
    getApiHistoryPromptId(content) === undefined
  );
}

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
