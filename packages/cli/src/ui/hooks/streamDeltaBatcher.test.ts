/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStreamDeltaBatcher,
  type StreamDeltaKind,
} from './streamDeltaBatcher.js';

const WINDOW = 16;

describe('createStreamDeltaBatcher', () => {
  let applied: Array<{ kind: StreamDeltaKind; text: string }>;
  let clock: number;

  const makeBatcher = () =>
    createStreamDeltaBatcher({
      windowMs: WINDOW,
      now: () => clock,
      onApply: (kind, text) => applied.push({ kind, text }),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    applied = [];
    clock = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the first delta immediately even with a clock starting at 0', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    expect(applied).toEqual([{ kind: 'text', text: 'a' }]);
  });

  it('coalesces same-kind deltas inside a window and flushes on the trailing edge', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    clock += 5;
    b.push('text', 'b');
    clock += 5;
    b.push('text', 'c');
    expect(applied).toEqual([{ kind: 'text', text: 'a' }]);

    clock += 6; // window boundary
    vi.advanceTimersByTime(WINDOW);
    expect(applied).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'bc' },
    ]);
  });

  it('takes the leading edge again once a full window has elapsed', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    clock += WINDOW;
    b.push('text', 'b');
    expect(applied).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('applies buffered content of the old kind before a cross-kind delta, in order', () => {
    const b = makeBatcher();
    b.push('thinking', 'A');
    clock += 2;
    b.push('thinking', 'B');
    clock += 2;
    b.push('text', 'ok');
    expect(applied).toEqual([
      { kind: 'thinking', text: 'A' },
      { kind: 'thinking', text: 'B' },
      { kind: 'text', text: 'ok' },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flush applies buffered content and is a strict no-op when clean', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    clock += 2;
    b.push('text', 'b');
    b.flush();
    expect(applied).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);

    // Clean flush: no apply, and the clock is untouched so it cannot
    // push the next leading edge out.
    b.flush();
    expect(applied).toHaveLength(2);
  });

  it('a clean flush does not delay the next leading edge', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    clock += 2;
    b.flush(); // clean after the trailing content was already applied? no: 'a' applied leading, nothing buffered
    b.push('text', 'b'); // still inside the window of the 'a' apply
    expect(applied).toEqual([{ kind: 'text', text: 'a' }]);
    clock += WINDOW;
    vi.advanceTimersByTime(WINDOW);
    expect(applied).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('discard drops buffered content, cancels the timer, and resets the clock', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    clock += 2;
    b.push('text', 'lost');
    b.discard();
    vi.advanceTimersByTime(WINDOW * 2);
    expect(applied).toEqual([{ kind: 'text', text: 'a' }]);

    // After discard the next delta takes the leading edge immediately,
    // even though the wall clock barely moved.
    clock += 1;
    b.push('text', 'fresh');
    expect(applied).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'fresh' },
    ]);
  });

  it('clamps the trailing delay when the clock steps backwards', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    clock -= 1000; // backwards step
    b.push('text', 'b');
    expect(applied).toEqual([{ kind: 'text', text: 'a' }]);
    // Degrades to debounce: the trailing timer is clamped to windowMs.
    vi.advanceTimersByTime(WINDOW);
    expect(applied).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('schedules only one trailing timer per window', () => {
    const b = makeBatcher();
    b.push('text', 'a');
    clock += 1;
    for (let i = 0; i < 10; i++) {
      b.push('text', 'x');
    }
    expect(vi.getTimerCount()).toBe(1);
  });
});
