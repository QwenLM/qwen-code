/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel } from './internal/testUtils.js';
import type { AcpChannel } from './channel.js';
import { BridgeTimeoutError } from './status.js';

describe('channel startup', () => {
  it('uses the remaining factory budget for initialize', async () => {
    vi.useFakeTimers();
    let finishInitialize!: () => void;
    const initializing = new Promise<void>((resolve) => {
      finishInitialize = resolve;
    });
    const handle = makeChannel({
      initializeImpl: async () => {
        await initializing;
        return { protocolVersion: PROTOCOL_VERSION };
      },
    });
    let releaseFactory!: (channel: AcpChannel) => void;
    const factoryResult = new Promise<AcpChannel>((resolve) => {
      releaseFactory = resolve;
    });
    let signal: AbortSignal | undefined;
    const bridge = makeBridge({
      initializeTimeoutMs: 50,
      channelFactory: (_workspace, _env, startupSignal) => {
        signal = startupSignal;
        return factoryResult;
      },
    });

    try {
      const preheat = bridge.preheat().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30);
      releaseFactory(handle.channel);
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.agent.initializeCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(19);
      expect(signal?.aborted).toBe(false);
      expect(handle.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const error = await preheat;
      expect(error).toBeInstanceOf(BridgeTimeoutError);
      expect(error).toMatchObject({ label: 'initialize', timeoutMs: 20 });
      expect(signal?.reason).toBe(error);
      expect(handle.killed).toBe(true);
      expect(bridge.isChannelLive()).toBe(false);
    } finally {
      releaseFactory(handle.channel);
      finishInitialize();
      await bridge.shutdown();
      vi.useRealTimers();
    }
  });

  it('registers a constructed channel before the next microtask can force shutdown', async () => {
    const handle = makeChannel();
    const stream = handle.channel.stream;
    const killSync = vi.fn(handle.channel.killSync);
    let forced!: () => void;
    const forceShutdown = new Promise<void>((resolve) => {
      forced = resolve;
    });
    handle.channel = {
      ...handle.channel,
      get stream() {
        queueMicrotask(() => {
          bridge.killAllSync();
          forced();
        });
        return stream;
      },
      killSync,
    };
    const allocate = vi.fn(() => 1);
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      runtimeEpochSource: { current: () => 0, allocate },
    });

    try {
      const result = bridge.preheat().catch((error: unknown) => error);
      await forceShutdown;
      expect(killSync).toHaveBeenCalledOnce();
      expect(await result).toBeInstanceOf(Error);
      expect(allocate).not.toHaveBeenCalled();
      expect(bridge.isChannelLive()).toBe(false);
    } finally {
      await bridge.shutdown();
    }
  });

  it('waits for a pending factory during shutdown and refuses publication', async () => {
    const handle = makeChannel();
    let releaseFactory!: (channel: AcpChannel) => void;
    const factoryResult = new Promise<AcpChannel>((resolve) => {
      releaseFactory = resolve;
    });
    let signal: AbortSignal | undefined;
    const allocate = vi.fn(() => 1);
    const bridge = makeBridge({
      channelFactory: (_workspace, _env, startupSignal) => {
        signal = startupSignal;
        return factoryResult;
      },
      runtimeEpochSource: { current: () => 0, allocate },
    });

    try {
      const preheat = bridge.preheat().catch((error: unknown) => error);
      const stopped = vi.fn();
      const shutdown = bridge.shutdown().then(stopped);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).not.toHaveBeenCalled();
      releaseFactory(handle.channel);

      const error = await preheat;
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: 'AcpSessionBridge is shutting down',
      });
      await shutdown;
      expect(signal?.aborted).toBe(true);
      expect(handle.killed).toBe(true);
      expect(handle.agent.initializeCalls).toHaveLength(1);
      expect(handle.agent.newSessionCalls).toHaveLength(0);
      expect(allocate).not.toHaveBeenCalled();
      expect(bridge.isChannelLive()).toBe(false);
    } finally {
      releaseFactory(handle.channel);
      await bridge.shutdown();
    }
  });
});
