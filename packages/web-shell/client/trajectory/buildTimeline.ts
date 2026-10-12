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

/**
 * How the axis treats time in which nothing ran. `active` cuts it out, so the
 * strip answers where the running time went; `clock` keeps it, so the strip
 * answers when things ran and how long the run waited between them.
 */
export type TimelineMode = 'active' | 'clock';

export interface TimelineTurnMark {
  turnIndex: number;
  at: number;
}

export interface TimelineModel {
  /** Ascending by start, then lane, then row key. */
  spans: TimelineSpan[];
  turnMarks: TimelineTurnMark[];
  mode: TimelineMode;
  /**
   * Length of the domain. In `active` mode idle gaps are cut out, so this is
   * the time during which at least one request or tool was running. In
   * `clock` mode it runs from the first drawn span's start to the last one's
   * end — which is the loaded window's span, not the session's age.
   */
  total: number;
  /**
   * Time during which at least one drawn span was running. Equal to `total` in
   * `active` mode.
   */
  activeMs: number;
  /** Epoch ms of domain 0: the earliest recorded start among drawn spans. */
  originMs: number;
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
 * axis — with the idle stretches between them cut out (`active`, the default)
 * or left in (`clock`).
 *
 * Only measured values are drawn. A row without a start is left off rather
 * than placed next to its neighbours: a bar in the wrong place reads as a fact.
 * Returns `undefined` when nothing in the window can be drawn.
 */
export function buildTimeline(
  trajectory: Trajectory,
  options: { mode?: TimelineMode } = {},
): TimelineModel | undefined {
  const mode = options.mode ?? 'active';
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
  // after it opens an idle gap. In `active` mode every later span shifts left
  // by the total gap so far; overlapping and parallel spans open no gap, so
  // they are never shifted twice. In `clock` mode nothing shifts past the
  // origin, and the gaps are only summed to say how much of the run was idle.
  const originMs = raw[0]!.start;
  const spans: TimelineSpan[] = [];
  let coveredUntil = originMs;
  let removed = originMs;
  let idleMs = 0;
  let total = 0;
  for (const span of raw) {
    if (span.start > coveredUntil) {
      idleMs += span.start - coveredUntil;
      if (mode === 'active') removed += span.start - coveredUntil;
    }
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

  return {
    spans,
    turnMarks,
    mode,
    total,
    activeMs: mode === 'active' ? total : Math.max(0, total - idleMs),
    originMs,
    droppedRows,
  };
}
