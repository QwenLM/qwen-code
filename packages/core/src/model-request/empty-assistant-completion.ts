/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectErrorObjects } from '../utils/errors.js';

export const EMPTY_ASSISTANT_COMPLETION_CODE = 'empty_assistant_completion';

export type EmptyAssistantCompletionReason =
  | 'reasoning_only'
  | 'no_visible_content';

export interface EmptyAssistantCompletionContext {
  reason: EmptyAssistantCompletionReason;
  finishReason: 'end_turn';
  contentBlockCount: number;
  reasoningBlockCount: number;
  textCharacterCount: number;
  model: string;
  transport: string;
  serverRequestId?: string;
}

/** A complete model response that produced no user-visible answer or action. */
export class EmptyAssistantCompletionError extends Error {
  readonly code = EMPTY_ASSISTANT_COMPLETION_CODE;
  readonly retryable = true;
  readonly reason: EmptyAssistantCompletionReason;
  readonly finishReason: 'end_turn';
  readonly contentBlockCount: number;
  readonly reasoningBlockCount: number;
  readonly textCharacterCount: number;
  readonly model: string;
  readonly transport: string;
  readonly serverRequestId?: string;

  constructor(context: EmptyAssistantCompletionContext) {
    super(
      `Empty assistant completion: model ended the turn without answer text ` +
        `or a tool call (reason=${context.reason}, ` +
        `transport=${context.transport}, ` +
        `contentBlockCount=${context.contentBlockCount}, ` +
        `reasoningBlockCount=${context.reasoningBlockCount}, ` +
        `textCharacterCount=${context.textCharacterCount}, ` +
        `serverRequestId=${context.serverRequestId ?? ''})`,
    );
    this.name = 'EmptyAssistantCompletionError';
    this.reason = context.reason;
    this.finishReason = context.finishReason;
    this.contentBlockCount = context.contentBlockCount;
    this.reasoningBlockCount = context.reasoningBlockCount;
    this.textCharacterCount = context.textCharacterCount;
    this.model = context.model;
    this.transport = context.transport;
    this.serverRequestId = context.serverRequestId;
  }
}

export function isEmptyAssistantCompletionError(
  error: unknown,
): error is EmptyAssistantCompletionError {
  return error instanceof EmptyAssistantCompletionError;
}

/** Preserve semantic-empty diagnostics through the inference error boundary. */
export function findEmptyAssistantCompletionError(
  error: unknown,
): EmptyAssistantCompletionError | undefined {
  return collectErrorObjects(error).find(isEmptyAssistantCompletionError);
}
