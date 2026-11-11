/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';
import type { ModelStopReason } from '../provider/event/modelStreamEvent.js';
import type { QueryEvent, Terminal } from '../core/query-event.js';

/** Why Conversation asks for another model request. */
export type RequestReason =
  | 'initial'
  | 'tool_results'
  | 'stop_hook'
  | 'escalation'
  | 'truncation'
  | 'malformed'
  | 'ptl'
  | 'reactive_compact'
  | 'stream_recovery';

export type QueryCancelReason =
  | 'abort'
  | 'consumer_return'
  | 'consumer_throw'
  | 'conversation_failed';

export type ToolCancelReason =
  | 'refusal'
  | 'terminal_interruption'
  | 'request_failed';

export type LlmOutcome = 'complete' | 'interrupted' | 'failed';

export type LlmFailureKind =
  /** Cancelled before the request was sent. */
  | 'aborted_before_request'
  /** Cancelled while the request was in flight. */
  | 'aborted'
  | 'ptl'
  | 'max_tokens_escalatable'
  | 'refusal_406'
  | 'context_limit'
  | 'reactive_compact_failed'
  | 'transport';

export type HandlerName = 'conversation' | 'llm' | 'tool' | 'query';

export interface LlmSettledData {
  outcome: LlmOutcome;
  failure?: LlmFailureKind;
  stopReason?: ModelStopReason;
  nextMaxOutputTokens?: number;
  /** Last assistant message of this response; tool results pair with it. */
  assistantMessageUuid?: string;
  /** Final tool calls of the response; for failures, the dispatched ones. */
  toolUseIds: string[];
  dispatchedToolUseIds: string[];
  terminalInterruption: boolean;
  requestSent: boolean;
}

export interface ToolSettledData {
  toolUseIds: string[];
  permissionDenialCount: number;
  terminalReason?: string;
  hasUnknownOutcomes: boolean;
  stopRequested: boolean;
  /** Settled by stopExecution after a cancellation. */
  bounded: boolean;
}

export interface QueryBusEventMap {
  'query.submitted': Record<string, never>;
  'query.output': { event: QueryEvent };
  'query.cancelled': { reason: QueryCancelReason; signalReason?: unknown };
  'query.finished': { reason: Terminal['reason'] | 'thrown' };
  'llm.request': { reason: RequestReason; requestIndex: number };
  'llm.tool_use': {
    block: ModelToolUseBlock;
    responseId: string;
    assistantMessageUuid?: string;
  };
  'llm.settled': LlmSettledData;
  'tool.cancel': { reason: ToolCancelReason };
  'tool.settled': ToolSettledData;
  /** The only event carrying a native Error; serialize it before crossing processes. */
  'handler.failed': {
    source: HandlerName;
    eventType: QueryBusEventType;
    roundId?: string;
    error: unknown;
  };
}

export type QueryBusEventType = keyof QueryBusEventMap;

export interface BusEvent<T extends QueryBusEventType = QueryBusEventType> {
  /** Dedup key. */
  eventId: string;
  type: T;
  /** Attribution only; never a routing key. */
  sessionId: string;
  /** Routing key. */
  queryId: string;
  parentQueryId?: string;
  roundId?: string;
  data: QueryBusEventMap[T];
}

export type AnyBusEvent = {
  [T in QueryBusEventType]: BusEvent<T>;
}[QueryBusEventType];
