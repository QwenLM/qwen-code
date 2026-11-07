/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import type { AcpSessionBridge } from './bridgeTypes.js';
import {
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
} from './status.js';

const bridges: AcpSessionBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdown()));
  vi.restoreAllMocks();
});

function setup() {
  const channels = [makeChannel(), makeChannel()];
  const factory = vi
    .fn()
    .mockResolvedValueOnce(channels[0].channel)
    .mockResolvedValueOnce(channels[1].channel);
  const bridge = makeBridge({
    channelFactory: factory,
    channelIdleTimeoutMs: 60_000,
  });
  bridges.push(bridge);
  return { bridge, channels, factory };
}

describe('idle channel reclamation', () => {
  it('ends soft keepalive without sealing the bridge and can cold-start again', async () => {
    const { bridge, channels, factory } = setup();
    expect(bridge.getIdleChannelCandidate!()).toBeUndefined();
    await bridge.preheat({ keepAliveMs: 600_000 });
    const candidate = bridge.getIdleChannelCandidate!()!;
    expect(candidate.runtimeEpoch).toBe(1);
    await expect(bridge.reclaimIdleChannel!(candidate)).resolves.toBe(true);
    expect(channels[0].killed).toBe(true);
    await bridge.preheat({ keepAliveMs: 600_000 });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(bridge.getIdleChannelCandidate!()!.runtimeEpoch).toBe(2);
    await expect(bridge.reclaimIdleChannel!(candidate)).resolves.toBe(false);
    expect(channels[1].killed).toBe(false);
  });

  it('preserves a loaded idle session without sending close or kill', async () => {
    const { bridge, channels } = setup();
    await bridge.preheat();
    const candidate = bridge.getIdleChannelCandidate!()!;
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(bridge.getIdleChannelCandidate!()).toBeUndefined();
    await expect(bridge.reclaimIdleChannel!(candidate)).resolves.toBe(false);
    expect(bridge.getSessionSummary(session.sessionId)).toBeDefined();
    expect(channels[0].killed).toBe(false);
  });

  it('does not refresh LRU on status polls but does on workspace commands and preheat', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { bridge } = setup();
    await bridge.preheat();
    const original = bridge.getIdleChannelCandidate!()!;
    now += 1000;
    await bridge.queryWorkspaceStatus('qwen/status/workspace/test', () => ({}));
    expect(bridge.getIdleChannelCandidate!()).toEqual(original);
    await bridge.invokeWorkspaceCommand('qwen/control/workspace/test');
    expect(bridge.getIdleChannelCandidate!()!.lastUsedAt).toBe(now);
    await expect(bridge.reclaimIdleChannel!(original)).resolves.toBe(false);
    now += 1000;
    await bridge.preheat();
    expect(bridge.getIdleChannelCandidate!()!.lastUsedAt).toBe(now);
  });

  it('refreshes recency once when polling observes pending MCP discovery finish', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let completed = false;
    const channel = makeChannel({
      extMethodImpl: async (method) => {
        if (method === SERVE_CONTROL_EXT_METHODS.workspaceMcpInitialize)
          return { accepted: true };
        return {
          discoveryState: completed ? 'completed' : 'in_progress',
          servers: [],
        };
      },
    });
    const bridge = makeBridge({
      channelFactory: async () => channel.channel,
      channelIdleTimeoutMs: 60_000,
    });
    bridges.push(bridge);
    await bridge.initializeWorkspaceMcp();
    const poll = () =>
      bridge.queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcp,
        () => ({}),
      );
    await poll();
    expect(bridge.getIdleChannelCandidate!()).toBeUndefined();
    completed = true;
    now += 1000;
    await poll();
    const candidate = bridge.getIdleChannelCandidate!()!;
    expect(candidate.lastUsedAt).toBe(now);
    now += 1000;
    await poll();
    expect(bridge.getIdleChannelCandidate!()).toEqual(candidate);
  });

  it('protects workspace control in flight, and does not reclaim after abort', async () => {
    let release!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const channel = makeChannel({ extMethodImpl: async () => pending });
    const bridge = makeBridge({
      channelFactory: async () => channel.channel,
      channelIdleTimeoutMs: 60_000,
    });
    bridges.push(bridge);
    await bridge.preheat();
    const candidate = bridge.getIdleChannelCandidate!()!;
    const control = bridge.invokeWorkspaceCommand(
      'qwen/control/workspace/test',
    );
    await vi.waitFor(() =>
      expect(bridge.getIdleChannelCandidate!()).toBeUndefined(),
    );
    await expect(bridge.reclaimIdleChannel!(candidate)).resolves.toBe(false);
    release({});
    await control;
    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge.reclaimIdleChannel!(
        bridge.getIdleChannelCandidate!()!,
        controller.signal,
      ),
    ).resolves.toBe(false);
    expect(channel.killed).toBe(false);
  });

  it('waits for teardown and skips a concurrent reclaim of the same child', async () => {
    const { bridge, channels } = setup();
    await bridge.preheat();
    const candidate = bridge.getIdleChannelCandidate!()!;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const kill = channels[0].channel.kill;
    vi.spyOn(channels[0].channel, 'kill').mockImplementation(async () => {
      await pending;
      await kill();
    });
    let done = false;
    const reclaim = bridge.reclaimIdleChannel!(candidate).then((value) => {
      done = true;
      return value;
    });
    expect(bridge.getIdleChannelCandidate!()).toBeUndefined();
    await expect(bridge.reclaimIdleChannel!(candidate)).resolves.toBe(false);
    expect(done).toBe(false);
    release();
    await expect(reclaim).resolves.toBe(true);
  });
});
