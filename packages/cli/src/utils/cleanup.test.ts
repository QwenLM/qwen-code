/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import {
  _resetCleanupFunctionsForTest,
  registerCleanup,
  runExitCleanup,
} from './cleanup';

describe('cleanup', () => {
  beforeEach(() => {
    // The previous `global['cleanupFunctions'] = []` setup was dead code —
    // the array is module-private, not on `global`. Tests passed by accident
    // because `runExitCleanup` itself clears at the end. A test that throws
    // before reaching `runExitCleanup` would leak state into the next case.
    _resetCleanupFunctionsForTest();
  });

  it('should run a registered synchronous function', async () => {
    const cleanupFn = vi.fn();
    registerCleanup(cleanupFn);

    await runExitCleanup();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('should run a registered asynchronous function', async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    registerCleanup(cleanupFn);

    await runExitCleanup();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('should run multiple registered functions', async () => {
    const syncFn = vi.fn();
    const asyncFn = vi.fn().mockResolvedValue(undefined);

    registerCleanup(syncFn);
    registerCleanup(asyncFn);

    await runExitCleanup();

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(asyncFn).toHaveBeenCalledTimes(1);
  });

  it('should continue running cleanup functions even if one throws an error', async () => {
    const errorFn = vi.fn(() => {
      throw new Error('Test Error');
    });
    const successFn = vi.fn();

    registerCleanup(errorFn);
    registerCleanup(successFn);

    await runExitCleanup();

    expect(errorFn).toHaveBeenCalledTimes(1);
    expect(successFn).toHaveBeenCalledTimes(1);
  });

  describe('timeout failsafes', () => {
    // Without these the async-jsonl flush() could hang exit forever on slow
    // disks / dead sockets — sync writes were inherently bounded, async aren't.

    it('caps a hung cleanup at the per-fn timeout and proceeds to the next one', async () => {
      const hangFn = vi.fn(() => new Promise<void>(() => {}));
      const nextFn = vi.fn();

      registerCleanup(hangFn);
      registerCleanup(nextFn);

      const start = Date.now();
      await runExitCleanup({
        _testPerFnTimeoutMs: 50,
        _testOverallTimeoutMs: 5_000,
      });
      const elapsed = Date.now() - start;

      expect(hangFn).toHaveBeenCalledTimes(1);
      expect(nextFn).toHaveBeenCalledTimes(1);
      expect(elapsed).toBeLessThan(500);
    });

    it('caps overall wall-clock time when many cleanups all hang', async () => {
      // 100 × 50ms perFn ≈ 5000ms drain — structurally impossible for "drain
      // finished naturally" to satisfy < 800ms, so the upper bound proves
      // wallClock actually fired. Lower bound proves we waited for it and
      // didn't short-circuit. 800ms slack absorbs CI scheduler jitter.
      for (let i = 0; i < 100; i++) {
        registerCleanup(() => new Promise<void>(() => {}));
      }

      const start = Date.now();
      await runExitCleanup({
        _testPerFnTimeoutMs: 50,
        _testOverallTimeoutMs: 100,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(800);
      expect(elapsed).toBeGreaterThanOrEqual(80);
    });

    it('still calls fast cleanups normally when timeouts are configured', async () => {
      const fastFn = vi.fn().mockResolvedValue(undefined);
      registerCleanup(fastFn);

      await runExitCleanup({
        _testPerFnTimeoutMs: 1_000,
        _testOverallTimeoutMs: 2_000,
      });

      expect(fastFn).toHaveBeenCalledTimes(1);
    });

    it('does not let a rejected cleanup poison the chain', async () => {
      // The original `for…await` already swallowed sync throws; this guards
      // the new withTimeout wrapper against rejected-async-cleanup leaks.
      const rejectFn = vi.fn().mockRejectedValue(new Error('boom'));
      const nextFn = vi.fn();

      registerCleanup(rejectFn);
      registerCleanup(nextFn);

      await expect(
        runExitCleanup({
          _testPerFnTimeoutMs: 50,
          _testOverallTimeoutMs: 1_000,
        }),
      ).resolves.toBeUndefined();
      expect(rejectFn).toHaveBeenCalledTimes(1);
      expect(nextFn).toHaveBeenCalledTimes(1);
    });
  });
});
