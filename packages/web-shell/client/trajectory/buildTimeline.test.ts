/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { buildTimeline } from './buildTimeline';
import type {
  Trajectory,
  TrajectoryRequestRow,
  TrajectoryRow,
  TrajectoryTiming,
  TrajectoryToolRow,
  TrajectoryTurn,
} from './types';

const BASE = 1_760_000_000_000;

function request(
  key: string,
  timing: TrajectoryTiming,
  over: Partial<TrajectoryRequestRow> = {},
): TrajectoryRequestRow {
  return {
    kind: 'request',
    key,
    turnIndex: 1,
    depth: 0,
    status: 'ok',
    timing,
    ...over,
  };
}

function tool(
  key: string,
  timing: TrajectoryTiming | undefined,
  over: Partial<TrajectoryToolRow> = {},
): TrajectoryToolRow {
  const block: DaemonToolTranscriptBlock = {
    id: key,
    kind: 'tool',
    toolCallId: key,
    title: `Tool ${key}`,
    status: 'completed',
    toolName: 'read_file',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    sourceRecordIds: [key],
  };
  return {
    kind: 'tool',
    key,
    turnIndex: 1,
    depth: 0,
    block,
    ...(timing ? { timing } : {}),
    ...over,
  };
}

function message(key: string): TrajectoryRow {
  const block: DaemonTextTranscriptBlock = {
    id: key,
    kind: 'assistant',
    text: 'hi',
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    kind: 'message',
    key,
    turnIndex: 1,
    depth: 0,
    block,
    thought: false,
  };
}

/** Rows grouped into turns; each inner array is one turn. */
function trajectoryOf(...turnRows: TrajectoryRow[][]): Trajectory {
  const rows = turnRows.flat();
  const turns: TrajectoryTurn[] = turnRows.map((group, i) => ({
    index: i + 1,
    rowKeys: group.map((row) => row.key),
    requestCount: 0,
    toolCount: 0,
    requestMs: 0,
    partial: false,
  }));
  return {
    turns,
    rows,
    rowIndexByKey: new Map(rows.map((row, i) => [row.key, i])),
  };
}

describe('buildTimeline', () => {
  it('puts requests, tools and subagent requests on their own lanes', () => {
    const model = buildTimeline(
      trajectoryOf([
        message('m'),
        request('r', { startedAt: BASE, durationMs: 100 }),
        tool('t', { startedAt: BASE + 100, durationMs: 50 }),
        request(
          's',
          { startedAt: BASE + 110, durationMs: 20 },
          { depth: 1, subagentId: 'general-purpose-t' },
        ),
      ]),
    )!;

    expect(model.spans.map((span) => [span.rowKey, span.lane])).toEqual([
      ['r', 0],
      ['t', 1],
      ['s', 2],
    ]);
  });

  it('draws nothing it would have to guess a start for', () => {
    const model = buildTimeline(
      trajectoryOf([
        request('r', { startedAt: BASE, durationMs: 100 }),
        tool('old', { durationMs: 35 }),
        tool('running', undefined),
      ]),
    )!;

    expect(model.spans.map((span) => span.rowKey)).toEqual(['r']);
    expect(model.droppedRows).toBe(1);
  });

  it('has no model when nothing recorded a start', () => {
    expect(
      buildTimeline(
        trajectoryOf([tool('old', { durationMs: 35 }), message('m')]),
      ),
    ).toBeUndefined();
  });

  it('cuts the idle time between turns out of the axis', () => {
    const model = buildTimeline(
      trajectoryOf(
        [
          request('r1', { startedAt: BASE, durationMs: 1000 }),
          tool('t1', { startedAt: BASE + 1000, durationMs: 20 }),
        ],
        [request('r2', { startedAt: BASE + 61_000, durationMs: 500 })],
      ),
    )!;

    expect(
      model.spans.map((span) => [span.rowKey, span.start, span.end]),
    ).toEqual([
      ['r1', 0, 1000],
      ['t1', 1000, 1020],
      ['r2', 1020, 1520],
    ]);
    expect(model.total).toBe(1520);
    // Nothing to leave out in this mode, so all of the domain is activity.
    expect(model.mode).toBe('active');
    expect(model.activeMs).toBe(1520);
    expect(model.originMs).toBe(BASE);
  });

  it('removes a gap once however many spans run in parallel after it', () => {
    const model = buildTimeline(
      trajectoryOf([
        request('r', { startedAt: BASE, durationMs: 100 }),
        // Two tools launched together, one long and one short, then a gap.
        tool('slow', { startedAt: BASE + 100, durationMs: 400 }),
        tool('fast', { startedAt: BASE + 100, durationMs: 10 }),
        // Starts inside the slow tool: no gap, no shift.
        tool('inner', { startedAt: BASE + 300, durationMs: 10 }),
        request('r2', { startedAt: BASE + 10_500, durationMs: 100 }),
      ]),
    )!;

    const at = Object.fromEntries(
      model.spans.map((span) => [span.rowKey, [span.start, span.end]]),
    );
    expect(at).toEqual({
      r: [0, 100],
      slow: [100, 500],
      fast: [100, 110],
      inner: [300, 310],
      r2: [500, 600],
    });
    expect(model.total).toBe(600);
  });

  it('splits a request at its first token only when that is inside it', () => {
    const model = buildTimeline(
      trajectoryOf([
        request('ok', { startedAt: BASE, durationMs: 1000, ttftMs: 400 }),
        request('none', { startedAt: BASE + 1000, durationMs: 1000 }),
        request('over', {
          startedAt: BASE + 2000,
          durationMs: 1000,
          ttftMs: 1500,
        }),
      ]),
    )!;

    const ttft = Object.fromEntries(
      model.spans.map((span) => [span.rowKey, span.ttftEnd]),
    );
    expect(ttft).toEqual({ ok: 400, none: undefined, over: undefined });
  });

  it('marks where each later turn starts, and not the first', () => {
    const model = buildTimeline(
      trajectoryOf(
        [request('r1', { startedAt: BASE, durationMs: 100 })],
        [message('m2')],
        [
          tool('t3', { startedAt: BASE + 5000, durationMs: 10 }),
          request('r3', { startedAt: BASE + 4000, durationMs: 50 }),
        ],
      ),
    )!;

    // Turn 2 drew nothing; turn 3 starts at its earliest span, not its first row.
    expect(model.turnMarks).toEqual([{ turnIndex: 3, at: 100 }]);
  });

  it('marks failed requests and failed tools', () => {
    const model = buildTimeline(
      trajectoryOf([
        request(
          'bad',
          { startedAt: BASE, durationMs: 10 },
          { status: 'error' },
        ),
        tool(
          't-bad',
          { startedAt: BASE + 10, durationMs: 10 },
          { toolStatus: 'error' },
        ),
        tool(
          't-ok',
          { startedAt: BASE + 20, durationMs: 10 },
          { toolStatus: 'success' },
        ),
      ]),
    )!;

    expect(model.spans.map((span) => [span.rowKey, span.error])).toEqual([
      ['bad', true],
      ['t-bad', true],
      ['t-ok', false],
    ]);
  });

  it('keeps a zero-length tool that succeeded', () => {
    const model = buildTimeline(
      trajectoryOf([tool('z', { startedAt: BASE, durationMs: 0 })]),
    )!;
    expect(model.spans).toMatchObject([{ rowKey: 'z', start: 0, end: 0 }]);
  });

  it('orders ties by lane and gives the same answer twice', () => {
    const trajectory = trajectoryOf([
      tool('t', { startedAt: BASE, durationMs: 10 }),
      request('r', { startedAt: BASE, durationMs: 10 }),
    ]);
    const first = buildTimeline(trajectory)!;
    expect(first.spans.map((span) => span.rowKey)).toEqual(['r', 't']);
    expect(buildTimeline(trajectory)).toEqual(first);
  });

  describe('clock mode', () => {
    /** A request and its tool, then a minute of nothing, then a request. */
    const twoTurns = () =>
      trajectoryOf(
        [
          request('r1', { startedAt: BASE, durationMs: 1000 }),
          tool('t1', { startedAt: BASE + 1000, durationMs: 250 }),
        ],
        [request('r2', { startedAt: BASE + 60_000, durationMs: 500 })],
      );

    it('leaves the idle time between turns on the axis', () => {
      const model = buildTimeline(twoTurns(), { mode: 'clock' })!;

      expect(
        model.spans.map((span) => [span.rowKey, span.start, span.end]),
      ).toEqual([
        ['r1', 0, 1000],
        ['t1', 1000, 1250],
        ['r2', 60_000, 60_500],
      ]);
      expect(model.mode).toBe('clock');
      expect(model.total).toBe(60_500);
      expect(model.activeMs).toBe(1750);
      expect(model.originMs).toBe(BASE);
    });

    it('marks later turns where they really started', () => {
      expect(buildTimeline(twoTurns(), { mode: 'clock' })!.turnMarks).toEqual([
        { turnIndex: 2, at: 60_000 },
      ]);
      expect(buildTimeline(twoTurns())!.turnMarks).toEqual([
        { turnIndex: 2, at: 1250 },
      ]);
    });

    it('counts parallel and overlapping calls once towards activity', () => {
      const model = buildTimeline(
        trajectoryOf([
          request('r', { startedAt: BASE, durationMs: 100 }),
          tool('slow', { startedAt: BASE + 100, durationMs: 400 }),
          tool('fast', { startedAt: BASE + 100, durationMs: 10 }),
          tool('inner', { startedAt: BASE + 300, durationMs: 10 }),
          request('r2', { startedAt: BASE + 10_500, durationMs: 100 }),
        ]),
        { mode: 'clock' },
      )!;

      expect(model.total).toBe(10_600);
      // 0–500 busy, 500–10 500 idle, 10 500–10 600 busy.
      expect(model.activeMs).toBe(600);
    });

    it('starts the axis at the earliest start, whatever order the rows are in', () => {
      // A subagent's request can be listed before a main-session call that
      // started earlier than it.
      const model = buildTimeline(
        trajectoryOf([
          request('late', { startedAt: BASE + 5000, durationMs: 100 }),
          request('early', { startedAt: BASE + 2000, durationMs: 100 }),
        ]),
        { mode: 'clock' },
      )!;

      expect(model.originMs).toBe(BASE + 2000);
      expect(model.spans.map((span) => [span.rowKey, span.start])).toEqual([
        ['early', 0],
        ['late', 3000],
      ]);
    });

    it('draws nothing it would have to guess a start for, either', () => {
      const model = buildTimeline(
        trajectoryOf([
          request('r', { startedAt: BASE, durationMs: 100 }),
          tool('t', { durationMs: 50 }),
        ]),
        { mode: 'clock' },
      )!;

      expect(model.spans.map((span) => span.rowKey)).toEqual(['r']);
      expect(model.droppedRows).toBe(1);
    });
  });
});
