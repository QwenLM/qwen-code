/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantBlockEvent, StreamEvent } from '../core/query-event.js';
import type { SystemMessage } from '../protocol/transcript/message.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';

import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import type { ModelPartialMessage } from '../provider/aggregate/modelPartialMessage.js';
import type { ModelResponseDelivery } from '../core/model-response-to-query-event.js';

export type ModelRequestOrigin = string;

/** Passive request observations. No prompt, response body or credentials. */
export interface ModelRequestObservation {
  kind:
    | 'request_started'
    | 'request_finished'
    | 'retry_decision'
    | 'retry_finished'
    | 'physical'
    | 'queue';
  request_id: string;
  initial_request_id: string;
  model: string;
  at_ms: number;
  /** The active Provider's attempt position, when available. */
  attempt?: number;
  data: Record<string, unknown>;
}

export type ModelRequestObserver = (record: ModelRequestObservation) => void;

export interface ModelRequestCompletedSnapshot {
  requestId: string;
  model: string;
  ttftMs: number;
  durationMs: number;
  usage: NonNullableUsage;
  thinkingTokens: number;
  finishReason: string;
}

export interface ModelRequestFinishedSnapshot {
  requestId: string;
  model: string;
  success: boolean;
  /** Actual inference submissions made for this logical model request. */
  attemptCount: number;
  /** Runtime retry signals observed for this logical model request. */
  retryCount: number;
  finishReason?: string;
  failureReason?: string;
}

export interface ModelRequestDiagnostic {
  loopId: string;
  requestIndex: number;
  requestMessageCount: number;
  toolSchemaCount: number;
  taskId?: string;
  isSubagent?: boolean;
  querySource?: string;
  userMessageTiming?: {
    submittedAtMs: number;
    /** First logical main-model call; retries retain this owner across request IDs. */
    firstModelRequestId?: string;
    firstRequestId?: string;
    /** SDK timing keeps its legacy transport-handle-return boundary. */
    firstTransportHandleRequestId?: string;
    latencyMs?: number;
    hookTiming?: { count: number; blockingMs: number };
    extra?: Record<string, unknown>;
    requestExtra?: Record<string, number>;
  };
  onCompleted?: (completion: ModelRequestCompletedSnapshot) => void;
  onFinished?: (result: ModelRequestFinishedSnapshot) => void;
  /** Best-effort observations; throwing must never affect inference or retries. */
  onObservation?: ModelRequestObserver;
  isWorkflowAgent?: boolean;
}

export type ModelRequestRunnerEvent =
  | StreamEvent
  | AssistantBlockEvent
  | SystemMessage;

export type ModelQueueStatusSystemMessage = SystemMessage & {
  subtype: 'model_queue_status';
  status: 'queued' | 'ready';
  request_id: string;
  request_set_id: string;
  model_key: string;
  queue_type?: string;
  queue_count?: number;
  wait_time_ms?: number;
  queue_wait_elapsed_ms?: number;
  queue_max_wait_ms?: number;
  service_available?: boolean;
};

export interface QueueNotificationState {
  emitted: boolean;
  lastEmittedAt: number;
  lastQueueCount?: number;
  lastWaitTimeMs?: number;
}

export type ModelRequestOutcome =
  | {
      kind: 'complete';
      requestId: string;
      message: ModelMessage;
    }
  | {
      kind: 'interrupted';
      requestId: string;
      message: ModelPartialMessage;
      /** 宿主消费边界与模型终态内容分开保存。 */
      delivery: ModelResponseDelivery;
      failure: {
        error: unknown;
        kind: 'transport' | 'abort' | 'refusal' | 'terminal';
        usageSource: 'partial' | 'unavailable';
      };
    };
