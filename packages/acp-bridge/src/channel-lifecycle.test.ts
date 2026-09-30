/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import type { AcpChannel } from './channel.js';

describe('channel lifecycle', () => {
  it('shares one physical startup between independent thread sessions', async () => {
    const handle = makeChannel({ sessionIdPrefix: 'shared' });
    let release!: (channel: AcpChannel) => void;
    const startup = new Promise<AcpChannel>((resolve) => {
      release = resolve;
    });
    const factory = vi.fn(() => startup);
    const bridge = makeBridge({
      channelFactory: factory,
      sessionScope: 'thread',
    });

    try {
      const first = bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const second = bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(bridge.getWorkspaceRuntimeLifecycleSnapshot!().state).toBe(
        'starting',
      );

      release(handle.channel);
      const [a, b] = await Promise.all([first, second]);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(a.sessionId).not.toBe(b.sessionId);
      expect([a.attached, b.attached]).toEqual([false, false]);
      expect(handle.agent.initializeCalls).toHaveLength(1);
      expect(handle.agent.newSessionCalls).toHaveLength(2);
      expect(bridge.sessionCount).toBe(2);
    } finally {
      release(handle.channel);
      await bridge.shutdown();
    }
  });

  it('rejects both startup waiters and allows a fresh shared retry', async () => {
    let reject!: (error: Error) => void;
    const failedStartup = new Promise<AcpChannel>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const handle = makeChannel({ sessionIdPrefix: 'retry' });
    const factory = vi
      .fn<() => Promise<AcpChannel>>()
      .mockReturnValueOnce(failedStartup)
      .mockResolvedValue(handle.channel);
    const bridge = makeBridge({
      channelFactory: factory,
      sessionScope: 'thread',
    });
    const failure = new Error('startup failed');

    try {
      const failed = Promise.allSettled([
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ]);
      expect(factory).toHaveBeenCalledTimes(1);
      reject(failure);
      expect(await failed).toEqual([
        { status: 'rejected', reason: failure },
        { status: 'rejected', reason: failure },
      ]);
      expect(bridge.getWorkspaceRuntimeLifecycleSnapshot!().state).toBe('cold');
      expect(bridge.sessionCount).toBe(0);

      const [a, b] = await Promise.all([
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ]);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(handle.agent.newSessionCalls).toHaveLength(2);
    } finally {
      reject(failure);
      await bridge.shutdown();
    }
  });

  it('keeps the replacement available after the old channel exits', async () => {
    const old = makeChannel({ sessionIdPrefix: 'old' });
    const replacement = makeChannel({ sessionIdPrefix: 'replacement' });
    let releaseKill!: () => void;
    const killing = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    const kill = old.channel.kill;
    const oldKill = vi.fn(async () => {
      await killing;
      await kill();
    });
    old.channel = { ...old.channel, kill: oldKill };
    const factory = vi
      .fn<() => Promise<AcpChannel>>()
      .mockResolvedValueOnce(old.channel)
      .mockResolvedValue(replacement.channel);
    const bridge = makeBridge({
      channelFactory: factory,
      sessionScope: 'thread',
    });

    try {
      const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const removing = bridge.killSession(first.sessionId);
      await vi.waitFor(() => expect(oldKill).toHaveBeenCalledTimes(1));

      const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(factory).toHaveBeenCalledTimes(2);
      releaseKill();
      await removing;
      await old.channel.exited;

      expect(bridge.isChannelLive()).toBe(true);
      const third = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(factory).toHaveBeenCalledTimes(2);
      expect(third.sessionId).not.toBe(second.sessionId);
      expect(replacement.agent.newSessionCalls).toHaveLength(2);
      await expect(
        bridge.sendPrompt(second.sessionId, {
          sessionId: second.sessionId,
          prompt: [{ type: 'text', text: 'still available' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
    } finally {
      releaseKill();
      await bridge.shutdown();
    }
  });
});
