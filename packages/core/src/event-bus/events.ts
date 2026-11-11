/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentLoopResult,
  AgentLoopRound,
  AgentLoopSettledCall,
  AgentLoopStopReason,
} from '../core/agent-loop.js';
import type {
  ServerLlmStreamEvent,
  ToolCallRequestInfo,
} from '../core/turn.js';

/** The handlers that publish and consume loop events. */
export type HandlerName = 'conversation' | 'llm' | 'tool' | 'loop';

export interface LlmSettledData {
  round: number;
  /** Tool calls the round collected, in request order. */
  calls: ToolCallRequestInfo[];
  /** Calls dropped by a Retry/ModelFallback during the round. */
  discardedCalls: ToolCallRequestInfo[];
  /** Present only when the round ended the loop with a terminal reason. */
  terminal?: AgentLoopStopReason;
}

export interface ToolSettledData {
  round: number;
  results: AgentLoopSettledCall[];
}

/**
 * The loop event vocabulary, expressed over main's agent-loop types. Ported
 * from the v1.0.0-preview event map (587e3429cabf); `query.*` becomes `loop.*`
 * and the UUID round id becomes main's numeric round.
 */
export interface LoopBusEventMap {
  'loop.started': { promptId: string };
  'loop.output': { event: ServerLlmStreamEvent };
  'loop.cancelled': { reason: string };
  'loop.finished': { result: AgentLoopResult };
  'llm.request': { round: number; send: AgentLoopRound };
  'llm.tool_call': { call: ToolCallRequestInfo };
  'llm.settled': LlmSettledData;
  'tool.cancel': { reason: string };
  'tool.settled': ToolSettledData;
  /** The only event carrying a native Error; serialize before crossing processes. */
  'handler.failed': {
    source: HandlerName;
    eventType: LoopBusEventType;
    round?: number;
    error: unknown;
  };
}

export type LoopBusEventType = keyof LoopBusEventMap;

export interface BusEvent<T extends LoopBusEventType = LoopBusEventType> {
  /** Dedup key. */
  eventId: string;
  type: T;
  /** Routing key: one run of the agent loop. */
  runId: string;
  /** Attribution only; never a routing key. */
  promptId?: string;
  /** The round an event belongs to, when round-scoped. */
  round?: number;
  data: LoopBusEventMap[T];
}

export type AnyBusEvent = {
  [T in LoopBusEventType]: BusEvent<T>;
}[LoopBusEventType];
