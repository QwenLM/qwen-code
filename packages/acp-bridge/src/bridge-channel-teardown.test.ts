/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AcpChannelTeardownError, type ChannelFactory } from './channel.js';
import { makeBridge, makeChannel } from './internal/testUtils.js';

describe('channel startup teardown', () => {
  it('retains unconfirmed startup cleanup through retries and shutdown', async () => {
    const failure = new AcpChannelTeardownError(new Error('live resource'));
    const channelFactory = vi.fn<ChannelFactory>().mockRejectedValue(failure);
    const bridge = makeBridge({ channelFactory, channelIdleTimeoutMs: 0 });
    await expect(bridge.preheat()).rejects.toBe(failure);
    await expect(bridge.preheat()).rejects.toBe(failure);
    expect(channelFactory).toHaveBeenCalledOnce();
    await expect(bridge.shutdown()).rejects.toBe(failure);
    await expect(bridge.shutdown()).rejects.toBe(failure);
  });

  it('still permits retry after an ordinary startup failure with no live resources', async () => {
    const next = makeChannel();
    const channelFactory = vi
      .fn<ChannelFactory>()
      .mockRejectedValueOnce(new Error('failed before creating resources'))
      .mockResolvedValueOnce(next.channel);
    const bridge = makeBridge({ channelFactory, channelIdleTimeoutMs: 0 });
    try {
      await expect(bridge.preheat()).rejects.toThrow('failed before');
      await bridge.preheat();
      expect(channelFactory).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.shutdown();
    }
    expect(next.killed).toBe(true);
  });
});
