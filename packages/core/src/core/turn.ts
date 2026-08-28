/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  Part,
  PartListUnion,
  GenerateContentResponse,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { FinishReason } from './genai-compat.js';
import type {
  ToolCallConfirmationDetails,
  ToolArtifact,
  ToolResultBoundaryArtifact,
  ToolResult,
  ToolResultDisplay,
} from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { getResponseText } from '../utils/partUtils.js';
import { reportError } from '../utils/errorReporting.js';
import {
  getErrorMessage,
  getErrorStatus,
  UnauthorizedError,
  toFriendlyError,
} from '../utils/errors.js';
import type { LlmChat } from './llm-chat.js';
import type { RetryInfo } from '../utils/rateLimit.js';
import {
  getThoughtSummary,
  type ThoughtSummary,
} from '../utils/thoughtUtils.js';
import type { LoopType } from '../telemetry/types.js';
import type { ActiveGoal } from '../goals/activeGoalStore.js';
import type {
  GoalSnapshotV2,
  GoalStateCause,
  GoalTurnPermit,
} from '../goals/goal-protocol.js';
import { getProviderToolCallId } from './toolCallIdUtils.js';

const ERROR_REPORT_HISTORY_TAIL_COUNT = 8;
const ERROR_REPORT_TEXT_PREVIEW_CHARS = 200;

// Define a structure for tools passed to the server
export interface ServerTool {
  name: string;
  schema: FunctionDeclaration;
  // The execute method signature might differ slightly or be wrapped
  execute(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

export enum LlmEventType {
  Content = 'content',
  ToolCallRequest = 'tool_call_request',
  ToolCallResponse = 'tool_call_response',
  ToolCallConfirmation = 'tool_call_confirmation',
  UserCancelled = 'user_cancelled',
  Error = 'error',
  ChatCompressed = 'chat_compressed',
  Thought = 'thought',
  MaxSessionTurns = 'max_session_turns',
  SessionTokenLimitExceeded = 'session_token_limit_exceeded',
  Finished = 'finished',
  LoopDetected = 'loop_detected',
  Citation = 'citation',
  Retry = 'retry',
  HookSystemMessage = 'hook_system_message',
  UserPromptSubmitBlocked = 'user_prompt_submit_blocked',
  StopHookLoop = 'stop_hook_loop',
  GoalState = 'goal_state',
  ActiveGoal = 'active_goal',
  /** The system switched to a fallback model after the primary (or prior
   *  fallback) exhausted retries on a capacity/availability error. */
  ModelFallback = 'model_fallback',
}

/** @deprecated Use `LlmEventType`; retained until a future major release. */
export { LlmEventType as GeminiEventType };

export type ServerLlmRetryEvent = {
  type: LlmEventType.Retry;
  retryInfo?: RetryInfo;
  /** When true, the retry is a continuation (recovery) rather than a fresh
   *  restart. The UI should keep accumulated text so the continuation appends. */
  isContinuation?: boolean;
};

export type ServerLlmModelFallbackEvent = {
  type: LlmEventType.ModelFallback;
  /** The model that exhausted its retry budget. */
  fromModel: string;
  /** The model the system is switching to. */
  toModel: string;
  /** HTTP status code that triggered the fallback (e.g. 429, 503, 529). */
  statusCode?: number;
  /** 1-based index of the fallback in the configured chain. */
  fallbackIndex: number;
};

export interface StructuredError {
  message: string;
  status?: number;
}

export interface LlmErrorEventValue {
  error: StructuredError;
}

export interface SessionTokenLimitExceededValue {
  currentTokens: number;
  limit: number;
  message: string;
}

export interface LlmFinishedEventValue {
  reason: FinishReason | undefined;
  usageMetadata: GenerateContentResponseUsageMetadata | undefined;
}

/** @deprecated Use `LlmErrorEventValue`; retained until a future major release. */
export type GeminiErrorEventValue = LlmErrorEventValue;

/** @deprecated Use `LlmFinishedEventValue`; retained until a future major release. */
export type GeminiFinishedEventValue = LlmFinishedEventValue;

export interface ToolCallRequestInfo {
  callId: string;
  /**
   * Original tool-call id emitted by the provider/model. When present, this is
   * the idempotency key for suppressing duplicate provider tool calls.
   */
  providerCallId?: string;
  name: string;
  args: Record<string, unknown>;
  isClientInitiated: boolean;
  prompt_id: string;
  response_id?: string;
  /** Set to true when the LLM response was truncated due to max_tokens. */
  wasOutputTruncated?: boolean;
  goalContext?: GoalTurnPermit;
}

export type ToolExecutionStatus =
  | 'not_started'
  | 'success'
  | 'error'
  | 'cancelled';

export interface ToolCallResponseInfo {
  callId: string;
  responseParts: Part[];
  resultDisplay: ToolResultDisplay | undefined;
  error: Error | undefined;
  errorType: ToolErrorType | undefined;
  executionStatus?: ToolExecutionStatus;
  contentLength?: number;
  persistedOutputFiles?: string[];
  modelOverride?: string;
  terminateTurn?: boolean;
  visionBridgeNotice?: string;
  artifacts?: ToolArtifact[];
  boundaryArtifact?: ToolResultBoundaryArtifact;
}

function normalizeRequestParts(req: PartListUnion): Part[] {
  const parts = Array.isArray(req) ? req : [req];
  return parts.map((part) =>
    typeof part === 'string' ? { text: part } : (part as Part),
  );
}

function summarizeParts(parts: Part[]): {
  partCount: number;
  functionCalls: string[];
  functionResponses: string[];
  textPreview: string;
} {
  return {
    partCount: parts.length,
    functionCalls: parts
      .map((part) => part.functionCall?.name)
      .filter((name): name is string => typeof name === 'string'),
    functionResponses: parts
      .map((part) => part.functionResponse?.name)
      .filter((name): name is string => typeof name === 'string'),
    textPreview: (() => {
      let textPreview = '';
      for (const part of parts) {
        if (typeof part.text !== 'string' || part.thought) continue;
        const remaining = ERROR_REPORT_TEXT_PREVIEW_CHARS - textPreview.length;
        if (remaining <= 0) break;
        textPreview += part.text.slice(0, remaining);
      }
      return textPreview;
    })(),
  };
}

function summarizeHistoryEntry(content: Content) {
  return {
    role: content.role,
    ...summarizeParts(content.parts ?? []),
  };
}

function buildApiErrorReportContext(chat: LlmChat, req: PartListUnion) {
  const requestParts = normalizeRequestParts(req);
  return {
    history: {
      rawLength: chat.getHistoryLength(),
      tail: chat
        .getHistoryTailShallow(
          ERROR_REPORT_HISTORY_TAIL_COUNT,
          /* curated */ true,
        )
        .map(summarizeHistoryEntry),
    },
    request: summarizeParts(requestParts),
  };
}

function duplicateProviderToolCallMessage(providerCallId: string): string {
  return (
    `Duplicate provider tool call id "${providerCallId}" was already handled. ` +
    `The duplicate tool call was ignored and not executed again. If you ` +
    `intended to run this tool again, re-issue the call with a new unique ` +
    `tool-call id (or explicitly different arguments).`
  );
}

export function createDuplicateProviderToolCallResponse(
  request: ToolCallRequestInfo,
): ToolCallResponseInfo {
  const providerCallId = request.providerCallId ?? request.callId;
  const message = duplicateProviderToolCallMessage(providerCallId);
  return {
    callId: request.callId,
    responseParts: [
      {
        functionResponse: {
          id: request.callId,
          name: request.name,
          response: { error: message },
        },
      },
    ],
    resultDisplay: message,
    error: new Error(message),
    errorType: ToolErrorType.EXECUTION_FAILED,
    executionStatus: 'not_started',
  };
}

export function markDuplicateProviderToolCallResponseSent(
  providerCallId: string,
  duplicateProviderToolCallResponseIds: Set<string>,
): void {
  duplicateProviderToolCallResponseIds.add(providerCallId);
}

/**
 * Finds the first tool call in `items` that must trip the repeated-duplicate
 * circuit breaker. `isReplayOfHandled` decides whether an item replays an
 * already-handled call (same provider id AND same (name, args) fingerprint
 * — see `isReplayOfHandledToolCall`); an id collision with different args is
 * not a replay and never trips the breaker. A replay trips it once a
 * synthetic duplicate response was already sent for its provider id, or when
 * the same handled id replays more than once within one batch.
 */
export function findRepeatedDuplicateProviderToolCall<T>(
  items: readonly T[],
  getProviderCallId: (item: T) => string | undefined,
  isReplayOfHandled: (item: T) => boolean,
  duplicateProviderToolCallResponseIds: ReadonlySet<string>,
): T | undefined {
  const repeatedProviderIds = new Map<string, number>();
  for (const item of items) {
    const providerCallId = getProviderCallId(item);
    if (!providerCallId || !isReplayOfHandled(item)) {
      continue;
    }
    repeatedProviderIds.set(
      providerCallId,
      (repeatedProviderIds.get(providerCallId) ?? 0) + 1,
    );
  }

  return items.find((item) => {
    const providerCallId = getProviderCallId(item);
    return (
      providerCallId !== undefined &&
      isReplayOfHandled(item) &&
      (duplicateProviderToolCallResponseIds.has(providerCallId) ||
        (repeatedProviderIds.get(providerCallId) ?? 0) > 1)
    );
  });
}

export interface ServerToolCallConfirmationDetails {
  request: ToolCallRequestInfo;
  details: ToolCallConfirmationDetails;
}

export type ServerLlmContentPart =
  | { text: string }
  | {
      inlineData: {
        data: string;
        mimeType: string;
        displayName?: string;
      };
    };

export type ServerLlmContentEvent = {
  type: LlmEventType.Content;
  value: string;
  /** Ordered display parts, present only when the chunk contains an image. */
  parts?: ServerLlmContentPart[];
};

export type ServerLlmThoughtEvent = {
  type: LlmEventType.Thought;
  value: ThoughtSummary;
};

export type ServerLlmToolCallRequestEvent = {
  type: LlmEventType.ToolCallRequest;
  value: ToolCallRequestInfo;
};

export type ServerLlmToolCallResponseEvent = {
  type: LlmEventType.ToolCallResponse;
  value: ToolCallResponseInfo;
};

export type ServerLlmToolCallConfirmationEvent = {
  type: LlmEventType.ToolCallConfirmation;
  value: ServerToolCallConfirmationDetails;
};

export type ServerLlmUserCancelledEvent = {
  type: LlmEventType.UserCancelled;
};

export type ServerLlmErrorEvent = {
  type: LlmEventType.Error;
  value: LlmErrorEventValue;
};

export enum CompressionStatus {
  /** The compression was successful */
  COMPRESSED = 1,

  /** The compression failed due to the compression inflating the token count */
  COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,

  /** The compression failed due to an error counting tokens */
  COMPRESSION_FAILED_TOKEN_COUNT_ERROR,

  /** The compression failed due to receiving an empty or null summary */
  COMPRESSION_FAILED_EMPTY_SUMMARY,

  /** The compression was not necessary and no action was taken */
  NOOP,

  /**
   * The compression call produced a summary, but the output reached the
   * requested output budget — the fixed COMPACT_MAX_OUTPUT_TOKENS ceiling
   * or the window-clamped budget below it (issue #7960) — indicating
   * likely truncation. The summary
   * is dropped (newHistory=null) and the attempt is treated as a failure:
   * `isCompressionFailureStatus` returns true so it counts toward the
   * per-chat circuit breaker. Kept distinct from
   * `COMPRESSION_FAILED_EMPTY_SUMMARY` so telemetry can separate
   * prompt-quality failures (empty / nonsensical summary) from capacity
   * failures (output cap hit, may need a higher cap or finer-grained
   * splitter). (R5.2)
   */
  COMPRESSION_FAILED_OUTPUT_TRUNCATED,
}

/**
 * Why an auto-compaction fired. Drives the user-facing notice so a
 * screenshot-overflow trigger isn't mislabeled as "approached the token
 * limit". Undefined on NOOP / failure paths and for callers that don't set it.
 */
export type CompactionTriggerReason =
  | 'token_limit'
  | 'image_overflow'
  | 'manual';

export interface ChatCompressionInfo {
  originalTokenCount: number;
  newTokenCount: number;
  /**
   * Whether originalTokenCount came from a local estimate rather than an
   * API-reported prompt count. The two compression paths measure on
   * different scales (see #9309): /compress-fast anchors on the last
   * API-reported prompt count (system prompt + tools + history) while a
   * later /compress re-estimates history-only once the stored count is
   * estimate-derived, so UIs must not present the numbers as one chain.
   */
  originalTokenCountIsEstimated?: boolean;
  /** Whether newTokenCount ultimately came from a local estimate. */
  newTokenCountIsEstimated?: boolean;
  compressionStatus: CompressionStatus;
  triggerReason?: CompactionTriggerReason;
  /** Set when the compaction model was swapped for the main model at runtime. */
  warning?: string;
}

export type ServerLlmChatCompressedEvent = {
  type: LlmEventType.ChatCompressed;
  value: ChatCompressionInfo | null;
};

export type ServerLlmMaxSessionTurnsEvent = {
  type: LlmEventType.MaxSessionTurns;
};

export type ServerLlmSessionTokenLimitExceededEvent = {
  type: LlmEventType.SessionTokenLimitExceeded;
  value: SessionTokenLimitExceededValue;
};

export type ServerLlmFinishedEvent = {
  type: LlmEventType.Finished;
  value: LlmFinishedEventValue;
};

export type ServerLlmLoopDetectedEvent = {
  type: LlmEventType.LoopDetected;
  // The loop type is optional so historical call sites that don't produce one
  // (tests, fixtures) stay valid. Real emissions in client.ts always populate
  // it so downstream consumers can surface a concrete reason to the user.
  value?: {
    loopType: LoopType;
  };
};

export type ServerLlmCitationEvent = {
  type: LlmEventType.Citation;
  value: string;
};

export type ServerLlmHookSystemMessageEvent = {
  type: LlmEventType.HookSystemMessage;
  value: string;
};

export type ServerLlmUserPromptSubmitBlockedEvent = {
  type: LlmEventType.UserPromptSubmitBlocked;
  value: {
    reason: string;
    originalPrompt: string;
  };
};

export type ServerLlmStopHookLoopEvent = {
  type: LlmEventType.StopHookLoop;
  value: {
    iterationCount: number;
    reasons: string[];
    stopHookCount: number;
  };
};

export type ServerLlmActiveGoalEvent = {
  type: LlmEventType.ActiveGoal;
  value: ActiveGoal | null;
};

export type ServerLlmGoalStateEvent = {
  type: LlmEventType.GoalState;
  value: GoalSnapshotV2;
  cause?: GoalStateCause;
};

// The original union type, now composed of the individual types
export type ServerLlmStreamEvent =
  | ServerLlmGoalStateEvent
  | ServerLlmActiveGoalEvent
  | ServerLlmChatCompressedEvent
  | ServerLlmCitationEvent
  | ServerLlmContentEvent
  | ServerLlmErrorEvent
  | ServerLlmFinishedEvent
  | ServerLlmHookSystemMessageEvent
  | ServerLlmUserPromptSubmitBlockedEvent
  | ServerLlmStopHookLoopEvent
  | ServerLlmLoopDetectedEvent
  | ServerLlmMaxSessionTurnsEvent
  | ServerLlmModelFallbackEvent
  | ServerLlmThoughtEvent
  | ServerLlmToolCallConfirmationEvent
  | ServerLlmToolCallRequestEvent
  | ServerLlmToolCallResponseEvent
  | ServerLlmUserCancelledEvent
  | ServerLlmSessionTokenLimitExceededEvent
  | ServerLlmRetryEvent;

/** @deprecated Use `ServerLlmRetryEvent`; retained until a future major release. */
export type ServerGeminiRetryEvent = ServerLlmRetryEvent;
/** @deprecated Use `ServerLlmModelFallbackEvent`; retained until a future major release. */
export type ServerGeminiModelFallbackEvent = ServerLlmModelFallbackEvent;
/** @deprecated Use `ServerLlmContentPart`; retained until a future major release. */
export type ServerGeminiContentPart = ServerLlmContentPart;
/** @deprecated Use `ServerLlmContentEvent`; retained until a future major release. */
export type ServerGeminiContentEvent = ServerLlmContentEvent;
/** @deprecated Use `ServerLlmThoughtEvent`; retained until a future major release. */
export type ServerGeminiThoughtEvent = ServerLlmThoughtEvent;
/** @deprecated Use `ServerLlmToolCallRequestEvent`; retained until a future major release. */
export type ServerGeminiToolCallRequestEvent = ServerLlmToolCallRequestEvent;
/** @deprecated Use `ServerLlmToolCallResponseEvent`; retained until a future major release. */
export type ServerGeminiToolCallResponseEvent = ServerLlmToolCallResponseEvent;
/** @deprecated Use `ServerLlmToolCallConfirmationEvent`; retained until a future major release. */
export type ServerGeminiToolCallConfirmationEvent =
  ServerLlmToolCallConfirmationEvent;
/** @deprecated Use `ServerLlmUserCancelledEvent`; retained until a future major release. */
export type ServerGeminiUserCancelledEvent = ServerLlmUserCancelledEvent;
/** @deprecated Use `ServerLlmErrorEvent`; retained until a future major release. */
export type ServerGeminiErrorEvent = ServerLlmErrorEvent;
/** @deprecated Use `ServerLlmChatCompressedEvent`; retained until a future major release. */
export type ServerGeminiChatCompressedEvent = ServerLlmChatCompressedEvent;
/** @deprecated Use `ServerLlmMaxSessionTurnsEvent`; retained until a future major release. */
export type ServerGeminiMaxSessionTurnsEvent = ServerLlmMaxSessionTurnsEvent;
/** @deprecated Use `ServerLlmSessionTokenLimitExceededEvent`; retained until a future major release. */
export type ServerGeminiSessionTokenLimitExceededEvent =
  ServerLlmSessionTokenLimitExceededEvent;
/** @deprecated Use `ServerLlmFinishedEvent`; retained until a future major release. */
export type ServerGeminiFinishedEvent = ServerLlmFinishedEvent;
/** @deprecated Use `ServerLlmLoopDetectedEvent`; retained until a future major release. */
export type ServerGeminiLoopDetectedEvent = ServerLlmLoopDetectedEvent;
/** @deprecated Use `ServerLlmCitationEvent`; retained until a future major release. */
export type ServerGeminiCitationEvent = ServerLlmCitationEvent;
/** @deprecated Use `ServerLlmHookSystemMessageEvent`; retained until a future major release. */
export type ServerGeminiHookSystemMessageEvent =
  ServerLlmHookSystemMessageEvent;
/** @deprecated Use `ServerLlmUserPromptSubmitBlockedEvent`; retained until a future major release. */
export type ServerGeminiUserPromptSubmitBlockedEvent =
  ServerLlmUserPromptSubmitBlockedEvent;
/** @deprecated Use `ServerLlmStopHookLoopEvent`; retained until a future major release. */
export type ServerGeminiStopHookLoopEvent = ServerLlmStopHookLoopEvent;
/** @deprecated Use `ServerLlmActiveGoalEvent`; retained until a future major release. */
export type ServerGeminiActiveGoalEvent = ServerLlmActiveGoalEvent;
/** @deprecated Use `ServerLlmGoalStateEvent`; retained until a future major release. */
export type ServerGeminiGoalStateEvent = ServerLlmGoalStateEvent;
/** @deprecated Use `ServerLlmStreamEvent`; retained until a future major release. */
export type ServerGeminiStreamEvent = ServerLlmStreamEvent;

function getDisplayContentParts(
  response: GenerateContentResponse,
): ServerLlmContentPart[] {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const displayParts: ServerLlmContentPart[] = [];

  for (const part of parts) {
    if (part.thought) {
      continue;
    }
    if (typeof part.text === 'string' && part.text.length > 0) {
      displayParts.push({ text: part.text });
    }
    const inlineData = part.inlineData;
    if (
      inlineData?.mimeType?.trim().toLowerCase().startsWith('image/') &&
      typeof inlineData.data === 'string' &&
      inlineData.data.length > 0
    ) {
      displayParts.push({
        inlineData: {
          data: inlineData.data,
          mimeType: inlineData.mimeType,
          ...(typeof inlineData.displayName === 'string'
            ? { displayName: inlineData.displayName }
            : {}),
        },
      });
    }
  }

  return displayParts;
}

// A turn manages the agentic loop turn within the server context.
export class Turn {
  readonly pendingToolCalls: ToolCallRequestInfo[] = [];
  private pendingCitations = new Set<string>();
  finishReason: FinishReason | undefined = undefined;
  private currentResponseId?: string;
  private readonly goalContext?: GoalTurnPermit;

  constructor(
    private readonly chat: LlmChat,
    private readonly prompt_id: string,
    goalContext?: GoalTurnPermit,
  ) {
    this.goalContext = goalContext ? { ...goalContext } : undefined;
  }
  // The run method yields simpler events suitable for server logic
  async *run(
    model: string,
    req: PartListUnion,
    signal: AbortSignal,
  ): AsyncGenerator<ServerLlmStreamEvent> {
    try {
      // Note: This assumes `sendMessageStream` yields events like
      // { type: StreamEventType.RETRY } or { type: StreamEventType.CHUNK, value: GenerateContentResponse }
      const responseStream = await this.chat.sendMessageStream(
        model,
        {
          message: req,
          config: {
            abortSignal: signal,
          },
        },
        this.prompt_id,
        this.goalContext,
      );

      for await (const streamEvent of responseStream) {
        if (signal?.aborted) {
          yield { type: LlmEventType.UserCancelled };
          return;
        }

        // Handle the new RETRY event: clear accumulated state from the
        // previous attempt to avoid duplicate tool calls and stale metadata.
        if (streamEvent.type === 'retry') {
          this.pendingToolCalls.length = 0;
          this.pendingCitations.clear();
          this.finishReason = undefined;
          yield {
            type: LlmEventType.Retry,
            retryInfo: streamEvent.retryInfo,
            isContinuation: streamEvent.isContinuation,
          };
          continue; // Skip to the next event in the stream
        }

        // Surface model fallback transitions from the chat stream as the
        // top-level ModelFallback event. The UI uses this to notify the user
        // that the system switched to a different model due to capacity issues.
        if (streamEvent.type === 'model_fallback') {
          // Clear accumulated state from the failed model's partial response
          this.pendingToolCalls.length = 0;
          this.pendingCitations.clear();
          this.finishReason = undefined;
          this.currentResponseId = undefined;
          yield {
            type: LlmEventType.ModelFallback,
            fromModel: streamEvent.info.fromModel,
            toModel: streamEvent.info.toModel,
            statusCode: streamEvent.info.statusCode,
            fallbackIndex: streamEvent.info.fallbackIndex,
          };
          continue;
        }

        // Surface auto-compaction that fired inside chat.sendMessageStream
        // as the top-level ChatCompressed event so existing UI handlers stay
        // connected. This bridge is the primary path for auto-compaction
        // events; manual /compress emits its own ChatCompressed in
        // LlmClient.tryCompressChat.
        if (streamEvent.type === 'compressed') {
          yield {
            type: LlmEventType.ChatCompressed,
            value: streamEvent.info,
          };
          continue;
        }

        // Assuming other events are chunks with a `value` property
        const resp = streamEvent.value as GenerateContentResponse;
        if (!resp) continue; // Skip if there's no response body

        // Track the current response ID for tool call correlation
        if (resp.responseId) {
          this.currentResponseId = resp.responseId;
        }

        const thoughtSummary = getThoughtSummary(resp);
        if (thoughtSummary) {
          yield {
            type: LlmEventType.Thought,
            value: thoughtSummary,
          };
        }

        const text = getResponseText(resp) ?? '';
        const displayParts = getDisplayContentParts(resp);
        const hasImage = displayParts.some((part) => 'inlineData' in part);
        if (text || hasImage) {
          yield {
            type: LlmEventType.Content,
            value: text,
            ...(hasImage ? { parts: displayParts } : {}),
          };
        }

        // Handle function calls (requesting tool execution)
        const functionCalls = resp.functionCalls ?? [];
        for (const fnCall of functionCalls) {
          const event = this.handlePendingFunctionCall(fnCall);
          if (event) {
            yield event;
          }
        }

        for (const citation of getCitations(resp)) {
          this.pendingCitations.add(citation);
        }

        // Check if response was truncated or stopped for various reasons
        const finishReason = resp.candidates?.[0]?.finishReason;

        // This is the key change: Only yield 'Finished' if there is a finishReason.
        if (finishReason) {
          // Mark pending tool calls so downstream can distinguish
          // truncation from real parameter errors.
          if (finishReason === FinishReason.MAX_TOKENS) {
            for (const tc of this.pendingToolCalls) {
              tc.wasOutputTruncated = true;
            }
          }

          if (this.pendingCitations.size > 0) {
            yield {
              type: LlmEventType.Citation,
              value: `Citations:\n${[...this.pendingCitations].sort().join('\n')}`,
            };
            this.pendingCitations.clear();
          }

          this.finishReason = finishReason;
          yield {
            type: LlmEventType.Finished,
            value: {
              reason: finishReason,
              usageMetadata: resp.usageMetadata,
            },
          };
        }
      }
    } catch (e) {
      if (signal.aborted) {
        yield { type: LlmEventType.UserCancelled };
        // Regular cancellation error, fail gracefully.
        return;
      }

      const originalStatus = getErrorStatus(e);
      const error = toFriendlyError(e);
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      let contextForReport: Record<string, unknown>;
      try {
        contextForReport = buildApiErrorReportContext(this.chat, req);
      } catch (diagError) {
        contextForReport = {
          history: {
            error: 'failed to build diagnostic summary',
            cause:
              diagError instanceof Error
                ? { message: diagError.message, stack: diagError.stack }
                : String(diagError),
          },
          request: summarizeParts(normalizeRequestParts(req)),
        };
      }
      await reportError(
        error,
        'Error when talking to API',
        contextForReport,
        'Turn.run-sendMessageStream',
        { contextAlreadySummarized: true },
      );
      const structuredError: StructuredError = {
        message: getErrorMessage(error),
        status: getErrorStatus(error) ?? originalStatus,
      };
      await this.chat.maybeIncludeSchemaDepthContext(structuredError);
      yield { type: LlmEventType.Error, value: { error: structuredError } };
      return;
    }
  }

  private handlePendingFunctionCall(
    fnCall: FunctionCall,
  ): ServerLlmStreamEvent | null {
    const callId =
      fnCall.id ??
      `${fnCall.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const providerCallId = getProviderToolCallId(fnCall) ?? fnCall.id;
    const name = fnCall.name || 'undefined_tool_name';
    const args = (fnCall.args || {}) as Record<string, unknown>;

    const toolCallRequest: ToolCallRequestInfo = {
      callId,
      ...(providerCallId ? { providerCallId } : {}),
      name,
      args,
      isClientInitiated: false,
      prompt_id: this.prompt_id,
      response_id: this.currentResponseId,
      ...(this.goalContext ? { goalContext: { ...this.goalContext } } : {}),
    };

    this.pendingToolCalls.push(toolCallRequest);

    // Yield a request for the tool call, not the pending/confirming status
    return { type: LlmEventType.ToolCallRequest, value: toolCallRequest };
  }
}

function getCitations(resp: GenerateContentResponse): string[] {
  return (resp.candidates?.[0]?.citationMetadata?.citations ?? [])
    .filter((citation) => citation.uri !== undefined)
    .map((citation) => {
      if (citation.title) {
        return `(${citation.title}) ${citation.uri}`;
      }
      return citation.uri!;
    });
}
