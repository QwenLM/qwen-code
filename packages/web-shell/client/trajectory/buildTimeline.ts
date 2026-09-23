/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Trajectory, TrajectoryRow } from './types';

/** 0 main-session requests · 1 tool calls · 2 subagent requests. */
export type TimelineLane = 0 | 1 | 2;

export interface TimelineSpan {
  /** The table row this span draws; selecting a span selects this row. */
  rowKey: string;
  row: TrajectoryRow;
  lane: TimelineLane;
  /** Offset into the compressed domain, ms. */
  start: number;
  end: number;
  /** Requests with a recorded TTFT only: where the first token landed. */
  ttftEnd?: number;
  error: boolean;
}

export interface TimelineTurnMark {
  turnIndex: number;
  at: number;
}

export interface TimelineModel {
  /** Ascending by start, then lane, then row key. */
  spans: TimelineSpan[];
  turnMarks: TimelineTurnMark[];
  /**
   * Length of the domain. Idle gaps are cut out, so this is the time during
   * which at least one request or tool was running — not wall-clock time.
   */
  total: number;
  /**
   * Rows with a recorded duration but no recorded start — tool calls from a
   * session written before tools recorded one. Not drawn, never estimated.
   */
  droppedRows: number;
}

interface RawSpan {
  row: TrajectoryRow;
  lane: TimelineLane;
  start: number;
  durationMs: number;
  ttftMs?: number;
  error: boolean;
}

function toRawSpan(row: TrajectoryRow): RawSpan | 'dropped' | undefined {
  if (row.kind === 'request') {
    const { startedAt, durationMs, ttftMs } = row.timing;
    if (startedAt === undefined) return 'dropped';
    return {
      row,
      lane: row.depth > 0 ? 2 : 0,
      start: startedAt,
      durationMs,
      ...(ttftMs !== undefined && ttftMs >= 0 && ttftMs <= durationMs
        ? { ttftMs }
        : {}),
      error: row.status === 'error',
    };
  }
  if (row.kind === 'tool') {
    if (row.timing === undefined) return undefined;
    const { startedAt, durationMs } = row.timing;
    if (startedAt === undefined) return 'dropped';
    const status = row.toolStatus ?? row.block.status;
    return {
      row,
      lane: 1,
      start: startedAt,
      durationMs,
      error: status === 'error' || status === 'failed',
    };
  }
  return undefined;
}

/**
 * Project the rows that recorded both a start and a duration onto one time
 * axis, with the idle stretches between them cut out.
 *
 * Only measured values are drawn. A row without a start is left off rather
 * than placed next to its neighbours: a bar in the wrong place reads as a fact.
 * Returns `undefined` when nothing in the window can be drawn.
 */
export function buildTimeline(
  trajectory: Trajectory,
): TimelineModel | undefined {
  const raw: RawSpan[] = [];
  let droppedRows = 0;
  for (const row of trajectory.rows) {
    const span = toRawSpan(row);
    if (span === 'dropped') droppedRows += 1;
    else if (span) raw.push(span);
  }
  if (raw.length === 0) return undefined;

  raw.sort(
    (a, b) =>
      a.start - b.start ||
      a.lane - b.lane ||
      (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0),
  );

  // Walk in start order, tracking the furthest end seen. A span that starts
  // after it opens an idle gap, and every later span shifts left by the total
  // gap so far. Overlapping and parallel spans open no gap, so they are never
  // shifted twice.
  const spans: TimelineSpan[] = [];
  let coveredUntil = raw[0]!.start;
  let removed = raw[0]!.start;
  let total = 0;
  for (const span of raw) {
    if (span.start > coveredUntil) removed += span.start - coveredUntil;
    const end = span.start + span.durationMs;
    coveredUntil = Math.max(coveredUntil, end);
    const start = span.start - removed;
    total = Math.max(total, end - removed);
    spans.push({
      rowKey: span.row.key,
      row: span.row,
      lane: span.lane,
      start,
      end: end - removed,
      ...(span.ttftMs !== undefined ? { ttftEnd: start + span.ttftMs } : {}),
      error: span.error,
    });
  }

  const startByKey = new Map(spans.map((span) => [span.rowKey, span.start]));
  const turnMarks: TimelineTurnMark[] = [];
  for (const turn of trajectory.turns) {
    let at: number | undefined;
    for (const key of turn.rowKeys) {
      const start = startByKey.get(key);
      if (start !== undefined && (at === undefined || start < at)) at = start;
    }
    // The domain starts where the first turn does; a line there marks nothing.
    if (at !== undefined && at > 0)
      turnMarks.push({ turnIndex: turn.index, at });
  }

  return { spans, turnMarks, total, droppedRows };
}
