/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { getEventListeners, getMaxListeners } from 'node:events';
import {
  combineAbortSignals,
  createAbortController,
  createChildAbortController,
} from './abortController.js';

describe('createAbortController', () => {
  it('sets a default max-listener cap of 50 on the signal', () => {
    const controller = createAbortController();
    expect(getMaxListeners(controller.signal)).toBe(50);
  });

  it('honors a custom max-listener cap', () => {
    const controller = createAbortController(200);
    expect(getMaxListeners(controller.signal)).toBe(200);
  });

  it('produces a working, abortable controller', () => {
    const controller = createAbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort('done');
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('done');
  });
});

describe('createChildAbortController', () => {
  it('aborts when the parent aborts and propagates the reason', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent);
    parent.abort('parent-reason');
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('parent-reason');
  });

  it('does not abort the parent when the child aborts', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent);
    child.abort('child-reason');
    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it('aborts synchronously when the parent is already aborted (fast path)', () => {
    const parent = createAbortController();
    parent.abort('pre-aborted');
    const child = createChildAbortController(parent);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('pre-aborted');
    // No listener should have been registered on the parent in the fast path.
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('removes its parent listener once the child has aborted (reverse cleanup)', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent);
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1);
    child.abort();
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('removes its parent listener after parent abort fires (once: true)', () => {
    const parent = createAbortController();
    createChildAbortController(parent);
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1);
    parent.abort();
    // The {once: true} listener should self-remove after firing.
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('does not accumulate listeners on a long-lived parent across many short-lived children', () => {
    const parent = createAbortController();
    for (let i = 0; i < 1000; i++) {
      const child = createChildAbortController(parent);
      child.abort();
    }
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('accepts an AbortSignal directly as the parent', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent.signal);
    parent.abort();
    expect(child.signal.aborted).toBe(true);
  });

  it('returns a plain controller when the parent is undefined', () => {
    const child = createChildAbortController(undefined);
    expect(child.signal.aborted).toBe(false);
    child.abort('manual');
    expect(child.signal.aborted).toBe(true);
  });
});

describe('combineAbortSignals', () => {
  it('aborts when any input signal aborts', () => {
    const a = createAbortController();
    const b = createAbortController();
    const { signal } = combineAbortSignals([a.signal, b.signal]);
    expect(signal.aborted).toBe(false);
    b.abort('from-b');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('from-b');
  });

  it('aborts synchronously when an input is already aborted', () => {
    const a = createAbortController();
    a.abort('pre');
    const { signal, cleanup } = combineAbortSignals([a.signal]);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('pre');
    expect(() => cleanup()).not.toThrow();
  });

  it('ignores undefined entries', () => {
    const a = createAbortController();
    const { signal } = combineAbortSignals([undefined, a.signal, undefined]);
    a.abort();
    expect(signal.aborted).toBe(true);
  });

  it('fires the timeout when no signal aborts first', async () => {
    vi.useFakeTimers();
    try {
      const { signal } = combineAbortSignals([], { timeoutMs: 50 });
      vi.advanceTimersByTime(50);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException).name).toBe('TimeoutError');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup removes listeners from inputs', () => {
    const a = createAbortController();
    const before = getEventListeners(a.signal, 'abort').length;
    const { cleanup } = combineAbortSignals([a.signal]);
    expect(getEventListeners(a.signal, 'abort').length).toBe(before + 1);
    cleanup();
    expect(getEventListeners(a.signal, 'abort').length).toBe(before);
  });

  it('cleanup is idempotent', () => {
    const a = createAbortController();
    const { cleanup } = combineAbortSignals([a.signal]);
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  it('auto-cleans listeners on inputs when the combined signal aborts', () => {
    const a = createAbortController();
    const b = createAbortController();
    combineAbortSignals([a.signal, b.signal]);
    expect(getEventListeners(a.signal, 'abort').length).toBe(1);
    expect(getEventListeners(b.signal, 'abort').length).toBe(1);
    a.abort();
    expect(getEventListeners(a.signal, 'abort').length).toBe(0);
    expect(getEventListeners(b.signal, 'abort').length).toBe(0);
  });
});

describe('GC safety (best-effort, requires --expose-gc)', () => {
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  const itGc = maybeGc ? it : it.skip;

  itGc(
    'does not retain abandoned children through the parent listener',
    async () => {
      const parent = createAbortController();
      let weakChild: WeakRef<AbortController>;
      (() => {
        const child = createChildAbortController(parent);
        weakChild = new WeakRef(child);
      })();
      // Yield to allow finalizers; then GC.
      await new Promise((r) => setTimeout(r, 0));
      maybeGc!();
      await new Promise((r) => setTimeout(r, 0));
      maybeGc!();
      expect(weakChild!.deref()).toBeUndefined();
      // Firing parent now should not throw (handler dereferences a dead WeakRef).
      expect(() => parent.abort()).not.toThrow();
    },
  );
});
