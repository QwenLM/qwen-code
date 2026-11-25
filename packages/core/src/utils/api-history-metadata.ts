/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';

const API_HISTORY_PROMPT_ID = Symbol('apiHistoryPromptId');
const DIRECTORY_CONTEXT = Symbol('directoryContext');

type IdentifiedContent = Content & {
  [API_HISTORY_PROMPT_ID]?: string;
  [DIRECTORY_CONTEXT]?: boolean;
};

// Keep the insertion offset so the note precedes any appended hook context.
const modelToolErrorNotes = new WeakMap<
  object,
  { text: string; offset: number }
>();

export function setModelToolErrorNote(part: Part, note: string): void {
  const response = part.functionResponse?.response;
  const error = response?.['error'];
  if (response && typeof error === 'string') {
    modelToolErrorNotes.set(response, { text: note, offset: error.length });
  }
}

export function getModelToolErrorNote(response: object) {
  return modelToolErrorNotes.get(response);
}

export function copyModelToolErrorNote(original: Part, updated: Part): void {
  const source = original.functionResponse?.response;
  const target = updated.functionResponse?.response;
  if (!source || !target) return;
  const note = modelToolErrorNotes.get(source);
  if (note) modelToolErrorNotes.set(target, note);
}

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
  return history.map((content) => {
    // Keep prompt and context markers on the in-memory copy.
    const copy = { ...content, ...structuredClone(content) };
    if (content.role === 'user') {
      content.parts?.forEach((part, index) => {
        copyModelToolErrorNote(part, copy.parts![index]);
      });
    }
    return copy;
  });
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
