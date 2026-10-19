/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecutionLifecycleEntry,
  ToolLifecycleEntry,
} from '@qwen-code/sdk/daemon';
import type {
  TrajectoryLifecycleEntry,
  TrajectoryLifecycleProjection,
} from './project-trajectory-lifecycle';
import { projectTrajectoryExecutions } from './project-trajectory-executions';

const identity = { sessionId: 'session', scope: 'workspace:a' };
function request(id = 'request', startedAt = 100): ExecutionLifecycleEntry {
  return {
    event: {
      v: 1,
      kind: 'request',
      phase: 'started',
      executionId: id,
      sessionId: identity.sessionId,
      promptId: 'prompt',
      model: 'model',
      startedAt,
    },
    status: 'running',
    conflicted: false,
  };
}
function projection(
  entries: TrajectoryLifecycleEntry[],
  status: TrajectoryLifecycleProjection['status'] = 'live',
): TrajectoryLifecycleProjection {
  return {
    byExecution: new Map(entries.map((entry, index) => [String(index), entry])),
    byRowKey: new Map(),
    outsideWindow: entries,
    status,
    incomplete: false,
    truncated: false,
  };
}

describe('projectTrajectoryExecutions', () => {
  it('isolates owner and includes scope, kind and subagent in stable identity', () => {
    const a = request();
    const child = { ...a, event: { ...a.event, subagentId: 'child' } };
    const foreign = { ...a, event: { ...a.event, sessionId: 'other' } };
    const input = projection([a, child, foreign]);
    expect(projectTrajectoryExecutions(input)).toEqual({
      rows: [],
      omitted: 0,
    });
    const { rows } = projectTrajectoryExecutions(input, identity);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows[0]!.key).not.toBe(
      projectTrajectoryExecutions(input, { ...identity, scope: 'b' }).rows[0]!
        .key,
    );
  });

  it('trusts only live running and never invents a recorded duration', () => {
    for (const status of [
      'live',
      'catching-up',
      'stale',
      'unavailable',
    ] as const) {
      const row = projectTrajectoryExecutions(
        projection([request()], status),
        identity,
      ).rows[0]!;
      expect(row.status).toBe(status === 'live' ? 'running' : 'unknown');
      expect(row.durationMs).toBeUndefined();
      expect(row.endedAt).toBeUndefined();
    }
    const replay = { ...request(), status: 'unknown' as const };
    expect(
      projectTrajectoryExecutions(projection([replay]), identity).rows[0]!
        .status,
    ).toBe('unknown');
  });

  it('replaces start with recorded terminal while keeping key and historical association', () => {
    const start = request();
    const end: ExecutionLifecycleEntry = {
      ...start,
      event: {
        ...start.event,
        phase: 'ended',
        endedAt: 300,
        durationMs: 150,
        outcome: 'interrupted',
      },
      status: 'interrupted',
    };
    const input = projection([end]);
    input.byRowKey = new Map([['history', end]]);
    const row = projectTrajectoryExecutions(input, identity).rows[0]!;
    expect(row).toMatchObject({
      status: 'interrupted',
      startedAt: 100,
      endedAt: 300,
      durationMs: 150,
      historyRowKey: 'history',
    });
    expect(row.key).toBe(
      projectTrajectoryExecutions(projection([start]), identity).rows[0]!.key,
    );
    expect(row.entry).toBe(end);
    const conflict = { ...end, conflicted: true };
    expect(
      projectTrajectoryExecutions(projection([conflict]), identity).rows[0],
    ).toMatchObject({ status: 'conflict' });
    expect(
      projectTrajectoryExecutions(projection([conflict]), identity).rows[0]!
        .durationMs,
    ).toBeUndefined();
  });

  it('separates tool execution result from final outcome and preserves not-started', () => {
    const tool: ToolLifecycleEntry = {
      event: {
        v: 1,
        kind: 'tool',
        phase: 'ended',
        executionId: 'tool',
        sessionId: identity.sessionId,
        callId: 'call',
        toolName: 'shell',
        startedAt: 100,
        endedAt: 200,
        executionDurationMs: 80,
        executionStatus: 'success',
        outcome: 'cancelled',
      },
      status: 'success',
      conflicted: false,
    };
    const skipped: ToolLifecycleEntry = {
      event: {
        v: 1,
        kind: 'tool',
        phase: 'ended',
        executionId: 'skipped',
        sessionId: identity.sessionId,
        callId: 'call',
        toolName: 'shell',
        endedAt: 200,
        executionStatus: 'not_started',
        outcome: 'cancelled',
      },
      status: 'not_started',
      conflicted: false,
    };
    const input = projection([tool, skipped]);
    input.byRowKey = new Map([['misleading-tool-history', tool]]);
    const rows = projectTrajectoryExecutions(input, identity).rows;
    expect(rows.find((row) => row.entry === tool)).toMatchObject({
      status: 'success',
      durationMs: 80,
      entry: { event: { outcome: 'cancelled' } },
    });
    expect(
      rows.find((row) => row.entry === tool)!.historyRowKey,
    ).toBeUndefined();
    const skippedRow = rows.find((row) => row.entry === skipped)!;
    expect(skippedRow.status).toBe('not_started');
    expect(skippedRow.startedAt).toBeUndefined();
    expect(skippedRow.durationMs).toBeUndefined();
  });

  it('caps each kind independently, retaining running before newest records deterministically', () => {
    const requests = Array.from({ length: 300 }, (_, index) => ({
      ...request(`r${index}`, index),
      status: 'unknown' as const,
    }));
    const running = request('old-running', 0);
    const tools: ToolLifecycleEntry[] = Array.from(
      { length: 300 },
      (_, index) => ({
        event: {
          v: 1,
          kind: 'tool',
          phase: 'started',
          executionStatus: 'running',
          executionId: `t${index}`,
          sessionId: identity.sessionId,
          callId: 'same-call',
          toolName: 'shell',
          startedAt: index,
        },
        status: 'unknown',
        conflicted: false,
      }),
    );
    const entries = [...requests, running, ...tools];
    const result = projectTrajectoryExecutions(projection(entries), identity);
    expect(result.rows).toHaveLength(512);
    expect(result.omitted).toBe(89);
    expect(result.rows[0]!.entry).toBe(running);
    expect(
      result.rows.filter((row) => row.entry.event.kind === 'tool'),
    ).toHaveLength(256);
    expect(
      result.rows.some((row) => row.entry.event.executionId === 'r0'),
    ).toBe(false);
    expect(
      projectTrajectoryExecutions(projection([...entries].reverse()), identity),
    ).toEqual(result);
  });
});
