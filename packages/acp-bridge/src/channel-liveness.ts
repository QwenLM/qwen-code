/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { CHANNEL_LIVENESS_VERSION } from './bridgeTypes.js';

export const CHANNEL_LIVENESS_INTERVAL_MS = 15_000;
export const CHANNEL_LIVENESS_PROBE_TIMEOUT_MS = 10_000;
export const CHANNEL_LIVENESS_FAILURE_THRESHOLD = 2;
export const CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS = 1_000;

export const CHANNEL_LIVENESS_TIMEOUT_CODE = 'acp_channel_liveness_timeout';
export const CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE =
  'acp_channel_liveness_protocol_error';

export class ChannelLivenessFailure extends Error {
  constructor(
    readonly code:
      | typeof CHANNEL_LIVENESS_TIMEOUT_CODE
      | typeof CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE,
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
      outcome = await Promise.race([response, timeout, stoppedOutcome]);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (outcome.kind === 'stopped' || !isActive()) return;
      if (outcome.kind !== 'local_delay') break;
      consecutiveTimeouts = 0;
    }

    if (outcome.kind === 'response') {
      if (!isValidResponse(outcome.response, nonce)) {
        fail(new ChannelLivenessFailure(CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE));
        return;
      }
      consecutiveTimeouts = 0;
      schedule(CHANNEL_LIVENESS_INTERVAL_MS);
      return;
    }
    if (outcome.kind === 'rejected') {
      await Promise.resolve();
      fail(new ChannelLivenessFailure(CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE));
      return;
    }

    consecutiveTimeouts++;
    if (consecutiveTimeouts >= CHANNEL_LIVENESS_FAILURE_THRESHOLD) {
      fail(new ChannelLivenessFailure(CHANNEL_LIVENESS_TIMEOUT_CODE));
      return;
    }
    void runProbe();
  };

  function schedule(delayMs: number): void {
    if (!isActive()) return;
    const expectedAt = now() + delayMs;
    timer = setTimeout(() => {
      timer = undefined;
      if (!isActive()) return;
      if (timerWasLate(expectedAt)) {
        consecutiveTimeouts = 0;
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
