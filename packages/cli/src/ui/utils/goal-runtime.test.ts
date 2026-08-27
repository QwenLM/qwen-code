/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  GoalPersistenceUnavailableError,
  type GoalRuntime,
} from '@qwen-code/qwen-code-core';
import {
  shouldDisplayGoalStateCause,
  waitForGoalRuntime,
} from './goal-runtime.js';

describe('waitForGoalRuntime', () => {
  afterEach(() => vi.useRealTimers());

  it('allows Goal-less sessions when persistence is disabled', async () => {
    const getGoalRuntimeReady = vi
      .fn()
      .mockRejectedValue(new GoalPersistenceUnavailableError());

    await expect(waitForGoalRuntime({ getGoalRuntimeReady })).resolves.toBe(
      true,
    );
    expect(getGoalRuntimeReady).toHaveBeenCalledTimes(1);
  });

  // Config.getGoalRuntimeReady() throws synchronously (not a rejected
  // promise) when persistence is unavailable; the gate must swallow that
  // shape too or it escapes the startup effect as an unhandled rejection
  // and the TUI never leaves its init banner (#10272).
  it('allows Goal-less sessions when readiness throws synchronously', async () => {
    const getGoalRuntimeReady = vi.fn((): Promise<GoalRuntime> => {
      throw new GoalPersistenceUnavailableError();
    });

    await expect(waitForGoalRuntime({ getGoalRuntimeReady })).resolves.toBe(
      true,
    );
    expect(getGoalRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it('swallows a synchronous readiness throw inside the bounded wait too', async () => {
    const getGoalRuntimeReady = vi.fn((): Promise<GoalRuntime> => {
      throw new GoalPersistenceUnavailableError();
    });

    await expect(
      waitForGoalRuntime({ getGoalRuntimeReady }, { timeoutMs: 100 }),
    ).resolves.toBe(true);
  });

  it('does not hide malformed or unsupported persisted Goal state', async () => {
    const failure = new Error('unsupported Goal lifecycle record');
    const getGoalRuntimeReady = vi.fn().mockRejectedValue(failure);

    await expect(waitForGoalRuntime({ getGoalRuntimeReady })).rejects.toBe(
      failure,
    );
  });

  it('resolves true once the runtime settles within the timeout', async () => {
    const getGoalRuntimeReady = vi.fn().mockResolvedValue({});
    await expect(
      waitForGoalRuntime({ getGoalRuntimeReady }, { timeoutMs: 100 }),
    ).resolves.toBe(true);
  });

  it('proceeds (false) instead of hanging when the runtime never settles', async () => {
    vi.useFakeTimers();
    // A promise that never resolves — the lease-contention hang.
    const getGoalRuntimeReady = vi.fn(() => new Promise<GoalRuntime>(() => {}));
    const pending = waitForGoalRuntime(
      { getGoalRuntimeReady },
      { timeoutMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBe(false);
  });

  it('a late rejection after timeout does not become unhandled', async () => {
    vi.useFakeTimers();
    let reject!: (err: Error) => void;
    const getGoalRuntimeReady = vi.fn(
      () =>
        new Promise<GoalRuntime>((_resolve, rej) => {
          reject = rej;
        }),
    );
    const pending = waitForGoalRuntime(
      { getGoalRuntimeReady },
      { timeoutMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toBe(false);
    // Reject after the timeout won; the race must have a handler attached.
    reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
  });

  it('keeps turn and verifier bookkeeping out of scrollback', () => {
    expect(shouldDisplayGoalStateCause('turn_finished')).toBe(false);
    expect(shouldDisplayGoalStateCause('checkpoint')).toBe(false);
    expect(shouldDisplayGoalStateCause('verifier_accept')).toBe(false);
    expect(shouldDisplayGoalStateCause('verifier_reject')).toBe(true);
    expect(shouldDisplayGoalStateCause('create')).toBe(true);
    expect(shouldDisplayGoalStateCause('complete')).toBe(true);
    expect(shouldDisplayGoalStateCause('clear')).toBe(true);
  });
});
