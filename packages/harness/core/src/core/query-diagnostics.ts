/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';
import type { ToolResultBlock } from './tool-result.js';
import type { Terminal } from './query-event.js';
import {
  emitInputPromptSubmitted,
  emitTurnStarted,
  emitTurnFinished,
  emitLoopStarted,
  emitLoopFinished,
  emitToolRequested,
  emitToolExecutionFinished,
  emitModelRequestStarted,
  emitModelRequestAttemptFailed,
} from '../utils/diagnosticInterceptors.js';

export function makeLoopId(promptId: string, requestIndex: number): string {
  return `${promptId}:${requestIndex}`;
}

export function logInputPromptSubmitted(params: {
  sessionId: string;
  promptId: string;
  prompt: string;
  isMeta: boolean;
  isSubagent: boolean;
  skipInitialUserMessage: boolean;
  originKind: string | undefined;
}): void {
  emitInputPromptSubmitted({
    sessionId: params.sessionId,
    turnId: params.promptId,
    prompt: params.prompt,
    isMeta: params.isMeta,
    isSubagent: params.isSubagent,
    skipInitialUserMessage: params.skipInitialUserMessage,
    originKind: params.originKind,
  });
}

function summarizeToolResultContent(content: ToolResultBlock['content']): {
  content_type: 'text' | 'parts';
  text_chars: number;
  part_count?: number;
  image_count?: number;
} {
  if (typeof content === 'string') {
    return { content_type: 'text', text_chars: content.length };
  }

  let textChars = 0;
  let imageCount = 0;
  for (const part of content) {
    if (part.type === 'text') {
      textChars += part.text.length;
    } else if (part.type === 'image') {
      imageCount++;
    }
  }

  return {
    content_type: 'parts',
    text_chars: textChars,
    part_count: content.length,
    image_count: imageCount,
  };
}

export function logTurnStarted(params: {
  sessionId: string;
  promptId: string;
  model: string;
  promptLength: number;
  historyLength: number;
  skipInitialUserMessage: boolean;
  skipBeforeHook: boolean;
  isSubagent: boolean;
}): void {
  emitTurnStarted({
    sessionId: params.sessionId,
    turnId: params.promptId,
    model: params.model,
    promptLength: params.promptLength,
    historyLength: params.historyLength,
    skipInitialUserMessage: params.skipInitialUserMessage,
    skipBeforeHook: params.skipBeforeHook,
    isSubagent: params.isSubagent,
  });
}

export function logTurnFinished(params: {
  sessionId: string;
  promptId: string;
  terminal: Terminal;
}): Terminal {
  const { terminal } = params;
  const data = {
    reason: terminal.reason,
    modelStopReason: terminal.modelStopReason,
    numTurns: terminal.numTurns,
    durationMs: terminal.durationMs,
    error: terminal.error?.message,
    requestId: terminal.requestId ?? terminal.usage.request_id,
    clientRequestId: terminal.clientRequestId ?? terminal.usage.request_id,
    serverRequestId: terminal.serverRequestId,
    inputTokens: terminal.usage.input_tokens,
    outputTokens: terminal.usage.output_tokens,
    cacheReadInputTokens: terminal.usage.cache_read_input_tokens,
    cacheCreationInputTokens: terminal.usage.cache_creation_input_tokens,
  };
  emitTurnFinished({
    sessionId: params.sessionId,
    turnId: params.promptId,
    ...data,
  });
  return terminal;
}

export function logLoopStarted(params: {
  sessionId: string;
  promptId: string;
  loopId: string;
  requestIndex: number;
  model: string;
  requestMessageCount: number;
  requestBaseHistoryLength: number;
  hasPendingUserMessage: boolean;
  toolSchemaCount: number;
}): void {
  emitLoopStarted({
    sessionId: params.sessionId,
    turnId: params.promptId,
    loopId: params.loopId,
    requestIndex: params.requestIndex,
    model: params.model,
    requestMessageCount: params.requestMessageCount,
    requestBaseHistoryLength: params.requestBaseHistoryLength,
    hasPendingUserMessage: params.hasPendingUserMessage,
    toolSchemaCount: params.toolSchemaCount,
  });
}

export function logLoopFinished(params: {
  sessionId: string;
  promptId: string;
  loopId: string;
  requestIndex: number;
  reason: string;
  level?: 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}): void {
  emitLoopFinished({
    sessionId: params.sessionId,
    turnId: params.promptId,
    loopId: params.loopId,
    requestIndex: params.requestIndex,
    reason: params.reason,
    level: params.level,
    data: params.data,
  });
}

export function logToolRequested(params: {
  sessionId: string;
  promptId: string;
  loopId: string;
  block: ModelToolUseBlock;
}): void {
  emitToolRequested({
    sessionId: params.sessionId,
    turnId: params.promptId,
    loopId: params.loopId,
    toolCallId: params.block.id,
    toolName: params.block.name,
    args: params.block.input,
  });
}

export function logToolResults(params: {
  sessionId: string;
  promptId: string;
  loopId: string;
  toolUseBlocks: ModelToolUseBlock[];
  toolResults: ToolResultBlock[];
  deniedToolUseIds: ReadonlySet<string>;
}): void {
  const toolNameById = new Map(
    params.toolUseBlocks.map((block) => [block.id, block.name]),
  );
  for (const result of params.toolResults) {
    const denied = params.deniedToolUseIds.has(result.tool_use_id);
    const status = denied ? 'denied' : result.is_error ? 'error' : 'success';
    const { content_type, text_chars, part_count, image_count } =
      summarizeToolResultContent(result.content);
    emitToolExecutionFinished({
      sessionId: params.sessionId,
      turnId: params.promptId,
      loopId: params.loopId,
      toolCallId: result.tool_use_id,
      toolName: toolNameById.get(result.tool_use_id) ?? 'unknown',
      status,
      isError: result.is_error,
      deniedByPermission: denied,
      contentType: content_type,
      textChars: text_chars,
      partCount: part_count,
      imageCount: image_count,
    });
  }
}

export function logModelRequestStarted(params: {
  sessionId: string;
  promptId: string;
  loopId: string | undefined;
  requestIndex: number | undefined;
  requestId: string;
  model: string;
  requestMessageCount: number;
  toolSchemaCount: number;
}): void {
  emitModelRequestStarted({
    sessionId: params.sessionId,
    turnId: params.promptId,
    loopId: params.loopId,
    requestId: params.requestId,
    requestIndex: params.requestIndex,
    model: params.model,
    requestMessageCount: params.requestMessageCount,
    toolSchemaCount: params.toolSchemaCount,
  });
}

export function logModelRequestAttemptFailed(params: {
  sessionId: string;
  promptId: string;
  loopId: string | undefined;
  requestIndex: number | undefined;
  requestId: string;
  serverRequestId: string | undefined;
  attempt: number;
  maxAttempts: number;
  status: number | undefined;
  error: unknown;
  retryable: boolean;
  willRetry: boolean;
  retryFetchErrors: boolean;
  attemptHadPayload: boolean;
  attemptHadReplayUnsafePayload: boolean;
  streamEventCount: number;
  pendingEventCount: number;
  streamReadCompleted: boolean;
  isEmptyResponseBody: boolean;
  emptyAssistantCompletion?: {
    reason: string;
    contentBlockCount: number;
    reasoningBlockCount: number;
    textCharacterCount: number;
    replayCount: number;
  };
  aborted: boolean;
}): void {
  emitModelRequestAttemptFailed({
    sessionId: params.sessionId,
    turnId: params.promptId,
    loopId: params.loopId,
    requestId: params.requestId,
    requestIndex: params.requestIndex,
    serverRequestId: params.serverRequestId,
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    status: params.status,
    error: params.error,
    retryable: params.retryable,
    willRetry: params.willRetry,
    retryFetchErrors: params.retryFetchErrors,
    attemptHadPayload: params.attemptHadPayload,
    attemptHadReplayUnsafePayload: params.attemptHadReplayUnsafePayload,
    streamEventCount: params.streamEventCount,
    pendingEventCount: params.pendingEventCount,
    streamReadCompleted: params.streamReadCompleted,
    isEmptyResponseBody: params.isEmptyResponseBody,
    emptyAssistantCompletion: params.emptyAssistantCompletion,
    aborted: params.aborted,
  });
}
