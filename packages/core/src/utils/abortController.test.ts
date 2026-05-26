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

  it('forwards a custom maxListeners through to the child signal', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent, 123);
    expect(getMaxListeners(child.signal)).toBe(123);
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

  it('auto-cleans input-signal listeners when the timeout fires', async () => {
    // Timeout-driven aborts must run the same auto-cleanup as source-driven
    // aborts — otherwise long-lived input signals (e.g. a session-lived
    // AbortSignal) accumulate dead listeners across many short-lived
    // combinedSignal calls. Verifies cleanup is wired to the COMBINED
    // controller abort path, not just to source-signal events.
    vi.useFakeTimers();
    try {
      const source = createAbortController();
      const before = getEventListeners(source.signal, 'abort').length;
      const { signal } = combineAbortSignals([source.signal], {
        timeoutMs: 50,
      });
      expect(getEventListeners(source.signal, 'abort').length).toBe(before + 1);
      vi.advanceTimersByTime(50);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException).name).toBe('TimeoutError');
      expect(getEventListeners(source.signal, 'abort').length).toBe(before);
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

  it('manual cleanup() cancels a pending timeout so it never fires', () => {
    vi.useFakeTimers();
    try {
      const { signal, cleanup } = combineAbortSignals([], { timeoutMs: 50 });
      cleanup();
      vi.advanceTimersByTime(100);
      // Without the clearTimeout in cleanups[], the timer would still fire
      // and abort the (already-cleaned) signal with TimeoutError.
      expect(signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats timeoutMs <= 0 as "no timeout"', () => {
    vi.useFakeTimers();
    try {
      const zero = combineAbortSignals([], { timeoutMs: 0 });
      const negative = combineAbortSignals([], { timeoutMs: -1 });
      vi.advanceTimersByTime(1_000_000);
      expect(zero.signal.aborted).toBe(false);
      expect(negative.signal.aborted).toBe(false);
      zero.cleanup();
      negative.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and stops registering listeners once an input is found aborted mid-iteration', () => {
    const a = createAbortController();
    const b = createAbortController();
    const c = createAbortController();
    // Simulate a signal whose `aborted` getter returns false during the initial
    // `find` scan and true on subsequent accesses, exercising the per-iteration
    // defensive check inside the for-loop (not the fast path).
    let accessCount = 0;
    const proxied = new Proxy(b.signal, {
      get(target, prop, recv) {
        if (prop === 'aborted') {
          accessCount++;
          return accessCount > 1; // false on first access, true thereafter
        }
        return Reflect.get(target, prop, recv);
      },
    }) as AbortSignal;
    const { signal } = combineAbortSignals([a.signal, proxied, c.signal]);
    // Per-iteration check fires when the loop reaches proxied (2nd `aborted`
    // access) and short-circuits → controller aborts, loop breaks before c.
    expect(signal.aborted).toBe(true);
    // a was iterated before the break and DID get a listener — cleanup must
    // run synchronously (since adding to an already-aborted signal is a no-op),
    // otherwise the listener leaks on the long-lived input.
    expect(getEventListeners(a.signal, 'abort').length).toBe(0);
    // c never had a listener attached (we broke out of the loop before it).
    expect(getEventListeners(c.signal, 'abort').length).toBe(0);
  });

  it('does not schedule a timeout when the per-iteration check aborts the controller mid-loop', () => {
    // Drives the `!controller.signal.aborted` guard inside the timeout
    // block (not the pre-loop fast path): the Proxy reports `aborted=false`
    // on the initial scan and `aborted=true` once the loop re-checks it.
    // Spy on setTimeout so we can distinguish "guard skipped scheduling"
    // from "scheduled then immediately cleared by synchronous cleanup" —
    // the latter would be observationally indistinguishable via timer
    // advancement alone since cleanup() runs synchronously and clears the
    // timer it just scheduled.
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const a = createAbortController();
      const b = createAbortController();
      let accessCount = 0;
      const proxied = new Proxy(b.signal, {
        get(target, prop, recv) {
          if (prop === 'aborted') {
            accessCount++;
            return accessCount > 1;
          }
          return Reflect.get(target, prop, recv);
        },
      }) as AbortSignal;
      const { signal } = combineAbortSignals([a.signal, proxied], {
        timeoutMs: 50,
      });
      expect(signal.aborted).toBe(true);
      // The guard must prevent setTimeout from being called at all.
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      // Belt-and-suspenders: even if a timer somehow snuck through,
      // advancing past it must not change the abort reason.
      const reasonAfterAbort = signal.reason;
      vi.advanceTimersByTime(100);
      expect(signal.reason).toBe(reasonAfterAbort);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
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

describe('lifetime contract', () => {
  it('parent abort propagates to a signal whose controller the caller has dropped', () => {
    // Real-world pattern: caller pipes child.signal into an async API and
    // does not hold the controller object itself. The parent listener
    // closure keeps the controller alive long enough for parent abort to
    // reach the signal — verified WITHOUT --expose-gc because we don't
    // depend on GC behavior at all, only on the strong reference inside
    // the listener closure.
    const parent = createAbortController();
    let signal: AbortSignal;
    (() => {
      const child = createChildAbortController(parent);
      signal = child.signal;
    })();
    expect(signal!.aborted).toBe(false);
    parent.abort('parent-reason');
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBe('parent-reason');
  });
});

describe('GC safety (best-effort, requires --expose-gc)', () => {
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  const itGc = maybeGc ? it : it.skip;

  itGc('controller becomes GC-eligible after the child aborts', async () => {
    // After child.abort(), the reverse-cleanup listener removes the
    // parent's handler closure — which was the strong holder of the
    // controller. With no other refs, the controller is collectable.
    const parent = createAbortController();
    let weakChild: WeakRef<AbortController>;
    (() => {
      const child = createChildAbortController(parent);
      weakChild = new WeakRef(child);
      child.abort();
    })();
    await new Promise((r) => setTimeout(r, 0));
    maybeGc!();
    await new Promise((r) => setTimeout(r, 0));
    maybeGc!();
    expect(weakChild!.deref()).toBeUndefined();
  });
});
