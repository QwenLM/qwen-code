/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stream aggregation window: the renderer-shared coalescing semantics.
 * Consecutive same-group events merge into one group per window;
 * never-same-group events (images) ride as single-event groups; consumers
 * drive boundaries via flushNow and failed attempts via discard.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  STREAM_UPDATE_WINDOW_MS,
  createStreamAggregator,
} from './stream-aggregation.js';

type TestEvent =
  | { kind: 'text'; value: string }
  | { kind: 'thought'; value: string }
  | { kind: 'image'; value: string };

interface Harness {
  flushed: TestEvent[];
  mergeCalls: number;
  push: (event: TestEvent) => void;
  flushNow: () => void;
  discard: () => void;
}

function createHarness(options?: { windowMs?: number }): Harness {
  const flushed: TestEvent[] = [];
  let mergeCalls = 0;
  const aggregator = createStreamAggregator<TestEvent>({
    ...(options?.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
    sameGroup: (a, b) => a.kind === b.kind,
    mergeGroup: (group) => {
      mergeCalls++;
      return {
        kind: group[0].kind,
        value: group.map((event) => event.value).join(''),
      } as TestEvent;
    },
    onFlush: (event) => flushed.push(event),
  });
  return {
    flushed,
    get mergeCalls() {
      return mergeCalls;
    },
    push: (event) => aggregator.push(event),
    flushNow: () => aggregator.flushNow(),
    discard: () => aggregator.discard(),
  };
}

describe('createStreamAggregator', () => {
  it('exposes the shared 60ms window', () => {
    expect(STREAM_UPDATE_WINDOW_MS).toBe(60);
  });

  it('flushes at the default window when windowMs is omitted', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.push({ kind: 'text', value: 'a' });
      expect(h.flushed).toEqual([]);
      vi.advanceTimersByTime(STREAM_UPDATE_WINDOW_MS - 1);
      expect(h.flushed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(h.flushed).toEqual([{ kind: 'text', value: 'a' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces consecutive same-group events inside one window', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ windowMs: 20 });
      h.push({ kind: 'text', value: 'a' });
      h.push({ kind: 'text', value: 'b' });
      h.push({ kind: 'text', value: 'c' });
      expect(h.flushed).toEqual([]);
      vi.advanceTimersByTime(20);
      expect(h.flushed).toEqual([{ kind: 'text', value: 'abc' }]);
      expect(h.mergeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a single-event group untouched without merging', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ windowMs: 20 });
      h.push({ kind: 'text', value: 'a' });
      vi.advanceTimersByTime(20);
      expect(h.flushed).toEqual([{ kind: 'text', value: 'a' }]);
      expect(h.mergeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('splits groups at kind changes and preserves order', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ windowMs: 20 });
      h.push({ kind: 'thought', value: 't1' });
      h.push({ kind: 'thought', value: 't2' });
      h.push({ kind: 'text', value: 'a' });
      h.push({ kind: 'text', value: 'b' });
      vi.advanceTimersByTime(20);
      expect(h.flushed).toEqual([
        { kind: 'thought', value: 't1t2' },
        { kind: 'text', value: 'ab' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rides never-same-group events (images) as single-event groups', () => {
    vi.useFakeTimers();
    try {
      // Images ride the window as their own group instead of merging with
      // adjacent text or with each other.
      const h = createHarness({ windowMs: 20 });
      h.push({ kind: 'text', value: 'before' });
      h.push({ kind: 'image', value: 'img' });
      h.push({ kind: 'text', value: 'after' });
      expect(h.flushed).toEqual([]);
      vi.advanceTimersByTime(20);
      expect(h.flushed).toEqual([
        { kind: 'text', value: 'before' },
        { kind: 'image', value: 'img' },
        { kind: 'text', value: 'after' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the window at the first buffered event, not per event', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ windowMs: 30 });
      h.push({ kind: 'text', value: 'a' });
      vi.advanceTimersByTime(20);
      h.push({ kind: 'text', value: 'b' });
      // 20ms after the second push = 40ms after the first: past the window.
      vi.advanceTimersByTime(20);
      expect(h.flushed).toEqual([{ kind: 'text', value: 'ab' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushNow drains synchronously and cancels the timer', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ windowMs: 20 });
      h.push({ kind: 'text', value: 'a' });
      h.flushNow();
      expect(h.flushed).toEqual([{ kind: 'text', value: 'a' }]);
      vi.advanceTimersByTime(50);
      expect(h.flushed).toHaveLength(1);

      // Idempotent on an empty buffer.
      h.flushNow();
      expect(h.flushed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms the window for events pushed after a flush', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ windowMs: 20 });
      h.push({ kind: 'text', value: 'a' });
      h.flushNow();
      h.push({ kind: 'text', value: 'b' });
      vi.advanceTimersByTime(20);
      expect(h.flushed).toEqual([
        { kind: 'text', value: 'a' },
        { kind: 'text', value: 'b' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discard drops pending events without flushing', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ windowMs: 20 });
      h.push({ kind: 'text', value: 'a' });
      h.discard();
      vi.advanceTimersByTime(50);
      expect(h.flushed).toEqual([]);
      // The buffer is gone: later pushes start fresh.
      h.push({ kind: 'text', value: 'b' });
      vi.advanceTimersByTime(20);
      expect(h.flushed).toEqual([{ kind: 'text', value: 'b' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hasPending reports buffered events by predicate', () => {
    const aggregator = createStreamAggregator<TestEvent>({
      windowMs: 20,
      sameGroup: (a, b) => a.kind === b.kind,
      mergeGroup: (group) =>
        ({
          kind: group[0].kind,
          value: group.map((e) => e.value).join(''),
        }) as TestEvent,
      onFlush: () => {},
    });
    expect(aggregator.hasPending()).toBe(false);
    expect(aggregator.hasPending((e) => e.kind === 'thought')).toBe(false);
    aggregator.push({ kind: 'text', value: 'a' });
    expect(aggregator.hasPending()).toBe(true);
    expect(aggregator.hasPending((e) => e.kind === 'thought')).toBe(false);
    aggregator.push({ kind: 'thought', value: 'why' });
    expect(aggregator.hasPending((e) => e.kind === 'thought')).toBe(true);
    aggregator.flushNow();
    expect(aggregator.hasPending()).toBe(false);
  });
});
