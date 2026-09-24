/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { TimelineModel, TimelineSpan } from './buildTimeline';
import type { TrajectoryRow } from './types';
import { rowKeysInRange } from './timelineRange';

const ROW = { kind: 'request', key: 'x' } as unknown as TrajectoryRow;

function span(rowKey: string, start: number, end: number): TimelineSpan {
  return { rowKey, row: ROW, lane: 0, start, end, error: false };
}

function model(spans: TimelineSpan[]): TimelineModel {
  return {
    spans,
    turnMarks: [],
    total: Math.max(0, ...spans.map((s) => s.end)),
    droppedRows: 0,
  };
}

const keys = (set: Set<string>) => [...set].sort();

describe('rowKeysInRange', () => {
  const MODEL = model([
    span('a', 0, 100),
    span('b', 100, 300),
    span('c', 300, 400),
    span('d', 500, 900),
  ]);

  it('keeps every span running at any point in the range', () => {
    expect(keys(rowKeysInRange(MODEL, { start: 150, end: 550 }))).toEqual([
      'b',
      'c',
      'd',
    ]);
  });

  it('counts a span that only touches either end', () => {
    // `a` ends where the range starts and `c` starts where it ends.
    expect(keys(rowKeysInRange(MODEL, { start: 100, end: 300 }))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps a zero-length span inside the range and drops one outside', () => {
    const zero = model([span('in', 200, 200), span('out', 800, 800)]);
    expect(keys(rowKeysInRange(zero, { start: 100, end: 300 }))).toEqual([
      'in',
    ]);
  });

  it('finds nothing in a gap between spans', () => {
    expect(rowKeysInRange(MODEL, { start: 420, end: 480 }).size).toBe(0);
  });

  it('keeps a span that covers the whole range', () => {
    expect(keys(rowKeysInRange(MODEL, { start: 600, end: 700 }))).toEqual([
      'd',
    ]);
  });
});
