/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { summarizeTrajectory } from './summarizeTrajectory';
import type { Trajectory, TrajectoryRow } from './types';

const T = 1_700_000_000_000;

function request(
  key: string,
  depth: number,
  startedAt: number | undefined,
  durationMs: number,
  status: 'ok' | 'error' = 'ok',
): TrajectoryRow {
  return {
    kind: 'request',
    key,
    turnIndex: 1,
    depth,
    status,
    timing: { durationMs, ...(startedAt === undefined ? {} : { startedAt }) },
  };
}

function tool(
  key: string,
  startedAt: number | undefined,
  durationMs: number | undefined,
  blockStatus: 'success' | 'error' | 'cancelled' = 'success',
  toolStatus?: 'success' | 'error' | 'cancelled',
): TrajectoryRow {
  return {
    kind: 'tool',
    key,
    turnIndex: 1,
    depth: 0,
    block: { kind: 'tool', status: blockStatus } as Extract<
      TrajectoryRow,
      { kind: 'tool' }
    >['block'],
    ...(durationMs === undefined
      ? {}
      : {
          timing: {
            durationMs,
            ...(startedAt === undefined ? {} : { startedAt }),
          },
        }),
    ...(toolStatus === undefined ? {} : { toolStatus }),
  };
}

function trajectory(rows: TrajectoryRow[]): Trajectory {
  return {
    rows,
    turns: [
      {
        index: 1,
        rowKeys: rows.map((row) => row.key),
        requestCount: 0,
        toolCount: 0,
        requestMs: 0,
        partial: true,
      },
    ],
    rowIndexByKey: new Map(rows.map((row, index) => [row.key, index])),
  };
}

describe('summarizeTrajectory', () => {
  it('counts projected rows and measures parallel spans and idle gaps', () => {
    const summary = summarizeTrajectory(
      trajectory([
        request('A', 0, T, 1000),
        request('S', 1, T + 200, 600),
        tool('X', T + 800, 600),
        tool('Y', T + 1000, 600, 'error'),
        request('B', 0, T + 4000, 500, 'error'),
        tool('Z', undefined, 300),
        tool('W', undefined, undefined, 'cancelled'),
      ]),
    );
    expect(summary).toEqual({
      turnCount: 1,
      requestCount: 3,
      toolCount: 4,
      requestFailures: 1,
      toolFailures: 1,
      mainRequestMs: 1500,
      elapsedMs: 4500,
      activeMs: 2100,
      plottedCount: 5,
      missingStartCount: 1,
      missingTimingCount: 1,
    });
  });

  it('keeps missing starts distinct from missing durations', () => {
    const summary = summarizeTrajectory(
      trajectory([
        request('A', 0, undefined, 250),
        tool('B', undefined, 100),
        tool('C', undefined, undefined),
      ]),
    );
    expect(summary.mainRequestMs).toBe(250);
    expect(summary.elapsedMs).toBeUndefined();
    expect(summary.activeMs).toBeUndefined();
    expect(summary.missingStartCount).toBe(2);
    expect(summary.missingTimingCount).toBe(1);
  });

  it('distinguishes measured zero and absent main requests', () => {
    expect(
      summarizeTrajectory(trajectory([request('A', 0, T, 0)])),
    ).toMatchObject({
      mainRequestMs: 0,
      elapsedMs: 0,
      activeMs: 0,
    });
    const subagent = summarizeTrajectory(trajectory([request('S', 1, T, 300)]));
    expect(subagent.mainRequestMs).toBeUndefined();
    expect(subagent.requestCount).toBe(1);
    expect(subagent.activeMs).toBe(300);
  });

  it('uses tool status in preference to the block status', () => {
    const summary = summarizeTrajectory(
      trajectory([
        tool('A', T, 10, 'error', 'success'),
        tool('B', T, 10, 'success', 'error'),
      ]),
    );
    expect(summary.toolFailures).toBe(1);
  });
});
