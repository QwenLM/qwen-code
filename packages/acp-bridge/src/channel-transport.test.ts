/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import { BridgeChannelClosedError, BridgeTimeoutError } from './status.js';

describe('channel transport', () => {
  it('forces a hanging teardown at the configured deadline and retains its failure', async () => {
    vi.useFakeTimers();
    const handle = makeChannel();
    const cleanup = handle.channel.kill;
    let release!: () => void;
    const killing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const kill = vi.fn(() => killing);
    const killSync = vi.fn();
    handle.channel = { ...handle.channel, kill, killSync };
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      initializeTimeoutMs: 40,
    });

    try {
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const shutdown = bridge.shutdown();
      const result = shutdown.catch((error: unknown) => error);
      expect(kill).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(39);
      expect(killSync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      const error = await result;
      expect(error).toBeInstanceOf(BridgeTimeoutError);
      expect(error).toMatchObject({
        label: 'bridge shutdown teardown',
        timeoutMs: 40,
      });
      expect(killSync).toHaveBeenCalledOnce();
      expect(bridge.shutdown()).toBe(shutdown);
      release();
      await expect(bridge.shutdown()).rejects.toBe(error);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await cleanup();
      vi.useRealTimers();
    }
  });

  it.each(['reject', 'throw'])(
    'preserves both failures when kill and killSync fail (%s)',
    async (failureMode) => {
      const handle = makeChannel();
      const cleanup = handle.channel.kill;
      const failure = new Error('graceful teardown failed');
      const forceFailure = new Error('forced teardown failed');
      const kill = vi.fn(() => {
        if (failureMode === 'throw') throw failure;
        return Promise.reject(failure);
      });
      const killSync = vi.fn(() => {
        throw forceFailure;
      });
      handle.channel = { ...handle.channel, kill, killSync };
      const bridge = makeBridge({ channelFactory: async () => handle.channel });

      try {
        await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        const error = await bridge
          .shutdown()
          .catch((reason: unknown) => reason);
        expect(kill).toHaveBeenCalledOnce();
        expect(killSync).toHaveBeenCalledOnce();
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({
          message: 'ACP channel teardown failed (bridge shutdown)',
          errors: [failure, forceFailure],
        });
        await expect(bridge.shutdown()).rejects.toBe(error);
      } finally {
        await cleanup();
      }
    },
  );

  it('maps rejected transport failure to channel-closed before process exit', async () => {
    let rejectTransport!: (error: Error) => void;
    const transportFailed = new Promise<unknown>((_resolve, reject) => {
      rejectTransport = reject;
    });
    let startPrompt!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      startPrompt = resolve;
    });
    let finishPrompt!: (result: { stopReason: 'end_turn' }) => void;
    const promptResult = new Promise<{ stopReason: 'end_turn' }>((resolve) => {
      finishPrompt = resolve;
    });
    const handle = makeChannel({
      promptImpl: () => {
        startPrompt();
        return promptResult;
      },
    });
    handle.channel = { ...handle.channel, transportFailed };
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const exited = vi.fn();
    void handle.channel.exited.then(exited);

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = bridge
        .sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'wait for transport failure' }],
        })
        .catch((error: unknown) => error);
      await promptStarted;
      rejectTransport(new Error('raw transport failure'));

      const error = await result;
      expect(error).toBeInstanceOf(BridgeChannelClosedError);
      expect(error).toMatchObject({
        context: `mid-request (session ${session.sessionId})`,
      });
      expect(exited).not.toHaveBeenCalled();
      expect(handle.killed).toBe(false);
    } finally {
      finishPrompt({ stopReason: 'end_turn' });
      await bridge.shutdown();
    }
  });
});
