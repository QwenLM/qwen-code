/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  FinishReason,
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import type { ToolResult } from '../tools/tools.js';
import type { SerializableConfirmationDetails } from '../tools/confirmation-details.js';
import type { ThoughtSummary } from '../utils/thoughtUtils.js';
import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '../tool-executor/types.js';

export interface ServerTool {
  name: string;
  schema: FunctionDeclaration;
  execute(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

export enum ModelEventType {
  Content = 'content',
  ToolCallRequest = 'tool_call_request',
  ToolCallResponse = 'tool_call_response',
  ToolCallConfirmation = 'tool_call_confirmation',
  UserCancelled = 'user_cancelled',
  Error = 'error',
  ChatCompressed = 'chat_compressed',
  Thought = 'thought',
  MaxSessionTurns = 'max_session_turns',
  Finished = 'finished',
  Citation = 'citation',
  Retry = 'retry',
  ContextWindowWillOverflow = 'context_window_will_overflow',
  InvalidStream = 'invalid_stream',
  ModelInfo = 'model_info',
  AgentExecutionStopped = 'agent_execution_stopped',
  AgentExecutionBlocked = 'agent_execution_blocked',
}

export type ServerRetryEvent = {
  type: ModelEventType.Retry;
};

export type ServerAgentExecutionStoppedEvent = {
  type: ModelEventType.AgentExecutionStopped;
  value: {
    reason: string;
    systemMessage?: string;
    contextCleared?: boolean;
  };
};

export type ServerAgentExecutionBlockedEvent = {
  type: ModelEventType.AgentExecutionBlocked;
  value: {
    reason: string;
    systemMessage?: string;
    contextCleared?: boolean;
  };
};

export type ServerContextWindowWillOverflowEvent = {
  type: ModelEventType.ContextWindowWillOverflow;
  value: {
    estimatedRequestTokenCount: number;
    remainingTokenCount: number;
  };
};

export type ServerInvalidStreamEvent = {
  type: ModelEventType.InvalidStream;
};

export type ServerModelInfoEvent = {
  type: ModelEventType.ModelInfo;
  value: string;
};

export interface StructuredError {
  message: string;
  status?: number;
}

export interface ErrorEventValue {
  error: unknown;
}

export interface FinishedEventValue {
  reason: FinishReason | undefined;
  usageMetadata: GenerateContentResponseUsageMetadata | undefined;
}

export interface ServerToolCallConfirmationDetails {
  request: ToolCallRequestInfo;
  details: SerializableConfirmationDetails;
}

export type ServerContentEvent = {
  type: ModelEventType.Content;
  value: string;
  traceId?: string;
};

export type ServerThoughtEvent = {
  type: ModelEventType.Thought;
  value: ThoughtSummary;
  traceId?: string;
};

export type ServerToolCallRequestEvent = {
  type: ModelEventType.ToolCallRequest;
  value: ToolCallRequestInfo;
};

export type ServerToolCallResponseEvent = {
  type: ModelEventType.ToolCallResponse;
  value: ToolCallResponseInfo;
};

export type ServerToolCallConfirmationEvent = {
  type: ModelEventType.ToolCallConfirmation;
  value: ServerToolCallConfirmationDetails;
};

export type ServerUserCancelledEvent = {
  type: ModelEventType.UserCancelled;
};

export type ServerErrorEvent = {
  type: ModelEventType.Error;
  value: ErrorEventValue;
};

export enum CompressionStatus {
  COMPRESSED = 1,
  COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
  COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
  COMPRESSION_FAILED_EMPTY_SUMMARY,
  NOOP,
  CONTENT_TRUNCATED,
  COMPRESSION_FAILED_PRECOMPACT_BLOCKED,
  COMPRESSION_FAILED_MODEL_REQUEST,
}

export interface ChatCompressionInfo {
  originalTokenCount: number;
  newTokenCount: number;
  compressionStatus: CompressionStatus;
  blockReason?: string;
  failureReason?: string;
  providerStatus?: number;
  providerCode?: string;
  providerSource?: string;
  /** Raw provider code, normalized ResultCode, or transport code. */
  errorCode?: string;
  /** Dynamic error-code key used by the shared user-facing formatter. */
  displayErrorCode?: string | number;
  /** Safe user-facing fallback when no dynamic text exists for the code. */
  errorFallbackMessage?: string;
}

export type ServerChatCompressedEvent = {
  type: ModelEventType.ChatCompressed;
  value: ChatCompressionInfo | null;
};

export type ServerMaxSessionTurnsEvent = {
  type: ModelEventType.MaxSessionTurns;
};

export type ServerFinishedEvent = {
  type: ModelEventType.Finished;
  value: FinishedEventValue;
};

export type ServerCitationEvent = {
  type: ModelEventType.Citation;
  value: string;
};

export type ServerStreamEvent =
  | ServerChatCompressedEvent
  | ServerCitationEvent
  | ServerContentEvent
  | ServerErrorEvent
  | ServerFinishedEvent
  | ServerMaxSessionTurnsEvent
  | ServerThoughtEvent
  | ServerToolCallConfirmationEvent
  | ServerToolCallRequestEvent
  | ServerToolCallResponseEvent
  | ServerUserCancelledEvent
  | ServerRetryEvent
  | ServerContextWindowWillOverflowEvent
  | ServerInvalidStreamEvent
  | ServerModelInfoEvent
  | ServerAgentExecutionStoppedEvent
  | ServerAgentExecutionBlockedEvent;
