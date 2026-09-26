/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  RequestError,
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
