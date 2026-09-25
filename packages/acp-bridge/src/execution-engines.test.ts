/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type NewSessionResponse,
} from '@agentclientprotocol/sdk';
import type { BridgeExecutionEngine, BridgeOptions } from './bridgeOptions.js';
import { SESSION_EXECUTION_ENGINE_META_KEY } from './bridgeOptions.js';
import {
  REQUESTED_SESSION_ID_META_KEY,
  type AcpSessionBridge,
} from './bridgeTypes.js';
import {
  makeBridge,
  makeChannel,
  WS_A,
  type FakeAgentOpts,
} from './internal/testUtils.js';
import { SessionLimitExceededError } from './bridgeErrors.js';
import { SERVE_CONTROL_EXT_METHODS } from './status.js';

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

const bridges: AcpSessionBridge[] = [];
function paired(
  options: Partial<BridgeOptions> = {},
  legacy = engineChannel('legacy'),
  managed = engineChannel('managed'),
) {
  let selected: BridgeExecutionEngine = 'managed';
  const legacyFactory = vi.fn(async () => legacy.channel);
  const managedFactory = vi.fn(async () => managed.channel);
  const select = vi.fn(() => selected);
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

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdown()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ACP Bridge execution engines', () => {
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
      ).rejects.toMatchObject({ reason: 'awaiting_abandoned_cleanup' });
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
    const bridge = makeBridge({
      maxSessions: 1,
      sessionScope: 'thread',
      executionEngines: {
        managed: factory,
        legacy: factory,
        select: async () => {
          await expect(
            bridge.spawnOrAttach({ workspaceCwd: WS_A }),
          ).rejects.toBeInstanceOf(SessionLimitExceededError);
          return selection.promise;
        },
      },
    });
    bridges.push(bridge);
    const spawn = bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const result = Promise.allSettled([spawn]);
    await Promise.resolve();
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
    const managed = engineChannel('managed', {
      loadSessionImpl: () => ({}),
      extMethodImpl: (method, params) => ({
        closed:
          method === SERVE_CONTROL_EXT_METHODS.sessionClose &&
          params['sessionId'] === 'managed-1',
      }),
    });
    const p = paired(
      { freshSessionAdmission: () => ({ release }) },
      engineChannel('legacy'),
      managed,
    );
    const live = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
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
    await p.bridge.closeSession(live.sessionId);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    expect(managed.killed).toBe(true);
    expect(p.legacy.killed).toBe(false);
  });

  it('quarantines an unaddressable success without closing another live session', async () => {
    const managed = engineChannel('managed', {
      newSessionImpl: (_request, agent) => ({
        sessionId: agent.newSessionCalls.length === 1 ? 'valid' : '',
        ...receipt('managed'),
      }),
    });
    const p = paired({}, engineChannel('legacy'), managed);
    const valid = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    expect(managed.killed).toBe(false);
    expect(managed.agent.extMethodCalls).toHaveLength(0);
    p.choose('legacy');
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).resolves.toMatchObject({ sessionId: 'legacy-1' });
    await p.bridge.closeSession(valid.sessionId);
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

  it('reports Managed-only liveness and blocks a multi-channel runtime stop', async () => {
    const p = paired();
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(p.bridge.isChannelLive()).toBe(true);
    expect(p.bridge.getDaemonStatusSnapshot().channelLive).toBe(true);
    expect(p.bridge.getWorkspaceRuntimeLifecycleSnapshot!()).toMatchObject({
      runtimeLive: true,
      activeWork: true,
    });
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(p.bridge.getRuntimeStopSnapshot!().blockedReasons).toContain(
      'multiple_engine_channels',
    );
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

  it('rejects Managed branching before sending a history mutation', async () => {
    const p = paired();
    const session = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await expect(p.bridge.branchSession(session.sessionId, {})).rejects.toThrow(
      'Managed session branching',
    );
    expect(p.managed.agent.extMethodCalls).toHaveLength(0);
    expect(p.legacyFactory).not.toHaveBeenCalled();
  });

  it('rejects branching on a quarantined Legacy channel before mutating history', async () => {
    const legacy = engineChannel('legacy', {
      newSessionImpl: (_request, agent) => ({
        sessionId: agent.newSessionCalls.length === 1 ? 'legacy-source' : '',
        ...receipt('legacy'),
      }),
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionBranch
          ? { newSessionId: 'legacy-branch' }
          : { closed: true },
    });
    const p = paired({}, legacy);
    p.choose('legacy');
    const source = await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('invalid');
    await expect(
      p.bridge.branchSession(source.sessionId, {}),
    ).rejects.toMatchObject({
      reason: 'new_session_cleanup_failed',
    });
    expect(legacy.agent.extMethodCalls).toHaveLength(0);
    expect(p.managedFactory).not.toHaveBeenCalled();
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

  it('awaits both engine startups during shutdown', async () => {
    const legacy = engineChannel('legacy');
    const managed = engineChannel('managed');
    const first = deferred<typeof legacy.channel>();
    const second = deferred<typeof managed.channel>();
    const select = vi
      .fn()
      .mockReturnValueOnce('legacy')
      .mockReturnValueOnce('managed');
    const bridge = makeBridge({
      sessionScope: 'thread',
      executionEngines: {
        legacy: () => first.promise,
        managed: () => second.promise,
        select,
      },
    });
    bridges.push(bridge);
    const spawns = Promise.allSettled([
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ]);
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    const shutdown = bridge.shutdown();
    first.resolve(legacy.channel);
    second.resolve(managed.channel);
    expect((await spawns).every((result) => result.status === 'rejected')).toBe(
      true,
    );
    await shutdown;
    expect(legacy.killed).toBe(true);
    expect(managed.killed).toBe(true);
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
      newSessionImpl: () => late.promise,
    });
    const p = paired(
      { initializeTimeoutMs: 30 },
      engineChannel('legacy'),
      managed,
    );
    p.choose('legacy');
    await p.bridge.spawnOrAttach({ workspaceCwd: WS_A });
    p.choose('managed');
    await expect(
      p.bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ).rejects.toThrow('timed out');
    late.resolve({ sessionId: 'late-managed', ...receipt('managed') });
    await vi.waitFor(() => expect(managed.killed).toBe(true));
    expect(p.legacy.killed).toBe(false);
    expect(p.bridge.sessionCount).toBe(1);
  });
});
