/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The loader keeps top-level module state (lowlightInstance, in-flight
 * promise, last-failure timestamp). `test-setup.ts` primes that state once
 * per test worker, so to exercise the load / failure / cooldown / shape-check
 * branches we need a fresh module copy per test plus a mock of `lowlight`.
 *
 * `vi.resetModules()` clears the module cache so the next dynamic
 * `await import('./lowlightLoader.js')` re-runs the file with all state
 * reset to zero. `vi.doMock('lowlight', ...)` injects the desired upstream
 * shape for the dynamic `import('lowlight')` inside `loadLowlight`.
 */

describe('lowlightLoader', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('lowlight');
    vi.resetModules();
  });

  function makeLowlightInstance() {
    return {
      registered: vi.fn(() => true),
      highlight: vi.fn(() => ({ type: 'root', children: [] })),
      highlightAuto: vi.fn(() => ({ type: 'root', children: [] })),
    };
  }

  it('resolves with a Lowlight instance on first successful load', async () => {
    const instance = makeLowlightInstance();
    vi.doMock('lowlight', () => ({
      createLowlight: vi.fn(() => instance),
      common: {},
    }));

    const mod = await import('./lowlightLoader.js');
    expect(mod.getLowlightInstance()).toBeNull();

    const loaded = await mod.loadLowlight();
    expect(loaded).toBe(instance);
    expect(mod.getLowlightInstance()).toBe(instance);
    expect(mod.isLowlightCoolingDown()).toBe(false);
  });

  it('dedupes concurrent in-flight loads to a single dynamic import', async () => {
    const instance = makeLowlightInstance();
    const createLowlight = vi.fn(() => instance);
    vi.doMock('lowlight', () => ({ createLowlight, common: {} }));

    const mod = await import('./lowlightLoader.js');
    const [a, b, c] = await Promise.all([
      mod.loadLowlight(),
      mod.loadLowlight(),
      mod.loadLowlight(),
    ]);

    expect(a).toBe(instance);
    expect(b).toBe(instance);
    expect(c).toBe(instance);
    // The factory is only called once across the three concurrent callers —
    // proves the in-flight `lowlightLoad` promise is reused.
    expect(createLowlight).toHaveBeenCalledTimes(1);
  });

  it('rejects and latches on upstream API-shape mismatch', async () => {
    // Simulate a future lowlight release that renames `highlightAuto`.
    const brokenInstance = {
      registered: vi.fn(() => true),
      highlight: vi.fn(() => ({ type: 'root', children: [] })),
      // highlightAuto missing — shape check must fail
    };
    vi.doMock('lowlight', () => ({
      createLowlight: vi.fn(() => brokenInstance),
      common: {},
    }));

    const mod = await import('./lowlightLoader.js');
    await expect(mod.loadLowlight()).rejects.toThrow(
      /lowlight instance does not match expected API/,
    );
    expect(mod.getLowlightInstance()).toBeNull();
    // After the failure callers should see the cooldown latch on so they
    // short-circuit the next render without retrying the broken import.
    expect(mod.isLowlightCoolingDown()).toBe(true);
  });

  it('caches rejection within the cooldown window and skips re-import', async () => {
    const importErr = new Error('chunk not found');
    const createLowlight = vi.fn(() => {
      throw importErr;
    });
    vi.doMock('lowlight', () => ({ createLowlight, common: {} }));

    const mod = await import('./lowlightLoader.js');
    await expect(mod.loadLowlight()).rejects.toThrow('chunk not found');
    expect(mod.isLowlightCoolingDown()).toBe(true);

    // A subsequent call inside the cooldown window must return the cached
    // rejection without re-invoking the dynamic import.
    await expect(mod.loadLowlight()).rejects.toThrow('chunk not found');
    expect(createLowlight).toHaveBeenCalledTimes(1);
  });

  it('retries after the cooldown elapses and recovers on transient failure', async () => {
    const instance = makeLowlightInstance();
    let attempt = 0;
    const createLowlight = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('EMFILE: too many open files');
      }
      return instance;
    });
    vi.doMock('lowlight', () => ({ createLowlight, common: {} }));

    const mod = await import('./lowlightLoader.js');
    await expect(mod.loadLowlight()).rejects.toThrow(/EMFILE/);
    expect(mod.isLowlightCoolingDown()).toBe(true);

    // Advance past the 30s cooldown window.
    await vi.advanceTimersByTimeAsync(30_001);
    expect(mod.isLowlightCoolingDown()).toBe(false);

    // Next call retries and now succeeds.
    const loaded = await mod.loadLowlight();
    expect(loaded).toBe(instance);
    expect(createLowlight).toHaveBeenCalledTimes(2);
  });
});
