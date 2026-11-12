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

function recordTelemetry(
  event: NonNullable<BridgeTelemetry['event']>,
): BridgeTelemetry {
  return {
    captureContext: () => undefined,
    runWithContext: async (_context, fn) => await fn(),
    withSpan: async (_operation, _attributes, fn) => await fn(),
    injectPromptContext: (request) => request,
    event,
  };
}

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
      const event = vi.fn();
      const bridge = makeBridge({
        initializeTimeoutMs: 10_000,
        channelFactory: () => factory,
        telemetry: recordTelemetry(event),
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
        expect(event).toHaveBeenCalledWith(
          'session.restore.public_result',
          expect.objectContaining({
            'qwen-code.daemon.session_restore.result': 'timeout',
          }),
        );
        expect(
          event.mock.calls.find(
            ([name]) => name === 'session.restore.public_result',
          )?.[1],
        ).not.toHaveProperty([
          'qwen-code.daemon.session_restore.preparation_stage',
        ]);
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
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = makeChannel();
    let releaseFactory!: (channel: AcpChannel) => void;
    const factory = new Promise<AcpChannel>((resolve) => {
      releaseFactory = resolve;
    });
    const event = vi.fn();
    const bridge = makeBridge({
      initializeTimeoutMs: 100,
      sessionRestoreTimeoutMs: 50,
      channelIdleTimeoutMs: 1_000,
      maxSessions: 1,
      channelFactory: () => factory,
      telemetry: recordTelemetry(event),
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
      expect(await outcome).toMatchObject({ dispatched: false });
      expect(event).toHaveBeenCalledWith(
        'session.restore.public_result',
        expect.objectContaining({
          'qwen-code.daemon.session_restore.result': 'timeout',
          'qwen-code.daemon.session_restore.timeout_ms': 50,
          'qwen-code.daemon.session_restore.preparation_stage':
            'channel_readiness',
        }),
      );
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          'phase=preparation; stage=channel_readiness; decision=release_admission',
        ),
      );
      await vi.advanceTimersByTimeAsync(30);
      releaseFactory(handle.channel);
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.agent.loadSessionCalls).toHaveLength(0);
      expect(handle.killed).toBe(false);
      await expect(
        bridge.loadSession({ sessionId: 'expired', workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'expired' });
      expect(
        handle.agent.loadSessionCalls.map((call) => call.sessionId),
      ).toEqual(['expired']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handle.killed).toBe(false);
    } finally {
      releaseFactory(handle.channel);
      await bridge.shutdown();
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['load', 'resume'] as const)(
    'applies the configured idle policy after abandoned session/%s preparation warms a channel',
    async (action) => {
      for (const channelIdleTimeoutMs of [0, 1_000]) {
        vi.useFakeTimers();
        const handle = makeChannel();
        let releaseFactory!: (channel: AcpChannel) => void;
        const factory = new Promise<AcpChannel>((resolve) => {
          releaseFactory = resolve;
        });
        const bridge = makeBridge({
          initializeTimeoutMs: 100,
          sessionRestoreTimeoutMs: 50,
          channelIdleTimeoutMs,
          channelFactory: () => factory,
        });
        const request = { sessionId: `idle-${action}`, workspaceCwd: WS_A };
        try {
          const outcome = (
            action === 'load'
              ? bridge.loadSession(request)
              : bridge.resumeSession(request)
          ).catch((error: unknown) => error);
          await vi.advanceTimersByTimeAsync(50);
          expect(await outcome).toBeInstanceOf(SessionRestoreTimeoutError);
          expect(await outcome).toMatchObject({ dispatched: false });
          await vi.advanceTimersByTimeAsync(30);
          releaseFactory(handle.channel);
          await vi.advanceTimersByTimeAsync(0);
          expect(handle.agent.loadSessionCalls).toHaveLength(0);
          expect(handle.agent.resumeSessionCalls).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(999);
          expect(handle.killed).toBe(false);
          await vi.advanceTimersByTimeAsync(2);
          expect(handle.killed).toBe(channelIdleTimeoutMs > 0);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(handle.killed).toBe(channelIdleTimeoutMs > 0);
        } finally {
          releaseFactory(handle.channel);
          await bridge.shutdown();
          vi.useRealTimers();
        }
      }
    },
  );

  it.each(['load', 'resume'] as const)(
    'allows a healthy session/%s to use a small positive remainder',
    async (action) => {
      vi.useFakeTimers();
      const handle = makeChannel();
      let releaseFactory!: (channel: AcpChannel) => void;
      const factory = new Promise<AcpChannel>((resolve) => {
        releaseFactory = resolve;
      });
      const bridge = makeBridge({
        initializeTimeoutMs: 100,
        sessionRestoreTimeoutMs: 50,
        channelFactory: () => factory,
      });
      const request = { sessionId: `fast-${action}`, workspaceCwd: WS_A };
      try {
        const outcome =
          action === 'load'
            ? bridge.loadSession(request)
            : bridge.resumeSession(request);
        await vi.advanceTimersByTimeAsync(49);
        releaseFactory(handle.channel);
        await vi.advanceTimersByTimeAsync(0);
        await expect(outcome).resolves.toMatchObject({
          sessionId: request.sessionId,
        });
        expect(handle.killed).toBe(false);
        expect(
          action === 'load'
            ? handle.agent.loadSessionCalls
            : handle.agent.resumeSessionCalls,
        ).toHaveLength(1);
      } finally {
        releaseFactory(handle.channel);
        await bridge.shutdown();
        vi.useRealTimers();
      }
    },
  );

  it.each(['load', 'resume'] as const)(
    'classifies a non-timeout session/%s preparation rejection as failure',
    async (action) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const event = vi.fn();
      const failure = new Error('engine selection failed');
      const channelFactory = vi.fn(async () => makeChannel().channel);
      const bridge = makeBridge({
        telemetry: recordTelemetry(event),
        executionEngines: {
          legacy: channelFactory,
          managed: channelFactory,
          select: async () => {
            throw failure;
          },
        },
      });
      const request = { sessionId: `rejected-${action}`, workspaceCwd: WS_A };
      try {
        await expect(
          action === 'load'
            ? bridge.loadSession(request)
            : bridge.resumeSession(request),
        ).rejects.toBe(failure);
        expect(channelFactory).not.toHaveBeenCalled();
        expect(event).toHaveBeenCalledWith(
          'session.restore.public_result',
          expect.objectContaining({
            'qwen-code.daemon.session_restore.result': 'failure',
          }),
        );
        expect(stderr).not.toHaveBeenCalledWith(
          expect.stringContaining('phase=preparation'),
        );
        expect(
          event.mock.calls.find(
            ([name]) => name === 'session.restore.public_result',
          )?.[1],
        ).not.toHaveProperty([
          'qwen-code.daemon.session_restore.preparation_stage',
        ]);
      } finally {
        await bridge.shutdown();
        stderr.mockRestore();
      }
    },
  );

  it('expires during engine selection without later starting either engine', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const event = vi.fn();
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
      telemetry: recordTelemetry(event),
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
      expect(event).toHaveBeenCalledWith(
        'session.restore.public_result',
        expect.objectContaining({
          'qwen-code.daemon.session_restore.preparation_stage':
            'engine_selection',
        }),
      );
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          'phase=preparation; stage=engine_selection; decision=release_admission',
        ),
      );
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
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['load', 'resume'] as const)(
    'does not dispatch session/%s after engine selection outlasts the deadline without timer delivery',
    async (action) => {
      vi.useFakeTimers();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const event = vi.fn();
      vi.setSystemTime(0);
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      const handle = makeChannel({
        loadSessionImpl: () => ({
          _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: 'managed' },
        }),
        resumeSessionImpl: () => ({
          _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: 'managed' },
        }),
      });
      let releaseSelection!: (engine: BridgeExecutionEngine) => void;
      const selection = new Promise<BridgeExecutionEngine>((resolve) => {
        releaseSelection = resolve;
      });
      const legacy = vi.fn(async () => makeChannel().channel);
      const managed = vi.fn(async () => handle.channel);
      const bridge = makeBridge({
        sessionRestoreTimeoutMs: 50,
        maxSessions: 1,
        telemetry: recordTelemetry(event),
        executionEngines: { legacy, managed, select: () => selection },
      });
      const request = { sessionId: 'stalled-selection', workspaceCwd: WS_A };
      const restore = () =>
        action === 'load'
          ? bridge.loadSession(request)
          : bridge.resumeSession(request);
      try {
        const outcome = restore().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        clock.mockReturnValue(51);
        vi.setSystemTime(51);
        releaseSelection('managed');
        expect(await outcome).toBeInstanceOf(SessionRestoreTimeoutError);
        expect(event).toHaveBeenCalledWith(
          'session.restore.public_result',
          expect.objectContaining({
            'qwen-code.daemon.session_restore.preparation_stage':
              'engine_selection',
          }),
        );
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining(
            'phase=preparation; stage=engine_selection; decision=release_admission',
          ),
        );
        expect(legacy).not.toHaveBeenCalled();
        expect(managed).not.toHaveBeenCalled();
        await expect(restore()).resolves.toMatchObject({
          sessionId: request.sessionId,
        });
        expect(managed).toHaveBeenCalledOnce();
      } finally {
        releaseSelection('managed');
        await bridge.shutdown();
        clock.mockRestore();
        stderr.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(['load', 'resume'] as const)(
    'keeps the session/%s deadline monotonic across wall-clock corrections',
    async (action) => {
      for (const shift of [-5_000, 5_000]) {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const delayedRestore = () =>
          new Promise<Record<string, never>>((resolve) => {
            setTimeout(() => resolve({}), shift < 0 ? 80 : 20);
          });
        const handle = makeChannel({
          loadSessionImpl: delayedRestore,
          resumeSessionImpl: delayedRestore,
        });
        let releaseFactory!: (channel: AcpChannel) => void;
        const factory = new Promise<AcpChannel>((resolve) => {
          releaseFactory = resolve;
        });
        const bridge = makeBridge({
          initializeTimeoutMs: 200,
          sessionRestoreTimeoutMs: 100,
          channelFactory: () => factory,
        });
        const request = { sessionId: 'clock-correction', workspaceCwd: WS_A };
        const settled = vi.fn();
        const outcome = (
          action === 'load'
            ? bridge.loadSession(request)
            : bridge.resumeSession(request)
        ).catch((error: unknown) => error);
        void outcome.then(() => settled(performance.now()));
        try {
          await vi.advanceTimersByTimeAsync(40);
          vi.setSystemTime(Date.now() + shift);
          releaseFactory(handle.channel);
          await vi.advanceTimersByTimeAsync(shift < 0 ? 59 : 19);
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toHaveBeenCalledWith(shift < 0 ? 100 : 60);
          if (shift < 0) {
            expect(await outcome).toBeInstanceOf(SessionRestoreTimeoutError);
            expect(await outcome).toMatchObject({ timeoutMs: 100 });
          } else {
            expect(await outcome).toMatchObject({
              sessionId: request.sessionId,
            });
          }
        } finally {
          releaseFactory(handle.channel);
          await bridge.shutdown();
          vi.useRealTimers();
        }
      }
    },
  );
});
