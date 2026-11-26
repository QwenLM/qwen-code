/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectErrorObjects } from '../utils/errors.js';
import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import type { ModelStreamRequest } from '../provider/modelStreamRequest.js';
import { ASK_USER_ASYNC_TOOL_NAME } from '../tools/tool-names.js';
import { SINGLE_REQUEST_FORK } from './request-scope.js';

/** The question itself is the deliverable; only its immediate empty continuation may finish silently. */
export function allowsEmptyCompletionAfterAsyncQuestion(
  request: ModelStreamRequest,
  result: ModelMessage,
): boolean {
  if (
    SINGLE_REQUEST_FORK in request ||
    result.stopReason !== 'end_turn' ||
    !result.blocks.every(
      (block) => block.type === 'text' && block.text.trim().length === 0,
    )
  )
    return false;

  const messages = request.prompt.messages;
  const resultIds = new Set<string>();
  let index = messages.length - 1;
  while (index >= 0) {
    const message = messages[index];
    if (message.role !== 'tool') break;
    if (message.isError) return false;
    resultIds.add(message.toolCallId);
    index--;
  }
  const assistant = messages[index];
  if (assistant?.role !== 'assistant' || !assistant.toolCalls?.length)
    return false;

  return (
    resultIds.size === assistant.toolCalls.length &&
    assistant.toolCalls.every(
      (call) =>
        call.name === ASK_USER_ASYNC_TOOL_NAME && resultIds.has(call.id),
    )
  );
}

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

export function validateAssistantCompletion(
  request: ModelStreamRequest,
  result: ModelMessage,
  transport: string,
): void {
  if (
    result.stopReason !== 'end_turn' ||
    result.blocks.some(
      (block) =>
        block.type === 'tool_use' ||
        (block.type === 'text' && block.text.trim().length > 0),
    ) ||
    allowsEmptyCompletionAfterAsyncQuestion(request, result)
  )
    return;

  const reasoningBlockCount = result.blocks.filter(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
  ).length;
  throw new EmptyAssistantCompletionError({
    reason: reasoningBlockCount > 0 ? 'reasoning_only' : 'no_visible_content',
    finishReason: 'end_turn',
    contentBlockCount: result.blocks.length,
    reasoningBlockCount,
    textCharacterCount: result.blocks.reduce(
      (count, block) => count + (block.type === 'text' ? block.text.length : 0),
      0,
    ),
    model: result.model,
    transport,
  });
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
