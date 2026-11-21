/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { CHANNEL_LIVENESS_VERSION } from './bridgeTypes.js';
import type { ChannelProcessSample } from './channel-process-sample.js';
import { raceLongLived } from './race-long-lived.js';

export const CHANNEL_LIVENESS_INTERVAL_MS = 15_000;
export const CHANNEL_LIVENESS_PROBE_TIMEOUT_MS = 10_000;
export const CHANNEL_LIVENESS_FAILURE_THRESHOLD = 2;
export const CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS = 1_000;
/**
 * CPU-advancing timeouts accumulated since the last successful probe that
 * are tolerated before the channel is failed anyway. A busy agent (GC
 * pause, heavy synchronous work, scheduling delay) is not a dead agent,
 * but an agent stuck in a busy loop consumes CPU forever — the grace must
 * stay bounded so its sessions are still torn down and recovered.
 */
export const CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT = 6;

export const CHANNEL_LIVENESS_TIMEOUT_CODE = 'acp_channel_liveness_timeout';
export const CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE =
  'acp_channel_liveness_protocol_error';

/**
 * Process state captured at failure time, before the SIGKILL destroys the
 * scene. `lastCpuDeltaTicks` is the CPU progress across the final probe
 * window; `undefined` means no trustworthy sample pair was available.
 */
export interface ChannelLivenessEvidence {
  lastSample?: ChannelProcessSample;
  lastCpuDeltaTicks?: number;
  consecutiveTimeouts: number;
  busyExtensions: number;
}

export interface ChannelLivenessBusyExtension {
  extension: number;
  limit: number;
  cpuDeltaTicks: number;
}

export class ChannelLivenessFailure extends Error {
  constructor(
    readonly code:
      | typeof CHANNEL_LIVENESS_TIMEOUT_CODE
      | typeof CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
    readonly evidence?: ChannelLivenessEvidence,
  ) {
    super(
      code === CHANNEL_LIVENESS_TIMEOUT_CODE
        ? 'ACP channel failed consecutive liveness probes'
        : 'ACP channel returned an invalid liveness response',
    );
    this.name = 'ChannelLivenessFailure';
  }
}

interface ChannelLivenessMonitorOptions {
  probe(nonce: number): Promise<unknown>;
  onFailure(error: ChannelLivenessFailure): void;
  isActive(): boolean;
  now?: () => number;
  /**
   * Best-effort process snapshot, called at probe start and again on an
   * on-time timeout. When both snapshots exist and CPU ticks advanced, the
   * timeout is charged as a bounded busy extension instead of a failure
   * strike. Omitted or `undefined` results keep the original accounting.
   */
  sampleProcess?: () => ChannelProcessSample | undefined;
  onBusyExtension?: (info: ChannelLivenessBusyExtension) => void;
}

export interface ChannelLivenessMonitor {
  stop(): void;
}

type ProbeOutcome =
  | { kind: 'response'; response: unknown }
  | { kind: 'rejected' }
  | { kind: 'timeout' }
  | { kind: 'local_delay' }
  | { kind: 'stopped' };

function isValidResponse(response: unknown, nonce: number): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    !Array.isArray(response) &&
    (response as Record<string, unknown>)['v'] === CHANNEL_LIVENESS_VERSION &&
    (response as Record<string, unknown>)['nonce'] === nonce
  );
}

export function startChannelLivenessMonitor(
  options: ChannelLivenessMonitorOptions,
): ChannelLivenessMonitor {
  const now = options.now ?? (() => performance.now());
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let consecutiveTimeouts = 0;
  let busyExtensions = 0;
  let nextNonce = 0;
  let resolveStopped!: (outcome: ProbeOutcome) => void;
  const stoppedOutcome = new Promise<ProbeOutcome>((resolve) => {
    resolveStopped = resolve;
  });

  const isActive = () => !stopped && options.isActive();
  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    resolveStopped({ kind: 'stopped' });
  };
  const fail = (error: ChannelLivenessFailure) => {
    if (!isActive()) return;
    stop();
    options.onFailure(error);
  };
  const timerWasLate = (expectedAt: number) =>
    now() > expectedAt + CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS;

  const runProbe = async () => {
    if (!isActive()) return;
    const nonce = nextNonce;
    nextNonce = nonce === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, nonce + 1);
    const baselineSample = options.sampleProcess?.();
    const response = Promise.resolve()
      .then(() => options.probe(nonce))
      .then<ProbeOutcome, ProbeOutcome>(
        (value) => ({ kind: 'response', response: value }),
        () => ({ kind: 'rejected' }),
      );

    let outcome: ProbeOutcome;
    while (true) {
      const expectedAt = now() + CHANNEL_LIVENESS_PROBE_TIMEOUT_MS;
      const timeout = new Promise<ProbeOutcome>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          resolve(
            timerWasLate(expectedAt)
              ? { kind: 'local_delay' }
              : { kind: 'timeout' },
          );
        }, CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
        timer.unref();
      });
      outcome = await raceLongLived([response, timeout], stoppedOutcome);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (outcome.kind === 'stopped' || !isActive()) return;
      if (outcome.kind !== 'local_delay') break;
      consecutiveTimeouts = 0;
      busyExtensions = 0;
    }

    if (outcome.kind === 'response') {
      if (!isValidResponse(outcome.response, nonce)) {
        fail(
          new ChannelLivenessFailure(CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE, {
            lastSample: options.sampleProcess?.(),
            consecutiveTimeouts,
            busyExtensions,
          }),
        );
        return;
      }
      consecutiveTimeouts = 0;
      busyExtensions = 0;
      schedule(CHANNEL_LIVENESS_INTERVAL_MS);
      return;
    }
    if (outcome.kind === 'rejected') {
      await Promise.resolve();
      fail(
        new ChannelLivenessFailure(CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE, {
          lastSample: options.sampleProcess?.(),
          consecutiveTimeouts,
          busyExtensions,
        }),
      );
      return;
    }

    const afterSample = options.sampleProcess?.();
    const cpuDeltaTicks =
      baselineSample && afterSample
        ? afterSample.cpuTicks - baselineSample.cpuTicks
        : undefined;
    if (cpuDeltaTicks !== undefined && cpuDeltaTicks > 0) {
      busyExtensions++;
      if (busyExtensions < CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT) {
        options.onBusyExtension?.({
          extension: busyExtensions,
          limit: CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT,
          cpuDeltaTicks,
        });
        void runProbe();
        return;
      }
    } else {
      consecutiveTimeouts++;
      if (consecutiveTimeouts < CHANNEL_LIVENESS_FAILURE_THRESHOLD) {
        void runProbe();
        return;
      }
    }
    fail(
      new ChannelLivenessFailure(CHANNEL_LIVENESS_TIMEOUT_CODE, {
        lastSample: afterSample,
        lastCpuDeltaTicks: cpuDeltaTicks,
        consecutiveTimeouts,
        busyExtensions,
      }),
    );
  };

  function schedule(delayMs: number): void {
    if (!isActive()) return;
    const expectedAt = now() + delayMs;
    timer = setTimeout(() => {
      timer = undefined;
      if (!isActive()) return;
      if (timerWasLate(expectedAt)) {
        consecutiveTimeouts = 0;
        busyExtensions = 0;
        schedule(CHANNEL_LIVENESS_INTERVAL_MS);
        return;
      }
      void runProbe();
    }, delayMs);
    timer.unref();
  }

  schedule(CHANNEL_LIVENESS_INTERVAL_MS);
  return { stop };
}
