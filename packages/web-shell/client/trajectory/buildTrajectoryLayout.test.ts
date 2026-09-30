/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { buildTimeline } from './buildTimeline';
import { summarizeTrajectory } from './summarizeTrajectory';
import { buildTrajectory } from './buildTrajectory';
import type {
  Trajectory,
  TrajectoryRow,
  TrajectoryToolRow,
  TrajectoryRequestRow,
  TrajectoryEntry,
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
  it('folds nested subagents into their main request through recorded tool parents', () => {
    const spawn = (callId: string, parent?: string): TrajectoryEntry => ({
      kind: 'block',
      block: {
        kind: 'tool',
        id: `block-${callId}`,
        toolCallId: callId,
        status: 'completed',
        title: callId,
        toolName: 'task',
        clientReceivedAt: 0,
        createdAt: 0,
        updatedAt: 0,
        ...(parent
          ? { parentToolCallId: parent, parentBlockId: `block-${parent}` }
          : {}),
      },
    });
    const timing = (
      recordId: string,
      subagentId?: string,
    ): TrajectoryEntry => ({
      kind: 'timing',
      recordId,
      timing: {
        kind: 'request',
        durationMs: 1000,
        ...(subagentId ? { subagentId } : {}),
      },
    });
    const trajectory = buildTrajectory([
      timing('main'),
      spawn('root'),
      timing('child', 'general-purpose-root'),
      spawn('nested', 'root'),
      timing('grandchild', 'general-purpose-nested'),
    ]);
    const layout = buildTrajectoryLayout(trajectory);
    expect(
      trajectory.rows.find((row) => row.key === 'req:grandchild'),
    ).toMatchObject({
      parentToolCallId: 'nested',
      depth: 1,
    });
    expect(layout.ancestors.get('req:grandchild')).toEqual([
      'turn:ordinal:1',
      'req:main',
    ]);
    expect(layout.unresolvedParents.size).toBe(0);
    expect(
      visibleTrajectoryRows(layout, layout.rows, new Set(['req:main'])).map(
        (row) => row.key,
      ),
    ).toEqual(['turn:ordinal:1', 'req:main']);
    expect(
      trajectoryRowsInRange(layout, new Set(['req:grandchild'])).map(
        (row) => row.key,
      ),
    ).toEqual(['turn:ordinal:1', 'req:main', 'req:grandchild']);
  });

  it('rejects cycles and ambiguous intermediate parents', () => {
    const nested = (key: string, parentToolCallId: string) => ({
      ...tool(key),
      depth: 1,
      block: { ...tool(key).block, parentToolCallId },
    });
    const child = (key: string, parentToolCallId: string) => ({
      ...request(key),
      depth: 1,
      parentToolCallId,
    });
    const layout = buildTrajectoryLayout(
      windowOf([
        request('r1'),
        tool('root'),
        nested('a', 'b'),
        nested('b', 'a'),
        child('cyclic', 'a'),
        {
          ...nested('duplicate1', 'root'),
          block: {
            ...nested('duplicate1', 'root').block,
            toolCallId: 'duplicate',
          },
        },
        {
          ...nested('duplicate2', 'root'),
          block: {
            ...nested('duplicate2', 'root').block,
            toolCallId: 'duplicate',
          },
        },
        child('ambiguous', 'duplicate'),
        child('missing', 'absent'),
      ]),
    );
    for (const key of ['a', 'b', 'cyclic', 'ambiguous', 'missing']) {
      expect(layout.unresolvedParents.has(key)).toBe(true);
      expect(layout.ancestors.get(key)).toEqual(['turn:ordinal:1']);
    }
    expect(layout.ancestors.get('duplicate1')).toEqual([
      'turn:ordinal:1',
      'r1',
    ]);
  });

  it('tracks only unique persisted identities for refreshing folds', () => {
    const trajectory = windowOf([
      { ...request('r1'), recordId: 'record' },
      tool('root'),
      { ...request('r2', 2), responseId: 'response' },
      { ...tool('second'), requestIndex: 2 },
      request('req:0', 3),
      { ...tool('fallback'), requestIndex: 3 },
    ]);
    const layout = buildTrajectoryLayout(trajectory);
    expect([...layout.groupIdentities]).toEqual([
      ['r1', 'request-record:record'],
      ['r2', 'request-response:response'],
    ]);
    trajectory.rows.push({ ...request('duplicate', 4), recordId: 'record' });
    trajectory.turns[0]!.rowKeys.push('duplicate');
    expect(buildTrajectoryLayout(trajectory).groupIdentities.has('r1')).toBe(
      false,
    );
  });

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
