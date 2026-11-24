/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel } from './internal/testUtils.js';
import { CHANNEL_STARTUP_PROFILE_META_KEY } from './bridgeTypes.js';
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

  it('reports elapsed time and budget when a startup fails', async () => {
    // A bare "initialize timed out" line cannot distinguish "the child never
    // answered" from "the transport was slow": the budget is the other half of
    // that comparison, so both numbers must appear together.
    vi.useFakeTimers();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    const handle = makeChannel({
      initializeImpl: () => new Promise(() => {}),
    });
    const bridge = makeBridge({
      initializeTimeoutMs: 20,
      channelFactory: async () => handle.channel,
    });

    try {
      const startup = bridge.preheat().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);

      expect(await startup).toBeInstanceOf(BridgeTimeoutError);
      const line = writes.find((entry) =>
        entry.includes('channel startup failed'),
      );
      expect(line).toContain('init_timeout_ms=20');
      expect(line).toContain('elapsed_ms=');
      expect(line).toContain('initialize timed out');
    } finally {
      write.mockRestore();
      await bridge.shutdown();
      vi.useRealTimers();
    }
  });

  it('logs the phase breakdown only for startup slow enough to matter', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    let finishInitialize!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishInitialize = resolve;
    });
    const handle = makeChannel({
      initializeImpl: async () => {
        await gate;
        return {
          protocolVersion: PROTOCOL_VERSION,
          _meta: {
            [CHANNEL_STARTUP_PROFILE_META_KEY]: {
              v: 1,
              complete: false,
              responseBuiltAtEpochMs: Date.now(),
              processToResponseMs: 2_500,
              phases: { settingsLoadMs: 20 },
              config: { toolWarmupMs: 2_400 },
            },
          },
        };
      },
    });
    const bridge = makeBridge({
      initializeTimeoutMs: 10_000,
      channelFactory: async () => handle.channel,
    });

    try {
      const startup = bridge.preheat();
      await vi.advanceTimersByTimeAsync(2_500);
      finishInitialize();
      await startup;

      const line = writes.find((entry) =>
        entry.includes('channel startup total_ms='),
      );
      expect(line).toContain('config.tool_warmup_ms=2400');
      expect(line).toContain('phase.settings_load_ms=20');
    } finally {
      write.mockRestore();
      await bridge.shutdown();
      vi.useRealTimers();
    }
  });
});
