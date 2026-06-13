/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DebouncedReloader } from './debouncedReloader.js';

/** A manual fake timer: `flush()` runs the latest scheduled (non-cancelled) one. */
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
    flush() {
      const entries = [...cbs.entries()];
      cbs.clear();
      for (const [, fn] of entries) fn();
    },
    armed: () => cbs.size,
  };
}

describe('DebouncedReloader (generic, over an arbitrary value type)', () => {
  it('debounces many triggers into one reload and applies the loaded value', async () => {
    const t = fakeTimers();
    let loads = 0;
    const applied: string[] = [];
    const r = new DebouncedReloader<string>({
      load: async () => {
        loads++;
        return `v${loads}`;
      },
      apply: (v) => applied.push(v),
      onReloaded: () => {},
      onError: () => {},
      schedule: t.schedule,
      cancel: t.cancel,
    });
    r.trigger();
    r.trigger();
    r.trigger();
    expect(t.armed()).toBe(1);
    t.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(1);
    expect(applied).toEqual(['v1']);
  });

  it('on a failed load calls onError and does NOT apply (previous value retained)', async () => {
    const t = fakeTimers();
    let applied = false;
    let errored: unknown;
    const r = new DebouncedReloader<number>({
      load: async () => {
        throw new Error('bad');
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
    expect((errored as Error).message).toBe('bad');
  });
});
