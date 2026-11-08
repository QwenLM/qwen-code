/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_LIVENESS_VERSION } from './bridgeTypes.js';
import {
  CHANNEL_LIVENESS_INTERVAL_MS,
  CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
  CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
  CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS,
  CHANNEL_LIVENESS_TIMEOUT_CODE,
  startChannelLivenessMonitor,
} from './channel-liveness.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startChannelLivenessMonitor', () => {
  it('keeps a healthy channel on the negotiated cadence', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async (nonce: number) => ({
      v: CHANNEL_LIVENESS_VERSION,
      nonce,
    }));
    const onFailure = vi.fn();
    const monitor = startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);

    expect(probe.mock.calls).toEqual([[0], [1]]);
    expect(onFailure).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('fails only after two consecutive on-time timeouts', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      code: CHANNEL_LIVENESS_TIMEOUT_CODE,
    });
  });

  it('resets the timeout count when the immediate retry succeeds', async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn<(nonce: number) => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockImplementation(async (nonce) => ({
        v: CHANNEL_LIVENESS_VERSION,
        nonce,
      }));
    const onFailure = vi.fn();
    const monitor = startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onFailure).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('does not charge a callback delayed by the parent event loop', async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const probe = vi.fn(async (nonce: number) => ({
      v: CHANNEL_LIVENESS_VERSION,
      nonce,
    }));
    const onFailure = vi.fn();
    const monitor = startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => monotonicNow,
    });

    monotonicNow =
      CHANNEL_LIVENESS_INTERVAL_MS +
      CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS +
      1;
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    expect(probe).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    expect(probe).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('clears an existing timeout streak after a delayed callback', async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => monotonicNow,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();

    monotonicNow =
      CHANNEL_LIVENESS_PROBE_TIMEOUT_MS +
      CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS +
      1;
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      code: CHANNEL_LIVENESS_TIMEOUT_CODE,
    });
  });

  it('does not let a late response reset the current probe streak', async () => {
    vi.useFakeTimers();
    const first = deferred<unknown>();
    const probe = vi
      .fn<(nonce: number) => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(probe).toHaveBeenCalledTimes(2);

    first.resolve({ v: CHANNEL_LIVENESS_VERSION, nonce: 0 });
    await Promise.resolve();
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      code: CHANNEL_LIVENESS_TIMEOUT_CODE,
    });
  });

  it('fails a malformed response without spending the retry budget', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => ({
      v: CHANNEL_LIVENESS_VERSION,
      nonce: 99,
    }));
    const onFailure = vi.fn();
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);

    expect(probe).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      code: CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
    });
  });

  it('fails a rejected probe without spending the retry budget', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => {
      throw new Error('ping rejected');
    });
    const onFailure = vi.fn();
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);

    expect(probe).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      code: CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
    });
  });

  it('cancels an active timeout when stopped', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    const monitor = startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS * 3);

    expect(probe).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
