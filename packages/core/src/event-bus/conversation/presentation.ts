/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { createAttachmentMessage } from '../../attachments/factory.js';
import { StreamInterruptionAttachment } from '../../attachments/models/system-attachments.js';
import { findEmptyAssistantCompletionError } from '../../model-request/empty-assistant-completion.js';
import { describeStreamInterruption } from '../../model-request/stream-interruption.js';
import type { ModelRequestOutcome } from '../../model-request/types.js';
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '../../protocol/transcript/conversions.js';
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../protocol/transcript/message.js';
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../protocol/transcript/message-utils.js';
import type { ModelMessage } from '../../provider/event/modelCompleteEvent.js';
import { findModelInferenceError } from '../../provider/modelInferenceError.js';
import { collectErrorCodes } from '../../utils/errors.js';
import { getErrorStatus } from '../../utils/httpErrors.js';
import { isRecord } from '../../utils/markdownUtils.js';
import { runLogger } from '../../utils/runLogger.js';
import { firstNonEmptyString } from '../../utils/stringUtils.js';
import type { HookCoordinatorAdapter } from '../../core/hook-coordinator-types.js';
import {
  CONTENT_FILTERED_MESSAGE,
  type ErrorNotificationDetails,
  type ErrorNotificationEvent,
} from '../../core/query-event.js';
import { MODEL_REFUSAL_ERROR_CODE } from '../../core/stream-errors.js';
import {
  buildUndeliveredToolRecords,
  type UndeliveredToolCall,
} from '../../core/tool-stream-settlement.js';

/** Semantic refusal when a completed response carries stop_reason=refusal. */
export function createModelRefusalError(error: unknown): Error {
  const status = getErrorStatus(error);
  const refusalError = new Error(CONTENT_FILTERED_MESSAGE);
  if (error instanceof Error) refusalError.stack = error.stack;
  if (isRecord(error)) Object.assign(refusalError, error);
  Object.assign(refusalError, {
    name: 'ModelRefusalError',
    message: CONTENT_FILTERED_MESSAGE,
    code: MODEL_REFUSAL_ERROR_CODE,
    error_code: MODEL_REFUSAL_ERROR_CODE,
    retryable: false,
    ...(status !== undefined
      ? {
          status,
          status_code: status,
        }
      : {}),
  });
  if (error !== undefined) {
    Object.defineProperty(refusalError, 'cause', {
      value: error,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  return refusalError;
}

/**
 * StopFailure is synchronous notification: wait for configured hooks, but
 * never let a hook failure replace the model error that caused the event.
 * The coordinator forwards `signal` to HookRunner, whose inner and defensive
 * outer timeouts guarantee that a wedged hook still settles.
 */
export async function fireStopFailureSafely(
  hookCoordinator: HookCoordinatorAdapter | undefined,
  error: Parameters<HookCoordinatorAdapter['fireStopFailure']>[0],
  options: Parameters<HookCoordinatorAdapter['fireStopFailure']>[1],
  signal: AbortSignal,
  model?: string,
): Promise<void> {
  if (!hookCoordinator?.fireStopFailure) return;

  try {
    await hookCoordinator.fireStopFailure(error, options, signal, model);
  } catch (hookError) {
    runLogger.warn(
      `[AgentLoop] StopFailure hook failed (non-fatal): ${hookError}`,
    );
  }
}

export function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Persist failure facts only; hosts choose their presentation after resume. */
export function modelErrorForTranscript(
  error: unknown,
  providerSource: string,
): AssistantMessage['modelError'] {
  const failure = findModelInferenceError(error);
  if (!failure) return undefined;
  const emptyCompletion = findEmptyAssistantCompletionError(error);
  return {
    kind: failure.kind,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    providerSource,
    causeCodes: collectErrorCodes(error),
    ...(emptyCompletion
      ? { emptyCompletionReason: emptyCompletion.reason }
      : {}),
  };
}

export function readBooleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return value === true || value === false ? value : undefined;
}

export function compactErrorDetails<T extends object>(details: T): T {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  ) as T;
}

export function buildErrorNotificationDetails(
  error: unknown,
  message: string,
  statusCode: number | undefined,
  providerSource: string,
): ErrorNotificationDetails {
  const record = isRecord(error) ? error : {};
  const inferenceError = findModelInferenceError(error);
  const source = inferenceError
    ? 'model_transport'
    : statusCode !== undefined
      ? 'http'
      : 'runtime';

  return compactErrorDetails<ErrorNotificationDetails>({
    source,
    name: error instanceof Error ? error.name : undefined,
    message,
    code:
      readStringField(record, 'code') ??
      inferenceError?.code ??
      (statusCode !== undefined ? String(statusCode) : undefined),
    normalized_code: inferenceError?.kind,
    provider_source: providerSource,
    status_code: statusCode,
    transport: readStringField(record, 'transport'),
    retryable: readBooleanField(record, 'retryable'),
  });
}

export function buildModelRequestErrorNotification(
  error: unknown,
  model: string,
  providerSource: string,
): ErrorNotificationEvent {
  const statusCode = getErrorStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  const errorDetails = buildErrorNotificationDetails(
    error,
    message,
    statusCode,
    providerSource,
  );
  const errorCode = errorDetails.code ?? errorDetails.normalized_code;
  const errorMessage = errorDetails.message;
  const lowerMessage = message.toLowerCase();
  const isTimeout =
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('etimedout');

  return {
    type: 'error_notification',
    error_type:
      statusCode === undefined && isTimeout
        ? 'network_timeout'
        : 'model_request_failed',
    message,
    ...(statusCode !== undefined ? { status_code: statusCode } : {}),
    ...(errorDetails.source !== undefined
      ? { error_source: errorDetails.source }
      : {}),
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    ...(errorMessage !== undefined ? { error_message: errorMessage } : {}),
    error_details: errorDetails,
    model,
    timestamp: new Date().toISOString(),
  };
}

/** 未投递的调用补成成对历史，再加一条请求级中断提醒。 */
export function buildStreamRecoveryMessages(params: {
  interrupted: Extract<ModelRequestOutcome, { kind: 'interrupted' }>;
  message: ModelMessage;
  attributeSessionRoute: (message: AssistantMessage) => void;
  promptId: string;
  responseGroupId: string;
}): Message[] {
  const {
    interrupted,
    message,
    attributeSessionRoute,
    promptId,
    responseGroupId,
  } = params;
  const messages: Message[] = [];
  const records = buildUndeliveredToolRecords(
    collectUndeliveredToolCalls(interrupted),
  );
  if (records.toolUses.length > 0) {
    // SDK 投影按 message.id 去重流式块；占位帧没走过流，需要自己的 id。
    const placeholder = createAssistantMessage(
      {
        messageId: message.messageId
          ? `${message.messageId}_recovery`
          : `recovery_${randomUUID()}`,
        model: message.model,
        blocks: records.toolUses,
        stopReason: 'tool_use',
      },
      promptId,
      undefined,
      undefined,
      responseGroupId,
    );
    // Usage 已归到保留下来的那次回复上。
    delete placeholder.message.usage;
    attributeSessionRoute(placeholder);
    messages.push(
      placeholder,
      createToolResultMessage(records.toolResults, placeholder.uuid, {
        promptId,
      }),
    );
  }
  messages.push(
    createAttachmentMessage(
      new StreamInterruptionAttachment({
        type: 'stream_interruption',
        cause: describeStreamInterruption(interrupted.failure.error),
      }),
    ),
  );
  return messages;
}

/** 收集中断时还没投递给执行器的调用：已闭合的块参数完整，未闭合的只有 id/name。 */
export function collectUndeliveredToolCalls(
  interrupted: Extract<ModelRequestOutcome, { kind: 'interrupted' }>,
): UndeliveredToolCall[] {
  const { message, delivery } = interrupted;
  const calls: UndeliveredToolCall[] = [];
  for (const [index, tool] of delivery.pendingTools) {
    if (delivery.deliveredBlocks.has(index)) continue;
    // An incomplete identity cannot establish a valid call/result pair.
    if (!tool.id || !tool.name) continue;
    const block = message.blocks[index];
    calls.push(
      block?.type === 'tool_use'
        ? {
            id: tool.id,
            name: tool.name,
            argumentsComplete: true,
            input: block.input,
          }
        : { id: tool.id, name: tool.name, argumentsComplete: false },
    );
  }
  return calls;
}

export interface ModelRequestIds {
  requestId?: string;
  clientRequestId?: string;
  serverRequestId?: string;
}

export function getModelRequestIds(error: unknown): ModelRequestIds {
  if (!error || typeof error !== 'object') {
    return {};
  }
  const record = error as {
    requestId?: unknown;
    clientRequestId?: unknown;
    serverRequestId?: unknown;
    request_id?: unknown;
    client_request_id?: unknown;
    server_request_id?: unknown;
  };
  return {
    requestId: firstNonEmptyString(record.requestId, record.request_id),
    clientRequestId: firstNonEmptyString(
      record.clientRequestId,
      record.client_request_id,
    ),
    serverRequestId: firstNonEmptyString(
      record.serverRequestId,
      record.server_request_id,
    ),
  };
}

/**
 * Create a synthetic error tool_result for a tool_use block.
 */
export function createUserInterruptionMessage({
  toolUse = false,
}: {
  toolUse?: boolean;
} = {}): UserMessage {
  return createUserMessage([
    {
      type: 'text',
      text: toolUse ? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE,
    },
  ]);
}