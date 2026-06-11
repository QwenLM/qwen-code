/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PolicyReloader } from './reloader.js';
import type { Policy } from './loader.js';

const policy = (n: number): Policy => ({
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    match: { tool: 'bash' },
    action: 'allow' as const,
  })),
});

/**
 * A manual fake timer: `schedule` stores the callback; `flush()` runs the latest
 * scheduled (non-cancelled) one. Models setTimeout/clearTimeout deterministically.
 */
function fakeTimers() {
  let next = 1;
  const cbs = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => {
      const id = next++;
      cbs.set(id, fn);
      return id;
    },
    cancel: (h: unknown) => {
      cbs.delete(h as number);
    },
    /** Run the single still-armed timer (debounce keeps at most one). */
    flush() {
      const entries = [...cbs.entries()];
      cbs.clear();
      for (const [, fn] of entries) fn();
    },
    armed: () => cbs.size,
  };
}

/** A deferred promise so a test can resolve load() mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PolicyReloader', () => {
  it('debounces many rapid triggers into exactly one reload', async () => {
    const t = fakeTimers();
    let loads = 0;
    const applied: Policy[] = [];
    const r = new PolicyReloader({
      load: async () => {
        loads++;
        return policy(1);
      },
      apply: (p) => applied.push(p),
      onReloaded: () => {},
      onError: () => {},
      schedule: t.schedule,
      cancel: t.cancel,
    });

    r.trigger();
    r.trigger();
    r.trigger();
    expect(t.armed()).toBe(1); // only the latest timer is armed
    t.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(1);
    expect(applied).toHaveLength(1);
  });

  it('on success calls apply then onReloaded (not onError)', async () => {
    const t = fakeTimers();
    const order: string[] = [];
    const r = new PolicyReloader({
      load: async () => policy(2),
      apply: () => order.push('apply'),
      onReloaded: (p) => order.push(`reloaded:${p.rules.length}`),
      onError: () => order.push('error'),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    r.trigger();
    t.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['apply', 'reloaded:2']);
  });

  it('on a failed load calls onError and does NOT apply (old policy retained)', async () => {
    const t = fakeTimers();
    let applied = false;
    let errored: unknown;
    const r = new PolicyReloader({
      load: async () => {
        throw new Error('bad yaml');
      },
      apply: () => {
        applied = true;
      },
      onReloaded: () => {},
      onError: (e) => {
        errored = e;
      },
      schedule: t.schedule,
      cancel: t.cancel,
    });
    r.trigger();
    t.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toBe(false);
    expect((errored as Error).message).toBe('bad yaml');
  });

  it('a trigger during an in-flight reload yields exactly one extra reload (last edit wins)', async () => {
    const t = fakeTimers();
    let loads = 0;
    const d = [deferred<Policy>(), deferred<Policy>()];
    const r = new PolicyReloader({
      load: () => {
        const idx = loads++;
        return d[idx]?.promise ?? Promise.resolve(policy(0));
      },
      apply: () => {},
      onReloaded: () => {},
      onError: () => {},
      schedule: t.schedule,
      cancel: t.cancel,
    });

    r.trigger();
    t.flush(); // starts reload #0, awaiting d[0]
    await Promise.resolve();
    expect(loads).toBe(1);

    r.trigger(); // arrives while #0 is in flight
    t.flush(); // its debounce fires → run() sees running → pending=true
    await Promise.resolve();
    expect(loads).toBe(1); // still in #0; no overlap

    d[0].resolve(policy(1)); // #0 completes → pending re-runs once
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(2); // exactly one extra
    d[1].resolve(policy(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(2); // no further reloads
  });

  it('stop() cancels a pending reload', async () => {
    const t = fakeTimers();
    let loads = 0;
    const r = new PolicyReloader({
      load: async () => {
        loads++;
        return policy(1);
      },
      apply: () => {},
      onReloaded: () => {},
      onError: () => {},
      schedule: t.schedule,
      cancel: t.cancel,
    });
    r.trigger();
    r.stop();
    expect(t.armed()).toBe(0);
    t.flush(); // nothing armed
    await Promise.resolve();
    expect(loads).toBe(0);
  });

  it('a throwing apply callback is caught (reloader stays total)', async () => {
    const t = fakeTimers();
    let errored = false;
    const r = new PolicyReloader({
      load: async () => policy(1),
      apply: () => {
        throw new Error('apply boom');
      },
      onReloaded: () => {},
      onError: () => {
        errored = true;
      },
      schedule: t.schedule,
      cancel: t.cancel,
    });
    r.trigger();
    t.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(errored).toBe(true);
  });
});
