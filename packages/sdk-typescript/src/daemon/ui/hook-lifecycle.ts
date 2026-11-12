/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseHookLifecycle as parse,
  createHookLifecycleState as create,
  reduceHookLifecycle as reduce,
  summarizeHookExecutions as summarize,
} from '@qwen-code/qwen-code-core/telemetry/hook-lifecycle-contract.js';
import { isRecord } from './utils.js';

export type HookLifecycleOutcome =
  | 'success'
  | 'blocked'
  | 'error'
  | 'timeout'
  | 'cancelled';
export type HookLifecycleSource =
  | 'system'
  | 'user'
  | 'project'
  | 'extensions'
  | 'session'
  | 'unknown';

export interface HookLifecycleBase {
  v: 1;
  kind: 'hook';
  executionId: string;
  runtimeId: string;
  sessionId: string;
  promptId: string;
  agentId: null;
  eventName: string;
  hookType: 'command' | 'http' | 'function' | 'prompt';
  source: HookLifecycleSource;
  name: string;
  startedAt: number;
}

export type HookLifecycleEvent = HookLifecycleBase &
  (
    | { phase: 'started' }
    | {
        phase: 'ended';
        endedAt: number;
        durationMs: number;
        outcome: HookLifecycleOutcome;
        exitCode?: number;
      }
    | { phase: 'dispatched'; dispatchedAt: number; dispatchDurationMs: number }
  );

export interface HookExecutionEntry {
  event: HookLifecycleEvent;
  status: 'running' | 'unknown' | 'dispatched' | HookLifecycleOutcome;
  conflicted: boolean;
}

export interface HookLifecycleState {
  entries: ReadonlyMap<string, HookExecutionEntry>;
}

export interface HookLifecycleSummary {
  totalExecutions: number;
  counts: Record<HookExecutionEntry['status'], number>;
  durationMs: number;
  durationComplete: boolean;
}

export interface HookTurnPage {
  sessionId: string;
  promptId: string;
  snapshot: string;
  start: number;
  totalExecutions: number;
  executions: HookExecutionEntry[];
  summary: HookLifecycleSummary | null;
  nextStart?: number;
  coverage: 'recorded' | 'unrecorded' | 'partial' | 'unsupported';
}

export function parseHookLifecycle(
  value: unknown,
): HookLifecycleEvent | undefined {
  return parse(value);
}
export function extractHookLifecycle(
  update: unknown,
): HookLifecycleEvent | undefined {
  return isRecord(update) && isRecord(update['_meta'])
    ? parse(update['_meta']['hookLifecycle'])
    : undefined;
}
export function createHookLifecycleState(): HookLifecycleState {
  return create();
}
export function reduceHookLifecycle(
  state: HookLifecycleState,
  update: unknown,
  options: { source: 'live' | 'replay' },
): HookLifecycleState {
  const event = extractHookLifecycle(update);
  return event ? reduce(state, event, options) : state;
}
export function summarizeHookExecutions(
  entries: Iterable<HookExecutionEntry>,
): HookLifecycleSummary {
  return summarize(entries);
}
