/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpChannel } from './channel.js';
import { raceLongLived } from './race-long-lived.js';
import { BridgeChannelClosedError } from './status.js';
import { withTimeout } from './with-timeout.js';

const CHANNEL_UNAVAILABLE: unique symbol = Symbol('channel unavailable');

const unavailableSignals = new WeakMap<
  AcpChannel,
  Promise<typeof CHANNEL_UNAVAILABLE>
>();

// Built once per channel: every reaction on `channel.exited` stays queued
// until the channel exits, so deriving a fresh promise from it per call would
// keep each call's race alive for the channel's lifetime.
function channelUnavailable(
  channel: AcpChannel,
): Promise<typeof CHANNEL_UNAVAILABLE> {
  const existing = unavailableSignals.get(channel);
  if (existing) return existing;
  const unavailable = channel.transportFailed
    ? Promise.race([channel.exited, channel.transportFailed])
    : channel.exited;
  const mark = (): typeof CHANNEL_UNAVAILABLE => CHANNEL_UNAVAILABLE;
  const signal = unavailable.then(mark, mark);
  unavailableSignals.set(channel, signal);
  return signal;
}

export async function terminateChannel(
  channel: AcpChannel,
  timeoutMs: number,
  context: string,
): Promise<void> {
  try {
    await withTimeout(channel.kill(), timeoutMs, `${context} teardown`);
  } catch (error) {
    try {
      channel.killSync();
    } catch (forceError) {
      throw new AggregateError(
        [error, forceError],
        `ACP channel teardown failed (${context})`,
      );
    }
    throw error;
  }
}

export function channelUnavailableReject(
  channel: AcpChannel,
  context: string,
): Promise<never> {
  const unavailable = channel.transportFailed
    ? Promise.race([channel.exited, channel.transportFailed])
    : channel.exited;
  const reject = () => {
    throw new BridgeChannelClosedError(context);
  };
  return unavailable.then(reject, reject);
}

/**
 * Settles like `work` unless the channel exits or its transport fails first,
 * in which case it rejects with `BridgeChannelClosedError(context)`. For
 * per-operation races: unlike racing `channelUnavailableReject(...)`, it
 * leaves nothing on the channel once the operation settles.
 */
export async function raceChannelUnavailable<T>(
  channel: AcpChannel,
  work: PromiseLike<T>,
  context: string,
): Promise<T> {
  const result = await raceLongLived(work, channelUnavailable(channel));
  if (result === CHANNEL_UNAVAILABLE) {
    throw new BridgeChannelClosedError(context);
  }
  return result as T;
}
