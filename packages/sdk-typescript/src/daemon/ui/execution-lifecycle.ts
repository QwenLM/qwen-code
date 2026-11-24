/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { isRecord } from './utils.js';

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const entry = value[key];
  return typeof entry === 'number' && Number.isFinite(entry)
    ? entry
    : undefined;
}

export type DaemonExecutionLifecycle = {
  readonly v: 1;
  readonly kind: 'request';
  readonly executionId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly model: string;
  readonly startedAt: number;
  readonly subagentId?: string;
} & (
  | { readonly phase: 'started' }
  | {
      readonly phase: 'ended';
      readonly endedAt: number;
      readonly durationMs: number;
      readonly outcome: 'success' | 'error' | 'cancelled' | 'interrupted';
      readonly reason?: 'consumer_closed';
    }
);

function parseLifecycle(value: unknown): DaemonExecutionLifecycle | undefined {
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'request') {
    return undefined;
  }
  const strings: Record<string, string> = {};
  for (const key of ['executionId', 'sessionId', 'promptId', 'model']) {
    const entry = value[key];
    if (typeof entry !== 'string' || !entry.trim()) return undefined;
    strings[key] = entry;
  }
  const startedAt = numberField(value, 'startedAt');
  if (startedAt === undefined || startedAt < 0) return undefined;
  const subagentId = value['subagentId'];
  if (
    subagentId !== undefined &&
    (typeof subagentId !== 'string' || !subagentId.trim())
  ) {
    return undefined;
  }
  const shared = {
    v: 1 as const,
    kind: 'request' as const,
    executionId: strings['executionId']!,
    sessionId: strings['sessionId']!,
    promptId: strings['promptId']!,
    model: strings['model']!,
    startedAt,
    ...(typeof subagentId === 'string' ? { subagentId } : {}),
  };
  if (value['phase'] === 'started') return { ...shared, phase: 'started' };
  if (value['phase'] !== 'ended') return undefined;
  const endedAt = numberField(value, 'endedAt');
  const durationMs = numberField(value, 'durationMs');
  const outcome = value['outcome'];
  if (
    endedAt === undefined ||
    endedAt < startedAt ||
    durationMs === undefined ||
    durationMs < 0 ||
    (outcome !== 'success' &&
      outcome !== 'error' &&
      outcome !== 'cancelled' &&
      outcome !== 'interrupted')
  ) {
    return undefined;
  }
  if (
    value['reason'] !== undefined &&
    (value['reason'] !== 'consumer_closed' || outcome !== 'interrupted')
  )
    return undefined;
  return {
    ...shared,
    phase: 'ended',
    endedAt,
    durationMs,
    outcome,
    ...(value['reason'] === 'consumer_closed'
      ? { reason: 'consumer_closed' as const }
      : {}),
  };
}

export function extractExecutionLifecycle(
  update: unknown,
): DaemonExecutionLifecycle | undefined {
  if (!isRecord(update) || !isRecord(update['_meta'])) return undefined;
  return parseLifecycle(update['_meta']['executionLifecycle']);
}

export interface ExecutionLifecycleEntry {
  readonly event: DaemonExecutionLifecycle;
  readonly status:
    | 'running'
    | 'unknown'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'interrupted';
  readonly conflicted: boolean;
}

export interface ExecutionLifecycleState {
  readonly entries: ReadonlyMap<string, ExecutionLifecycleEntry>;
}

export function createExecutionLifecycleState(): ExecutionLifecycleState {
  return { entries: new Map() };
}

/** Pass the source explicitly: a replayed start does not prove a live request. */
export function reduceExecutionLifecycle(
  state: ExecutionLifecycleState,
  input: unknown,
  options: { source: 'live' | 'replay'; maxEntries?: number },
): ExecutionLifecycleState {
  const event = extractExecutionLifecycle(input);
  if (!event) return state;
  const key = JSON.stringify([
    event.sessionId,
    event.subagentId ?? null,
    event.executionId,
  ]);
  const prior = state.entries.get(key);
  const conflicts =
    prior !== undefined &&
    (prior.event.promptId !== event.promptId ||
      prior.event.model !== event.model ||
      prior.event.startedAt !== event.startedAt ||
      (prior.event.phase === 'ended' &&
        event.phase === 'ended' &&
        (prior.event.endedAt !== event.endedAt ||
          prior.event.durationMs !== event.durationMs ||
          prior.event.outcome !== event.outcome ||
          prior.event.reason !== event.reason)));
  const kept =
    prior?.event.phase === 'ended' || conflicts ? prior!.event : event;
  const status =
    kept.phase === 'ended'
      ? kept.outcome
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
