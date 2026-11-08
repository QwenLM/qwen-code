/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  createExecutionLifecycleState,
  createToolLifecycleState,
  getSessionUpdatePayload,
  extractExecutionLifecycle,
  extractToolLifecycle,
  reduceExecutionLifecycle,
  reduceToolLifecycle,
  type DaemonEvent,
  type ExecutionLifecycleEntry,
  type ToolLifecycleEntry,
} from '@qwen-code/sdk/daemon';
import type { Trajectory } from './types';
import type { TrajectoryLiveSnapshot } from './trajectory-live-store';

export type TrajectoryLifecycleEntry =
  | ExecutionLifecycleEntry
  | ToolLifecycleEntry;
export interface TrajectoryLifecycleProjection {
  byRowKey: ReadonlyMap<string, TrajectoryLifecycleEntry>;
  byExecution: ReadonlyMap<string, TrajectoryLifecycleEntry>;
  outsideWindow: readonly TrajectoryLifecycleEntry[];
  status: TrajectoryLiveSnapshot['status'];
  incomplete: boolean;
  truncated: boolean;
}

export function projectHistoricalLifecycle(events: readonly DaemonEvent[]) {
  let requests = createExecutionLifecycleState();
  let tools = createToolLifecycleState();
  let truncated = false;
  let incomplete = false;
  for (const event of events) {
    try {
      if (event.type !== 'session_update') continue;
      const update = getSessionUpdatePayload(event.data);
      for (const [entry, state] of [
        [extractExecutionLifecycle(update), requests],
        [extractToolLifecycle(update), tools],
      ] as const) {
        if (
          entry &&
          state.entries.size === 256 &&
          !state.entries.has(
            JSON.stringify([
              entry.sessionId,
              entry.subagentId ?? null,
              entry.executionId,
            ]),
          )
        )
          truncated = true;
      }
      requests = reduceExecutionLifecycle(requests, update, {
        source: 'replay',
      });
      tools = reduceToolLifecycle(tools, update, { source: 'replay' });
    } catch {
      incomplete = true;
    }
  }
  return {
    requests,
    tools,
    truncated,
    incomplete,
  };
}

export function projectTrajectoryLifecycle(
  history: ReturnType<typeof projectHistoricalLifecycle>,
  trajectory: Trajectory | undefined,
  identity: { sessionId: string; scope?: string } | undefined,
  live: TrajectoryLiveSnapshot,
): TrajectoryLifecycleProjection {
  const { requests, tools } = history;
  const matches =
    identity?.scope !== undefined &&
    live.sessionId === identity.sessionId &&
    live.scope === identity.scope;
  const merged = new Map<string, TrajectoryLifecycleEntry>();
  const keyOf = (entry: TrajectoryLifecycleEntry) =>
    JSON.stringify([
      entry.event.kind,
      entry.event.sessionId,
      entry.event.subagentId ?? null,
      entry.event.executionId,
    ]);
  for (const entry of [
    ...requests.entries.values(),
    ...tools.entries.values(),
  ]) {
    merged.set(keyOf(entry), entry);
  }
  const liveKeys = new Set<string>();
  if (matches) {
    for (const entry of [
      ...live.requests.entries.values(),
      ...live.tools.entries.values(),
    ]) {
      const key = keyOf(entry);
      liveKeys.add(key);
      const previous = merged.get(key);
      if (previous?.event.phase === 'ended') continue;
      merged.set(
        key,
        entry.status === 'running' && live.status !== 'live'
          ? { ...entry, status: 'unknown' }
          : entry,
      );
    }
  }
  const byRowKey = new Map<string, TrajectoryLifecycleEntry>();
  const claimed = new Set<string>();
  for (const row of trajectory?.rows ?? []) {
    if (row.kind !== 'request' || !row.executionId || !identity) continue;
    const key = JSON.stringify([
      row.kind,
      identity.sessionId,
      row.subagentId ?? null,
      row.executionId,
    ]);
    const entry = merged.get(key);
    if (entry) {
      byRowKey.set(row.key, entry);
      claimed.add(key);
    }
  }
  return {
    byExecution: merged,
    byRowKey,
    outsideWindow: matches
      ? [...merged]
          .filter(([key]) => liveKeys.has(key) && !claimed.has(key))
          .map(([, entry]) => entry)
      : [],
    status: matches ? live.status : 'unavailable',
    incomplete: history.incomplete || (matches ? live.incomplete : true),
    truncated: history.truncated || (matches && live.truncated),
  };
}
