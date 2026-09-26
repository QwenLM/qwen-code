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

/** Runs `body` under fake timers, restoring real timers even if it throws. */
function withFakeTimers(body: () => void) {
  vi.useFakeTimers();
  try {
    body();
  } finally {
    vi.useRealTimers();
  }
}

// `aborted` reads false on the first (fast-path `find`) access and true after,
// driving the per-iteration check inside the for-loop instead.
function abortedAfterFirstRead(signal: AbortSignal): AbortSignal {
  let accessCount = 0;
  return new Proxy(signal, {
    get(target, prop, recv) {
      if (prop === 'aborted') {
        accessCount++;
        return accessCount > 1;
      }
      return Reflect.get(target, prop, recv);
    },
  }) as AbortSignal;
}

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
    withFakeTimers(() => {
      const { signal } = combineAbortSignals([], { timeoutMs: 50 });
      vi.advanceTimersByTime(50);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException).name).toBe('TimeoutError');
    });
  });

  it('auto-cleans input-signal listeners when the timeout fires', async () => {
    // Timeout aborts need the same auto-cleanup as source aborts, or long-lived
    // inputs (e.g. a session AbortSignal) accumulate dead listeners across many
    // short-lived calls: cleanup is wired to the COMBINED controller's abort.
    withFakeTimers(() => {
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
    });
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
    withFakeTimers(() => {
      const { signal, cleanup } = combineAbortSignals([], { timeoutMs: 50 });
      cleanup();
      vi.advanceTimersByTime(100);
      // Without the clearTimeout in cleanups[], the timer would still abort
      // the (already-cleaned) signal with TimeoutError.
      expect(signal.aborted).toBe(false);
    });
  });

  it('treats timeoutMs <= 0 as "no timeout"', () => {
    withFakeTimers(() => {
      const zero = combineAbortSignals([], { timeoutMs: 0 });
      const negative = combineAbortSignals([], { timeoutMs: -1 });
      vi.advanceTimersByTime(1_000_000);
      expect(zero.signal.aborted).toBe(false);
      expect(negative.signal.aborted).toBe(false);
      zero.cleanup();
      negative.cleanup();
    });
  });

  it('aborts and stops registering listeners once an input is found aborted mid-iteration', () => {
    const a = createAbortController();
    const b = createAbortController();
    const c = createAbortController();
    const proxied = abortedAfterFirstRead(b.signal);
    const { signal } = combineAbortSignals([a.signal, proxied, c.signal]);
    // The loop's 2nd `aborted` read on proxied aborts and breaks before c.
    expect(signal.aborted).toBe(true);
    // a DID get a listener before the break; cleanup must run synchronously
    // (adding to an aborted signal is a no-op) or it leaks on the input.
    expect(getEventListeners(a.signal, 'abort').length).toBe(0);
    // c never had a listener attached (we broke out of the loop before it).
    expect(getEventListeners(c.signal, 'abort').length).toBe(0);
  });

  it('does not schedule a timeout when the per-iteration check aborts the controller mid-loop', () => {
    // Drives the `!controller.signal.aborted` guard in the timeout block (not
    // the pre-loop fast path). The setTimeout spy tells "guard skipped
    // scheduling" from "scheduled then cleared by synchronous cleanup", which
    // advancing timers alone cannot distinguish.
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const a = createAbortController();
      const proxied = abortedAfterFirstRead(createAbortController().signal);
      const { signal } = combineAbortSignals([a.signal, proxied], {
        timeoutMs: 50,
      });
      expect(signal.aborted).toBe(true);
      // The guard must prevent setTimeout from being called at all.
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      // Belt-and-suspenders: a timer that snuck through must not change the reason.
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
    // Real-world pattern: the caller pipes child.signal into an async API and
    // drops the controller. The parent listener closure's strong reference
    // keeps it alive, so no --expose-gc is needed: GC behaviour is irrelevant.
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
