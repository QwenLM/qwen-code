/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

export interface ResponsesMessageMetadata {
  id: string;
  phase?: 'commentary' | 'final_answer';
}

export type ResponsesTextPart = Part & {
  responsesMessage?: ResponsesMessageMetadata;
};

export function getResponsesMessage(
  part: Part,
): ResponsesMessageMetadata | undefined {
  const value = (part as ResponsesTextPart).responsesMessage;
  if (!value || typeof value.id !== 'string') return undefined;
  if (
    value.phase !== undefined &&
    value.phase !== 'commentary' &&
    value.phase !== 'final_answer'
  ) {
    return { id: value.id };
  }
  return value;
}

export function sameResponsesMessage(left: Part, right: Part): boolean {
  const a = getResponsesMessage(left);
  const b = getResponsesMessage(right);
  return a?.id === b?.id && a?.phase === b?.phase;
}
