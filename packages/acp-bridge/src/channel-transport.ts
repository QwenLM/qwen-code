/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpChannel } from './channel.js';
import { BridgeChannelClosedError } from './status.js';
import { withTimeout } from './with-timeout.js';

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
