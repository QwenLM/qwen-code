/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  TrajectoryLifecycleEntry,
  TrajectoryLifecycleProjection,
} from './project-trajectory-lifecycle';

export interface TrajectoryExecutionRow {
  key: string;
  entry: TrajectoryLifecycleEntry;
  name: string;
  status:
    | 'running'
    | 'unknown'
    | 'conflict'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'interrupted'
    | 'not_started';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  historyRowKey?: string;
}

export function projectTrajectoryExecutions(
  lifecycle: TrajectoryLifecycleProjection,
  identity?: { sessionId: string; scope?: string },
): { rows: TrajectoryExecutionRow[]; omitted: number } {
  if (!identity) return { rows: [], omitted: 0 };
  const historyKeys = new Map<TrajectoryLifecycleEntry, string>();
  for (const [key, entry] of lifecycle.byRowKey) historyKeys.set(entry, key);
  const rows: TrajectoryExecutionRow[] = [];
  for (const entry of lifecycle.byExecution.values()) {
    const event = entry.event;
    if (event.sessionId !== identity.sessionId) continue;
    const status: TrajectoryExecutionRow['status'] = entry.conflicted
      ? 'conflict'
      : event.phase === 'ended'
        ? event.kind === 'tool'
          ? event.executionStatus
          : event.outcome
        : entry.status === 'running' && lifecycle.status === 'live'
          ? 'running'
          : 'unknown';
    const durationMs =
      !entry.conflicted && event.phase === 'ended'
        ? event.kind === 'request'
          ? event.durationMs
          : event.executionStatus !== 'not_started'
            ? event.executionDurationMs
            : undefined
        : undefined;
    rows.push({
      key: JSON.stringify([
        identity.scope ?? null,
        event.kind,
        event.sessionId,
        event.subagentId ?? null,
        event.executionId,
      ]),
      entry,
      name: event.kind === 'request' ? event.model : event.toolName,
      status,
      ...('startedAt' in event ? { startedAt: event.startedAt } : {}),
      ...(event.phase === 'ended' ? { endedAt: event.endedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(event.kind === 'request' && historyKeys.has(entry)
        ? { historyRowKey: historyKeys.get(entry) }
        : {}),
    });
  }
  rows.sort((a, b) => {
    const running =
      Number(b.status === 'running') - Number(a.status === 'running');
    if (running) return running;
    const time =
      (b.endedAt ?? b.startedAt ?? -Infinity) -
      (a.endedAt ?? a.startedAt ?? -Infinity);
    if (time && !Number.isNaN(time)) return time;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const counts = { request: 0, tool: 0 };
  const retained = rows.filter((row) => ++counts[row.entry.event.kind] <= 256);
  return { rows: retained, omitted: rows.length - retained.length };
}
