/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import type {
  AcpSessionBridge,
  BridgeRuntimeStopRequest,
} from './bridgeTypes.js';
import { SERVE_CONTROL_EXT_METHODS } from './status.js';

const bridges: AcpSessionBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdown()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function confirmation(bridge: AcpSessionBridge): BridgeRuntimeStopRequest {
  const snapshot = bridge.getRuntimeStopSnapshot!();
  return {
    confirmInterruptions: true,
    expectedChannelId: snapshot.channelId!,
    expectedRuntimeEpoch: snapshot.runtimeEpoch,
    expectedStopToken: snapshot.stopToken,
    expectedSessionIds: snapshot.sessions.map((s) => s.sessionId),
  };
}

function setup(
  close: (id: string) => Promise<Record<string, unknown>> = async () => ({
    closed: true,
  }),
) {
  const channels = Array.from({ length: 2 }, () => {
    const handle = makeChannel({
      extMethodImpl: async (method, params) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionClose
          ? close(String(params['sessionId']))
          : {},
    });
    handle.channel.registryReleased = handle.channel.exited.then(() => {});
    return handle;
  });
  const factory = vi
    .fn()
    .mockResolvedValueOnce(channels[0].channel)
    .mockResolvedValueOnce(channels[1].channel);
  const bridge = makeBridge({
    channelFactory: factory,
    channelIdleTimeoutMs: 60_000,
    initializeTimeoutMs: 1000,
  });
  bridges.push(bridge);
  return { bridge, channels, factory };
}

describe('explicit workspace runtime stop', () => {
  it('closes a loaded session, releases the child and preserves a reusable bridge', async () => {
    const { bridge, channels, factory } = setup();
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const request = confirmation(bridge);
    expect(bridge.getIdleChannelCandidate!()).toBeUndefined();
    expect(bridge.getRuntimeStopSnapshot!().blockedReasons).toEqual([]);
    const result = await bridge.stopWorkspaceRuntime!(request);
    expect(result).toMatchObject({
      state: 'stopped',
      released: true,
      closedSessionIds: [session.sessionId],
    });
    expect(channels[0].killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
    await bridge.preheat();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(await bridge.stopWorkspaceRuntime!(request)).toEqual(result);
    expect(channels[1].killed).toBe(false);
  });

  it('rejects changed membership before interrupting any session', async () => {
    const close = vi.fn(async () => ({ closed: true }));
    const { bridge, channels } = setup(close);
    await bridge.preheat();
    const request = confirmation(bridge);
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(() => bridge.stopWorkspaceRuntime!(request)).toThrow('changed');
    expect(close).not.toHaveBeenCalled();
    expect(channels[0].killed).toBe(false);
  });

  it('waits for the selected child registry release after root exit and blocks re-entry', async () => {
    const { bridge, channels } = setup();
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    let release!: () => void;
    channels[0].channel.registryReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = confirmation(bridge);
    const stop = bridge.stopWorkspaceRuntime!(request);
    expect(bridge.stopWorkspaceRuntime!(request)).toBe(stop);
    await vi.waitFor(() => expect(channels[0].killed).toBe(true));
    expect(bridge.getRuntimeStopSnapshot!().lastStop?.released).toBe(false);
    expect(bridge.getWorkspaceRuntimeLifecycleSnapshot!().state).toBe(
      'stopping',
    );
    await expect(bridge.preheat()).rejects.toThrow();
    release();
    expect((await stop).released).toBe(true);
    await bridge.preheat();
  });

  it('keeps refused sessions live and accepts a fresh confirmation on the same channel', async () => {
    let refuse = true;
    const close = vi.fn(async () => {
      if (refuse) throw new RequestError(-32603, 'flush refused');
      return { closed: true };
    });
    const { bridge, channels } = setup(close);
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const old = confirmation(bridge);
    const result = await bridge.stopWorkspaceRuntime!(old);
    expect(result).toMatchObject({
      state: 'incomplete',
      released: false,
      remainingSessionIds: [session.sessionId],
    });
    expect(channels[0].killed).toBe(false);
    expect(await bridge.stopWorkspaceRuntime!(old)).toEqual(result);
    expect(close).toHaveBeenCalledTimes(1);
    refuse = false;
    expect(
      (await bridge.stopWorkspaceRuntime!(confirmation(bridge))).state,
    ).toBe('stopped');
    expect(() => bridge.stopWorkspaceRuntime!(old)).toThrow('changed');
  });

  it('does not accept an unacknowledged close as flushed', async () => {
    const { bridge, channels } = setup(async () => ({ closed: false }));
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const result = await bridge.stopWorkspaceRuntime!(confirmation(bridge));
    expect(result.state).toBe('incomplete');
    expect(result.closedSessionIds).toEqual([]);
    expect(bridge.sessionCount).toBe(1);
    expect(channels[0].killed).toBe(false);
  });

  it('refuses channels without owned release observation', async () => {
    const { bridge, channels } = setup();
    delete channels[0].channel.registryReleased;
    await bridge.preheat();
    expect(bridge.getRuntimeStopSnapshot!().blockedReasons).toContain(
      'release_unavailable',
    );
    expect(() => bridge.stopWorkspaceRuntime!(confirmation(bridge))).toThrow(
      'pending',
    );
    expect(channels[0].killed).toBe(false);
  });
  it('reports partial closes without terminating sessions after the total budget expires', async () => {
    let now = Date.now();
    const { bridge, channels } = setup(async () => {
      now += 2000;
      return { closed: true };
    });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const result = await bridge.stopWorkspaceRuntime!(
      confirmation(bridge),
      1000,
    );
    expect(result).toMatchObject({
      state: 'incomplete',
      stopped: false,
      released: false,
      closedSessionIds: [first.sessionId],
      remainingSessionIds: [second.sessionId],
    });
    expect(channels[0].killed).toBe(false);
    vi.restoreAllMocks();
  });

  it('bounds an unknown close outcome while retaining isolation until release', async () => {
    const { bridge, channels } = setup(() => new Promise(() => {}));
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    let release!: () => void;
    channels[0].channel.registryReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.useFakeTimers();
    const stopping = bridge.stopWorkspaceRuntime!(confirmation(bridge), 50);
    const completion = bridge.getRuntimeStopCompletion!()!;
    await vi.advanceTimersByTimeAsync(100);
    const failed = await stopping;
    expect(channels[0].killed).toBe(true);
    expect(failed).toMatchObject({
      state: 'failed',
      released: false,
      closedSessionIds: [],
    });
    await expect(bridge.preheat()).rejects.toThrow();
    release();
    expect(await completion).toMatchObject({
      state: 'incomplete',
      stopped: false,
      released: true,
      closedSessionIds: [],
      interruptedSessionIds: [session.sessionId],
    });
    expect(failed).toMatchObject({ state: 'failed', released: false });
    expect(bridge.getRuntimeStopSnapshot!().blockedReasons).not.toContain(
      'stopping',
    );
  });

  it.each([false, true])(
    'settles the response but retains quarantine until release (teardown rejects: %s)',
    async (rejectTeardown) => {
      const { bridge, channels, factory } = setup();
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      let release!: () => void;
      channels[0].channel.registryReleased = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (rejectTeardown) {
        const kill = channels[0].channel.kill;
        channels[0].channel.kill = async () => {
          await kill();
          throw new Error('teardown failed');
        };
      }
      vi.useFakeTimers();
      const request = confirmation(bridge);
      const stop = bridge.stopWorkspaceRuntime!(request, 50);
      const completion = bridge.getRuntimeStopCompletion!()!;
      const completed = vi.fn();
      void completion.then(completed);
      await vi.advanceTimersByTimeAsync(50);
      const failed = await stop;
      expect(failed).toMatchObject({
        state: 'failed',
        stopped: false,
        released: false,
        closedSessionIds: [session.sessionId],
      });
      expect(completed).not.toHaveBeenCalled();
      expect(bridge.stopWorkspaceRuntime!(request)).toBe(stop);
      await expect(bridge.stopWorkspaceRuntime!(request)).resolves.toEqual(
        failed,
      );
      await expect(bridge.preheat()).rejects.toThrow();
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toThrow();
      expect(factory).toHaveBeenCalledOnce();
      expect(bridge.getRuntimeStopSnapshot!().blockedReasons).toContain(
        'stopping',
      );
      release();
      expect(await completion).toMatchObject({
        state: 'stopped',
        stopped: true,
        released: true,
      });
      expect(failed).toMatchObject({ state: 'failed', released: false });
      expect(bridge.getRuntimeStopCompletion!()).toBeUndefined();
      await bridge.preheat();
      expect(factory).toHaveBeenCalledTimes(2);
    },
  );
  it('does not let a concurrent cleanup kill bypass the confirmed session flush', async () => {
    let acknowledge!: (value: Record<string, unknown>) => void;
    const close = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { bridge, channels } = setup(close);
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const stopping = bridge.stopWorkspaceRuntime!(confirmation(bridge));
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(await bridge.killSession(session.sessionId)).toBe(false);
    expect(channels[0].killed).toBe(false);
    acknowledge({ closed: true });
    expect((await stopping).state).toBe('stopped');
  });
});

it('cleanup requested during refused stop survives to last detach', async () => {
  let refuse!: (error: Error) => void;
  let pending = true;
  const close = vi.fn(async () => {
    if (pending) {
      pending = false;
      return new Promise<Record<string, unknown>>((_, reject) => {
        refuse = reject;
      });
    }
    return { closed: true };
  });
  const { bridge, channels } = setup(close);
  const owner = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
  const attacher = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
  expect(owner.sessionId).toBe(attacher.sessionId);
  const stop = bridge.stopWorkspaceRuntime!(confirmation(bridge));
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(
    await bridge.killSession(owner.sessionId, { requireZeroAttaches: true }),
  ).toBe(false);
  expect(channels[0].killed).toBe(false);
  refuse(new RequestError(-32603, 'flush refused'));
  expect((await stop).state).toBe('incomplete');
  await bridge.detachClient(attacher.sessionId, attacher.clientId);
  expect(bridge.sessionCount).toBe(0);
});

it('reaps a session whose kill was deferred to a stop that ended incomplete', async () => {
  let refuse!: (error: Error) => void;
  let pending = true;
  const close = vi.fn(async () => {
    if (pending) {
      pending = false;
      return new Promise<Record<string, unknown>>((_, reject) => {
        refuse = reject;
      });
    }
    return { closed: true };
  });
  const { bridge, channels } = setup(close);
  const owner = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
  const attacher = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
  expect(owner.sessionId).toBe(attacher.sessionId);
  const stop = bridge.stopWorkspaceRuntime!(confirmation(bridge));
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  // A no-options kill requested while the stop is in flight is deferred by
  // the runtime-stop bail — record the intent rather than drop it.
  expect(await bridge.killSession(owner.sessionId)).toBe(false);
  expect(channels[0].killed).toBe(false);
  refuse(new RequestError(-32603, 'flush refused'));
  expect((await stop).state).toBe('incomplete');
  // The session survived the incomplete stop. The recorded intent reaps it
  // at the first detach that empties the attach ledger; without the
  // tombstone the survivor instead waits for the owner's goodbye.
  await bridge.detachClient(attacher.sessionId, attacher.clientId);
  expect(bridge.sessionCount).toBe(0);
});
