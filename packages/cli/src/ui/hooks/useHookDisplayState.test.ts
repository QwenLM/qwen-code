/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '../../test-utils/render.js';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useHookDisplayState } from './useHookDisplayState.js';
import {
  coreEvents,
  CoreEvent,
  type HookStartPayload,
  type HookEndPayload,
} from '@qwen-code/core';
import { act } from 'react';

const DEBOUNCE_MS = 200;
const MIN_DISPLAY_MS = 1500;
const LINGER_MS = 600;

type StartOverrides = Partial<HookStartPayload> &
  Pick<HookStartPayload, 'hookIndex'>;
type EndOverrides = Partial<HookEndPayload> & Pick<HookEndPayload, 'hookIndex'>;

function start(overrides: StartOverrides) {
  act(() => {
    coreEvents.emit(CoreEvent.HookStart, {
      sessionId: 'test-session',
      hookName: 'PreToolUse',
      eventName: 'PreToolUse',
      batchId: 'b1',
      totalHooks: 1,
      ...overrides,
    });
  });
}

function end(overrides: EndOverrides) {
  act(() => {
    coreEvents.emit(CoreEvent.HookEnd, {
      sessionId: 'test-session',
      hookName: 'PreToolUse',
      eventName: 'PreToolUse',
      batchId: 'b1',
      success: true,
      ...overrides,
    });
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useHookDisplayState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    coreEvents.removeAllListeners(CoreEvent.HookStart);
    coreEvents.removeAllListeners(CoreEvent.HookEnd);
  });

  it.each([300, 2000])('clears a cancelled 2/5 batch immediately at %s ms without a completed frame', async (elapsed) => {
    const frames: number[] = [];
    const { result } = await renderHook(() => {
      const hooks = useHookDisplayState();
      frames.push(hooks.filter((hook) => hook.settled).length);
      return hooks;
    });
    for (let hookIndex = 1; hookIndex <= 5; hookIndex++) {
      start({ hookIndex, totalHooks: 5 });
    }
    advance(elapsed);
    end({ hookIndex: 1 });
    end({ hookIndex: 2 });
    expect(result.current.filter((hook) => hook.settled)).toHaveLength(2);
    for (let hookIndex = 3; hookIndex <= 5; hookIndex++) {
      end({ hookIndex, success: false, cancelled: true });
      expect(result.current).toEqual([]);
    }
    advance(MIN_DISPLAY_MS + LINGER_MS);
    expect(result.current).toEqual([]);
    expect(frames).not.toContain(5);
    start({ batchId: 'next', hookIndex: 1 });
    advance(DEBOUNCE_MS + 1);
    expect(result.current).toHaveLength(1);
    expect(result.current[0].settled).toBe(false);
  });

  it('does not reveal a cancelled batch after debounce or hide another running batch', async () => {
    const { result } = await renderHook(() => useHookDisplayState());
    start({ batchId: 'other', hookIndex: 1 });
    advance(DEBOUNCE_MS + 1);
    start({ hookIndex: 1, totalHooks: 2 });
    end({ hookIndex: 1, success: false, cancelled: true });
    start({ hookIndex: 2, totalHooks: 2 });
    advance(DEBOUNCE_MS + 1);
    expect(result.current).toHaveLength(1);
    expect(result.current[0].total).toBe(1);
    end({ hookIndex: 2, success: false, cancelled: true });
    advance(MIN_DISPLAY_MS + LINGER_MS);
    expect(result.current).toHaveLength(1);
  });

  it('initializes with no hooks', async () => {
    const { result } = await renderHook(() => useHookDisplayState());
    expect(result.current).toEqual([]);
  });

  it('shows a batch only after the debounce expires', async () => {
    const { result } = await renderHook(() => useHookDisplayState());
    vi.setSystemTime(1_000_000);

    start({ hookIndex: 1, statusMessage: 'Checking' });
    expect(result.current).toHaveLength(0);

    advance(DEBOUNCE_MS + 1);
    expect(result.current).toEqual([
      {
        eventName: 'PreToolUse',
        index: 1,
        total: 1,
        statusMessage: 'Checking',
        settled: false,
        batchStartedAt: 1_000_000,
        batchEndedAt: undefined,
      },
    ]);
  });

  it('never shows a batch that finishes within the debounce window', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ hookIndex: 1 });
    advance(100);
    end({ hookIndex: 1 });
    advance(DEBOUNCE_MS + MIN_DISPLAY_MS + LINGER_MS);

    expect(result.current).toHaveLength(0);
  });

  it('keeps a parallel batch visible until its last hook ends', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ hookIndex: 1, totalHooks: 3 });
    start({ hookIndex: 2, totalHooks: 3 });
    start({ hookIndex: 3, totalHooks: 3 });
    advance(DEBOUNCE_MS + 1);
    expect(result.current).toHaveLength(3);

    end({ hookIndex: 2 });
    expect(result.current.map((h) => h.settled)).toEqual([false, true, false]);

    end({ hookIndex: 1 });
    end({ hookIndex: 3 });
    // Finished, but held for the minimum display time.
    expect(result.current.map((h) => h.settled)).toEqual([true, true, true]);

    advance(MIN_DISPLAY_MS);
    expect(result.current).toHaveLength(3);
    advance(LINGER_MS + 1);
    expect(result.current).toEqual([]);
  });

  it('takes the total from the payload for a sequential batch', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ hookIndex: 1, totalHooks: 3 });
    advance(DEBOUNCE_MS + 1);
    expect(result.current).toEqual([
      expect.objectContaining({ index: 1, total: 3, settled: false }),
    ]);

    end({ hookIndex: 1 });
    start({ hookIndex: 2, totalHooks: 3, statusMessage: 'Linting' });
    expect(result.current).toEqual([
      expect.objectContaining({ index: 1, settled: true }),
      expect.objectContaining({
        index: 2,
        statusMessage: 'Linting',
        settled: false,
      }),
    ]);
  });

  it('debounces per batch, so short sequential hooks still show', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ hookIndex: 1, totalHooks: 3 });
    advance(150);
    end({ hookIndex: 1 });
    start({ hookIndex: 2, totalHooks: 3 });
    advance(150);

    expect(result.current).toHaveLength(2);
  });

  it('ignores hooks that run inside a subagent', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ hookIndex: 1, agentId: 'agent-1' });
    advance(DEBOUNCE_MS + 1);
    expect(result.current).toEqual([]);

    expect(() => end({ hookIndex: 1, agentId: 'agent-1' })).not.toThrow();
    expect(result.current).toEqual([]);
  });

  it('treats duplicate and unknown end events as no-ops', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ hookIndex: 1, totalHooks: 2 });
    start({ hookIndex: 2, totalHooks: 2 });
    advance(DEBOUNCE_MS + 1);

    end({ hookIndex: 1 });
    end({ hookIndex: 1 });
    end({ hookIndex: 1, batchId: 'unknown' });
    advance(MIN_DISPLAY_MS + LINGER_MS);

    expect(result.current.map((h) => h.settled)).toEqual([true, false]);
  });

  it('shows the newest batch and falls back to an older running one', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ batchId: 'older', eventName: 'PreToolUse', hookIndex: 1 });
    advance(DEBOUNCE_MS + 1);
    start({
      batchId: 'newer',
      eventName: 'PostToolUse',
      hookIndex: 1,
      totalHooks: 2,
    });
    start({
      batchId: 'newer',
      eventName: 'PostToolUse',
      hookIndex: 2,
      totalHooks: 2,
    });
    advance(DEBOUNCE_MS + 1);
    expect(result.current[0].eventName).toBe('PostToolUse');

    end({ batchId: 'newer', hookIndex: 1 });
    end({ batchId: 'newer', hookIndex: 2 });
    // The finished batch is still inside its minimum display window, but it
    // must not hide the older batch that is still running.
    expect(result.current).toEqual([
      expect.objectContaining({ eventName: 'PreToolUse', settled: false }),
    ]);
  });

  it('keeps separate batches apart when the same event fires again', async () => {
    const { result } = await renderHook(() => useHookDisplayState());

    start({ batchId: 'stop-1', eventName: 'Stop', hookIndex: 1 });
    advance(DEBOUNCE_MS + 1);
    end({ batchId: 'stop-1', eventName: 'Stop', hookIndex: 1 });

    start({ batchId: 'stop-2', eventName: 'Stop', hookIndex: 1 });
    advance(DEBOUNCE_MS + 1);
    expect(result.current).toEqual([
      expect.objectContaining({ eventName: 'Stop', settled: false }),
    ]);

    // The first batch's removal timer must not take the second one with it.
    advance(MIN_DISPLAY_MS + LINGER_MS);
    expect(result.current).toEqual([
      expect.objectContaining({ eventName: 'Stop', settled: false }),
    ]);
  });

  it('times serial hooks from the first start through the last end', async () => {
    const { result, unmount } = await renderHook(() => useHookDisplayState());
    vi.setSystemTime(1_000_000);

    start({ hookIndex: 1, totalHooks: 2 });
    advance(1100);
    end({ hookIndex: 1 });
    advance(500);
    start({ hookIndex: 2, totalHooks: 2 });
    expect(result.current.every((h) => h.batchStartedAt === 1_000_000)).toBe(
      true,
    );
    expect(result.current[0].batchEndedAt).toBeUndefined();

    advance(900);
    end({ hookIndex: 2 });
    expect(result.current).toEqual([
      expect.objectContaining({
        batchStartedAt: 1_000_000,
        batchEndedAt: 1_002_500,
        settled: true,
      }),
      expect.objectContaining({
        batchStartedAt: 1_000_000,
        batchEndedAt: 1_002_500,
        settled: true,
      }),
    ]);
    advance(LINGER_MS - 1);
    expect(result.current[0].batchEndedAt).toBe(1_002_500);
    advance(1);
    expect(result.current).toEqual([]);
    unmount();
  });

  it('freezes a parallel batch at its final end during the minimum hold', async () => {
    const { result, unmount } = await renderHook(() => useHookDisplayState());
    vi.setSystemTime(1_000_000);

    start({ hookIndex: 1, totalHooks: 2 });
    advance(100);
    start({ hookIndex: 2, totalHooks: 2 });
    advance(200);
    end({ hookIndex: 1 });
    expect(result.current[0].batchEndedAt).toBeUndefined();
    advance(200);
    end({ hookIndex: 2 });
    expect(result.current[0]).toMatchObject({
      batchStartedAt: 1_000_000,
      batchEndedAt: 1_000_500,
    });
    advance(1400);
    expect(result.current[0].batchEndedAt).toBe(1_000_500);
    unmount();
  });

  it('restores the older running batch timing and resets for a new batch', async () => {
    const { result, unmount } = await renderHook(() => useHookDisplayState());
    vi.setSystemTime(1_000_000);

    start({ batchId: 'older', hookIndex: 1 });
    advance(300);
    start({ batchId: 'newer', hookIndex: 1 });
    advance(300);
    expect(result.current[0].batchStartedAt).toBe(1_000_300);
    end({ batchId: 'newer', hookIndex: 1 });
    expect(result.current[0]).toMatchObject({
      batchStartedAt: 1_000_000,
      settled: false,
    });
    expect(result.current[0].batchEndedAt).toBeUndefined();
    unmount();
  });

  it('clears every timer on unmount', async () => {
    const { unmount } = await renderHook(() => useHookDisplayState());
    const timersBefore = vi.getTimerCount();

    start({ hookIndex: 1, totalHooks: 2 });
    start({ batchId: 'b2', hookIndex: 1 });
    advance(DEBOUNCE_MS + 1);
    end({ batchId: 'b2', hookIndex: 1 });
    expect(vi.getTimerCount()).toBeGreaterThan(timersBefore);

    unmount();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});
