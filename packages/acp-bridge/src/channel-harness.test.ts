/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import type { AcpChannel } from './channel.js';
import type { BridgeSession } from './bridgeTypes.js';
import { createChannelHarness } from './channel-harness.js';
import * as channelLifecycle from './channel-lifecycle.js';
import { createSessionControlPlane } from './session-control-plane.js';

describe('channel harness ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('preserves all six exit cleanup steps for the current channel', async () => {
    vi.useFakeTimers();
    const handle = makeChannel();
    const order: string[] = [];
    const createLifecycle = channelLifecycle.createChannelLifecycle;
    vi.spyOn(channelLifecycle, 'createChannelLifecycle').mockImplementation(
      () => {
        const lifecycle = createLifecycle();
        const remove = lifecycle.remove;
        vi.spyOn(lifecycle, 'remove').mockImplementation((info) => {
          order.push('remove');
          remove(info);
        });
        return lifecycle;
      },
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
      if (idleTimer !== undefined && timer === idleTimer) {
        order.push('cancelIdleTimer');
      }
      clearTimer(timer);
    });
    let harness!: ReturnType<typeof createChannelHarness>;
    const bridge = createSessionControlPlane(
      {
        boundWorkspace: WS_A,
        channelFactory: async () => handle.channel,
        channelIdleTimeoutMs: 1000,
      },
      (options) => {
        harness = createChannelHarness({
          ...options,
          constructHarnessChannel(channel, id) {
            const info = options.constructHarnessChannel(channel, id);
            info.channelLiveness = { stop: () => order.push('liveness.stop') };
            return info;
          },
          handleChannelTransportUnavailable(info) {
            order.push('transportUnavailable');
            options.handleChannelTransportUnavailable(info);
          },
          beforeChannelExit(info) {
            order.push('beforeExit');
            options.beforeChannelExit(info);
          },
          handleChannelExit(info, exitInfo) {
            order.push('sessionExit');
            options.handleChannelExit(info, exitInfo);
          },
        });
        return harness;
      },
    );

    try {
      const info = await harness.ensure();
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      const armed = harness.startIdleTimer(info);
      idleTimer = setTimer.mock.results.at(-1)?.value;
      await armed;
      expect(idleTimer).toBeDefined();
      order.length = 0;

      handle.crash();
      await handle.channel.exited;

      expect(order).toEqual([
        'liveness.stop',
        'transportUnavailable',
        'cancelIdleTimer',
        'beforeExit',
        'remove',
        'sessionExit',
      ]);
      expect(harness.current).toBeUndefined();
      expect(harness.has(info)).toBe(false);
    } finally {
      await bridge.shutdown();
    }
  });

  it('does not visit a new preheated channel while an older settlement awaits exit', async () => {
    let releaseExit!: () => void;
    let startedKill!: () => void;
    const exit = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const killing = new Promise<void>((resolve) => {
      startedKill = resolve;
    });
    const old = makeChannel({ extMethodImpl: () => ({ available: true }) });
    const fresh = makeChannel();
    const kill = old.channel.kill.bind(old.channel);
    vi.spyOn(old.channel, 'kill').mockImplementation(async () => {
      startedKill();
      await exit;
      await kill();
    });
    const factory = vi
      .fn<() => Promise<AcpChannel>>()
      .mockResolvedValueOnce(old.channel)
      .mockResolvedValue(fresh.channel);
    const bridge = makeBridge({
      channelFactory: factory,
      channelIdleTimeoutMs: 0,
    });
    let operation: Promise<boolean> | undefined;
    try {
      await bridge.preheat();
      operation = bridge.isWorkspaceMemoryRememberAvailable!();
      await killing;
      await bridge.preheat();
      expect(fresh.killed).toBe(false);
      releaseExit();
      expect(await operation).toBe(true);
      expect(fresh.killed).toBe(false);
      expect(bridge.isChannelLive()).toBe(true);
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      releaseExit();
      await operation;
      await bridge.shutdown();
    }
  });

  it('keeps the replacement idle timer armed when an old channel exits late', async () => {
    vi.useFakeTimers();
    const old = makeChannel();
    const replacement = makeChannel();
    const factory = vi
      .fn<() => Promise<AcpChannel>>()
      .mockResolvedValueOnce(old.channel)
      .mockResolvedValue(replacement.channel);
    let harness!: ReturnType<typeof createChannelHarness>;
    const bridge = createSessionControlPlane(
      {
        boundWorkspace: WS_A,
        channelFactory: factory,
        channelIdleTimeoutMs: 1000,
      },
      (options) => {
        harness = createChannelHarness(options);
        return harness;
      },
    );

    try {
      const oldInfo = await harness.ensure();
      harness.markDying([oldInfo]);
      const freshInfo = await harness.ensure();
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
      const armed = harness.startIdleTimer(freshInfo);
      const idleTimer = setTimer.mock.results.at(-1)?.value;
      await armed;
      expect(idleTimer).toBeDefined();
      clearTimer.mockClear();

      old.crash();
      await old.channel.exited;

      expect(harness.current).toBe(freshInfo);
      expect(harness.has(oldInfo)).toBe(false);
      expect(harness.has(freshInfo)).toBe(true);
      expect(clearTimer).not.toHaveBeenCalledWith(idleTimer);
      expect(replacement.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(replacement.killed).toBe(true);
      await replacement.channel.exited;
      expect(harness.current).toBeUndefined();
    } finally {
      await bridge.shutdown();
    }
  });

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
