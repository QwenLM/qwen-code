/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptContentBlock } from './types.js';

export type DaemonManagedSessionPhase =
  | 'admitted'
  | 'runtime_starting'
  | 'agent_running'
  | 'waiting_runtime'
  | 'tool_running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DaemonManagedRuntimeState =
  | 'unknown'
  | 'starting'
  | 'ready'
  | 'failed';

export interface DaemonManagedSessionSummary {
  sessionId: string;
  promptId: string;
  title: string;
  workspaceCwd: string;
  createdAt: number;
  admittedAt: number;
  updatedAt: number;
  phase: DaemonManagedSessionPhase;
  runtimeReady: boolean;
  runtimeState: DaemonManagedRuntimeState;
  capabilities: { canSend: boolean; canCancel: boolean };
  failure?: { code: string; message: string };
}

export interface DaemonManagedSessionList {
  sessions: DaemonManagedSessionSummary[];
  nextCursor?: string;
}

export type DaemonManagedSessionEventType =
  | 'accepted'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'runtime_failed'
  | 'runtime_released'
  | 'agent_started'
  | 'assistant_thought'
  | 'assistant_delta'
  | 'tool_requested'
  | 'tool_started'
  | 'tool_completed'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'stream_gap';

export interface DaemonManagedSessionEvent {
  id: number;
  at: number;
  type: DaemonManagedSessionEventType;
  sessionId: string;
  promptId: string;
  data?: unknown;
}

export interface DaemonManagedSessionTranscript {
  events: DaemonManagedSessionEvent[];
  olderCursor?: string;
  lastEventId: number;
}

export interface DaemonManagedPromptRequest {
  prompt: PromptContentBlock[];
  deadlineMs?: number;
}

export interface DaemonManagedSessionCreateRequest
  extends DaemonManagedPromptRequest {
  cwd?: string;
}

export interface DaemonManagedPromptAdmission {
  managed: true;
  sessionId: string;
  promptId: string;
  created: boolean;
  state: 'admitted' | 'processing' | 'finished';
  activationReady: boolean;
  eventStreamAvailable: boolean;
  phase: DaemonManagedSessionPhase;
  eventPath?: string;
  statusPath?: string;
}

export interface DaemonManagedRequestOptions {
  /** Stable caller correlation within the authenticated daemon connection. */
  clientId: string;
  signal?: AbortSignal;
}

export function isManagedSessionEvent(
  value: unknown,
): value is DaemonManagedSessionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(event['id']) &&
    (event['id'] as number) >= 0 &&
    typeof event['at'] === 'number' &&
    Number.isFinite(event['at']) &&
    typeof event['type'] === 'string' &&
    typeof event['sessionId'] === 'string' &&
    typeof event['promptId'] === 'string'
  );
}
