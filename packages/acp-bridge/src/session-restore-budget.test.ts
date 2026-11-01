/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_EXECUTION_ENGINE_META_KEY,
  type BridgeExecutionEngine,
  type BridgeTelemetry,
} from './bridgeOptions.js';
import type { AcpChannel } from './channel.js';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import { SessionRestoreTimeoutError } from './status.js';

describe('session restore budget', () => {
  it.each(['load', 'resume'] as const)(
    'includes cold startup in the session/%s deadline',
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const delayedRestore = () =>
        new Promise<Record<string, never>>((resolve) => {
          setTimeout(() => resolve({}), 53_000);
        });
      const handle = makeChannel({
        initializeDelayMs: 9_000,
        loadSessionImpl: delayedRestore,
        resumeSessionImpl: delayedRestore,
      });
      let releaseFactory!: (channel: AcpChannel) => void;
      const factory = new Promise<AcpChannel>((resolve) => {
        releaseFactory = resolve;
      });
      const bridge = makeBridge({
        initializeTimeoutMs: 10_000,
        channelFactory: () => factory,
      });
      const request = { sessionId: `cold-${action}`, workspaceCwd: WS_A };
      let settledAt: number | undefined;
      const outcome = (
        action === 'load'
          ? bridge.loadSession(request)
          : bridge.resumeSession(request)
      ).catch((error: unknown) => {
        settledAt = Date.now();
        return error;
      });

      try {
        await vi.advanceTimersByTimeAsync(9_000);
        releaseFactory(handle.channel);
        await vi.advanceTimersByTimeAsync(9_000);
        expect(
          action === 'load'
            ? handle.agent.loadSessionCalls
            : handle.agent.resumeSessionCalls,
        ).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(41_999);
        expect(settledAt).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settledAt).toBe(60_000);
        expect(await outcome).toBeInstanceOf(SessionRestoreTimeoutError);
        expect(await outcome).toMatchObject({ action, timeoutMs: 60_000 });
        expect(settledAt).toBeLessThan(70_000);
        expect(handle.killed).toBe(true);
      } finally {
        releaseFactory(handle.channel);
        await bridge.shutdown();
        vi.useRealTimers();
      }
    },
  );

  it('completes a cold restore that fits the remaining budget', async () => {
    vi.useFakeTimers();
    const handle = makeChannel({
      initializeDelayMs: 30,
      loadSessionImpl: () =>
        new Promise((resolve) => setTimeout(() => resolve({}), 20)),
    });
    let releaseFactory!: (channel: AcpChannel) => void;
    const factory = new Promise<AcpChannel>((resolve) => {
      releaseFactory = resolve;
    });
    const channelFactory = vi.fn(() => factory);
    const bridge = makeBridge({
      initializeTimeoutMs: 50,
      sessionRestoreTimeoutMs: 100,
      channelFactory,
    });

    try {
      const outcome = bridge
        .loadSession({
          sessionId: 'cold-success',
          workspaceCwd: WS_A,
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30);
      releaseFactory(handle.channel);
      await vi.advanceTimersByTimeAsync(50);
      await expect(outcome).resolves.toMatchObject({
        sessionId: 'cold-success',
      });
      expect(handle.killed).toBe(false);
      await expect(
        bridge.loadSession({ sessionId: 'cold-success', workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ attached: true });
      expect(channelFactory).toHaveBeenCalledOnce();
      expect(handle.agent.loadSessionCalls).toHaveLength(1);
    } finally {
      releaseFactory(handle.channel);
      await bridge.shutdown();
      vi.useRealTimers();
    }
  });

  it('expires while waiting for a channel without a late restore or capacity leak', async () => {
    vi.useFakeTimers();
    const handle = makeChannel();
    let releaseFactory!: (channel: AcpChannel) => void;
    const factory = new Promise<AcpChannel>((resolve) => {
      releaseFactory = resolve;
    });
    const event = vi.fn();
    const telemetry: BridgeTelemetry = {
      captureContext: () => undefined,
      runWithContext: async (_context, fn) => await fn(),
      withSpan: async (_operation, _attributes, fn) => await fn(),
      injectPromptContext: (request) => request,
      event,
    };
    const bridge = makeBridge({
      initializeTimeoutMs: 100,
      sessionRestoreTimeoutMs: 50,
      channelIdleTimeoutMs: 1_000,
      maxSessions: 1,
      channelFactory: () => factory,
      telemetry,
    });

    try {
      const settled = vi.fn();
      const outcome = bridge
        .loadSession({ sessionId: 'expired', workspaceCwd: WS_A })
        .catch((error: unknown) => error);
      void outcome.then(settled);
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toHaveBeenCalledOnce();
      expect(await outcome).toBeInstanceOf(SessionRestoreTimeoutError);
      expect(event).toHaveBeenCalledWith(
        'session.restore.public_result',
        expect.objectContaining({
          'qwen-code.daemon.session_restore.result': 'timeout',
          'qwen-code.daemon.session_restore.timeout_ms': 50,
        }),
      );
      await vi.advanceTimersByTimeAsync(30);
      releaseFactory(handle.channel);
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.agent.loadSessionCalls).toHaveLength(0);
      expect(handle.killed).toBe(false);
      await expect(
        bridge.loadSession({ sessionId: 'next', workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'next' });
      expect(
        handle.agent.loadSessionCalls.map((call) => call.sessionId),
      ).toEqual(['next']);
    } finally {
      releaseFactory(handle.channel);
      await bridge.shutdown();
      vi.useRealTimers();
    }
  });

  it('expires during engine selection without later starting either engine', async () => {
    vi.useFakeTimers();
    const managed = makeChannel({
      loadSessionImpl: () => ({
        _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: 'managed' },
      }),
    });
    let releaseSelection!: (engine: BridgeExecutionEngine) => void;
    const selection = new Promise<BridgeExecutionEngine>((resolve) => {
      releaseSelection = resolve;
    });
    const select = vi.fn(() => selection);
    const legacyFactory = vi.fn(async () => makeChannel().channel);
    const managedFactory = vi.fn(async () => managed.channel);
    const bridge = makeBridge({
      initializeTimeoutMs: 100,
      sessionRestoreTimeoutMs: 50,
      maxSessions: 1,
      executionEngines: {
        legacy: legacyFactory,
        managed: managedFactory,
        select,
      },
    });

    try {
      const outcome = bridge
        .loadSession({ sessionId: 'expired-selection', workspaceCwd: WS_A })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(await outcome).toBeInstanceOf(SessionRestoreTimeoutError);
      releaseSelection('managed');
      await vi.advanceTimersByTimeAsync(0);
      expect(legacyFactory).not.toHaveBeenCalled();
      expect(managedFactory).not.toHaveBeenCalled();
      select.mockResolvedValue('managed');
      await expect(
        bridge.loadSession({ sessionId: 'next-selection', workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'next-selection' });
      expect(legacyFactory).not.toHaveBeenCalled();
      expect(managedFactory).toHaveBeenCalledOnce();
    } finally {
      releaseSelection('managed');
      await bridge.shutdown();
      vi.useRealTimers();
    }
  });
});
