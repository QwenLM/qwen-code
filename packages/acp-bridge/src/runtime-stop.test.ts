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

  it('keeps an unknown close outcome pending until release and never claims it was flushed', async () => {
    const { bridge, channels } = setup(() => new Promise(() => {}));
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    let release!: () => void;
    channels[0].channel.registryReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopping = bridge.stopWorkspaceRuntime!(confirmation(bridge), 50);
    await vi.waitFor(() => expect(channels[0].killed).toBe(true));
    expect(bridge.getRuntimeStopSnapshot!().lastStop).toMatchObject({
      state: 'stopping',
      released: false,
      closedSessionIds: [],
    });
    release();
    expect(await stopping).toMatchObject({
      state: 'incomplete',
      stopped: false,
      released: true,
      closedSessionIds: [],
      interruptedSessionIds: [session.sessionId],
    });
  });
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
