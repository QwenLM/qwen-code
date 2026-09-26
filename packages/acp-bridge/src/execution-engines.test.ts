/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  RequestError,
  type NewSessionResponse,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import type {
  BridgeExecutionEngine,
  BridgeOptions,
  BridgeTelemetry,
} from './bridgeOptions.js';
import { SESSION_EXECUTION_ENGINE_META_KEY } from './bridgeOptions.js';
import {
  ACTIVE_WORK_CLOSE_TIMEOUT_MS,
  REQUESTED_SESSION_ID_META_KEY,
  type AcpSessionBridge,
  type BridgeRuntimeStopRequest,
} from './bridgeTypes.js';
import {
  makeBridge,
  makeChannel,
  WS_A,
  type FakeAgentOpts,
} from './internal/testUtils.js';
import {
  ManagedSessionBranchUnsupportedError,
  RequestedSessionIdRejectedError,
  RestoreInProgressError,
  SessionLimitExceededError,
  SessionNotFoundError,
} from './bridgeErrors.js';
import {
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
} from './status.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const receipt = (engine: BridgeExecutionEngine) => ({
  _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: engine },
});

function engineChannel(
  engine: BridgeExecutionEngine,
  opts: FakeAgentOpts = {},
) {
  return makeChannel({
    newSessionImpl: (request, agent) => ({
      sessionId:
        typeof request._meta?.[REQUESTED_SESSION_ID_META_KEY] === 'string'
          ? request._meta[REQUESTED_SESSION_ID_META_KEY]
          : `${engine}-${agent.newSessionCalls.length}`,
      ...receipt(engine),
    }),
    loadSessionImpl: () => receipt(engine),
    resumeSessionImpl: () => receipt(engine),
    extMethodImpl: (method) =>
      method === SERVE_CONTROL_EXT_METHODS.sessionClose ? { closed: true } : {},
    ...opts,
  });
}

/** The error a call throws synchronously, if any. */
function refusal(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The synchronous admission refusal of a new prompt, if any. */
function promptRefusal(
  bridge: AcpSessionBridge,
  sessionId: string,
  text: string,
): unknown {
  try {
    void bridge
      .sendPrompt(sessionId, {
        sessionId,
        prompt: [{ type: 'text', text }],
      })
      .catch(() => undefined);
  } catch (error) {
    return error;
  }
  return undefined;
}

const bridges: AcpSessionBridge[] = [];
function paired(
  options: Partial<BridgeOptions> = {},
  legacy = engineChannel('legacy'),
  managed = engineChannel('managed'),
) {
  let selected: BridgeExecutionEngine = 'managed';
  const legacyFactory = vi.fn(async () => legacy.channel);
  const managedFactory = vi.fn(async () => managed.channel);
  const select = vi.fn<
    NonNullable<BridgeOptions['executionEngines']>['select']
  >(() => selected);
  const bridge = makeBridge({
    sessionScope: 'thread',
    channelIdleTimeoutMs: 60_000,
    executionEngines: {
      legacy: legacyFactory,
      managed: managedFactory,
      select,
    },
    ...options,
  });
  bridges.push(bridge);
  return {
    bridge,
    legacy,
    managed,
    select,
    legacyFactory,
    managedFactory,
    choose: (engine: BridgeExecutionEngine) => {
      selected = engine;
    },
  };
}

// Every start gets a new child whose registry release follows its exit.
function restartable(
  options: Partial<BridgeOptions> = {},
  agents: Partial<Record<BridgeExecutionEngine, FakeAgentOpts>> = {},
) {
  let selected: BridgeExecutionEngine = 'managed';
  const channels: Record<
    BridgeExecutionEngine,
    Array<ReturnType<typeof engineChannel>>
  > = { legacy: [], managed: [] };
  const start = (engine: BridgeExecutionEngine) => async () => {
    const handle = engineChannel(engine, agents[engine]);
    handle.channel.registryReleased = handle.channel.exited.then(
      () => undefined,
    );
    channels[engine].push(handle);
    return handle.channel;
  };
  const bridge = makeBridge({
    sessionScope: 'thread',
    channelIdleTimeoutMs: 60_000,
    executionEngines: {
      legacy: start('legacy'),
      managed: start('managed'),
      select: () => selected,
    },
    ...options,
  });
  bridges.push(bridge);
  return {
    bridge,
    channels,
    choose: (engine: BridgeExecutionEngine) => {
      selected = engine;
    },
  };
}

function stopConfirmation(bridge: AcpSessionBridge): BridgeRuntimeStopRequest {
  const snapshot = bridge.getRuntimeStopSnapshot!();
  return {
    confirmInterruptions: true,
    expectedChannelId: snapshot.channelId!,
    expectedRuntimeEpoch: snapshot.runtimeEpoch,
    expectedStopToken: snapshot.stopToken,
    expectedSessionIds: snapshot.sessions.map((s) => s.sessionId),
  };
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdown()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ACP Bridge execution engines', () => {
  it.each(['prototype', 'stateful object'] as const)(
    'preserves the receiver of a %s selector',
    async (kind) => {
      const legacy = engineChannel('legacy');
      const managed = engineChannel('managed');
      class Router {
        legacy = vi.fn(async () => legacy.channel);
        managed = vi.fn(async () => managed.channel);
        calls = 0;
        #engine = 'managed' as const;
        select() {
          this.calls++;
          return this.#engine;
        }
      }
      const router =
        kind === 'prototype'
          ? new Router()
          : {
              legacy: vi.fn(async () => legacy.channel),
              managed: vi.fn(async () => managed.channel),
              calls: 0,
              select() {
                this.calls++;
                return 'managed' as const;
              },
            };
      const p = paired({ executionEngines: router });
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await p.bridge.loadSession({
        workspaceCwd: WS_A,
        sessionId: 'persisted',
      });
      expect(router.calls).toBe(2);
      expect(managed.agent.newSessionCalls).toHaveLength(1);
      expect(managed.agent.loadSessionCalls).toHaveLength(1);
      expect(router.legacy).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'trailing ', 'control\u0001id', 'x'.repeat(513)])(
    'rejects an unaddressable requested ID before dispatch: %j',
    async (sessionId) => {
      const p = paired();
      const live = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const error = await p.bridge
        .spawnOrAttach({ workspaceCwd: WS_A, sessionId })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RequestedSessionIdRejectedError);
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({
        code: -32602,
        errorKind: 'invalid_session_id',
        sessionId: undefined,
        message: 'Invalid params: Requested session ID is invalid',
      });
      expect((error as RequestError).data).toEqual({
        errorKind: 'invalid_session_id',
      });
      expect(p.managed.agent.newSessionCalls).toHaveLength(1);
      expect(p.managed.agent.extMethodCalls).toHaveLength(0);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'managed-2' });
      expect(p.bridge.getSessionSummary(live.sessionId)).toBeDefined();
    },
  );

  it('rejects an already live requested ID before selecting another engine', async () => {
    const p = paired();
    p.choose('legacy');
    const source = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    const conflict = p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: source.sessionId,
    });
    await expect(conflict).rejects.toBeInstanceOf(
      RequestedSessionIdRejectedError,
    );
    await expect(conflict).rejects.toMatchObject({
      code: -32602,
      errorKind: 'session_id_conflict',
      sessionId: source.sessionId,
      data: { errorKind: 'session_id_conflict', sessionId: source.sessionId },
    });
    expect(p.select).toHaveBeenCalledTimes(1);
    expect(p.managedFactory).not.toHaveBeenCalled();
    expect(p.legacy.agent.extMethodCalls).toHaveLength(0);
    expect(p.bridge.sessionCount).toBe(1);
  });

  it.each(['hot', 'coalesced'] as const)(
    'rejects a branch restored by another engine through %s attach',
    async (mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-branch-engine-'));
      const copying = deferred<void>();
      const copied = deferred<Record<string, unknown>>();
      const loaded = deferred<ReturnType<typeof receipt>>();
      const legacy = engineChannel('legacy', {
        extMethodImpl: (method) => {
          if (method === SERVE_CONTROL_EXT_METHODS.sessionBranch)
            return { newSessionId: 'legacy-branch' };
          if (method === 'qwen/session/sources/copy') {
            copying.resolve();
            return copied.promise;
          }
          return { closed: true };
        },
      });
      const managed = engineChannel('managed', {
        loadSessionImpl: () => loaded.promise,
      });
      const p = paired({ sessionAttachmentsRoot: root }, legacy, managed);
      try {
        p.choose('legacy');
        const source = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
        p.choose('managed');
        const branch = Promise.allSettled([
          p.bridge.branchSession(source.sessionId, {}),
        ]);
        await copying.promise;
        const load = p.bridge.loadSession({
          workspaceCwd: WS_A,
          sessionId: 'legacy-branch',
        });
        await vi.waitFor(() =>
          expect(managed.agent.loadSessionCalls).toHaveLength(1),
        );
        if (mode === 'hot') {
          loaded.resolve(receipt('managed'));
          await load;
        }
        copied.resolve({ warnings: [] });
        if (mode === 'coalesced') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          loaded.resolve(receipt('managed'));
        }
        await load;
        expect(await branch).toMatchObject([
          {
            status: 'rejected',
            reason: {
              message:
                'Branched session execution engine differs from its source',
            },
          },
        ]);
        expect(
          p.bridge
            .getDaemonStatusSnapshot()
            .sessions.find((entry) => entry.sessionId === 'legacy-branch')
            ?.attachCount,
        ).toBe(0);
        expect(managed.agent.extMethodCalls).toHaveLength(0);
        expect(legacy.agent.loadSessionCalls).toHaveLength(0);
      } finally {
        copied.resolve({});
        loaded.resolve(receipt('managed'));
        await p.bridge.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([0, 100])(
    'protects a spawn during slow selection with idle %i',
    async (channelIdleTimeoutMs) => {
      vi.useFakeTimers();
      const p = paired({ channelIdleTimeoutMs });
      p.choose('legacy');
      const first = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const selection = deferred<BridgeExecutionEngine>();
      p.select.mockImplementation(() => selection.promise);
      const spawn = p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await p.bridge.closeSession(first.sessionId);
      await vi.advanceTimersByTimeAsync(150);
      expect(p.legacy.killed).toBe(false);
      selection.resolve('legacy');
      await expect(spawn).resolves.toMatchObject({ sessionId: 'legacy-2' });
      expect(p.legacyFactory).toHaveBeenCalledTimes(1);
      await p.bridge.closeSession('legacy-2');
      await vi.advanceTimersByTimeAsync(100);
      expect(p.legacy.killed).toBe(true);
    },
  );

  it.each(['success', 'rejection', 'timeout'] as const)(
    'rearms consumed idle timers after spawn selection ends in %s',
    async (outcome) => {
      vi.useFakeTimers();
      const p = paired({ channelIdleTimeoutMs: 100, initializeTimeoutMs: 200 });
      p.choose('legacy');
      const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await p.bridge.closeSession(session.sessionId);
      const selection = deferred<BridgeExecutionEngine>();
      p.select.mockImplementation(() => selection.promise);
      const spawn = Promise.allSettled([
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ]);
      await vi.advanceTimersByTimeAsync(150);
      expect(p.legacy.killed).toBe(false);
      if (outcome === 'success') selection.resolve('managed');
      else if (outcome === 'rejection')
        selection.reject(new Error('selection failed'));
      else await vi.advanceTimersByTimeAsync(50);
      expect(await spawn).toMatchObject([
        { status: outcome === 'success' ? 'fulfilled' : 'rejected' },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      expect(p.legacy.killed).toBe(true);
      if (outcome !== 'success') {
        selection.resolve('managed');
        await vi.advanceTimersByTimeAsync(0);
        expect(p.managedFactory).not.toHaveBeenCalled();
      }
    },
  );

  describe.each(['load', 'resume'] as const)(
    '%s failure idle settlement',
    (operation) => {
      it.each(['missing', 'failure'] as const)(
        'reclaims a failed cold channel after another selector releases it: %s',
        async (outcome) => {
          vi.useFakeTimers();
          const selection = deferred<BridgeExecutionEngine>();
          const failed = deferred<ReturnType<typeof receipt>>();
          const legacy = engineChannel('legacy', {
            loadSessionImpl: () => failed.promise,
            resumeSessionImpl: () => failed.promise,
          });
          const p = paired({ channelIdleTimeoutMs: 100 }, legacy);
          p.choose('legacy');
          const request = { workspaceCwd: WS_A, sessionId: 'failed' };
          const restore = Promise.allSettled([
            operation === 'load'
              ? p.bridge.loadSession(request)
              : p.bridge.resumeSession(request),
          ]);
          await vi.advanceTimersByTimeAsync(0);
          p.select.mockImplementation(() => selection.promise);
          const other = p.bridge.loadSession({
            workspaceCwd: WS_A,
            sessionId: 'managed',
          });
          failed.reject(
            outcome === 'missing'
              ? RequestError.resourceNotFound('session:failed')
              : new Error('restore failed'),
          );
          expect(await restore).toMatchObject([{ status: 'rejected' }]);
          await vi.advanceTimersByTimeAsync(150);
          expect(legacy.killed).toBe(false);
          selection.resolve('managed');
          await other;
          await vi.advanceTimersByTimeAsync(100);
          expect(legacy.killed).toBe(true);
          expect(p.managed.killed).toBe(false);
        },
      );
    },
  );

  it.each(['restore', 'rejected create'] as const)(
    'preserves bare Legacy preheat during a Managed %s',
    async (operation) => {
      const response = deferred<ReturnType<typeof receipt>>();
      const managed = engineChannel('managed', {
        loadSessionImpl: () => response.promise,
        ...(operation === 'rejected create'
          ? { newSessionImpl: () => ({ sessionId: 'rejected' }) }
          : {}),
      });
      const p = paired(
        { channelIdleTimeoutMs: 0 },
        engineChannel('legacy'),
        managed,
      );
      await p.bridge.preheat();
      if (operation === 'restore') {
        const restore = p.bridge.loadSession({
          workspaceCwd: WS_A,
          sessionId: 'restored',
        });
        await vi.waitFor(() =>
          expect(managed.agent.loadSessionCalls).toHaveLength(1),
        );
        expect(p.legacy.killed).toBe(false);
        response.resolve(receipt('managed'));
        await restore;
      } else {
        await expect(
          p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ).rejects.toThrow('receipt');
        await vi.waitFor(() => expect(managed.killed).toBe(true));
      }
      expect(p.legacy.killed).toBe(false);
      p.choose('legacy');
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(p.legacyFactory).toHaveBeenCalledTimes(1);
    },
  );

  describe.each([
    {
      label: 'late success without an ID',
      result: receipt('managed'),
      late: true,
    },
    { label: 'late null success', result: null, late: true },
    { label: 'null success', result: null, late: false },
  ])('$label', ({ result, late }) => {
    it.each([2, 3])(
      'retains admission with capacity %i',
      async (maxSessions) => {
        vi.useFakeTimers();
        const response = deferred<NewSessionResponse>();
        const running = deferred<PromptResponse>();
        const released = vi.fn();
        const managed = engineChannel('managed', {
          newSessionImpl: (_request, agent) =>
            agent.newSessionCalls.length === 2
              ? response.promise
              : {
                  sessionId: `managed-${agent.newSessionCalls.length}`,
                  ...receipt('managed'),
                },
          promptImpl: () => running.promise,
        });
        const p = paired(
          {
            maxSessions,
            initializeTimeoutMs: 30,
            freshSessionAdmission: () => ({ release: released }),
          },
          engineChannel('legacy'),
          managed,
        );
        await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
        expect(released).toHaveBeenCalledTimes(1);
        // A running turn keeps the live session, and so the quarantined
        // channel, in place until it settles.
        const turn = p.bridge.sendPrompt('managed-1', {
          sessionId: 'managed-1',
          prompt: [{ type: 'text', text: 'still live' }],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(managed.agent.promptCalls).toHaveLength(1);
        const spawn = Promise.allSettled([
          p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ]);
        if (late) {
          await vi.advanceTimersByTimeAsync(30);
          expect(await spawn).toMatchObject([
            { status: 'rejected', reason: { name: 'BridgeTimeoutError' } },
          ]);
        }
        response.resolve(result as unknown as NewSessionResponse);
        await vi.advanceTimersByTimeAsync(0);
        await expect(
          p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ).rejects.toMatchObject(
          maxSessions === 2
            ? { name: 'SessionLimitExceededError' }
            : { reason: 'new_session_cleanup_failed' },
        );
        if (!late) {
          expect(await spawn).toMatchObject([
            {
              status: 'rejected',
              reason: {
                message:
                  'ACP returned an invalid or already reserved session ID',
              },
            },
          ]);
        }
        expect(managed.agent.newSessionCalls).toHaveLength(2);
        expect(managed.killed).toBe(false);
        expect(managed.agent.extMethodCalls).toHaveLength(0);
        expect(promptRefusal(p.bridge, 'managed-1', 'refused')).toMatchObject({
          reason: 'new_session_cleanup_failed',
        });
        expect(managed.agent.promptCalls).toHaveLength(1);
        // A rejected third attempt can reserve and release at capacity 3.
        expect(released).toHaveBeenCalledTimes(maxSessions === 2 ? 1 : 2);
        running.resolve({ stopReason: 'end_turn' });
        await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' });
        await flushWithoutTime();
        expect(managed.killed).toBe(true);
        expect(released).toHaveBeenCalledTimes(maxSessions === 2 ? 2 : 3);
      },
    );
  });

  it.each([false, true])(
    'preserves single-factory null-response cleanup with a live sibling: %s',
    async (sibling) => {
      const legacy = engineChannel('legacy', {
        newSessionImpl: (_request, agent) =>
          agent.newSessionCalls.length === (sibling ? 2 : 1)
            ? (null as unknown as NewSessionResponse)
            : { sessionId: `legacy-${agent.newSessionCalls.length}` },
      });
      const bridge = makeBridge({
        channelFactory: async () => legacy.channel,
        sessionScope: 'thread',
      });
      bridges.push(bridge);
      if (sibling) await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toThrow();
      expect(legacy.killed).toBe(!sibling);
      if (sibling) {
        await expect(
          bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ).resolves.toMatchObject({ sessionId: 'legacy-3' });
      }
    },
  );

  it('rejects ambiguous construction before starting a channel', () => {
    const factory = vi.fn();
    expect(() =>
      makeBridge({
        channelFactory: factory,
        executionEngines: {
          legacy: factory,
          managed: factory,
          select: () => 'legacy',
        },
      }),
    ).toThrow('mutually exclusive');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'managed'] as const)(
    'applies startup configuration only to a fresh session on %s',
    async (engine) => {
      const p = paired({ sessionScope: 'single' });
      p.choose(engine === 'legacy' ? 'managed' : 'legacy');
      const existing = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const startupConfig = {
        modelServiceId: 'configured-model',
        reasoningEffort: 'high' as const,
      };
      const setters = {
        legacy: vi.spyOn(p.legacy.agent, 'setSessionConfigOption'),
        managed: vi.spyOn(p.managed.agent, 'setSessionConfigOption'),
      };
      setters[engine].mockResolvedValue({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: startupConfig.modelServiceId,
            options: [{ value: 'configured-model', name: 'Configured' }],
          },
          {
            id: 'reasoning_effort',
            name: 'Reasoning',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
      });
      p.choose(engine);
      const session = await p.bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        startupConfig,
      });
      expect(session).toMatchObject({
        sessionId: `${engine}-1`,
        attached: false,
        startupConfigApplied: {
          ...startupConfig,
          effectiveReasoning: { state: 'enabled', effort: 'high' },
        },
      });
      expect(setters[engine].mock.calls.map(([request]) => request)).toEqual([
        {
          sessionId: session.sessionId,
          configId: 'model',
          value: startupConfig.modelServiceId,
        },
        {
          sessionId: session.sessionId,
          configId: 'reasoning_effort',
          value: 'high',
        },
      ]);
      expect(
        setters[engine === 'legacy' ? 'managed' : 'legacy'],
      ).not.toHaveBeenCalled();
      expect(p.bridge.getSessionSummary(existing.sessionId)).toBeDefined();
    },
  );

  it('coalesces each engine independently and routes prompts through the bound channel', async () => {
    const p = paired();
    const managed = await Promise.all([
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ]);
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    for (const session of [...managed, legacy]) {
      await p.bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      });
    }
    expect(p.managedFactory).toHaveBeenCalledTimes(1);
    expect(p.legacyFactory).toHaveBeenCalledTimes(1);
    expect(p.managed.agent.promptCalls.map((call) => call.sessionId)).toEqual(
      managed.map((s) => s.sessionId),
    );
    expect(p.legacy.agent.promptCalls.map((call) => call.sessionId)).toEqual([
      legacy.sessionId,
    ]);
    expect(p.bridge.sessionCount).toBe(3);
    await p.bridge.shutdown();
    expect(p.legacy.killed).toBe(true);
    expect(p.managed.killed).toBe(true);
  });

  it('keeps hot attach on its existing owner after the selector changes', async () => {
    const p = paired({ sessionScope: 'single' });
    const first = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('legacy');
    const attached = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const restored = await p.bridge.loadSession({
      workspaceCwd: WS_A,
      sessionId: first.sessionId,
    });
    expect(attached.sessionId).toBe(first.sessionId);
    expect(restored.attached).toBe(true);
    expect(p.select).toHaveBeenCalledTimes(1);
    expect(p.legacyFactory).not.toHaveBeenCalled();
  });

  it.each(['load', 'resume'] as const)(
    'uses the server-selected durable owner for cold %s',
    async (operation) => {
      const p = paired();
      const request = { workspaceCwd: WS_A, sessionId: 'persisted-managed' };
      const session =
        operation === 'load'
          ? await p.bridge.loadSession(request)
          : await p.bridge.resumeSession(request);
      expect(p.select).toHaveBeenCalledWith({
        operation,
        request,
        daemonOwnedStandalone: false,
      });
      expect(session.sessionId).toBe(request.sessionId);
      expect(
        p.managed.agent[
          operation === 'load' ? 'loadSessionCalls' : 'resumeSessionCalls'
        ],
      ).toHaveLength(1);
      expect(p.legacyFactory).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'Managed'])(
    'rejects invalid selector result %j without starting either engine',
    async (selected) => {
      const p = paired();
      p.select.mockReturnValue(selected as BridgeExecutionEngine);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toThrow('Invalid execution engine selection');
      expect(p.legacyFactory).not.toHaveBeenCalled();
      expect(p.managedFactory).not.toHaveBeenCalled();
    },
  );

  it.each(['load', 'resume'] as const)(
    'isolates pending %s replay from the other engine',
    async (operation) => {
      const restored = deferred<ReturnType<typeof receipt>>();
      const managed = engineChannel('managed', {
        loadSessionImpl: () => restored.promise,
        resumeSessionImpl: () => restored.promise,
      });
      const p = paired({}, engineChannel('legacy'), managed);
      p.choose('legacy');
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      p.choose('managed');
      const sessionId = 'persisted-managed';
      const loading =
        operation === 'load'
          ? p.bridge.loadSession({ workspaceCwd: WS_A, sessionId })
          : p.bridge.resumeSession({ workspaceCwd: WS_A, sessionId });
      await vi.waitFor(() =>
        expect(
          managed.agent[
            operation === 'load' ? 'loadSessionCalls' : 'resumeSessionCalls'
          ],
        ).toHaveLength(1),
      );
      try {
        for (const [channel, text] of [
          [p.legacy, 'foreign replay'],
          [managed, 'owner replay'],
        ] as const) {
          await channel.agentConnection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          });
        }
      } finally {
        restored.resolve(receipt('managed'));
      }
      await loading;
      const iterator = p.bridge
        .subscribeEvents(sessionId, { lastEventId: 0 })
        [Symbol.asyncIterator]();
      try {
        expect((await iterator.next()).value).toMatchObject({
          type: 'session_update',
          data: { update: { content: { text: 'owner replay' } } },
        });
        expect(p.bridge.getSessionLastEventId(sessionId)).toBe(1);
      } finally {
        await iterator.return?.();
      }
    },
  );

  it('ignores generation events from a foreign connection', async () => {
    const completion = deferred<Record<string, unknown>>();
    const managed = engineChannel('managed', {
      extMethodImpl: () => completion.promise,
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const stream = p.bridge.generateSessionContent!(
      session.sessionId,
      'generate',
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls).toHaveLength(1),
    );
    const requestId = managed.agent.extMethodCalls[0].params['requestId'];
    try {
      for (const [channel, model] of [
        [p.legacy, 'foreign model'],
        [managed, 'owner model'],
      ] as const) {
        await channel.agentConnection.extNotification(
          'qwen/notify/session/generation/event',
          {
            v: 1,
            sessionId: session.sessionId,
            requestId,
            event: { type: 'started', model, modelSource: 'main' },
          },
        );
      }
    } finally {
      completion.resolve({ model: 'owner model', modelSource: 'main' });
    }
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([
      { type: 'started', requestId, model: 'owner model', modelSource: 'main' },
      { type: 'done', requestId, model: 'owner model', modelSource: 'main' },
    ]);
  });

  it('reserves a generated ID while a rejected receipt is being cleaned up', async () => {
    const closed = deferred<Record<string, unknown>>();
    const managed = engineChannel('managed', {
      newSessionImpl: () => ({ sessionId: 'generated-rejected' }),
      extMethodImpl: () => closed.promise,
    });
    const p = paired({}, engineChannel('legacy'), managed);
    try {
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toThrow('receipt');
      p.choose('legacy');
      await expect(
        p.bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          sessionId: 'generated-rejected',
        }),
      ).rejects.toMatchObject({
        reason: 'awaiting_abandoned_cleanup',
        message: expect.not.stringContaining('timed out'),
      });
      expect(p.legacyFactory).not.toHaveBeenCalled();
    } finally {
      closed.resolve({ closed: true });
    }
  });

  it('reserves shared capacity and IDs before awaiting selection', async () => {
    const selection = deferred<BridgeExecutionEngine>();
    const managed = engineChannel('managed');
    const legacy = vi.fn();
    const bridge = makeBridge({
      maxSessions: 1,
      sessionScope: 'thread',
      executionEngines: {
        managed: async () => managed.channel,
        legacy,
        select: () => selection.promise,
      },
    });
    bridges.push(bridge);
    const first = bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'reserved',
    });
    await expect(
      bridge.loadSession({ workspaceCwd: WS_A, sessionId: 'reserved' }),
    ).rejects.toMatchObject({ activeAction: 'spawn' });
    await expect(
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toBeInstanceOf(SessionLimitExceededError);
    expect(managed.agent.newSessionCalls).toHaveLength(0);
    selection.resolve('managed');
    expect((await first).sessionId).toBe('reserved');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('tracks reentrant selector calls and shutdown before any factory starts', async () => {
    const selection = deferred<BridgeExecutionEngine>();
    const factory = vi.fn();
    let reentrant: Promise<Array<PromiseSettledResult<unknown>>> | undefined;
    const bridge = makeBridge({
      maxSessions: 1,
      sessionScope: 'thread',
      executionEngines: {
        managed: factory,
        legacy: factory,
        select: () => {
          // Settled here and asserted below: a failed expectation thrown
          // inside the selector would only reject the outer spawn.
          reentrant ??= Promise.allSettled([
            bridge.spawnOrAttach({ workspaceCwd: WS_A }),
          ]);
          return selection.promise;
        },
      },
    });
    bridges.push(bridge);
    const spawn = bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const result = Promise.allSettled([spawn]);
    await vi.waitFor(() => expect(reentrant).toBeDefined());
    expect(await reentrant).toEqual([
      {
        status: 'rejected',
        reason: expect.any(SessionLimitExceededError),
      },
    ]);
    const shutdown = bridge.shutdown();
    selection.resolve('managed');
    expect((await result)[0].status).toBe('rejected');
    await shutdown;
    expect(factory).not.toHaveBeenCalled();
  });

  it('passes an immutable request snapshot to selection', async () => {
    const p = paired();
    const request = {
      workspaceCwd: WS_A,
      sessionId: 'original',
      worktree: { path: WS_A, slug: 'original', branch: 'original' },
    };
    const spawn = p.bridge.spawnOrAttach(request);
    request.sessionId = 'mutated';
    request.worktree.slug = 'mutated';
    await spawn;
    const selected = p.select.mock.calls[0] as unknown as [
      { request: typeof request },
    ];
    expect(selected[0].request.sessionId).toBe('original');
    expect(selected[0].request.worktree.slug).toBe('original');
    expect(Object.isFrozen(selected[0].request)).toBe(true);
  });

  it('does not fall back when Managed initialization fails', async () => {
    const p = paired(
      {},
      engineChannel('legacy'),
      engineChannel('managed', {
        initializeThrows: new Error('managed unavailable'),
      }),
    );
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('Internal error');
    expect(p.legacyFactory).not.toHaveBeenCalled();
    expect(p.managed.killed).toBe(true);
  });

  it.each(['spawn', 'load', 'resume'] as const)(
    'fails closed before starting either engine when %s selection fails',
    async (operation) => {
      const factory = vi.fn();
      const bridge = makeBridge({
        executionEngines: {
          legacy: factory,
          managed: factory,
          select: () => {
            throw new Error('owner unavailable');
          },
        },
      });
      bridges.push(bridge);
      const request = { workspaceCwd: WS_A, sessionId: 'unknown-owner' };
      await expect(
        operation === 'spawn'
          ? bridge.spawnOrAttach(request)
          : operation === 'load'
            ? bridge.loadSession(request)
            : bridge.resumeSession(request),
      ).rejects.toThrow('owner unavailable');
      expect(factory).not.toHaveBeenCalled();
      expect(bridge.sessionCount).toBe(0);
    },
  );

  it.each([undefined, 'legacy', 'invalid'])(
    'rejects a Managed creation receipt %s and closes only its unregistered state',
    async (engine) => {
      const managed = engineChannel('managed', {
        newSessionImpl: () => ({
          sessionId: 'rejected',
          ...(engine
            ? { _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: engine } }
            : {}),
        }),
      });
      const p = paired({}, engineChannel('legacy'), managed);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toThrow('execution engine receipt');
      await vi.waitFor(() =>
        expect(managed.agent.extMethodCalls).toContainEqual({
          method: SERVE_CONTROL_EXT_METHODS.sessionClose,
          params: expect.objectContaining({ sessionId: 'rejected' }),
        }),
      );
      expect(p.bridge.sessionCount).toBe(0);
      expect(p.legacyFactory).not.toHaveBeenCalled();
    },
  );

  it('holds admission until rejected-session cleanup acknowledges physical close', async () => {
    const closed = deferred<Record<string, unknown>>();
    const release = vi.fn();
    const managed = engineChannel('managed', {
      newSessionImpl: () => ({ sessionId: 'rejected' }),
      extMethodImpl: () => closed.promise,
    });
    const p = paired(
      { maxSessions: 1, freshSessionAdmission: () => ({ release }) },
      engineChannel('legacy'),
      managed,
    );
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionId: 'rejected' }),
    ).rejects.toThrow('receipt');
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls).toHaveLength(1),
    );
    expect(release).not.toHaveBeenCalled();
    p.choose('legacy');
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toBeInstanceOf(SessionLimitExceededError);
    closed.resolve({ closed: true });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).resolves.toMatchObject({ sessionId: 'legacy-1' });
  });

  it.each(['load', 'resume'] as const)(
    'cleans a rejected %s receipt without releasing its ID early',
    async (operation) => {
      const closed = deferred<Record<string, unknown>>();
      const managed = engineChannel('managed', {
        loadSessionImpl: () => ({}),
        resumeSessionImpl: () => ({}),
        extMethodImpl: () => closed.promise,
      });
      const p = paired({}, engineChannel('legacy'), managed);
      const request = { workspaceCwd: WS_A, sessionId: 'restore-rejected' };
      await expect(
        operation === 'load'
          ? p.bridge.loadSession(request)
          : p.bridge.resumeSession(request),
      ).rejects.toThrow('receipt');
      await expect(p.bridge.spawnOrAttach(request)).rejects.toMatchObject({
        reason: 'awaiting_abandoned_cleanup',
      });
      closed.resolve({ closed: true });
      await vi.waitFor(() =>
        expect(managed.agent.extMethodCalls).toHaveLength(1),
      );
      expect(p.bridge.sessionCount).toBe(0);
      expect(p.legacyFactory).not.toHaveBeenCalled();
    },
  );

  it('preserves the real owner when another channel returns the same ID', async () => {
    const p = paired(
      {},
      engineChannel('legacy'),
      engineChannel('managed', {
        newSessionImpl: () => ({
          sessionId: 'legacy-1',
          ...receipt('managed'),
        }),
      }),
    );
    p.choose('legacy');
    const original = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('reserved session ID');
    await vi.waitFor(() =>
      expect(p.managed.agent.extMethodCalls).toHaveLength(1),
    );
    expect(p.legacy.agent.extMethodCalls).toHaveLength(0);
    expect(p.bridge.sessionCount).toBe(1);
    await p.bridge.sendPrompt(original.sessionId, {
      sessionId: original.sessionId,
      prompt: [{ type: 'text', text: 'still here' }],
    });
    expect(p.legacy.agent.promptCalls).toHaveLength(1);
  });

  it.each([false, true])(
    'fences duplicate-ID cleanup after the other engine owner closes (late=%s)',
    async (isLate) => {
      vi.useFakeTimers();
      const late = deferred<NewSessionResponse>();
      const closed = deferred<Record<string, unknown>>();
      const managed = engineChannel('managed', {
        newSessionImpl: (_request, agent) =>
          isLate && agent.newSessionCalls.length === 1
            ? { sessionId: 'managed-sibling', ...receipt('managed') }
            : isLate && agent.newSessionCalls.length === 2
              ? late.promise
              : { sessionId: 'shared-id', ...receipt('managed') },
        extMethodImpl: () => closed.promise,
      });
      const p = paired(
        { initializeTimeoutMs: 30 },
        engineChannel('legacy'),
        managed,
      );
      p.choose('legacy');
      const original = await p.bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionId: 'shared-id',
      });
      p.choose('managed');
      try {
        if (isLate) {
          await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
          await Promise.all([
            expect(
              p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
            ).rejects.toThrow('timed out'),
            vi.advanceTimersByTimeAsync(30),
          ]);
          late.resolve({ sessionId: 'shared-id', ...receipt('managed') });
        } else {
          await expect(
            p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
          ).rejects.toThrow('reserved session ID');
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(managed.agent.extMethodCalls).toContainEqual({
          method: SERVE_CONTROL_EXT_METHODS.sessionClose,
          params: expect.objectContaining({ sessionId: 'shared-id' }),
        });
        await p.bridge.closeSession(original.sessionId);
        const createsBeforeRetry = managed.agent.newSessionCalls.length;
        await expect(
          p.bridge.spawnOrAttach({
            workspaceCwd: WS_A,
            sessionId: 'shared-id',
          }),
        ).rejects.toMatchObject({ reason: 'awaiting_abandoned_cleanup' });
        expect(managed.agent.newSessionCalls).toHaveLength(createsBeforeRetry);
      } finally {
        closed.resolve({ closed: true });
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it('retains a rejected restore reservation until its quarantined channel exits', async () => {
    const release = vi.fn();
    const running = deferred<PromptResponse>();
    const managed = engineChannel('managed', {
      loadSessionImpl: () => ({}),
      extMethodImpl: (method, params) => ({
        closed:
          method === SERVE_CONTROL_EXT_METHODS.sessionClose &&
          params['sessionId'] === 'managed-1',
      }),
      promptImpl: () => running.promise,
    });
    const p = paired(
      { freshSessionAdmission: () => ({ release }) },
      engineChannel('legacy'),
      managed,
    );
    const live = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const turn = p.bridge.sendPrompt(live.sessionId, {
      sessionId: live.sessionId,
      prompt: [{ type: 'text', text: 'keep the channel busy' }],
    });
    await vi.waitFor(() => expect(managed.agent.promptCalls).toHaveLength(1));
    release.mockClear();
    const request = { workspaceCwd: WS_A, sessionId: 'rejected-restore' };
    await expect(p.bridge.loadSession(request)).rejects.toThrow('receipt');
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls).toHaveLength(1),
    );
    expect(release).not.toHaveBeenCalled();
    await expect(p.bridge.spawnOrAttach(request)).rejects.toMatchObject({
      reason: 'awaiting_abandoned_cleanup',
    });
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(release).toHaveBeenCalledTimes(1);
    expect(managed.killed).toBe(false);
    // The settled session is closed and the drained channel retires.
    running.resolve({ stopReason: 'end_turn' });
    await turn;
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    expect(managed.killed).toBe(true);
    expect(() => p.bridge.getSessionSummary(live.sessionId)).toThrow(
      'No session',
    );
    expect(p.legacy.killed).toBe(false);
  });

  it('quarantines an unaddressable success without closing another live session', async () => {
    const running = deferred<PromptResponse>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) => ({
        sessionId: agent.newSessionCalls.length === 1 ? 'valid' : '',
        ...receipt('managed'),
      }),
      promptImpl: () => running.promise,
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const valid = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const turn = p.bridge.sendPrompt(valid.sessionId, {
      sessionId: valid.sessionId,
      prompt: [{ type: 'text', text: 'running' }],
    });
    await vi.waitFor(() => expect(managed.agent.promptCalls).toHaveLength(1));
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    expect(managed.killed).toBe(false);
    expect(managed.agent.extMethodCalls).toHaveLength(0);
    p.choose('legacy');
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).resolves.toMatchObject({ sessionId: 'legacy-1' });
    running.resolve({ stopReason: 'end_turn' });
    await turn;
    await vi.waitFor(() => expect(managed.killed).toBe(true));
    expect(p.legacy.killed).toBe(false);
  });

  it('rejects foreign-channel permission requests without creating a vote', async () => {
    const p = paired();
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const response = await p.legacy.agentConnection.requestPermission({
      sessionId: managed.sessionId,
      toolCall: { toolCallId: 'forged', title: 'forged' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    });
    expect(response.outcome.outcome).toBe('cancelled');
    expect(p.bridge.pendingPermissionCount).toBe(0);
  });

  it('reports aggregate liveness and workspace control separately', async () => {
    const ready = deferred<void>();
    const p = paired(
      {},
      engineChannel('legacy', {
        initializeImpl: async () => {
          await ready.promise;
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {},
            authMethods: [],
          };
        },
      }),
    );
    const lifecycle = () => p.bridge.getWorkspaceRuntimeLifecycleSnapshot!();
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(p.bridge.isChannelLive()).toBe(true);
    expect(p.bridge.getDaemonStatusSnapshot().channelLive).toBe(true);
    expect(p.bridge.isWorkspaceControlLive!()).toBe(false);
    expect(lifecycle()).toMatchObject({
      state: 'active',
      runtimeLive: true,
      workspaceControl: 'cold',
    });

    const preheat = p.bridge.preheat();
    await vi.waitFor(() =>
      expect(p.legacy.agent.initializeCalls).toHaveLength(1),
    );
    expect(lifecycle().workspaceControl).toBe('starting');
    ready.resolve();
    await preheat;
    expect(p.bridge.isWorkspaceControlLive!()).toBe(true);
    expect(lifecycle().workspaceControl).toBe('live');

    p.legacy.crash();
    await vi.waitFor(() => expect(lifecycle().workspaceControl).toBe('cold'));
    expect(p.bridge.isWorkspaceControlLive!()).toBe(false);
    expect(lifecycle().runtimeLive).toBe(true);
  });

  it('keeps the workspace-control epoch while Managed channels come and go', async () => {
    const p = restartable(
      {},
      {
        legacy: {
          extMethodImpl: (method) =>
            method === SERVE_STATUS_EXT_METHODS.workspaceSkills
              ? { v: 1, workspaceCwd: WS_A, initialized: true, skills: [] }
              : {},
        },
      },
    );
    const lifecycle = () => p.bridge.getWorkspaceRuntimeLifecycleSnapshot!();
    const skillsEpoch = async () =>
      (
        await p.bridge.queryWorkspaceStatus<{ runtimeEpoch?: number }>(
          SERVE_STATUS_EXT_METHODS.workspaceSkills,
          () => ({}),
        )
      ).runtimeEpoch;
    await p.bridge.preheat();
    const legacyEpoch = lifecycle().runtimeEpoch;
    expect(await skillsEpoch()).toBe(legacyEpoch);

    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const stop = p.bridge.getRuntimeStopSnapshot!();
    expect(stop.channels.map((c) => c.executionEngine)).toEqual([
      'legacy',
      'managed',
    ]);
    expect(stop.channels[0].runtimeEpoch).toBe(legacyEpoch);
    expect(stop.runtimeEpoch).toBe(stop.channels[1].runtimeEpoch);
    expect(stop.runtimeEpoch).toBeGreaterThan(legacyEpoch);
    expect(lifecycle()).toMatchObject({
      runtimeEpoch: legacyEpoch,
      workspaceControl: 'live',
    });
    expect(await skillsEpoch()).toBe(legacyEpoch);

    p.channels.managed[0].crash();
    await vi.waitFor(() => expect(p.bridge.sessionCount).toBe(0));
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(p.channels.managed).toHaveLength(2);
    expect(lifecycle().runtimeEpoch).toBe(legacyEpoch);
    expect(await skillsEpoch()).toBe(legacyEpoch);

    p.channels.legacy[0].crash();
    await vi.waitFor(() => expect(lifecycle().workspaceControl).toBe('cold'));
    expect(lifecycle().runtimeLive).toBe(true);
    await p.bridge.preheat();
    const nextLegacyEpoch = lifecycle().runtimeEpoch;
    expect(nextLegacyEpoch).toBeGreaterThan(
      p.bridge.getRuntimeStopSnapshot!().channels[1].runtimeEpoch,
    );
    expect(await skillsEpoch()).toBe(nextLegacyEpoch);
  });

  it('stamps an idle candidate with its own channel epoch', async () => {
    const p = restartable();
    await p.bridge.preheat();
    const legacyEpoch =
      p.bridge.getWorkspaceRuntimeLifecycleSnapshot!().runtimeEpoch;
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(managed.sessionId);
    const candidate = p.bridge.getIdleChannelCandidate!();
    expect(candidate).toMatchObject({ runtimeEpoch: legacyEpoch });
    expect(await p.bridge.reclaimIdleChannel!(candidate!)).toBe(true);
    expect(p.channels.legacy[0].killed).toBe(true);
    expect(p.channels.managed[0].killed).toBe(false);
  });

  it('stops every live channel with one confirmation', async () => {
    const p = restartable();
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const snapshot = p.bridge.getRuntimeStopSnapshot!();
    expect(snapshot.blockedReasons).toEqual([]);
    expect(snapshot.channels).toEqual([
      {
        channelId: snapshot.channelId,
        runtimeEpoch: expect.any(Number),
        executionEngine: 'legacy',
      },
      {
        channelId: expect.any(String),
        runtimeEpoch: snapshot.runtimeEpoch,
        executionEngine: 'managed',
      },
    ]);
    const request = stopConfirmation(p.bridge);
    const result = await p.bridge.stopWorkspaceRuntime!(request);
    expect(result).toMatchObject({
      state: 'stopped',
      stopped: true,
      released: true,
      channelId: snapshot.channelId,
      runtimeEpoch: snapshot.runtimeEpoch,
      channels: snapshot.channels,
      closedSessionIds: [legacy.sessionId, managed.sessionId].sort(),
      remainingSessionIds: [],
    });
    for (const [engine, sessionId] of [
      ['legacy', legacy.sessionId],
      ['managed', managed.sessionId],
    ] as const) {
      const [handle] = p.channels[engine];
      expect(handle.killed).toBe(true);
      expect(handle.agent.extMethodCalls).toContainEqual({
        method: SERVE_CONTROL_EXT_METHODS.sessionClose,
        params: expect.objectContaining({ sessionId }),
      });
    }
    expect(await p.bridge.stopWorkspaceRuntime!(request)).toEqual(result);
    expect(p.bridge.getWorkspaceRuntimeLifecycleSnapshot!()).toMatchObject({
      runtimeLive: false,
      workspaceControl: 'cold',
    });
  });

  it('stales a stop confirmation when a channel starts after the preview', async () => {
    const p = restartable();
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const request = stopConfirmation(p.bridge);
    p.choose('managed');
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(managed.sessionId);
    expect(p.bridge.getRuntimeStopSnapshot!().sessions).toHaveLength(1);
    expect(() => p.bridge.stopWorkspaceRuntime!(request)).toThrow('changed');
    expect(p.channels.legacy[0].killed).toBe(false);
    expect(p.channels.managed[0].killed).toBe(false);
  });

  it('keeps a confirmation after an older channel without sessions exits', async () => {
    const p = restartable();
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(managed.sessionId);
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const request = stopConfirmation(p.bridge);
    p.channels.managed[0].crash();
    await vi.waitFor(() =>
      expect(p.bridge.getRuntimeStopSnapshot!().channels).toHaveLength(1),
    );
    await expect(
      p.bridge.stopWorkspaceRuntime!(request),
    ).resolves.toMatchObject({
      state: 'stopped',
      closedSessionIds: [legacy.sessionId],
      channels: [{ executionEngine: 'legacy' }],
    });
  });

  it('reports only the sessions of an exited channel as interrupted', async () => {
    const p: ReturnType<typeof restartable> = restartable(
      {},
      {
        managed: {
          extMethodImpl: async (method) => {
            if (method !== SERVE_CONTROL_EXT_METHODS.sessionClose) return {};
            p.channels.managed[0].crash();
            await new Promise((resolve) => setTimeout(resolve, 0));
            throw new RequestError(-32603, 'child exited');
          },
        },
      },
    );
    const managed = await p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'a-managed',
    });
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'z-legacy',
    });
    const managedEvents = p.bridge.subscribeEvents(managed.sessionId);
    const result = await p.bridge.stopWorkspaceRuntime!(
      stopConfirmation(p.bridge),
    );
    expect(result).toMatchObject({
      state: 'incomplete',
      stopped: false,
      closedSessionIds: [],
      interruptedSessionIds: [managed.sessionId],
      remainingSessionIds: [legacy.sessionId],
    });
    expect(p.channels.legacy[0].killed).toBe(false);
    expect(p.bridge.getSessionSummary(legacy.sessionId)).toBeDefined();
    const events = [];
    for await (const event of managedEvents) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session_closed',
        data: expect.objectContaining({ cause: 'workspace_runtime_stop' }),
      }),
    );
  });

  it('counts sessions lost while an exited channel releases as interrupted', async () => {
    const release = deferred<void>();
    const p: ReturnType<typeof restartable> = restartable(
      {},
      {
        managed: {
          extMethodImpl: async (method) => {
            if (method !== SERVE_CONTROL_EXT_METHODS.sessionClose) return {};
            p.channels.managed[0].crash();
            await new Promise((resolve) => setTimeout(resolve, 0));
            throw new RequestError(-32603, 'child exited');
          },
        },
      },
    );
    const managed = await p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'a-managed',
    });
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'z-legacy',
    });
    p.channels.managed[0].channel.registryReleased = release.promise;
    const stop = p.bridge.stopWorkspaceRuntime!(stopConfirmation(p.bridge));
    await vi.waitFor(() =>
      expect(p.bridge.getRuntimeStopSnapshot!().lastStop?.error).toBeDefined(),
    );
    p.channels.legacy[0].crash();
    await vi.waitFor(() => expect(p.bridge.sessionCount).toBe(0));
    release.resolve();
    await expect(stop).resolves.toMatchObject({
      state: 'incomplete',
      closedSessionIds: [],
      interruptedSessionIds: [managed.sessionId, legacy.sessionId],
      remainingSessionIds: [],
    });
  });

  it('reports a paired stop released only after every child is released', async () => {
    const p = restartable();
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const release = deferred<void>();
    p.channels.managed[0].channel.registryReleased = release.promise;
    const stop = p.bridge.stopWorkspaceRuntime!(stopConfirmation(p.bridge));
    await vi.waitFor(() => {
      expect(p.channels.legacy[0].killed).toBe(true);
      expect(p.channels.managed[0].killed).toBe(true);
    });
    expect(p.bridge.getRuntimeStopSnapshot!().lastStop).toMatchObject({
      state: 'stopping',
      released: false,
    });
    expect(p.bridge.getWorkspaceRuntimeLifecycleSnapshot!()).toMatchObject({
      state: 'stopping',
      workspaceControl: 'stopping',
    });
    release.resolve();
    await expect(stop).resolves.toMatchObject({
      state: 'stopped',
      released: true,
    });
  });

  it('returns channels an incomplete stop left running to the idle policy', async () => {
    const p = restartable(
      { channelIdleTimeoutMs: 100 },
      {
        legacy: {
          extMethodImpl: async (method) => {
            if (method === SERVE_CONTROL_EXT_METHODS.sessionClose) {
              throw new RequestError(-32603, 'flush refused');
            }
            return {};
          },
        },
      },
    );
    const managed = await p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'a-managed',
    });
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'z-legacy',
    });
    await expect(
      p.bridge.stopWorkspaceRuntime!(stopConfirmation(p.bridge)),
    ).resolves.toMatchObject({
      state: 'incomplete',
      closedSessionIds: [managed.sessionId],
      remainingSessionIds: [legacy.sessionId],
    });
    await vi.waitFor(() => expect(p.channels.managed[0].killed).toBe(true));
    expect(p.channels.legacy[0].killed).toBe(false);
  });

  it('reports a dying Legacy channel as stopping workspace control', async () => {
    const p = restartable({ channelIdleTimeoutMs: 0 });
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const [legacyChannel] = p.channels.legacy;
    // Terminate returns while the child has not exited yet.
    legacyChannel.channel.kill = async () => {
      legacyChannel.killed = true;
    };
    p.choose('managed');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(legacy.sessionId);
    expect(legacyChannel.killed).toBe(true);
    expect(p.bridge.getWorkspaceRuntimeLifecycleSnapshot!()).toMatchObject({
      runtimeLive: true,
      workspaceControl: 'stopping',
    });
    legacyChannel.crash();
    await vi.waitFor(() =>
      expect(
        p.bridge.getWorkspaceRuntimeLifecycleSnapshot!().workspaceControl,
      ).toBe('cold'),
    );
  });

  it('ignores workspace generation events from a foreign connection', async () => {
    const completion = deferred<Record<string, unknown>>();
    const legacy = engineChannel('legacy', {
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.workspaceGenerationStart
          ? completion.promise
          : {},
    });
    const p = paired({}, legacy);
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const stream = p.bridge.generateWorkspaceContent!(
      'generate',
      new AbortController().signal,
      undefined,
    );
    await vi.waitFor(() => expect(legacy.agent.extMethodCalls).toHaveLength(1));
    const requestId = legacy.agent.extMethodCalls[0].params['requestId'];
    try {
      for (const [channel, text] of [
        [p.managed, 'FOREIGN'],
        [legacy, 'OWNER'],
      ] as const) {
        await channel.agentConnection.extNotification(
          'qwen/notify/workspace/generation/event',
          { v: 1, requestId, event: { type: 'delta', seq: 0, text } },
        );
      }
    } finally {
      completion.resolve({ model: 'owner model', modelSource: 'main' });
    }
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([
      { type: 'delta', requestId, seq: 0, text: 'OWNER' },
      { type: 'done', requestId, model: 'owner model', modelSource: 'main' },
    ]);
  });

  it('does not report a tracked Managed channel live before its handshake completes', async () => {
    const ready = deferred<void>();
    const p = paired(
      {},
      engineChannel('legacy'),
      engineChannel('managed', {
        initializeImpl: async () => {
          await ready.promise;
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {},
            authMethods: [],
          };
        },
      }),
    );
    const starting = p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    try {
      await vi.waitFor(() =>
        expect(p.managed.agent.initializeCalls).toHaveLength(1),
      );
      expect(p.bridge.isChannelLive()).toBe(false);
      expect(p.bridge.getWorkspaceRuntimeLifecycleSnapshot!()).toMatchObject({
        state: 'starting',
        runtimeLive: false,
        activeWork: true,
      });
    } finally {
      ready.resolve();
      await starting;
    }
    expect(p.bridge.isChannelLive()).toBe(true);
  });

  it.each([
    ['branch', {}],
    ['side task', { sourceType: 'side_task' }],
  ] as const)(
    'rejects a Managed %s with a typed error before mutating history',
    async (_kind, request) => {
      const p = paired();
      const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const branch = p.bridge.branchSession(session.sessionId, request);
      await expect(branch).rejects.toBeInstanceOf(
        ManagedSessionBranchUnsupportedError,
      );
      await expect(branch).rejects.toMatchObject({
        sessionId: session.sessionId,
      });
      expect(p.managed.agent.extMethodCalls).toHaveLength(0);
      expect(p.legacyFactory).not.toHaveBeenCalled();
    },
  );

  it('rejects branching on a quarantined Legacy channel before mutating history', async () => {
    const delivered = deferred<Record<string, unknown>>();
    const legacy = engineChannel('legacy', {
      newSessionImpl: (_request, agent) => ({
        sessionId: agent.newSessionCalls.length === 1 ? 'legacy-source' : '',
        ...receipt('legacy'),
      }),
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionBranch
          ? { newSessionId: 'legacy-branch' }
          : method === SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification
            ? delivered.promise
            : { closed: true },
    });
    const p = paired({}, legacy);
    p.choose('legacy');
    const source = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    // A notification still being delivered keeps the source out of the
    // quarantine drain without making it a running turn.
    const notification = p.bridge.enqueueBackgroundNotification(
      source.sessionId,
      {
        displayText: 'Worker completed.',
        modelText: '<task-notification />',
        taskId: 'worker-1',
        status: 'completed',
        kind: 'agent',
      },
    );
    await vi.waitFor(() => expect(legacy.agent.extMethodCalls).toHaveLength(1));
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    await expect(
      p.bridge.branchSession(source.sessionId, {}),
    ).rejects.toMatchObject({
      reason: 'new_session_cleanup_failed',
    });
    expect(legacy.agent.extMethodCalls.map((call) => call.method)).toEqual([
      SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification,
    ]);
    expect(p.managedFactory).not.toHaveBeenCalled();
    delivered.resolve({ sessionId: source.sessionId, accepted: true });
    await notification;
  });

  it('refuses to restore a Legacy branch through the Managed engine', async () => {
    const legacy = engineChannel('legacy', {
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionBranch
          ? { newSessionId: 'legacy-branch' }
          : { closed: true },
    });
    const p = paired({}, legacy);
    p.choose('legacy');
    const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    await expect(p.bridge.branchSession(session.sessionId, {})).rejects.toThrow(
      'execution engine differs from its source',
    );
    expect(p.managedFactory).not.toHaveBeenCalled();
    expect(legacy.agent.loadSessionCalls).toHaveLength(0);
    expect(p.bridge.sessionCount).toBe(1);
  });

  it.each(['legacy', 'managed'] as const)(
    'reads and flushes live replay on its %s owner',
    async (engine) => {
      const p = paired();
      p.choose(engine);
      const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      p.choose(engine === 'legacy' ? 'managed' : 'legacy');
      await p.bridge.getSessionTranscriptPage({ sessionId: session.sessionId });
      await p.bridge.getSessionTurnIndexPage({ sessionId: session.sessionId });
      await p.bridge.flushSessionTranscript!(session.sessionId);
      expect(p[engine].agent.extMethodCalls).toEqual([
        {
          method: SERVE_STATUS_EXT_METHODS.sessionTranscript,
          params: { sessionId: session.sessionId, cwd: WS_A },
        },
        {
          method: SERVE_STATUS_EXT_METHODS.sessionTurnIndex,
          params: { sessionId: session.sessionId, cwd: WS_A },
        },
        {
          method: SERVE_STATUS_EXT_METHODS.sessionTranscript,
          params: {
            sessionId: session.sessionId,
            cwd: WS_A,
            direction: 'backward',
            limit: 1,
          },
        },
      ]);
      expect(
        engine === 'managed' ? p.legacyFactory : p.managedFactory,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(['getSessionTranscriptPage', 'getSessionTurnIndexPage'] as const)(
    'propagates a Managed owner failure from %s without falling back',
    async (method) => {
      const managed = engineChannel('managed', {
        extMethodImpl: () => {
          throw new RequestError(-32603, 'owner read failed');
        },
      });
      const p = paired({}, engineChannel('legacy'), managed);
      const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        p.bridge[method]({ sessionId: session.sessionId }),
      ).rejects.toThrow('owner read failed');
      expect(managed.agent.extMethodCalls).toHaveLength(1);
      expect(p.legacyFactory).not.toHaveBeenCalled();
    },
  );

  it('keeps cold persisted replay reads on Legacy without selecting an engine', async () => {
    const p = paired();
    await p.bridge.getSessionTranscriptPage({ sessionId: 'cold' });
    await p.bridge.getSessionTurnIndexPage({ sessionId: 'cold' });
    expect(p.legacy.agent.extMethodCalls.map((call) => call.method)).toEqual([
      SERVE_STATUS_EXT_METHODS.sessionTranscript,
      SERVE_STATUS_EXT_METHODS.sessionTurnIndex,
    ]);
    expect(p.select).not.toHaveBeenCalled();
    expect(p.managedFactory).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'managed'] as const)(
    'recycles an empty timed-out channel while %s holds a runtime operation',
    async (busyEngine) => {
      vi.useFakeTimers();
      const completion = deferred<Record<string, unknown>>();
      const pendingNew = deferred<NewSessionResponse>();
      const busy = engineChannel(busyEngine, {
        extMethodImpl: (method) =>
          method === SERVE_CONTROL_EXT_METHODS.workspaceGenerationStart ||
          method === SERVE_CONTROL_EXT_METHODS.sessionCd
            ? completion.promise
            : { closed: true },
      });
      const idleEngine = busyEngine === 'legacy' ? 'managed' : 'legacy';
      const idle = engineChannel(idleEngine, {
        newSessionImpl: () => pendingNew.promise,
      });
      const replacement = engineChannel(idleEngine);
      const p = paired(
        { initializeTimeoutMs: 200 },
        busyEngine === 'legacy' ? busy : idle,
        busyEngine === 'managed' ? busy : idle,
      );
      const idleFactory =
        idleEngine === 'managed' ? p.managedFactory : p.legacyFactory;
      idleFactory
        .mockResolvedValueOnce(idle.channel)
        .mockResolvedValue(replacement.channel);
      let operation: Promise<unknown> | undefined;
      try {
        if (busyEngine === 'legacy') {
          const stream = p.bridge.generateWorkspaceContent!(
            'held generation',
            new AbortController().signal,
            undefined,
          );
          operation = (async () => {
            const events = [];
            for await (const event of stream) events.push(event);
            return events;
          })();
        } else {
          const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
          operation = p.bridge.changeSessionCwd(session.sessionId, {
            path: WS_A,
          });
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(busy.agent.extMethodCalls).toHaveLength(1);
        p.choose(idleEngine);
        const spawn = Promise.allSettled([
          p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ]);
        await vi.advanceTimersByTimeAsync(200);
        expect(await spawn).toMatchObject([
          { status: 'rejected', reason: { name: 'BridgeTimeoutError' } },
        ]);
        await vi.advanceTimersByTimeAsync(200);
        expect(idle.killed).toBe(true);
        expect(busy.killed).toBe(false);
        await expect(
          p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ).resolves.toMatchObject({
          sessionId: `${idleEngine}-1`,
        });
        expect(idleFactory).toHaveBeenCalledTimes(2);
        expect(
          p.bridge.getWorkspaceRuntimeLifecycleSnapshot!().activeWork,
        ).toBe(true);
      } finally {
        completion.resolve(
          busyEngine === 'legacy'
            ? { model: 'test', modelSource: 'main' }
            : { previousCwd: WS_A, newCwd: WS_A, warnings: [] },
        );
        await operation;
      }
    },
  );

  it.each([0, undefined])(
    'reaps Managed while bare Legacy preheat is pending with idle timeout %s',
    async (channelIdleTimeoutMs) => {
      const startup = deferred<ReturnType<typeof engineChannel>['channel']>();
      const p = paired({ channelIdleTimeoutMs });
      const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      p.legacyFactory.mockImplementation(() => startup.promise);
      const preheat = p.bridge.preheat();
      try {
        await p.bridge.closeSession(session.sessionId);
        expect(p.managed.killed).toBe(true);
        expect(
          p.bridge.getWorkspaceRuntimeLifecycleSnapshot!().activeWork,
        ).toBe(true);
      } finally {
        startup.resolve(p.legacy.channel);
        await preheat;
      }
      expect(p.legacy.killed).toBe(false);
    },
  );

  it('keeps both idle timers when the second engine becomes idle', async () => {
    vi.useFakeTimers();
    const p = paired({ channelIdleTimeoutMs: 100 });
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(managed.sessionId);
    await vi.advanceTimersByTimeAsync(50);
    await p.bridge.closeSession(legacy.sessionId);
    await vi.advanceTimersByTimeAsync(50);
    expect(p.managed.killed).toBe(true);
    expect(p.legacy.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(p.legacy.killed).toBe(true);
  });

  it.each(['load', 'resume'] as const)(
    'preserves the existing Legacy idle deadline during Managed %s',
    async (operation) => {
      vi.useFakeTimers();
      const p = paired({ channelIdleTimeoutMs: 100 });
      p.choose('legacy');
      const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await p.bridge.closeSession(legacy.sessionId);
      await vi.advanceTimersByTimeAsync(50);
      p.choose('managed');
      const request = { workspaceCwd: WS_A, sessionId: 'restored' };
      if (operation === 'load') await p.bridge.loadSession(request);
      else await p.bridge.resumeSession(request);
      await vi.advanceTimersByTimeAsync(50);
      expect(p.legacy.killed).toBe(true);
      expect(p.managed.killed).toBe(false);
    },
  );

  it.each(['load', 'resume'] as const)(
    'reclaims Legacy while the selected Managed %s response is still pending',
    async (operation) => {
      vi.useFakeTimers();
      const selection = deferred<BridgeExecutionEngine>();
      const response = deferred<ReturnType<typeof receipt>>();
      const managed = engineChannel('managed', {
        loadSessionImpl: () => response.promise,
        resumeSessionImpl: () => response.promise,
      });
      const p = paired(
        { channelIdleTimeoutMs: 100 },
        engineChannel('legacy'),
        managed,
      );
      p.choose('legacy');
      const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await p.bridge.closeSession(legacy.sessionId);
      p.select.mockImplementation(() => selection.promise);
      const restore =
        operation === 'load'
          ? p.bridge.loadSession({ workspaceCwd: WS_A, sessionId: 'pending' })
          : p.bridge.resumeSession({
              workspaceCwd: WS_A,
              sessionId: 'pending',
            });
      try {
        await vi.advanceTimersByTimeAsync(150);
        expect(p.legacy.killed).toBe(false);
        selection.resolve('managed');
        await vi.advanceTimersByTimeAsync(0);
        expect(
          managed.agent[
            operation === 'load' ? 'loadSessionCalls' : 'resumeSessionCalls'
          ],
        ).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(p.legacy.killed).toBe(true);
        expect(managed.killed).toBe(false);
      } finally {
        selection.resolve('managed');
        response.resolve(receipt('managed'));
        await restore;
      }
    },
  );

  describe.each(['load', 'resume'] as const)(
    '%s idle settlement',
    (operation) => {
      it.each(['success', 'rejection', 'timeout'] as const)(
        'rearms Legacy idle cleanup after slow selection ends in %s',
        async (outcome) => {
          vi.useFakeTimers();
          const selection = deferred<BridgeExecutionEngine>();
          const p = paired({
            channelIdleTimeoutMs: 100,
            initializeTimeoutMs: 200,
          });
          p.choose('legacy');
          const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
          await p.bridge.closeSession(legacy.sessionId);
          p.select.mockImplementation(() => selection.promise);
          const restore =
            operation === 'load'
              ? p.bridge.loadSession({ workspaceCwd: WS_A, sessionId: 'cold' })
              : p.bridge.resumeSession({
                  workspaceCwd: WS_A,
                  sessionId: 'cold',
                });
          const result = Promise.allSettled([restore]);
          await vi.advanceTimersByTimeAsync(150);
          expect(p.legacy.killed).toBe(false);
          if (outcome === 'success') selection.resolve('managed');
          else if (outcome === 'rejection')
            selection.reject(new Error('selection failed'));
          else await vi.advanceTimersByTimeAsync(50);
          const [settled] = await result;
          expect(settled).toMatchObject(
            outcome === 'success'
              ? { status: 'fulfilled', value: { sessionId: 'cold' } }
              : {
                  status: 'rejected',
                  reason: expect.objectContaining({
                    message: expect.stringContaining(
                      outcome === 'rejection'
                        ? 'selection failed'
                        : 'timed out',
                    ),
                  }),
                },
          );
          await vi.advanceTimersByTimeAsync(100);
          expect(p.legacy.killed).toBe(true);
          if (outcome === 'success') {
            expect(p.managed.killed).toBe(false);
            await p.bridge.closeSession('cold');
            await vi.advanceTimersByTimeAsync(100);
            expect(p.managed.killed).toBe(true);
          } else {
            expect(p.managedFactory).not.toHaveBeenCalled();
            selection.resolve('managed');
            await vi.advanceTimersByTimeAsync(0);
            expect(p.managedFactory).not.toHaveBeenCalled();
          }
          expect(p.bridge.sessionCount).toBe(0);
        },
      );
    },
  );

  it('reclaims a Managed-only idle channel', async () => {
    const p = paired();
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(managed.sessionId);
    const candidate = p.bridge.getIdleChannelCandidate!();
    expect(candidate).toBeDefined();
    expect(await p.bridge.reclaimIdleChannel!(candidate!)).toBe(true);
    expect(p.managed.killed).toBe(true);
    expect(p.legacyFactory).not.toHaveBeenCalled();
  });

  it('awaits a second engine preheat during shutdown after the first startup settles', async () => {
    const legacy = engineChannel('legacy');
    const managed = engineChannel('managed');
    const first = deferred<typeof managed.channel>();
    const second = deferred<typeof legacy.channel>();
    const managedFactory = vi.fn(() => first.promise);
    const legacyFactory = vi.fn(() => second.promise);
    const bridge = makeBridge({
      sessionScope: 'thread',
      executionEngines: {
        legacy: legacyFactory,
        managed: managedFactory,
        select: () => 'managed',
      },
    });
    bridges.push(bridge);
    const spawn = Promise.allSettled([
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ]);
    await vi.waitFor(() => expect(managedFactory).toHaveBeenCalledOnce());
    const preheat = Promise.allSettled([bridge.preheat()]);
    await vi.waitFor(() => expect(legacyFactory).toHaveBeenCalledOnce());
    let shutdownSettled = false;
    const shutdown = bridge.shutdown().then(() => {
      shutdownSettled = true;
    });
    try {
      first.resolve(managed.channel);
      expect((await spawn)[0].status).toBe('rejected');
      expect(managed.killed).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(shutdownSettled).toBe(false);
      expect(legacy.killed).toBe(false);
    } finally {
      second.resolve(legacy.channel);
      expect((await preheat)[0].status).toBe('rejected');
      await shutdown;
    }
    expect(legacy.killed).toBe(true);
  });

  it.each([2, 3])(
    'releases a timed-out create after a late RPC failure with capacity %i',
    async (maxSessions) => {
      vi.useFakeTimers();
      const late = deferred<NewSessionResponse>();
      const managed = engineChannel('managed', {
        newSessionImpl: (_request, agent) =>
          agent.newSessionCalls.length === 2
            ? late.promise
            : {
                sessionId: `managed-${agent.newSessionCalls.length}`,
                ...receipt('managed'),
              },
      });
      const p = paired(
        { maxSessions, initializeTimeoutMs: 30 },
        engineChannel('legacy'),
        managed,
      );
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await Promise.all([
        expect(p.bridge.spawnOrAttach({ workspaceCwd: WS_A })).rejects.toThrow(
          'timed out',
        ),
        vi.advanceTimersByTimeAsync(30),
      ]);
      late.reject(new Error('agent rejected newSession'));
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'managed-3' });
      expect(p.managedFactory).toHaveBeenCalledTimes(1);
      expect(p.legacyFactory).not.toHaveBeenCalled();
      expect(managed.agent.extMethodCalls).toHaveLength(0);
      expect(managed.killed).toBe(false);
    },
  );

  it('cleans a late Managed response while a Legacy session remains live', async () => {
    const late = deferred<NewSessionResponse>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) =>
        agent.newSessionCalls.length === 1
          ? { sessionId: 'managed-live', ...receipt('managed') }
          : late.promise,
    });
    const p = paired(
      { initializeTimeoutMs: 30 },
      engineChannel('legacy'),
      managed,
    );
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('timed out');
    expect(managed.killed).toBe(false);
    late.resolve({ sessionId: 'late-managed', ...receipt('managed') });
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls).toContainEqual({
        method: SERVE_CONTROL_EXT_METHODS.sessionClose,
        params: expect.objectContaining({ sessionId: 'late-managed' }),
      }),
    );
    expect(managed.killed).toBe(false);
    expect(p.legacy.killed).toBe(false);
    expect(p.bridge.sessionCount).toBe(2);
  });

  it('asks the selected engine to own every creation and cold restore', async () => {
    const p = paired();
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.loadSession({
      workspaceCwd: WS_A,
      sessionId: 'persisted-managed',
    });
    p.choose('legacy');
    await p.bridge.resumeSession({
      workspaceCwd: WS_A,
      sessionId: 'persisted-legacy',
    });
    expect(p.managed.agent.newSessionCalls[0]!._meta).toMatchObject({
      [SESSION_EXECUTION_ENGINE_META_KEY]: 'managed',
    });
    expect(p.managed.agent.loadSessionCalls[0]!._meta).toMatchObject({
      [SESSION_EXECUTION_ENGINE_META_KEY]: 'managed',
    });
    expect(p.legacy.agent.resumeSessionCalls[0]!._meta).toMatchObject({
      [SESSION_EXECUTION_ENGINE_META_KEY]: 'legacy',
    });
  });

  it('does not ask a single-factory channel for an execution engine owner', async () => {
    const single = engineChannel('legacy');
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: async () => single.channel,
    });
    bridges.push(bridge);
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await bridge.loadSession({ workspaceCwd: WS_A, sessionId: 'persisted' });
    await bridge.resumeSession({ workspaceCwd: WS_A, sessionId: 'resumed' });
    for (const request of [
      single.agent.newSessionCalls[0],
      single.agent.loadSessionCalls[0],
      single.agent.resumeSessionCalls[0],
    ]) {
      expect(request?._meta).not.toHaveProperty(
        SESSION_EXECUTION_ENGINE_META_KEY,
      );
    }
  });

  it.each(['spawn', 'load', 'resume'] as const)(
    'releases admission and the requested ID after %s selection fails',
    async (operation) => {
      const release = vi.fn();
      const p = paired({
        maxSessions: 1,
        freshSessionAdmission: () => ({ release }),
      });
      p.select.mockImplementationOnce(() => {
        throw new Error('owner unavailable');
      });
      const request = { workspaceCwd: WS_A, sessionId: 'retried' };
      await expect(
        operation === 'spawn'
          ? p.bridge.spawnOrAttach(request)
          : operation === 'load'
            ? p.bridge.loadSession(request)
            : p.bridge.resumeSession(request),
      ).rejects.toThrow('owner unavailable');
      expect(release).toHaveBeenCalledTimes(1);
      await expect(p.bridge.spawnOrAttach(request)).resolves.toMatchObject({
        sessionId: 'retried',
      });
      expect(p.managed.agent.newSessionCalls).toHaveLength(1);
      expect(p.legacyFactory).not.toHaveBeenCalled();
    },
  );

  it('closes a mismatched returned ID on its channel and frees the requested ID', async () => {
    const managed = engineChannel('managed', {
      newSessionImpl: (request, agent) => ({
        sessionId:
          agent.newSessionCalls.length === 1
            ? 'unexpected'
            : String(request._meta?.[REQUESTED_SESSION_ID_META_KEY]),
        ...receipt('managed'),
      }),
    });
    const p = paired({}, engineChannel('legacy'), managed);
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionId: 'wanted' }),
    ).rejects.toThrow('invalid or already reserved session ID');
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls).toEqual([
        {
          method: SERVE_CONTROL_EXT_METHODS.sessionClose,
          params: expect.objectContaining({ sessionId: 'unexpected' }),
        },
      ]),
    );
    await vi.waitFor(async () => {
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionId: 'wanted' }),
      ).resolves.toMatchObject({ sessionId: 'wanted' });
    });
    expect(managed.agent.newSessionCalls).toHaveLength(2);
    expect(managed.killed).toBe(false);
    expect(p.bridge.sessionCount).toBe(1);
    expect(p.legacyFactory).not.toHaveBeenCalled();
  });

  it('keeps a rejected requested ID reserved until cleanup acknowledges its close', async () => {
    const closed = deferred<Record<string, unknown>>();
    const managed = engineChannel('managed', {
      newSessionImpl: () => ({ sessionId: 'rejected' }),
      extMethodImpl: () => closed.promise,
    });
    const p = paired({}, engineChannel('legacy'), managed);
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionId: 'rejected' }),
    ).rejects.toThrow('receipt');
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls).toHaveLength(1),
    );
    p.choose('legacy');
    const blocked = p.bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionId: 'rejected',
    });
    await expect(blocked).rejects.toBeInstanceOf(RestoreInProgressError);
    await expect(blocked).rejects.toMatchObject({
      reason: 'awaiting_abandoned_cleanup',
    });
    expect(p.legacyFactory).not.toHaveBeenCalled();
    closed.resolve({ closed: true });
    await vi.waitFor(async () => {
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionId: 'rejected' }),
      ).resolves.toMatchObject({ sessionId: 'rejected' });
    });
    expect(p.legacy.agent.newSessionCalls).toHaveLength(1);
  });

  it('quarantines a late unaddressable Managed response while Legacy stays usable', async () => {
    const late = deferred<NewSessionResponse>();
    const running = deferred<PromptResponse>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) =>
        agent.newSessionCalls.length === 1
          ? { sessionId: 'managed-live', ...receipt('managed') }
          : late.promise,
      promptImpl: () => running.promise,
    });
    const p = paired(
      { initializeTimeoutMs: 30 },
      engineChannel('legacy'),
      managed,
    );
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    const managedLive = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const turn = p.bridge.sendPrompt(managedLive.sessionId, {
      sessionId: managedLive.sessionId,
      prompt: [{ type: 'text', text: 'still owned' }],
    });
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('timed out');
    late.resolve({ sessionId: 'late\u0001id', ...receipt('managed') });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toMatchObject({
      name: 'BridgeChannelQuarantinedError',
      reason: 'new_session_cleanup_failed',
    });
    expect(managed.agent.newSessionCalls).toHaveLength(2);
    expect(managed.agent.extMethodCalls).toHaveLength(0);
    expect(managed.agent.promptCalls).toHaveLength(1);
    p.choose('legacy');
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).resolves.toMatchObject({ sessionId: 'legacy-2' });
    running.resolve({ stopReason: 'end_turn' });
    await turn;
    await vi.waitFor(() => expect(managed.killed).toBe(true));
    expect(p.legacy.killed).toBe(false);
    expect(p.bridge.getSessionSummary(legacy.sessionId)).toBeDefined();
  });

  it.each(['load', 'resume'] as const)(
    'restores a cold Legacy %s on Legacy after the default changes',
    async (operation) => {
      const p = paired();
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      p.choose('legacy');
      const request = { workspaceCwd: WS_A, sessionId: 'persisted-legacy' };
      const restored =
        operation === 'load'
          ? await p.bridge.loadSession(request)
          : await p.bridge.resumeSession(request);
      p.choose('managed');
      await p.bridge.sendPrompt(restored.sessionId, {
        sessionId: restored.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      });
      expect(
        p.legacy.agent[
          operation === 'load' ? 'loadSessionCalls' : 'resumeSessionCalls'
        ],
      ).toEqual([
        expect.objectContaining({
          sessionId: 'persisted-legacy',
          _meta: expect.objectContaining({
            [SESSION_EXECUTION_ENGINE_META_KEY]: 'legacy',
          }),
        }),
      ]);
      expect(p.legacy.agent.promptCalls.map((call) => call.sessionId)).toEqual([
        'persisted-legacy',
      ]);
      expect(p.managed.agent.promptCalls).toHaveLength(0);
    },
  );

  it('restores a successful Legacy branch on its source engine', async () => {
    const legacy = engineChannel('legacy', {
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionBranch
          ? { newSessionId: 'legacy-branch' }
          : { closed: true },
    });
    const p = paired({}, legacy);
    p.choose('legacy');
    const source = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const branch = await p.bridge.branchSession(source.sessionId, {});
    expect(branch.sessionId).toBe('legacy-branch');
    expect(p.select).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ sessionId: 'legacy-branch' }),
      }),
    );
    expect([
      ...legacy.agent.loadSessionCalls,
      ...legacy.agent.resumeSessionCalls,
    ]).toEqual([
      expect.objectContaining({
        sessionId: 'legacy-branch',
        _meta: expect.objectContaining({
          [SESSION_EXECUTION_ENGINE_META_KEY]: 'legacy',
        }),
      }),
    ]);
    expect(p.bridge.sessionCount).toBe(2);
    expect(p.managedFactory).not.toHaveBeenCalled();
  });
});

function recordQuarantineEvents(): {
  telemetry: BridgeTelemetry;
  named: (suffix: string) => Array<Record<string, unknown>>;
} {
  const events: Array<{ name: string; attributes: Record<string, unknown> }> =
    [];
  return {
    named: (suffix) =>
      events
        .filter((event) => event.name === `channel.quarantine.${suffix}`)
        .map((event) => event.attributes),
    telemetry: {
      captureContext: () => undefined,
      runWithContext: async (_captured, fn) => await fn(),
      withSpan: async (_operation, _attributes, fn) => await fn(),
      event: (name, attributes) => {
        if (name.startsWith('channel.quarantine.')) {
          events.push({ name, attributes: { ...attributes } });
        }
      },
      injectPromptContext: (request) => request,
    },
  };
}

/**
 * Let pending work run without moving fake time; `vi.waitFor` would advance
 * it and could reach an idle timeout that hides a missing retirement.
 */
async function flushWithoutTime(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Times out the next creation and lets it outlive its settlement grace. */
async function abandonCreationPastGrace(
  bridge: AcpSessionBridge,
  initializeTimeoutMs: number,
): Promise<void> {
  await Promise.all([
    expect(bridge.spawnOrAttach({ workspaceCwd: WS_A })).rejects.toThrow(
      'timed out',
    ),
    vi.advanceTimersByTimeAsync(initializeTimeoutMs),
  ]);
  await vi.advanceTimersByTimeAsync(initializeTimeoutMs);
}

const prompt = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: 'text' as const, text }],
});

describe('paired quarantine recovery', () => {
  it('refuses new turns on a quarantined channel while its running turn settles', async () => {
    vi.useFakeTimers();
    const abandoned = deferred<NewSessionResponse>();
    const running = deferred<PromptResponse>();
    const answer = deferred<Record<string, unknown>>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) =>
        agent.newSessionCalls.length === 3
          ? abandoned.promise
          : {
              sessionId: `managed-${agent.newSessionCalls.length}`,
              ...receipt('managed'),
            },
      promptImpl: () => running.promise,
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionBtw
          ? answer.promise
          : method === SERVE_CONTROL_EXT_METHODS.sessionClose
            ? { closed: true }
            : {},
    });
    const quarantine = recordQuarantineEvents();
    const p = paired(
      { initializeTimeoutMs: 30, telemetry: quarantine.telemetry },
      engineChannel('legacy'),
      managed,
    );
    const waiting = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const busy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    // Answering a side question, so not settled, but not running a turn.
    const side = p.bridge.generateSessionBtw(waiting.sessionId, 'side');
    const turn = p.bridge.sendPrompt(
      busy.sessionId,
      prompt(busy.sessionId, 'running'),
    );
    const queued = p.bridge
      .sendPrompt(busy.sessionId, prompt(busy.sessionId, 'queued'))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(managed.agent.promptCalls).toHaveLength(1);

    await abandonCreationPastGrace(p.bridge, 30);

    expect(quarantine.named('started')).toEqual([
      expect.objectContaining({
        'qwen-code.daemon.acp_channel.execution_engine': 'managed',
        'qwen-code.daemon.acp_channel.quarantine_reason':
          'new_session_settlement_overdue',
      }),
    ]);
    expect(promptRefusal(p.bridge, waiting.sessionId, 'refused')).toMatchObject(
      {
        name: 'BridgeChannelQuarantinedError',
        reason: 'new_session_settlement_overdue',
        message: expect.stringContaining('new prompts'),
      },
    );
    await expect(
      managed.agentConnection.extMethod('_qwencode/start_turn', {
        sessionId: waiting.sessionId,
        source: 'background_notification',
        turnId: 'notification-1',
        taskId: 'Explore-1',
        kind: 'agent',
        startedAt: 1000,
      }),
    ).resolves.toEqual({ accepted: false });
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toMatchObject({ reason: 'new_session_settlement_overdue' });
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await expect(
      p.bridge.sendPrompt(legacy.sessionId, prompt(legacy.sessionId, 'hi')),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });

    running.resolve({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' });
    // Queued before the quarantine, but still a new turn when it comes up.
    expect(await queued).toMatchObject({
      reason: 'new_session_settlement_overdue',
    });
    expect(managed.agent.promptCalls).toHaveLength(1);
    // Once settled the session is closed; the other one waits for its side
    // question, and the channel retires when both are gone.
    await flushWithoutTime();
    expect(() => p.bridge.getSessionSummary(busy.sessionId)).toThrow(
      SessionNotFoundError,
    );
    expect(p.bridge.getSessionSummary(waiting.sessionId)).toBeDefined();
    expect(managed.killed).toBe(false);
    answer.resolve({ sessionId: waiting.sessionId, answer: 'done' });
    await expect(side).resolves.toMatchObject({ answer: 'done' });
    await flushWithoutTime();
    expect(managed.killed).toBe(true);
    expect(p.legacy.killed).toBe(false);
  });

  it.each([true, false])(
    'retires the channel for an overdue settlement even after it clears (close answered: %s)',
    async (answersClose) => {
      vi.useFakeTimers();
      const lateRestore = deferred<ReturnType<typeof receipt>>();
      const running = deferred<PromptResponse>();
      // Without an answer to the drain's close of the busy session, only the
      // bounded close can retire the channel.
      const managed = engineChannel('managed', {
        loadSessionImpl: () => lateRestore.promise,
        promptImpl: () => running.promise,
        extMethodImpl: (method, params) =>
          !answersClose &&
          method === SERVE_CONTROL_EXT_METHODS.sessionClose &&
          params['sessionId'] === 'managed-2'
            ? new Promise(() => {})
            : { closed: true },
      });
      const replacement = engineChannel('managed');
      const quarantine = recordQuarantineEvents();
      const p = paired(
        {
          sessionRestoreTimeoutMs: 40,
          quarantineDrainTimeoutMs: 60_000,
          telemetry: quarantine.telemetry,
        },
        engineChannel('legacy'),
        managed,
      );
      p.managedFactory
        .mockResolvedValueOnce(managed.channel)
        .mockResolvedValue(replacement.channel);
      const idle = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const busy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const turn = p.bridge.sendPrompt(
        busy.sessionId,
        prompt(busy.sessionId, 'running'),
      );
      await vi.advanceTimersByTimeAsync(0);
      const restore = p.bridge
        .loadSession({ workspaceCwd: WS_A, sessionId: 'slow' })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(40);
      expect(await restore).toMatchObject({
        name: 'SessionRestoreTimeoutError',
      });
      await vi.advanceTimersByTimeAsync(40);
      await flushWithoutTime();

      expect(quarantine.named('started')).toEqual([
        expect.objectContaining({
          'qwen-code.daemon.acp_channel.quarantine_reason':
            'restore_settlement_overdue',
        }),
      ]);
      // Only an acknowledged workspace change (B2b) may end a quarantine early,
      // so the idle session is closed at once...
      expect(() => p.bridge.getSessionSummary(idle.sessionId)).toThrow(
        SessionNotFoundError,
      );
      // ...and when the late restore settles and is cleaned up, the channel
      // stays quarantined.
      lateRestore.resolve(receipt('managed'));
      await flushWithoutTime();
      expect(managed.agent.extMethodCalls).toContainEqual({
        method: SERVE_CONTROL_EXT_METHODS.sessionClose,
        params: expect.objectContaining({ sessionId: 'slow' }),
      });
      expect(promptRefusal(p.bridge, busy.sessionId, 'more')).toMatchObject({
        reason: 'restore_settlement_overdue',
        message: expect.stringContaining('did not settle in time'),
      });
      expect(managed.killed).toBe(false);
      // A workspace runtime stop waits for the retiring channel.
      expect(p.bridge.getRuntimeStopSnapshot!().blockedReasons).toContain(
        'stopping',
      );

      // Once the last session settles, the drained channel retires at once;
      // its close is still bounded, so a child that never answers it is
      // retired within the close budget rather than at the deadline.
      running.resolve({ stopReason: 'end_turn' });
      await turn;
      await flushWithoutTime();
      if (!answersClose) {
        expect(managed.killed).toBe(false);
        await vi.advanceTimersByTimeAsync(ACTIVE_WORK_CLOSE_TIMEOUT_MS);
        await flushWithoutTime();
      }
      expect(managed.killed).toBe(true);
      expect(quarantine.named('deadline')).toEqual([]);
      expect(quarantine.named('ended')).toHaveLength(1);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'managed-1' });
      expect(p.managedFactory).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['legacy', 'managed'] as const)(
    'closes settled %s sessions and retires the drained channel before its deadline',
    async (engine) => {
      const other = engine === 'legacy' ? 'managed' : 'legacy';
      const running = deferred<PromptResponse>();
      const released = deferred<void>();
      const quarantined = engineChannel(engine, {
        newSessionImpl: (_request, agent) => ({
          sessionId:
            agent.newSessionCalls.length === 3
              ? ''
              : `${engine}-${agent.newSessionCalls.length}`,
          ...receipt(engine),
        }),
        promptImpl: () => running.promise,
      });
      const replacement = engineChannel(engine);
      const p =
        engine === 'legacy'
          ? paired({}, quarantined, engineChannel('managed'))
          : paired({}, engineChannel('legacy'), quarantined);
      const factory = engine === 'legacy' ? p.legacyFactory : p.managedFactory;
      factory
        .mockResolvedValueOnce({
          ...quarantined.channel,
          registryReleased: released.promise,
        })
        .mockResolvedValue(replacement.channel);
      p.choose(engine);
      const idle = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const busy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const idleEvents: string[] = [];
      const collecting = (async () => {
        for await (const event of p.bridge.subscribeEvents(idle.sessionId, {
          signal: abort.signal,
        })) {
          if (event.type === 'session_closed') {
            idleEvents.push((event.data as { reason: string }).reason);
          }
        }
      })();
      const turn = p.bridge.sendPrompt(
        busy.sessionId,
        prompt(busy.sessionId, 'running'),
      );
      await vi.waitFor(() =>
        expect(quarantined.agent.promptCalls).toHaveLength(1),
      );

      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toThrow('invalid');

      // The settled session closes although a client is attached; the
      // running one is left to settle.
      await vi.waitFor(() =>
        expect(idleEvents).toEqual(['channel_quarantined']),
      );
      expect(() => p.bridge.getSessionSummary(idle.sessionId)).toThrow(
        SessionNotFoundError,
      );
      expect(p.bridge.getSessionSummary(busy.sessionId)).toBeDefined();
      expect(quarantined.killed).toBe(false);
      // The closed session cannot come back while its channel still runs,
      // and the other engine keeps working.
      await expect(
        p.bridge.loadSession({ workspaceCwd: WS_A, sessionId: idle.sessionId }),
      ).rejects.toMatchObject({ reason: 'new_session_cleanup_failed' });
      p.choose(other);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: `${other}-1` });
      p.choose(engine);

      running.resolve({ stopReason: 'end_turn' });
      await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(quarantined.killed).toBe(true));
      await vi.waitFor(() =>
        expect(() => p.bridge.getSessionSummary(busy.sessionId)).toThrow(
          SessionNotFoundError,
        ),
      );
      abort.abort();
      await collecting;
      // The root exited, but the engine opens only once the process tree is
      // released, and a runtime stop waits for it too.
      await expect(
        p.bridge.loadSession({ workspaceCwd: WS_A, sessionId: idle.sessionId }),
      ).rejects.toMatchObject({ reason: 'new_session_cleanup_failed' });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(p.bridge.getRuntimeStopSnapshot!().blockedReasons).toContain(
        'stopping',
      );

      released.resolve();
      await vi.waitFor(async () =>
        expect(
          await p.bridge.loadSession({
            workspaceCwd: WS_A,
            sessionId: idle.sessionId,
          }),
        ).toMatchObject({ sessionId: idle.sessionId }),
      );
      expect(p.select).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: 'load' }),
      );
      expect(factory).toHaveBeenCalledTimes(2);
      expect(replacement.agent.loadSessionCalls).toEqual([
        expect.objectContaining({ sessionId: idle.sessionId }),
      ]);
    },
  );

  it('terminates at the deadline and holds the engine until the process is gone', async () => {
    vi.useFakeTimers();
    const running = deferred<PromptResponse>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) => ({
        sessionId:
          agent.newSessionCalls.length === 2
            ? ''
            : `managed-${agent.newSessionCalls.length}`,
        ...receipt('managed'),
      }),
      promptImpl: () => running.promise,
    });
    // A child that survives both termination steps; only `crash()` ends it,
    // and its process tree is released later still.
    const kill = vi.fn(() => new Promise<void>(() => {}));
    const killSync = vi.fn();
    const released = deferred<void>();
    const replacement = engineChannel('managed');
    const quarantine = recordQuarantineEvents();
    // One release per admitted creation; the creation whose cleanup failed
    // keeps its admission until its channel is gone.
    const reservations: Array<ReturnType<typeof vi.fn>> = [];
    const removed: string[] = [];
    const p = paired(
      {
        initializeTimeoutMs: 100,
        quarantineDrainTimeoutMs: 1_000,
        telemetry: quarantine.telemetry,
        freshSessionAdmission: () => {
          const release = vi.fn();
          reservations.push(release);
          return { release };
        },
        sessionLifecycle: (event) => {
          if (event.type === 'removed') removed.push(event.sessionId);
        },
      },
      engineChannel('legacy'),
      managed,
    );
    p.managedFactory
      .mockResolvedValueOnce({
        ...managed.channel,
        kill,
        killSync,
        registryReleased: released.promise,
      })
      .mockResolvedValue(replacement.channel);
    try {
      const busy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const turn = p.bridge
        .sendPrompt(busy.sessionId, prompt(busy.sessionId, 'long'))
        .then(
          () => 'settled',
          () => 'failed',
        );
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toThrow('invalid');
      expect(reservations).toHaveLength(2);
      const cleanupAdmission = reservations[1]!;

      // Activity on the channel does not move the deadline.
      await vi.advanceTimersByTimeAsync(900);
      await managed.agentConnection.sessionUpdate({
        sessionId: busy.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'still working' },
        },
      });
      expect(promptRefusal(p.bridge, busy.sessionId, 'more')).toMatchObject({
        reason: 'new_session_cleanup_failed',
      });
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);

      expect(quarantine.named('deadline')).toEqual([
        expect.objectContaining({
          'qwen-code.daemon.acp_channel.unsettled_session_count': 1,
        }),
      ]);
      expect(managed.agent.cancelCalls).toContainEqual(
        expect.objectContaining({ sessionId: busy.sessionId }),
      );
      expect(kill).toHaveBeenCalledTimes(1);
      // The deadline is not an exit: the session, its ID and the engine stay
      // held, and nothing is released.
      expect(p.bridge.getSessionSummary(busy.sessionId)).toBeDefined();
      expect(cleanupAdmission).not.toHaveBeenCalled();
      expect(removed).toEqual([]);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toMatchObject({ reason: 'new_session_cleanup_failed' });
      await vi.advanceTimersByTimeAsync(100);
      expect(killSync).toHaveBeenCalled();
      // Not reported before the registry had its own termination window,
      // however short the initialize budget.
      await vi.advanceTimersByTimeAsync(14_900);
      expect(quarantine.named('exit_unverified')).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);

      expect(quarantine.named('exit_unverified')).toHaveLength(1);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toMatchObject({
        reason: 'channel_exit_unverified',
        message: expect.stringContaining('operator action may be required'),
      });
      expect(p.managedFactory).toHaveBeenCalledTimes(1);
      expect(p.bridge.getSessionSummary(busy.sessionId)).toBeDefined();
      expect(cleanupAdmission).not.toHaveBeenCalled();
      expect(removed).toEqual([]);
      p.choose('legacy');
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'legacy-1' });
      p.choose('managed');

      // The root's exit ends the channel and its sessions...
      managed.crash();
      await vi.advanceTimersByTimeAsync(0);
      expect(await turn).toBe('failed');
      expect(() => p.bridge.getSessionSummary(busy.sessionId)).toThrow(
        SessionNotFoundError,
      );
      expect(cleanupAdmission).toHaveBeenCalledTimes(1);
      expect(removed).toEqual([busy.sessionId]);
      // ...but only the released process tree frees the engine.
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toMatchObject({ reason: 'channel_exit_unverified' });
      expect(quarantine.named('ended')).toEqual([]);
      released.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(quarantine.named('ended')).toEqual([
        expect.objectContaining({
          'qwen-code.daemon.acp_channel.quarantine_exit_unverified': true,
        }),
      ]);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'managed-1' });
      expect(p.managedFactory).toHaveBeenCalledTimes(2);
    } finally {
      managed.crash();
      released.resolve();
    }
  });

  it('refuses mid-turn input on a quarantined channel and clears what can no longer run', async () => {
    const running = deferred<PromptResponse>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) => ({
        sessionId:
          agent.newSessionCalls.length === 2
            ? ''
            : `managed-${agent.newSessionCalls.length}`,
        ...receipt('managed'),
      }),
      promptImpl: () => running.promise,
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const busy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const abort = new AbortController();
    const removedFromQueue: string[] = [];
    const collecting = (async () => {
      for await (const event of p.bridge.subscribeEvents(busy.sessionId, {
        signal: abort.signal,
      })) {
        const data = event.data as { promptId?: string; state?: string };
        if (event.type === 'pending_prompt_completed' && data.promptId) {
          removedFromQueue.push(`${data.promptId}:${data.state}`);
        }
      }
    })();
    const turn = p.bridge.sendPrompt(
      busy.sessionId,
      prompt(busy.sessionId, 'running'),
    );
    await vi.waitFor(() => expect(managed.agent.promptCalls).toHaveLength(1));
    // Queued before the quarantine; the running turn never drains it.
    expect(
      p.bridge.enqueueMidTurnMessage(
        busy.sessionId,
        'follow up',
        { clientId: busy.clientId },
        'queued-early',
      ),
    ).toEqual({ accepted: true, messageId: 'queued-early' });

    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');

    expect(
      refusal(() =>
        p.bridge.enqueueMidTurnMessage(busy.sessionId, 'more', {
          clientId: busy.clientId,
        }),
      ),
    ).toMatchObject({
      name: 'BridgeChannelQuarantinedError',
      reason: 'new_session_cleanup_failed',
    });
    running.resolve({ stopReason: 'end_turn' });
    await turn;
    // The undrained message cannot start a turn, so it leaves the queue view
    // instead of being dropped silently.
    await vi.waitFor(() =>
      expect(removedFromQueue).toEqual(['queued-early:removed']),
    );
    expect(managed.agent.promptCalls).toHaveLength(1);
    await vi.waitFor(() => expect(managed.killed).toBe(true));
    abort.abort();
    await collecting;
  });

  it('waits for side requests before closing a session and refuses new ones', async () => {
    const answer = deferred<Record<string, unknown>>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) => ({
        sessionId:
          agent.newSessionCalls.length === 2
            ? ''
            : `managed-${agent.newSessionCalls.length}`,
        ...receipt('managed'),
      }),
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionBtw
          ? answer.promise
          : method === SERVE_CONTROL_EXT_METHODS.sessionClose
            ? { closed: true }
            : {},
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const btw = p.bridge.generateSessionBtw(session.sessionId, 'side question');
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls.map((call) => call.method)).toEqual([
        SERVE_CONTROL_EXT_METHODS.sessionBtw,
      ]),
    );

    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');

    const refused = { reason: 'new_session_cleanup_failed' };
    await expect(
      p.bridge.generateSessionRecap(session.sessionId),
    ).rejects.toMatchObject(refused);
    await expect(
      p.bridge.generateSessionBtw(session.sessionId, 'another'),
    ).rejects.toMatchObject(refused);
    expect(
      refusal(() =>
        p.bridge.generateSessionContent!(
          session.sessionId,
          'generate',
          new AbortController().signal,
        ),
      ),
    ).toMatchObject(refused);
    await expect(
      p.bridge.launchSessionForkAgent(session.sessionId, 'fork'),
    ).rejects.toMatchObject(refused);
    await expect(
      p.bridge.controlSessionWorkflowTask(session.sessionId, 'wf-1', 'rerun'),
    ).rejects.toMatchObject(refused);
    await expect(
      p.bridge.controlSessionGoal(session.sessionId, {
        action: 'resume',
        expectedGoalId: 'goal-1',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject(refused);
    // Stopping work is still allowed.
    await expect(
      p.bridge.controlSessionWorkflowTask(session.sessionId, 'wf-1', 'pause'),
    ).resolves.toBeDefined();
    await expect(
      p.bridge.controlSessionGoal(session.sessionId, {
        action: 'pause',
        expectedGoalId: 'goal-1',
        expectedRevision: 1,
      }),
    ).resolves.toBeDefined();
    expect(managed.agent.extMethodCalls.map((call) => call.method)).toEqual([
      SERVE_CONTROL_EXT_METHODS.sessionBtw,
      SERVE_CONTROL_EXT_METHODS.sessionWorkflowTaskAction,
      SERVE_CONTROL_EXT_METHODS.sessionGoalControl,
    ]);
    expect(p.bridge.getSessionSummary(session.sessionId)).toBeDefined();
    expect(managed.killed).toBe(false);
    answer.resolve({ sessionId: session.sessionId, answer: 'yes' });
    await expect(btw).resolves.toMatchObject({ answer: 'yes' });
    await vi.waitFor(() => expect(managed.killed).toBe(true));
  });

  it('keeps a session while its content generation runs', async () => {
    const generated = deferred<Record<string, unknown>>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) => ({
        sessionId:
          agent.newSessionCalls.length === 2
            ? ''
            : `managed-${agent.newSessionCalls.length}`,
        ...receipt('managed'),
      }),
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionGenerationStart
          ? generated.promise
          : method === SERVE_CONTROL_EXT_METHODS.sessionClose
            ? { closed: true }
            : {},
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const stream = p.bridge.generateSessionContent!(
      session.sessionId,
      'generate',
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(managed.agent.extMethodCalls).toHaveLength(1),
    );
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    expect(p.bridge.getSessionSummary(session.sessionId)).toBeDefined();

    generated.resolve({ model: 'test', modelSource: 'main' });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    expect(events).toEqual(['done']);
    await vi.waitFor(() => expect(managed.killed).toBe(true));
  });

  it('drains a session whose creation lands during the quarantine', async () => {
    const created = deferred<NewSessionResponse>();
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) =>
        agent.newSessionCalls.length === 1
          ? created.promise
          : { sessionId: '', ...receipt('managed') },
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const spawn = p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await vi.waitFor(() =>
      expect(managed.agent.newSessionCalls).toHaveLength(1),
    );
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    expect(managed.killed).toBe(false);

    created.resolve({ sessionId: 'managed-late', ...receipt('managed') });
    await expect(spawn).resolves.toMatchObject({ sessionId: 'managed-late' });
    await vi.waitFor(() => expect(managed.killed).toBe(true));
    expect(p.bridge.sessionCount).toBe(0);
  });

  it('drains a session once its worktree reset barrier is cleared', async () => {
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) => ({
        sessionId:
          agent.newSessionCalls.length === 2
            ? ''
            : `managed-${agent.newSessionCalls.length}`,
        ...receipt('managed'),
      }),
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.bridge.setSessionResetPending!(session.sessionId);
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    // A transfer owns the session's worktree, so the drain leaves it alone.
    expect(p.bridge.getSessionSummary(session.sessionId)).toBeDefined();
    expect(managed.killed).toBe(false);

    p.bridge.clearSessionResetPending!(session.sessionId);
    await vi.waitFor(() => expect(managed.killed).toBe(true));
    expect(p.bridge.sessionCount).toBe(0);
  });

  it('drains a session whose restore lands during the quarantine', async () => {
    const loaded = deferred<ReturnType<typeof receipt>>();
    const managed = engineChannel('managed', {
      newSessionImpl: () => ({ sessionId: '', ...receipt('managed') }),
      loadSessionImpl: () => loaded.promise,
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const restore = p.bridge.loadSession({
      workspaceCwd: WS_A,
      sessionId: 'persisted',
    });
    await vi.waitFor(() =>
      expect(managed.agent.loadSessionCalls).toHaveLength(1),
    );
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    expect(managed.killed).toBe(false);

    loaded.resolve(receipt('managed'));
    await expect(restore).resolves.toMatchObject({ sessionId: 'persisted' });
    await vi.waitFor(() => expect(managed.killed).toBe(true));
    expect(p.bridge.sessionCount).toBe(0);
  });

  it('keeps single-factory quarantine without a drain deadline', async () => {
    vi.useFakeTimers();
    const late = deferred<NewSessionResponse>();
    const channel = makeChannel({
      newSessionImpl: (_request, agent) =>
        agent.newSessionCalls.length === 2
          ? late.promise
          : { sessionId: `legacy-${agent.newSessionCalls.length}` },
      // The late session's cleanup is refused, which requires retirement.
      extMethodImpl: (method, params) => ({
        closed:
          method === SERVE_CONTROL_EXT_METHODS.sessionClose &&
          params['sessionId'] !== 'late',
      }),
    });
    const bridge = makeBridge({
      channelFactory: async () => channel.channel,
      sessionScope: 'thread',
      initializeTimeoutMs: 30,
      quarantineDrainTimeoutMs: 1_000,
    });
    bridges.push(bridge);
    const idle = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await Promise.all([
      expect(bridge.spawnOrAttach({ workspaceCwd: WS_A })).rejects.toThrow(
        'timed out',
      ),
      vi.advanceTimersByTimeAsync(30),
    ]);
    late.resolve({ sessionId: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toMatchObject({ reason: 'new_session_cleanup_failed' });
    // Existing sessions keep prompting and are neither closed nor terminated.
    await expect(
      bridge.sendPrompt(idle.sessionId, prompt(idle.sessionId, 'still here')),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bridge.getSessionSummary(idle.sessionId)).toBeDefined();
    expect(channel.killed).toBe(false);
    expect(channel.agent.cancelCalls).toHaveLength(0);
  });

  it('rejects an invalid drain deadline', () => {
    for (const quarantineDrainTimeoutMs of [0, -1, 1.5, 2 ** 31, NaN]) {
      expect(() => paired({ quarantineDrainTimeoutMs })).toThrow(
        'quarantineDrainTimeoutMs',
      );
    }
  });
});

describe('paired per-engine operations', () => {
  const heap = (peak: number, names: string[]) => ({
    peakOldGenerationBytes: peak,
    peakLiveSetBytes: peak / 2,
    peakTotalHeapBytes: peak * 2,
    majorGcCount: peak / 100,
    majorGcMs: peak / 10,
    unclassifiedSpaceNames: names,
  });
  const reporting = (
    engine: BridgeExecutionEngine,
    report: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  ) =>
    engineChannel(engine, {
      extMethodImpl: (method) =>
        method === SERVE_STATUS_EXT_METHODS.workspaceResource
          ? report()
          : method === SERVE_CONTROL_EXT_METHODS.sessionClose
            ? { closed: true }
            : {},
    });
  async function bothEngines(p: ReturnType<typeof paired>) {
    const managed = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('legacy');
    const legacy = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    return { managed, legacy };
  }

  it('combines the readings of both engines in the child resource snapshot', async () => {
    const legacyReport = {
      rssBytes: 100,
      cpuPercent: 30,
      heap: heap(1_000, ['code_space']),
    };
    let managedReport: Record<string, unknown> = {
      rssBytes: 50,
      cpuPercent: 80,
    };
    const p = paired(
      {},
      reporting('legacy', () => legacyReport),
      reporting('managed', () => managedReport),
    );
    await bothEngines(p);
    expect(p.bridge.liveChannelCount).toBe(2);

    await p.bridge.refreshChildResource!();
    expect(p.bridge.getChildResourceSnapshot!()).toMatchObject({
      rssBytes: 150,
      // Each child's share of the machine adds up, within the machine.
      cpuPercent: 100,
      children: 2,
      heapReported: 1,
      heap: heap(1_000, ['code_space']),
    });

    managedReport = {
      rssBytes: 70,
      cpuPercent: 5,
      heap: heap(2_000, ['shared_space']),
    };
    await p.bridge.refreshChildResource!();
    expect(p.bridge.getChildResourceSnapshot!()).toMatchObject({
      rssBytes: 170,
      cpuPercent: 35,
      children: 2,
      heapReported: 2,
      heap: {
        ...heap(2_000, []),
        unclassifiedSpaceNames: expect.arrayContaining([
          'code_space',
          'shared_space',
        ]),
      },
    });
    expect(
      p.bridge.getChildResourceSnapshot!()!.heap!.unclassifiedSpaceNames,
    ).toHaveLength(2);
  });

  it('keeps sampling one engine while the other child is wedged', async () => {
    const wedged = deferred<Record<string, unknown>>();
    const p = paired(
      {},
      reporting('legacy', () => ({ rssBytes: 100, cpuPercent: 1 })),
      reporting('managed', () => wedged.promise),
    );
    await bothEngines(p);
    const first = p.bridge.refreshChildResource!();
    await vi.waitFor(() =>
      expect(
        p.managed.agent.extMethodCalls.filter(
          (call) => call.method === SERVE_STATUS_EXT_METHODS.workspaceResource,
        ),
      ).toHaveLength(1),
    );
    await p.bridge.refreshChildResource!();
    expect(
      p.legacy.agent.extMethodCalls.filter(
        (call) => call.method === SERVE_STATUS_EXT_METHODS.workspaceResource,
      ),
    ).toHaveLength(2);
    expect(
      p.managed.agent.extMethodCalls.filter(
        (call) => call.method === SERVE_STATUS_EXT_METHODS.workspaceResource,
      ),
    ).toHaveLength(1);
    expect(p.bridge.getChildResourceSnapshot!()).toMatchObject({
      rssBytes: 100,
      children: 1,
    });
    wedged.resolve({ rssBytes: 1, cpuPercent: 1 });
    await first;
  });

  it('does not keep an idle Managed channel alive by sampling it', async () => {
    vi.useFakeTimers();
    const p = paired(
      { channelIdleTimeoutMs: 100 },
      reporting('legacy', () => ({ rssBytes: 1, cpuPercent: 1 })),
      reporting('managed', () => ({ rssBytes: 1, cpuPercent: 1 })),
    );
    await p.bridge.preheat({ keepAliveMs: 10_000 });
    const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(session.sessionId);
    await vi.advanceTimersByTimeAsync(60);
    await p.bridge.refreshChildResource!();
    expect(
      p.managed.agent.extMethodCalls.filter(
        (call) => call.method === SERVE_STATUS_EXT_METHODS.workspaceResource,
      ),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(p.managed.killed).toBe(true);
    expect(p.legacy.killed).toBe(false);
  });

  it('keeps preheat and keepalive on Legacy while Managed follows its idle timeout', async () => {
    vi.useFakeTimers();
    const p = paired({ channelIdleTimeoutMs: 100 });
    await p.bridge.preheat({ keepAliveMs: 1_000 });
    expect(p.legacyFactory).toHaveBeenCalledTimes(1);
    expect(p.managedFactory).not.toHaveBeenCalled();
    const first = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await p.bridge.closeSession(first.sessionId);
    await vi.advanceTimersByTimeAsync(100);
    expect(p.managed.killed).toBe(true);
    expect(p.legacy.killed).toBe(false);
    // Managed work does not stretch the Legacy keepalive either.
    const second = engineChannel('managed');
    p.managedFactory.mockResolvedValue(second.channel);
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await vi.advanceTimersByTimeAsync(900);
    expect(p.legacy.killed).toBe(true);
    expect(second.killed).toBe(false);
  });

  describe('user language', () => {
    const answering = (
      engine: BridgeExecutionEngine,
      log: string[],
      answer: (params: Record<string, unknown>) => Record<string, unknown>,
    ) =>
      engineChannel(engine, {
        newSessionImpl: (_request, agent) => {
          log.push(`${engine}:newSession`);
          return {
            sessionId: `${engine}-${agent.newSessionCalls.length}`,
            ...receipt(engine),
          };
        },
        loadSessionImpl: (request) => {
          log.push(`${engine}:loadSession:${request.sessionId}`);
          return receipt(engine);
        },
        extMethodImpl: (method, params) => {
          if (method !== SERVE_CONTROL_EXT_METHODS.userLanguage) {
            return method === SERVE_CONTROL_EXT_METHODS.sessionClose
              ? { closed: true }
              : {};
          }
          log.push(`${engine}:userLanguage:${String(params['language'])}`);
          return answer(params);
        },
      });
    const refreshed =
      (sessions: number) => (params: Record<string, unknown>) => ({
        language: params['language'],
        sessions,
        failed: 0,
      });
    const request = { language: 'zh', syncOutputLanguage: true };

    it('reaches both engines and adds up their counts', async () => {
      const log: string[] = [];
      const p = paired(
        {},
        answering('legacy', log, refreshed(2)),
        answering('managed', log, refreshed(3)),
      );
      await bothEngines(p);
      await expect(p.bridge.setUserLanguage(request)).resolves.toEqual({
        language: 'zh',
        sessions: 5,
        failed: 0,
      });
      expect(log.filter((line) => line.includes('userLanguage'))).toEqual(
        expect.arrayContaining([
          'legacy:userLanguage:zh',
          'managed:userLanguage:zh',
        ]),
      );
    });

    it('counts a failing engine as one failure and rejects only when every engine fails', async () => {
      const log: string[] = [];
      let legacyFails = false;
      const p = paired(
        {},
        answering('legacy', log, (params) => {
          if (legacyFails) throw new RequestError(-32000, 'legacy unavailable');
          return refreshed(2)(params);
        }),
        answering('managed', log, () => {
          throw new RequestError(-32000, 'managed unavailable');
        }),
      );
      await bothEngines(p);
      await expect(p.bridge.setUserLanguage(request)).resolves.toEqual({
        language: 'zh',
        sessions: 2,
        failed: 1,
      });
      legacyFails = true;
      await expect(p.bridge.setUserLanguage(request)).rejects.toThrow(
        'unavailable',
      );
    });

    it('sends the remembered language to a Managed channel before its first session', async () => {
      const log: string[] = [];
      const p = paired(
        {},
        answering('legacy', log, refreshed(0)),
        answering('managed', log, refreshed(0)),
      );
      await expect(p.bridge.setUserLanguage(request)).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
      await p.bridge.preheat();
      await expect(p.bridge.setUserLanguage(request)).resolves.toMatchObject({
        sessions: 0,
      });
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(log).toEqual([
        'legacy:userLanguage:zh',
        'managed:userLanguage:zh',
        'managed:newSession',
        'managed:newSession',
      ]);
      // A channel that was live for the change is not sent it twice.
      await p.bridge.setUserLanguage({
        language: 'en',
        syncOutputLanguage: false,
      });
      await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(log.slice(4)).toEqual([
        expect.stringMatching(/^(legacy|managed):userLanguage:en$/),
        expect.stringMatching(/^(legacy|managed):userLanguage:en$/),
        'managed:newSession',
      ]);
    });

    it('sends the remembered language before a Managed restore and its deadline', async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const language = deferred<Record<string, unknown>>();
      const managed = engineChannel('managed', {
        extMethodImpl: async (method, params) => {
          if (method !== SERVE_CONTROL_EXT_METHODS.userLanguage) return {};
          log.push(`managed:userLanguage:${String(params['language'])}`);
          await language.promise;
          return refreshed(0)(params);
        },
        loadSessionImpl: async (restore) => {
          log.push(`managed:loadSession:${restore.sessionId}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
          return receipt('managed');
        },
      });
      const p = paired(
        { initializeTimeoutMs: 1_000, sessionRestoreTimeoutMs: 1_000 },
        engineChannel('legacy'),
        managed,
      );
      await expect(p.bridge.setUserLanguage(request)).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
      const restore = p.bridge.loadSession({
        workspaceCwd: WS_A,
        sessionId: 'persisted',
      });
      await vi.advanceTimersByTimeAsync(900);
      expect(log).toEqual(['managed:userLanguage:zh']);
      language.resolve({});
      // The slow language answer does not eat into the restore deadline.
      await vi.advanceTimersByTimeAsync(200);
      await expect(restore).resolves.toMatchObject({ sessionId: 'persisted' });
      expect(log).toEqual([
        'managed:userLanguage:zh',
        'managed:loadSession:persisted',
      ]);
    });

    it('does not block a Managed session when the remembered language fails', async () => {
      const log: string[] = [];
      const p = paired(
        {},
        answering('legacy', log, refreshed(0)),
        answering('managed', log, () => {
          throw new Error('language unsupported');
        }),
      );
      await p.bridge.preheat();
      await p.bridge.setUserLanguage(request);
      await expect(
        p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).resolves.toMatchObject({ sessionId: 'managed-1' });
      expect(log).toEqual([
        'legacy:userLanguage:zh',
        'managed:userLanguage:zh',
        'managed:newSession',
      ]);
    });
  });
});
