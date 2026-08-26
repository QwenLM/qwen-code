/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-neutral stream aggregation window.
 *
 * One place for the 60ms coalescing semantics shared by the renderers
 * (see docs/design/screen-mode-contracts.md, "streaming aggregation"):
 * token-level events arrive far faster than a terminal frame, so
 * consecutive events merge into one group per window, while consumers
 * flush pending groups at turn boundaries (flushNow) or drop them on a
 * failed attempt (discard), preserving cross-kind ordering and
 * turn-boundary semantics.
 *
 * This module must not import react / solid / ink / @opentui — the rule is
 * enforced by `scripts/check-tui-dep-direction.mjs`.
 */

/** The aggregation window both renderers coalesce stream events into. */
export const STREAM_UPDATE_WINDOW_MS = 60;

export interface StreamAggregationOptions<E> {
  /** Coalescing window; defaults to {@link STREAM_UPDATE_WINDOW_MS}. */
  windowMs?: number;
  /**
   * Whether `next` merges into the group headed by `head`. Events that are
   * never same-group (e.g. images) ride the window as single-event groups.
   */
  sameGroup: (head: E, next: E) => boolean;
  /**
   * Collapse a multi-event group into one. Only called for groups of two or
   * more events; single-event groups pass through untouched.
   */
  mergeGroup: (group: readonly E[]) => E;
  /** Consume a flushed event — a merged group or a pass-through. */
  onFlush: (event: E) => void;
}

export interface StreamAggregator<E> {
  /** Stream arrival path: buffer, coalesce, or pass through. */
  push(event: E): void;
  /**
   * Whether any event is sitting in the pending buffer, optionally limited
   * to events matching `predicate`. Consumers use this to detect pending
   * cross-kind transitions (e.g. "is buffered reasoning waiting when the
   * answer starts streaming?").
   */
  hasPending(predicate?: (event: E) => boolean): boolean;
  /**
   * Flush every pending group now, synchronously, and cancel the window
   * timer. Boundary handling and external pre-snapshot drains call this
   * (e.g. cancellation must land buffered content in React state before
   * the caller snapshots it).
   */
  flushNow(): void;
  /** Drop all pending events without flushing (failed-attempt reset). */
  discard(): void;
}

export function createStreamAggregator<E>(
  options: StreamAggregationOptions<E>,
): StreamAggregator<E> {
  const { sameGroup, mergeGroup, onFlush } = options;
  const windowMs = options.windowMs ?? STREAM_UPDATE_WINDOW_MS;
  const buffer: E[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flushNow = () => {
    cancelTimer();
    while (buffer.length > 0) {
      const group: E[] = [buffer.shift()!];
      while (buffer.length > 0 && sameGroup(group[0], buffer[0])) {
        group.push(buffer.shift()!);
      }
      onFlush(group.length === 1 ? group[0] : mergeGroup(group));
    }
  };

  const schedule = () => {
    if (flushTimer === null) {
      flushTimer = setTimeout(flushNow, windowMs);
    }
  };

  return {
    push(event: E) {
      buffer.push(event);
      schedule();
    },
    hasPending(predicate?: (event: E) => boolean) {
      return predicate ? buffer.some(predicate) : buffer.length > 0;
    },
    flushNow,
    discard() {
      cancelTimer();
      buffer.length = 0;
    },
  };
}
