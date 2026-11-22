/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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

export type HookLifecycleRecord = HookLifecycleEvent & {
  'event.name': 'hook_lifecycle';
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseHookLifecycle(
  value: unknown,
): HookLifecycleEvent | undefined {
  if (
    !object(value) ||
    value['v'] !== 1 ||
    value['kind'] !== 'hook' ||
    value['agentId'] !== null
  )
    return undefined;
  const strings: Record<string, string> = {};
  for (const key of [
    'executionId',
    'runtimeId',
    'sessionId',
    'promptId',
    'eventName',
    'name',
  ]) {
    const field = value[key];
    if (typeof field !== 'string' || !field.trim()) return undefined;
    strings[key] = field;
  }
  const hookType = value['hookType'];
  const source = value['source'];
  if (
    hookType !== 'command' &&
    hookType !== 'http' &&
    hookType !== 'function' &&
    hookType !== 'prompt'
  )
    return undefined;
  if (
    source !== 'system' &&
    source !== 'user' &&
    source !== 'project' &&
    source !== 'extensions' &&
    source !== 'session' &&
    source !== 'unknown'
  )
    return undefined;
  const startedAt = value['startedAt'];
  if (!finite(startedAt)) return undefined;
  const base: HookLifecycleBase = {
    v: 1,
    kind: 'hook',
    executionId: strings['executionId']!,
    runtimeId: strings['runtimeId']!,
    sessionId: strings['sessionId']!,
    promptId: strings['promptId']!,
    agentId: null,
    eventName: strings['eventName']!,
    hookType,
    source,
    name: strings['name']!.replace(/\p{Cc}/gu, '').slice(0, 80) || hookType,
    startedAt,
  };
  if (value['phase'] === 'started') return { ...base, phase: 'started' };
  if (value['phase'] === 'dispatched') {
    if (
      !finite(value['dispatchedAt']) ||
      value['dispatchedAt'] < startedAt ||
      !finite(value['dispatchDurationMs'])
    )
      return undefined;
    return {
      ...base,
      phase: 'dispatched',
      dispatchedAt: value['dispatchedAt'],
      dispatchDurationMs: value['dispatchDurationMs'],
    };
  }
  const outcome = value['outcome'];
  if (
    value['phase'] !== 'ended' ||
    !finite(value['endedAt']) ||
    value['endedAt'] < startedAt ||
    !finite(value['durationMs'])
  )
    return undefined;
  if (
    outcome !== 'success' &&
    outcome !== 'blocked' &&
    outcome !== 'error' &&
    outcome !== 'timeout' &&
    outcome !== 'cancelled'
  )
    return undefined;
  const exitCode = value['exitCode'];
  if (
    exitCode !== undefined &&
    (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))
  )
    return undefined;
  return {
    ...base,
    phase: 'ended',
    endedAt: value['endedAt'],
    durationMs: value['durationMs'],
    outcome,
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
  };
}

export function createHookLifecycleState(): HookLifecycleState {
  return { entries: new Map() };
}

export function mergeHookExecution(
  prior: HookExecutionEntry | undefined,
  event: HookLifecycleEvent,
  source: 'live' | 'replay',
): HookExecutionEntry {
  const identity = (entry: HookLifecycleEvent) =>
    JSON.stringify([
      entry.runtimeId,
      entry.promptId,
      entry.agentId,
      entry.eventName,
      entry.hookType,
      entry.source,
      entry.name,
      entry.startedAt,
    ]);
  const conflict =
    prior !== undefined &&
    (identity(prior.event) !== identity(event) ||
      (prior.event.phase !== 'started' &&
        event.phase !== 'started' &&
        JSON.stringify(prior.event) !== JSON.stringify(event)));
  const kept =
    prior && (conflict || prior.event.phase !== 'started')
      ? prior.event
      : event;
  const status =
    kept.phase === 'ended'
      ? kept.outcome
      : kept.phase === 'dispatched'
        ? 'dispatched'
        : prior?.status === 'running' || source === 'live'
          ? 'running'
          : 'unknown';
  const conflicted = conflict || prior?.conflicted === true;
  if (
    prior &&
    JSON.stringify(prior.event) === JSON.stringify(kept) &&
    prior.status === status &&
    prior.conflicted === conflicted
  )
    return prior;
  return { event: kept, status, conflicted };
}

export function reduceHookLifecycle(
  state: HookLifecycleState,
  event: HookLifecycleEvent | readonly HookLifecycleEvent[],
  options: { source: 'live' | 'replay' },
): HookLifecycleState {
  let entries: Map<string, HookExecutionEntry> | undefined;
  for (const next of 'phase' in event ? [event] : event) {
    const key = JSON.stringify([next.sessionId, next.executionId]);
    const prior = (entries ?? state.entries).get(key);
    const entry = mergeHookExecution(prior, next, options.source);
    if (entry === prior) continue;
    entries ??= new Map(state.entries);
    entries.set(key, entry);
  }
  return entries ? { entries } : state;
}

export function summarizeHookExecutions(
  entries: Iterable<HookExecutionEntry>,
): HookLifecycleSummary {
  const summary: HookLifecycleSummary = {
    totalExecutions: 0,
    counts: {
      running: 0,
      unknown: 0,
      dispatched: 0,
      success: 0,
      blocked: 0,
      error: 0,
      timeout: 0,
      cancelled: 0,
    },
    durationMs: 0,
    durationComplete: true,
  };
  for (const entry of entries) {
    summary.totalExecutions++;
    summary.counts[entry.status]++;
    if (entry.event.phase === 'ended' && !entry.conflicted)
      summary.durationMs += entry.event.durationMs;
    else summary.durationComplete = false;
  }
  return summary;
}
