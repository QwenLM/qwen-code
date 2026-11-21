/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_LIVENESS_VERSION } from './bridgeTypes.js';
import {
  CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT,
  CHANNEL_LIVENESS_INTERVAL_MS,
  CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
  CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
  CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS,
  CHANNEL_LIVENESS_TIMEOUT_CODE,
  startChannelLivenessMonitor,
} from './channel-liveness.js';
import type { ChannelProcessSample } from './channel-process-sample.js';

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
    const sampleProcess = vi.fn(
      (): ChannelProcessSample => ({
        cpuTicks: 7,
        state: 'R',
        wchan: '',
        rssBytes: 4096,
      }),
    );
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
      sampleProcess,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);

    expect(probe).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({
      code: CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
    });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 0,
      busyExtensions: 0,
      lastSample: { state: 'R', cpuTicks: 7 },
    });
    expect(failure.evidence.lastCpuDeltaTicks).toBeUndefined();
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
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({
      code: CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
    });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 0,
      busyExtensions: 0,
    });
    expect(failure.evidence.lastSample).toBeUndefined();
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

  it('extends grace while CPU advances, then fails at the bounded limit', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    const onBusyExtension = vi.fn();
    let ticks = 0;
    const sampleProcess = vi.fn(
      (): ChannelProcessSample => ({
        cpuTicks: (ticks += 10),
        state: 'R',
        wchan: '',
        rssBytes: 1024,
      }),
    );
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
      sampleProcess,
      onBusyExtension,
    });

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    for (let i = 1; i < CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT; i++) {
      await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
      expect(onFailure).not.toHaveBeenCalled();
      expect(onBusyExtension).toHaveBeenCalledTimes(i);
      expect(onBusyExtension).toHaveBeenLastCalledWith({
        extension: i,
        limit: CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT,
        cpuDeltaTicks: 10,
      });
    }

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onBusyExtension).toHaveBeenCalledTimes(
      CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT - 1,
    );
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ code: CHANNEL_LIVENESS_TIMEOUT_CODE });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 0,
      busyExtensions: CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT,
      lastCpuDeltaTicks: 10,
      // 6 windows x 2 samples x 10 ticks: the failure must carry the
      // timeout-side sample (call 12), not the probe-start baseline (110).
      lastSample: { state: 'R', cpuTicks: 120 },
    });
  });

  it('charges timeouts when CPU makes no progress', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    const onBusyExtension = vi.fn();
    const sampleProcess = vi.fn(
      (): ChannelProcessSample => ({
        cpuTicks: 100,
        state: 'T',
        wchan: 'stop',
        rssBytes: 2048,
      }),
    );
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
      sampleProcess,
      onBusyExtension,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + 2 * CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(onBusyExtension).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ code: CHANNEL_LIVENESS_TIMEOUT_CODE });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 2,
      busyExtensions: 0,
      lastCpuDeltaTicks: 0,
      lastSample: { state: 'T', wchan: 'stop' },
    });
  });

  it('reports undefined evidence fields without a sampler', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + 2 * CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ code: CHANNEL_LIVENESS_TIMEOUT_CODE });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 2,
      busyExtensions: 0,
    });
    expect(failure.evidence.lastSample).toBeUndefined();
    expect(failure.evidence.lastCpuDeltaTicks).toBeUndefined();
  });

  it('resets busy extensions after a successful probe', async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn<(nonce: number) => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockImplementationOnce(async (nonce) => ({
        v: CHANNEL_LIVENESS_VERSION,
        nonce,
      }))
      .mockImplementation(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    const onBusyExtension = vi.fn();
    let busy = true;
    let ticks = 0;
    const sampleProcess = vi.fn(
      (): ChannelProcessSample => ({
        cpuTicks: busy ? (ticks += 10) : 100,
        state: busy ? 'R' : 'T',
        wchan: '',
        rssBytes: 1024,
      }),
    );
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
      sampleProcess,
      onBusyExtension,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(onBusyExtension).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();

    busy = false;
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS);
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0].evidence).toMatchObject({
      consecutiveTimeouts: 2,
      busyExtensions: 0,
    });
  });

  it('resets busy extensions after a delayed callback', async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    const onBusyExtension = vi.fn();
    let ticks = 0;
    const sampleProcess = vi.fn(
      (): ChannelProcessSample => ({
        cpuTicks: (ticks += 10),
        state: 'R',
        wchan: '',
        rssBytes: 1024,
      }),
    );
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => monotonicNow,
      sampleProcess,
      onBusyExtension,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(onBusyExtension).toHaveBeenCalledTimes(1);
    expect(onBusyExtension).toHaveBeenLastCalledWith(
      expect.objectContaining({ extension: 1 }),
    );

    monotonicNow =
      CHANNEL_LIVENESS_PROBE_TIMEOUT_MS +
      CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS +
      1;
    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(onFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
    expect(onBusyExtension).toHaveBeenCalledTimes(2);
    expect(onBusyExtension).toHaveBeenLastCalledWith(
      expect.objectContaining({ extension: 1 }),
    );
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('charges a timeout when the mid-sequence sample goes missing', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    let calls = 0;
    let ticks = 0;
    const sampleProcess = vi.fn((): ChannelProcessSample | undefined => {
      calls++;
      if (calls <= 2) {
        return {
          cpuTicks: (ticks += 10),
          state: 'R',
          wchan: '',
          rssBytes: 1024,
        };
      }
      return undefined;
    });
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
      sampleProcess,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + 3 * CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ code: CHANNEL_LIVENESS_TIMEOUT_CODE });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 2,
      busyExtensions: 1,
    });
    expect(failure.evidence.lastSample).toBeUndefined();
    expect(failure.evidence.lastCpuDeltaTicks).toBeUndefined();
  });

  it('charges strikes when the agent dies inside the probe window', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    let calls = 0;
    const sampleProcess = vi.fn((): ChannelProcessSample | undefined => {
      calls++;
      if (calls === 1) {
        return { cpuTicks: 10, state: 'R', wchan: '', rssBytes: 1024 };
      }
      return undefined;
    });
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
      sampleProcess,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + 2 * CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ code: CHANNEL_LIVENESS_TIMEOUT_CODE });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 2,
      busyExtensions: 0,
    });
    expect(failure.evidence.lastSample).toBeUndefined();
    expect(failure.evidence.lastCpuDeltaTicks).toBeUndefined();
  });

  it('charges strikes when only the timeout-side sample exists', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const onFailure = vi.fn();
    let calls = 0;
    const sampleProcess = vi.fn((): ChannelProcessSample | undefined => {
      calls++;
      if (calls % 2 === 0) {
        return { cpuTicks: 10, state: 'R', wchan: '', rssBytes: 1024 };
      }
      return undefined;
    });
    startChannelLivenessMonitor({
      probe,
      onFailure,
      isActive: () => true,
      now: () => 0,
      sampleProcess,
    });

    await vi.advanceTimersByTimeAsync(
      CHANNEL_LIVENESS_INTERVAL_MS + 2 * CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
    );
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ code: CHANNEL_LIVENESS_TIMEOUT_CODE });
    expect(failure.evidence).toMatchObject({
      consecutiveTimeouts: 2,
      busyExtensions: 0,
      lastSample: { state: 'R' },
    });
    expect(failure.evidence.lastCpuDeltaTicks).toBeUndefined();
  });
});
