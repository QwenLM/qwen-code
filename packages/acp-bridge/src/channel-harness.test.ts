/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import type { AcpChannel } from './channel.js';
import type { BridgeSession } from './bridgeTypes.js';

describe('channel harness ownership', () => {
  it('removes the exited physical channel before a session lifecycle callback starts its replacement', async () => {
    const old = makeChannel({ sessionIdPrefix: 'old' });
    const replacement = makeChannel({ sessionIdPrefix: 'replacement' });
    const factory = vi
      .fn<() => Promise<AcpChannel>>()
      .mockResolvedValueOnce(old.channel)
      .mockResolvedValue(replacement.channel);
    let replacing: Promise<BridgeSession> | undefined;
    const removed: string[] = [];
    const bridge = makeBridge({
      channelFactory: factory,
      sessionScope: 'thread',
      sessionLifecycle(event) {
        if (event.type !== 'removed' || event.reason !== 'channel_closed') {
          return;
        }
        removed.push(event.sessionId);
        replacing ??= bridge.spawnOrAttach({ workspaceCwd: WS_A });
      },
    });

    try {
      const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      old.crash();
      await old.channel.exited;
      expect(replacing).toBeDefined();
      const fresh = await replacing!;
      expect(removed).toEqual([first.sessionId, second.sessionId]);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(bridge.sessionCount).toBe(1);
      expect(bridge.getSessionSummary(fresh.sessionId).sessionId).toBe(
        fresh.sessionId,
      );

      const sibling = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(sibling.sessionId).not.toBe(fresh.sessionId);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(replacement.agent.newSessionCalls).toHaveLength(2);
    } finally {
      await bridge.shutdown();
    }
  });

  it('keeps physical force-kill ownership while shutdown publishes session removal callbacks', async () => {
    const handle = makeChannel({ sessionIdPrefix: 'shutdown' });
    const kill = handle.channel.kill;
    const killSync = vi.fn(handle.channel.killSync);
    const order: string[] = [];
    handle.channel = {
      ...handle.channel,
      kill: async () => {
        order.push('kill');
        await kill();
      },
      killSync,
    };
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      sessionScope: 'thread',
      sessionLifecycle(event) {
        if (event.type !== 'removed' || event.reason !== 'daemon_shutdown') {
          return;
        }
        order.push(event.sessionId);
        if (order.length === 1) {
          bridge.killAllSync();
        }
      },
    });

    try {
      const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const shutdown = bridge.shutdown();
      expect(bridge.shutdown()).toBe(shutdown);
      expect(bridge.sessionCount).toBe(0);
      expect(killSync).toHaveBeenCalledOnce();
      expect(order).toEqual([first.sessionId, second.sessionId, 'kill']);
      await shutdown;
    } finally {
      await bridge.shutdown();
    }
  });
});
