/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { buildTimeline } from './buildTimeline';
import { summarizeTrajectory } from './summarizeTrajectory';
import type {
  Trajectory,
  TrajectoryRow,
  TrajectoryToolRow,
  TrajectoryRequestRow,
} from './types';
import {
  buildTrajectoryLayout,
  trajectoryRowsInRange,
  visibleTrajectoryAncestor,
  visibleTrajectoryRows,
} from './buildTrajectoryLayout';

const request = (key: string, requestIndex = 1): TrajectoryRequestRow => ({
  kind: 'request',
  key,
  requestIndex,
  depth: 0,
  turnIndex: 1,
  status: 'ok',
  timing: { durationMs: 1000 },
});
const tool = (key: string, callId = key): TrajectoryToolRow => ({
  kind: 'tool',
  key,
  requestIndex: 1,
  depth: 0,
  turnIndex: 1,
  block: {
    kind: 'tool',
    id: key,
    toolCallId: callId,
    status: 'completed',
    title: key,
    content: [],
  },
});
function windowOf(rows: TrajectoryRow[]): Trajectory {
  return {
    rows,
    rowIndexByKey: new Map(rows.map((row, i) => [row.key, i])),
    turns: [
      {
        index: 1,
        rowKeys: rows.map((row) => row.key),
        requestCount: 1,
        toolCount: 1,
        requestMs: 1000,
        partial: true,
      },
    ],
  };
}

describe('trajectory layout', () => {
  it('keeps interleaved wire order and collapses known request membership', () => {
    const child = { ...request('child'), depth: 1, parentToolCallId: 'spawn' };
    const trajectory = windowOf([
      request('r1'),
      tool('spawn'),
      request('r2', 2),
      child,
      tool('last'),
    ]);
    const layout = buildTrajectoryLayout(trajectory);
    expect(layout.rows.map((row) => row.key)).toEqual([
      'turn:ordinal:1',
      'r1',
      'spawn',
      'r2',
      'child',
      'last',
    ]);
    expect(layout.ancestors.get('child')).toEqual(['turn:ordinal:1', 'r1']);
    const visible = visibleTrajectoryRows(layout, layout.rows, new Set(['r1']));
    expect(visible.map((row) => row.key)).toEqual([
      'turn:ordinal:1',
      'r1',
      'r2',
    ]);
    expect(
      visibleTrajectoryAncestor(
        layout,
        'child',
        new Set(visible.map((row) => row.key)),
      ),
    ).toBe('r1');
    expect(trajectory.rows.map((row) => row.key)).toEqual([
      'r1',
      'spawn',
      'r2',
      'child',
      'last',
    ]);
  });

  it('keeps missing, duplicate and cross-turn parents independent', () => {
    const children = ['missing', 'duplicate', 'elsewhere'].map(
      (parentToolCallId) => ({
        ...request(parentToolCallId),
        depth: 1,
        parentToolCallId,
      }),
    );
    const trajectory = windowOf([
      request('r1'),
      tool('a', 'duplicate'),
      tool('b', 'duplicate'),
      ...children,
    ]);
    const other = tool('other', 'elsewhere');
    trajectory.rows.push(other);
    trajectory.turns.push({
      ...trajectory.turns[0]!,
      index: 2,
      rowKeys: ['other'],
    });
    const layout = buildTrajectoryLayout(trajectory);
    for (const child of children) {
      expect(layout.ancestors.get(child.key)).toEqual(['turn:ordinal:1']);
      expect(layout.unresolvedParents.has(child.key)).toBe(true);
    }
  });

  it('preserves range context before folding without pretending context is a hit', () => {
    const trajectory = windowOf([request('r1'), tool('a'), request('r2', 2)]);
    const layout = buildTrajectoryLayout(trajectory);
    const range = trajectoryRowsInRange(layout, new Set(['a']));
    expect(range.map((row) => row.key)).toEqual(['turn:ordinal:1', 'r1', 'a']);
    expect(
      visibleTrajectoryRows(layout, range, new Set(['r1'])).map(
        (row) => row.key,
      ),
    ).toEqual(['turn:ordinal:1', 'r1']);
    expect(trajectoryRowsInRange(layout, new Set())).toEqual([]);
  });

  it('does not invent a group for ambiguous request indices or absent headers', () => {
    const layout = buildTrajectoryLayout(
      windowOf([
        request('r1'),
        request('duplicate'),
        tool('a'),
        { ...tool('orphan'), requestIndex: 9 },
      ]),
    );
    expect(layout.groups.has('r1')).toBe(false);
    expect(layout.ancestors.get('a')).toEqual(['turn:ordinal:1']);
    expect(layout.ancestors.get('orphan')).toEqual(['turn:ordinal:1']);
  });

  it('keeps measured parallel timing and window metrics when records are folded', () => {
    const trajectory = windowOf([
      {
        ...request('r1'),
        timing: { startedAt: 1760000000000, durationMs: 1000 },
      },
      { ...tool('a'), timing: { startedAt: 1760000000800, durationMs: 600 } },
      { ...tool('b'), timing: { startedAt: 1760000001000, durationMs: 600 } },
      {
        ...request('r2', 2),
        timing: { startedAt: 1760000004000, durationMs: 500 },
      },
      { ...tool('c'), requestIndex: 2, timing: { durationMs: 300 } },
    ]);
    const summary = summarizeTrajectory(trajectory);
    expect(summary.elapsedMs).toBe(4500);
    expect(summary.activeMs).toBe(2100);
    expect(summary.mainRequestMs).toBe(1500);
    expect(
      buildTimeline(trajectory, { mode: 'clock' })?.spans.map((span) => [
        span.rowKey,
        span.start,
        span.end,
      ]),
    ).toEqual([
      ['r1', 0, 1000],
      ['a', 800, 1400],
      ['b', 1000, 1600],
      ['r2', 4000, 4500],
    ]);
    expect(
      buildTimeline(trajectory, { mode: 'active' })?.spans.find(
        (span) => span.rowKey === 'r2',
      ),
    ).toMatchObject({ start: 1600, end: 2100 });
    const layout = buildTrajectoryLayout(trajectory);
    expect(
      visibleTrajectoryRows(layout, layout.rows, new Set(['r1'])).map(
        (row) => row.key,
      ),
    ).toEqual(['turn:ordinal:1', 'r1', 'r2', 'c']);
    expect(summarizeTrajectory(trajectory)).toEqual(summary);
  });

  it('matches parentBlockId and rejects conflicting parent references', () => {
    const good = {
      ...tool('good'),
      depth: 1,
      block: { ...tool('good').block!, parentBlockId: 'spawn' },
    } as TrajectoryRow;
    const bad = {
      ...tool('bad'),
      depth: 1,
      block: {
        ...tool('bad').block!,
        parentBlockId: 'spawn',
        parentToolCallId: 'other',
      },
    } as TrajectoryRow;
    const layout = buildTrajectoryLayout(
      windowOf([request('r1'), tool('spawn'), tool('other'), good, bad]),
    );
    expect(layout.ancestors.get('good')).toEqual(['turn:ordinal:1', 'r1']);
    expect(layout.ancestors.get('bad')).toEqual(['turn:ordinal:1']);
  });
});
