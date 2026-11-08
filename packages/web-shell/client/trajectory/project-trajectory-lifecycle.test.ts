/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  createExecutionLifecycleState,
  createToolLifecycleState,
  reduceExecutionLifecycle,
  reduceToolLifecycle,
  type DaemonEvent,
} from '@qwen-code/sdk/daemon';
import {
  projectHistoricalLifecycle,
  projectTrajectoryLifecycle,
} from './project-trajectory-lifecycle';
import { buildTrajectory } from './buildTrajectory';
import type { TrajectoryLiveSnapshot } from './trajectory-live-store';
const started = {
  v: 1,
  kind: 'request',
  phase: 'started',
  executionId: 'e',
  sessionId: 's',
  promptId: 'p',
  model: 'm',
  startedAt: 1,
};
const ended = {
  ...started,
  phase: 'ended',
  endedAt: 3,
  durationMs: 2,
  outcome: 'success',
};
const wrap = (value: unknown) => ({ _meta: { executionLifecycle: value } });
const event = (value: unknown): DaemonEvent => ({
  type: 'session_update',
  v: 1,
  id: 1,
  data: wrap(value),
});
const trajectory = buildTrajectory([
  {
    kind: 'timing',
    timing: {
      kind: 'request',
      executionId: 'e',
      durationMs: 2,
      startedAt: 1,
    },
  },
]);
function live(): TrajectoryLiveSnapshot {
  return {
    sessionId: 's',
    scope: 'workspace:a',
    status: 'live',
    requests: reduceExecutionLifecycle(
      createExecutionLifecycleState(),
      wrap(started),
      { source: 'live' },
    ),
    tools: createToolLifecycleState(),
    incomplete: false,
    truncated: false,
  };
}
describe('projectTrajectoryLifecycle', () => {
  it('preserves historical terminal over duplicate live start without changing recorded metrics', () => {
    const result = projectTrajectoryLifecycle(
      projectHistoricalLifecycle([event(ended)]),
      trajectory,
      { sessionId: 's', scope: 'workspace:a' },
      live(),
    );
    expect([...result.byRowKey.values()][0]?.status).toBe('success');
    expect(result.outsideWindow).toEqual([]);
    expect(trajectory.rows[0]).toMatchObject({ timing: { durationMs: 2 } });
  });
  it('never merges another workspace or an unscoped loader', () => {
    for (const scope of [undefined, 'workspace:b']) {
      const result = projectTrajectoryLifecycle(
        projectHistoricalLifecycle([]),
        trajectory,
        { sessionId: 's', scope },
        live(),
      );
      expect(result.byRowKey.size).toBe(0);
      expect(result.status).toBe('unavailable');
    }
  });
  it('makes replay-only starts unknown and stale live starts unknown', () => {
    const identity = { sessionId: 's', scope: 'workspace:a' };
    expect(
      [
        ...projectTrajectoryLifecycle(
          projectHistoricalLifecycle([event(started)]),
          trajectory,
          identity,
          { ...live(), requests: createExecutionLifecycleState() },
        ).byRowKey.values(),
      ][0]?.status,
    ).toBe('unknown');
    expect(
      [
        ...projectTrajectoryLifecycle(
          projectHistoricalLifecycle([]),
          trajectory,
          identity,
          { ...live(), status: 'stale' },
        ).byRowKey.values(),
      ][0]?.status,
    ).toBe('unknown');
  });
  it('isolates malformed metadata and keeps later lifecycle records readable', () => {
    const malformed: DaemonEvent = {
      v: 1,
      type: 'session_update',
      data: {
        get update() {
          throw new Error('bad metadata');
        },
      },
    };
    const history = projectHistoricalLifecycle([malformed, event(ended)]);
    expect(history.incomplete).toBe(true);
    expect([...history.requests.entries.values()][0]?.status).toBe('success');
    expect(
      projectTrajectoryLifecycle(
        history,
        trajectory,
        { sessionId: 's', scope: 'workspace:a' },
        live(),
      ).incomplete,
    ).toBe(true);
  });

  it('reports historical lifecycle eviction without growing beyond the SDK cap', () => {
    const history = projectHistoricalLifecycle(
      Array.from({ length: 257 }, (_, index) =>
        event({ ...ended, executionId: `e-${index}` }),
      ),
    );
    expect(history.requests.entries.size).toBe(256);
    expect(history.truncated).toBe(true);
    expect(
      projectHistoricalLifecycle(
        Array.from({ length: 256 }, (_, index) =>
          event({ ...ended, executionId: `e-${index}` }),
        ),
      ).truncated,
    ).toBe(false);
  });

  it('retains tool executions separately when historical tool rows have no execution identity', () => {
    const snapshot = live();
    const tools = reduceToolLifecycle(
      createToolLifecycleState(),
      {
        _meta: {
          toolLifecycle: {
            v: 1,
            kind: 'tool',
            executionId: 'tool-e',
            sessionId: 's',
            callId: 'call',
            toolName: 'shell',
            phase: 'ended',
            executionStatus: 'not_started',
            endedAt: 3,
            outcome: 'cancelled',
          },
        },
      },
      { source: 'replay' },
    );
    const result = projectTrajectoryLifecycle(
      projectHistoricalLifecycle([]),
      trajectory,
      { sessionId: 's', scope: 'workspace:a' },
      { ...snapshot, tools },
    );
    expect(result.outsideWindow).toHaveLength(1);
    expect(result.outsideWindow[0]?.event).toMatchObject({
      kind: 'tool',
      executionId: 'tool-e',
    });
    expect([...result.byRowKey.values()]).toHaveLength(1);
  });

  it('keeps executions outside the window separate from historical rows', () => {
    const result = projectTrajectoryLifecycle(
      projectHistoricalLifecycle([]),
      buildTrajectory([]),
      { sessionId: 's', scope: 'workspace:a' },
      live(),
    );
    expect(result.byRowKey.size).toBe(0);
    expect(result.outsideWindow).toHaveLength(1);
  });
});
