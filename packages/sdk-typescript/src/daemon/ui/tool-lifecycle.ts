/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { isRecord } from './utils.js';
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
export type DaemonToolLifecycle = {
  readonly v: 1;
  readonly kind: 'tool';
  readonly executionId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly subagentId?: string;
} & (
  | {
      readonly phase: 'started';
      readonly executionStatus: 'running';
      readonly startedAt: number;
    }
  | {
      readonly phase: 'ended';
      readonly executionStatus: 'not_started';
      readonly endedAt: number;
      readonly outcome: 'success' | 'error' | 'cancelled';
    }
  | {
      readonly phase: 'ended';
      readonly executionStatus: 'success' | 'error' | 'cancelled';
      readonly startedAt: number;
      readonly endedAt: number;
      readonly executionDurationMs: number;
      readonly outcome: 'success' | 'error' | 'cancelled';
    }
);

function parseToolLifecycle(value: unknown): DaemonToolLifecycle | undefined {
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'tool')
    return undefined;
  const strings: Record<string, string> = {};
  for (const key of ['executionId', 'sessionId', 'callId', 'toolName']) {
    const entry = value[key];
    if (typeof entry !== 'string' || !entry.trim()) return undefined;
    strings[key] = entry;
  }
  const subagentId = value['subagentId'];
  if (
    subagentId !== undefined &&
    (typeof subagentId !== 'string' || !subagentId.trim())
  )
    return undefined;
  const shared = {
    v: 1 as const,
    kind: 'tool' as const,
    executionId: strings['executionId']!,
    sessionId: strings['sessionId']!,
    callId: strings['callId']!,
    toolName: strings['toolName']!,
    ...(typeof subagentId === 'string' ? { subagentId } : {}),
  };
  const startedAt = finiteNumber(value['startedAt']);
  if (value['phase'] === 'started') {
    if (
      value['executionStatus'] !== 'running' ||
      startedAt === undefined ||
      startedAt < 0 ||
      value['endedAt'] !== undefined ||
      value['outcome'] !== undefined ||
      value['executionDurationMs'] !== undefined
    )
      return undefined;
    return {
      ...shared,
      phase: 'started',
      executionStatus: 'running',
      startedAt,
    };
  }
  if (value['phase'] !== 'ended') return undefined;
  const endedAt = finiteNumber(value['endedAt']);
  const outcome = value['outcome'];
  if (
    endedAt === undefined ||
    endedAt < 0 ||
    (outcome !== 'success' && outcome !== 'error' && outcome !== 'cancelled')
  )
    return undefined;
  const executionStatus = value['executionStatus'];
  if (executionStatus === 'not_started') {
    if (
      value['startedAt'] !== undefined ||
      value['executionDurationMs'] !== undefined
    )
      return undefined;
    return { ...shared, phase: 'ended', executionStatus, endedAt, outcome };
  }
  const executionDurationMs = finiteNumber(value['executionDurationMs']);
  if (
    (executionStatus !== 'success' &&
      executionStatus !== 'error' &&
      executionStatus !== 'cancelled') ||
    startedAt === undefined ||
    startedAt < 0 ||
    endedAt < startedAt ||
    executionDurationMs === undefined ||
    executionDurationMs < 0
  )
    return undefined;
  return {
    ...shared,
    phase: 'ended',
    executionStatus,
    startedAt,
    endedAt,
    executionDurationMs,
    outcome,
  };
}

export function extractToolLifecycle(
  update: unknown,
): DaemonToolLifecycle | undefined {
  if (!isRecord(update) || !isRecord(update['_meta'])) return undefined;
  return parseToolLifecycle(update['_meta']['toolLifecycle']);
}
export interface ToolLifecycleEntry {
  readonly event: DaemonToolLifecycle;
  readonly status:
    | 'running'
    | 'unknown'
    | 'not_started'
    | 'success'
    | 'error'
    | 'cancelled';
  readonly conflicted: boolean;
}
export interface ToolLifecycleState {
  readonly entries: ReadonlyMap<string, ToolLifecycleEntry>;
}
export function createToolLifecycleState(): ToolLifecycleState {
  return { entries: new Map() };
}
export function reduceToolLifecycle(
  state: ToolLifecycleState,
  input: unknown,
  options: { source: 'live' | 'replay'; maxEntries?: number },
): ToolLifecycleState {
  const event = extractToolLifecycle(input);
  if (!event) return state;
  const key = JSON.stringify([
    event.sessionId,
    event.subagentId ?? null,
    event.executionId,
  ]);
  const prior = state.entries.get(key);
  const startOf = (item: DaemonToolLifecycle) =>
    'startedAt' in item ? item.startedAt : undefined;
  const conflicts =
    prior !== undefined &&
    (prior.event.callId !== event.callId ||
      prior.event.toolName !== event.toolName ||
      (startOf(prior.event) !== undefined &&
        startOf(event) !== undefined &&
        startOf(prior.event) !== startOf(event)) ||
      (prior.event.phase === 'ended' &&
        event.phase === 'ended' &&
        JSON.stringify(prior.event) !== JSON.stringify(event)) ||
      (prior.event.phase === 'ended' &&
        prior.event.executionStatus === 'not_started' &&
        event.phase === 'started') ||
      (prior.event.phase === 'started' &&
        event.phase === 'ended' &&
        event.executionStatus === 'not_started'));
  const kept =
    prior?.event.phase === 'ended' || conflicts ? prior!.event : event;
  const status =
    kept.phase === 'ended'
      ? kept.executionStatus
      : prior?.status === 'running' || options.source === 'live'
        ? 'running'
        : 'unknown';
  const conflicted = (prior?.conflicted ?? false) || conflicts;
  const requestedLimit = options.maxEntries ?? 256;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(256, Math.floor(requestedLimit)))
    : 256;
  if (
    prior &&
    state.entries.size <= limit &&
    JSON.stringify(prior.event) === JSON.stringify(kept) &&
    prior.status === status &&
    prior.conflicted === conflicted
  )
    return state;
  const entries = new Map(state.entries);
  entries.set(key, { event: kept, status, conflicted });
  while (entries.size > limit) entries.delete(entries.keys().next().value!);
  return { entries };
}
