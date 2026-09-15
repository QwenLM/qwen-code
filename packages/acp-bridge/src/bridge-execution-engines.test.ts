/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { NewSessionResponse } from '@agentclientprotocol/sdk';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import type {
  BridgeExecutionSelection,
  BridgeOptions,
} from './bridgeOptions.js';
import type { AcpSessionBridge, BridgeSpawnRequest } from './bridgeTypes.js';
import { REQUESTED_SESSION_ID_META_KEY } from './bridgeTypes.js';
import { AcpChannelTeardownError, type ChannelFactory } from './channel.js';
import {
  BridgeChannelQuarantinedError,
  SessionLimitExceededError,
  SessionNotFoundError,
} from './bridgeErrors.js';
import {
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  SessionRestoreTimeoutError,
} from './status.js';
import {
  makeBridge,
  makeChannel,
  WS_A,
  type ChannelHandle,
} from './internal/testUtils.js';

type Engine = 'legacy' | 'managed';
type Selector = NonNullable<BridgeOptions['executionEngines']>['select'];
const ENGINE_META_KEY = 'qwen.session.executionEngine';
const SESSION_ID = '550e8400-e29b-41d4-a716-446655440501';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function engineChannel(
  engine: Engine,
  overrides: Parameters<typeof makeChannel>[0] = {},
): ChannelHandle {
  return makeChannel({
    newSessionImpl: (request, agent) => ({
      sessionId:
        String(request._meta?.[REQUESTED_SESSION_ID_META_KEY] ?? '') ||
        `${engine}-${agent.newSessionCalls.length}`,
      _meta: { [ENGINE_META_KEY]: engine },
    }),
    loadSessionImpl: () => ({ _meta: { [ENGINE_META_KEY]: engine } }),
    resumeSessionImpl: () => ({ _meta: { [ENGINE_META_KEY]: engine } }),
    extMethodImpl: (method) =>
      method === SERVE_CONTROL_EXT_METHODS.sessionClose ? { closed: true } : {},
    ...overrides,
  });
}

function pairedBridge(
  select: Selector,
  options: Partial<BridgeOptions> = {},
  handles = {
    legacy: engineChannel('legacy'),
    managed: engineChannel('managed'),
  },
) {
  const legacy = vi
    .fn<ChannelFactory>()
    .mockResolvedValue(handles.legacy.channel);
  const managed = vi
    .fn<ChannelFactory>()
    .mockResolvedValue(handles.managed.channel);
  const bridge = makeBridge({
    sessionScope: 'thread',
    channelIdleTimeoutMs: 0,
    ...options,
    executionEngines: { legacy, managed, select },
  });
  return { bridge, legacy, managed, handles };
}

function restore(
  bridge: AcpSessionBridge,
  operation: 'load' | 'resume',
  sessionId: string,
) {
  const request = { workspaceCwd: WS_A, sessionId };
  return operation === 'load'
    ? bridge.loadSession(request)
    : bridge.resumeSession(request);
}

describe('paired execution engine channels', () => {
  it('rejects a paired configuration combined with the generic factory', () => {
    const factory = vi.fn<ChannelFactory>();
    const select = vi.fn<Selector>().mockReturnValue('managed');
    expect(() =>
      makeBridge({
        channelFactory: factory,
        executionEngines: { legacy: factory, managed: factory, select },
      }),
    ).toThrow(/channelFactory/);
    expect(factory).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('hosts both engines in one workspace and sends each prompt to its owner', async () => {
    const select = vi.fn<Selector>((context) =>
      context.request.sourceType === 'channel' ? 'legacy' : 'managed',
    );
    const { bridge, handles, legacy, managed } = pairedBridge(select);
    try {
      const [first, second] = await Promise.all([
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        bridge.spawnOrAttach({ workspaceCwd: WS_A, sourceType: 'channel' }),
      ]);
      expect(first.sessionId).toBe('managed-1');
      expect(second.sessionId).toBe('legacy-1');
      expect(bridge.sessionCount).toBe(2);
      expect(legacy).toHaveBeenCalledOnce();
      expect(managed).toHaveBeenCalledOnce();
      for (const session of [first, second]) {
        await bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: session.sessionId }],
        });
      }
      expect(
        handles.managed.agent.promptCalls.map((call) => call.sessionId),
      ).toEqual([first.sessionId]);
      expect(
        handles.legacy.agent.promptCalls.map((call) => call.sessionId),
      ).toEqual([second.sessionId]);
    } finally {
      await bridge.shutdown();
    }
    expect(handles.legacy.killed).toBe(true);
    expect(handles.managed.killed).toBe(true);
  });

  it('coalesces concurrent channel creation for the same engine without merging sessions', async () => {
    const gate = deferred<void>();
    const handle = engineChannel('managed');
    const managed = vi.fn<ChannelFactory>(async () => {
      await gate.promise;
      return handle.channel;
    });
    const legacy = vi.fn<ChannelFactory>();
    const select = vi.fn<Selector>().mockReturnValue('managed');
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelIdleTimeoutMs: 0,
      executionEngines: { legacy, managed, select },
    });
    const pending = Promise.all([
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
    ]);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(managed).toHaveBeenCalledOnce());
      expect(handle.agent.newSessionCalls).toHaveLength(0);
      gate.resolve();
      const sessions = await pending;
      expect(sessions.map((session) => session.sessionId).sort()).toEqual([
        'managed-1',
        'managed-2',
      ]);
      expect(handle.agent.initializeCalls).toHaveLength(1);
      expect(handle.agent.newSessionCalls).toHaveLength(2);
      expect(managed).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await pending.catch(() => undefined);
      await bridge.shutdown();
    }
  });

  it('does not select again when single scope attaches to a live session', async () => {
    const select = vi
      .fn<Selector>()
      .mockReturnValueOnce('managed')
      .mockReturnValue('legacy');
    const { bridge, handles, legacy } = pairedBridge(select, {
      sessionScope: 'single',
    });
    try {
      const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const attached = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sourceType: 'channel',
      });
      expect(attached).toMatchObject({
        sessionId: first.sessionId,
        attached: true,
      });
      expect(select).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
      expect(handles.managed.agent.newSessionCalls).toHaveLength(1);
    } finally {
      await bridge.shutdown();
    }
  });

  it.each(['load', 'resume'] as const)(
    'selects the persisted owner for cold %s and preserves it on hot attach',
    async (operation) => {
      const select = vi.fn<Selector>((context) =>
        context.operation === 'spawn' ? 'managed' : 'legacy',
      );
      const { bridge, handles, legacy, managed } = pairedBridge(select);
      try {
        await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        const loaded = await restore(bridge, operation, 'persisted-legacy');
        expect(loaded).toMatchObject({
          sessionId: 'persisted-legacy',
          attached: false,
        });
        expect(select).toHaveBeenLastCalledWith({
          operation,
          request: { workspaceCwd: WS_A, sessionId: 'persisted-legacy' },
          daemonOwnedStandalone: false,
        });
        const attached = await bridge.resumeSession({
          workspaceCwd: WS_A,
          sessionId: loaded.sessionId,
        });
        expect(attached).toMatchObject({
          sessionId: loaded.sessionId,
          attached: true,
        });
        expect(select).toHaveBeenCalledTimes(2);
        expect(legacy).toHaveBeenCalledOnce();
        expect(managed).toHaveBeenCalledOnce();
        expect(handles.legacy.agent.loadSessionCalls).toHaveLength(
          operation === 'load' ? 1 : 0,
        );
        expect(handles.legacy.agent.resumeSessionCalls).toHaveLength(
          operation === 'resume' ? 1 : 0,
        );
        expect(handles.managed.agent.loadSessionCalls).toHaveLength(0);
        expect(handles.managed.agent.resumeSessionCalls).toHaveLength(0);
      } finally {
        await bridge.shutdown();
      }
    },
  );

  it('gives the selector an independent validated snapshot before calling a factory', async () => {
    const gate = deferred<void>();
    const rejected = new Error('unsupported effective configuration');
    const contexts: BridgeExecutionSelection[] = [];
    const select = vi.fn<Selector>(async (context) => {
      contexts.push(context);
      await gate.promise;
      throw rejected;
    });
    const { bridge, legacy, managed } = pairedBridge(select);
    const request: BridgeSpawnRequest = {
      workspaceCwd: WS_A,
      modelServiceId: 'original-model',
      sessionId: SESSION_ID,
      parentSessionId: 'parent',
      sourceType: 'default',
      sourceId: 'scheduled_task_run:one',
      approvalMode: ApprovalMode.PLAN,
      worktree: { slug: 'one', path: WS_A, branch: 'original-worktree' },
      branch: { name: 'original-branch', baseBranch: 'main' },
    };
    const expected = structuredClone(request);
    const pending = bridge
      .spawnOrAttach(request)
      .catch((error: unknown) => error);
    request.modelServiceId = 'mutated-model';
    request.branch!.name = 'mutated-branch';
    request.worktree!.branch = 'mutated-worktree';
    try {
      await vi.waitFor(() => expect(contexts).toHaveLength(1));
      expect(contexts[0]).toEqual({
        operation: 'spawn',
        request: { ...expected, sessionScope: 'thread' },
        daemonOwnedStandalone: false,
      });
      expect(legacy).not.toHaveBeenCalled();
      expect(managed).not.toHaveBeenCalled();
      gate.resolve();
      expect(await pending).toBe(rejected);
    } finally {
      gate.resolve();
      await pending;
      await bridge.shutdown();
    }
  });

  it('shares maxSessions across selectors waiting to create or restore either engine', async () => {
    const gate = deferred<void>();
    const select = vi.fn<Selector>(async (context) => {
      await gate.promise;
      return context.operation === 'spawn' ? 'managed' : 'legacy';
    });
    const { bridge, legacy, managed } = pairedBridge(select, {
      maxSessions: 2,
    });
    const pending = Promise.all([
      bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      bridge.loadSession({ workspaceCwd: WS_A, sessionId: 'pending-legacy' }),
    ]);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
      await expect(
        bridge.resumeSession({
          workspaceCwd: WS_A,
          sessionId: 'over-capacity',
        }),
      ).rejects.toBeInstanceOf(SessionLimitExceededError);
      expect(select).toHaveBeenCalledTimes(2);
      expect(legacy).not.toHaveBeenCalled();
      expect(managed).not.toHaveBeenCalled();
      gate.resolve();
      await pending;
      expect(bridge.sessionCount).toBe(2);
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toBeInstanceOf(SessionLimitExceededError);
      expect(select).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await pending.catch(() => undefined);
      await bridge.shutdown();
    }
  });

  it.each(['spawn', 'load', 'resume'] as const)(
    'waits for a pending %s selector during shutdown without creating a late channel',
    async (operation) => {
      const gate = deferred<Engine>();
      const select = vi.fn<Selector>(() => gate.promise);
      const release = vi.fn();
      const { bridge, legacy, managed } = pairedBridge(select, {
        freshSessionAdmission: () => ({ release }),
      });
      const pending = (
        operation === 'spawn'
          ? bridge.spawnOrAttach({ workspaceCwd: WS_A })
          : restore(bridge, operation, 'pending-restore')
      ).catch((error: unknown) => error);
      let shutdown: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
        let stopped = false;
        shutdown = bridge.shutdown().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(release).not.toHaveBeenCalled();
        gate.resolve('managed');
        expect(await pending).toMatchObject({
          message: expect.stringMatching(/shutting down/i),
        });
        await shutdown;
        expect(stopped).toBe(true);
        expect(release).toHaveBeenCalledOnce();
        expect(legacy).not.toHaveBeenCalled();
        expect(managed).not.toHaveBeenCalled();
        expect(bridge.sessionCount).toBe(0);
      } finally {
        gate.resolve('managed');
        await pending;
        await (shutdown ?? bridge.shutdown());
      }
    },
  );

  it.each([
    ['spawn', undefined],
    ['spawn', 'legacy'],
    ['load', undefined],
    ['load', 'legacy'],
    ['resume', undefined],
    ['resume', 'legacy'],
  ] as const)(
    'closes a %s receipt with owner %s on its actual channel before releasing admission',
    async (operation, receiptOwner) => {
      const closeGate = deferred<void>();
      const meta =
        receiptOwner === undefined ? {} : { [ENGINE_META_KEY]: receiptOwner };
      const handles = {
        legacy: engineChannel('legacy'),
        managed: engineChannel('managed', {
          newSessionImpl: () => ({ sessionId: SESSION_ID, _meta: meta }),
          loadSessionImpl: () => ({ _meta: meta }),
          resumeSessionImpl: () => ({ _meta: meta }),
          extMethodImpl: async (method) => {
            if (method !== SERVE_CONTROL_EXT_METHODS.sessionClose) return {};
            await closeGate.promise;
            return { closed: true };
          },
        }),
      };
      const select = vi.fn<Selector>().mockReturnValue('managed');
      const release = vi.fn();
      const { bridge, legacy, managed } = pairedBridge(
        select,
        {
          maxSessions: 1,
          freshSessionAdmission: () => ({ release }),
        },
        handles,
      );
      const pending = (
        operation === 'spawn'
          ? bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionId: SESSION_ID })
          : restore(bridge, operation, SESSION_ID)
      ).catch((error: unknown) => error);
      try {
        await vi.waitFor(() => {
          expect(handles.managed.agent.extMethodCalls).toContainEqual({
            method: SERVE_CONTROL_EXT_METHODS.sessionClose,
            params: expect.objectContaining({ sessionId: SESSION_ID }),
          });
        });
        expect(release).not.toHaveBeenCalled();
        expect(bridge.sessionCount).toBe(0);
        expect(() => bridge.getSessionSummary(SESSION_ID)).toThrow(
          SessionNotFoundError,
        );
        await expect(
          bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ).rejects.toBeInstanceOf(SessionLimitExceededError);
        expect(legacy).not.toHaveBeenCalled();
        expect(managed).toHaveBeenCalledOnce();
        expect(handles.legacy.agent.extMethodCalls).toHaveLength(0);
        closeGate.resolve();
        expect(await pending).toMatchObject({
          message: expect.stringMatching(/execution engine/i),
        });
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
        expect(select).toHaveBeenCalledOnce();
      } finally {
        closeGate.resolve();
        await pending;
        await bridge.shutdown();
      }
    },
  );

  it.each(['legacy', 'managed'] as const)(
    'drops live notifications and permissions sent from the foreign %s channel',
    async (foreignEngine) => {
      const select = vi.fn<Selector>((context) =>
        context.request.sourceType === 'channel' ? 'legacy' : 'managed',
      );
      const { bridge, handles } = pairedBridge(select);
      try {
        const managed = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        const legacy = await bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          sourceType: 'channel',
        });
        const target = foreignEngine === 'legacy' ? managed : legacy;
        const owner =
          foreignEngine === 'legacy' ? handles.managed : handles.legacy;
        const foreign = handles[foreignEngine];
        const before = bridge.getSessionLastEventId(target.sessionId);
        await foreign.agentConnection.sessionUpdate({
          sessionId: target.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'foreign update' },
          },
        });
        await foreign.agentConnection.extNotification(
          'qwen/notify/session/terminal-sequence',
          {
            v: 1,
            sessionId: target.sessionId,
            marker: 'foreign terminal',
          },
        );
        await expect(
          foreign.agentConnection.requestPermission({
            sessionId: target.sessionId,
            toolCall: {
              toolCallId: 'foreign-tool',
              title: 'Foreign tool',
              status: 'pending',
            },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          }),
        ).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        expect(bridge.getSessionLastEventId(target.sessionId)).toBe(before);
        await owner.agentConnection.sessionUpdate({
          sessionId: target.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'owner update' },
          },
        });
        await vi.waitFor(() =>
          expect(bridge.getSessionLastEventId(target.sessionId)).toBe(
            before + 1,
          ),
        );
      } finally {
        await bridge.shutdown();
      }
    },
  );

  it('buffers cold restore notifications only from the selected channel', async () => {
    const gate = deferred<void>();
    const handles = {
      legacy: engineChannel('legacy'),
      managed: engineChannel('managed', {
        loadSessionImpl: async () => {
          await gate.promise;
          return { _meta: { [ENGINE_META_KEY]: 'managed' } };
        },
      }),
    };
    const select = vi.fn<Selector>((context) =>
      context.operation === 'spawn' ? 'legacy' : 'managed',
    );
    const { bridge } = pairedBridge(select, {}, handles);
    let pending: ReturnType<AcpSessionBridge['loadSession']> | undefined;
    try {
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      pending = bridge.loadSession({
        workspaceCwd: WS_A,
        sessionId: 'pending-media-restore',
        historyReplay: 'response',
      });
      void pending.catch(() => undefined);
      await vi.waitFor(() =>
        expect(handles.managed.agent.loadSessionCalls).toHaveLength(1),
      );
      for (const [handle, text] of [
        [handles.legacy, 'foreign replay'],
        [handles.managed, 'owner replay'],
      ] as const) {
        await handle.agentConnection.sessionUpdate({
          sessionId: 'pending-media-restore',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        });
      }
      gate.resolve();
      const loaded = await pending;
      expect(JSON.stringify(loaded.liveJournal)).toContain('owner replay');
      expect(JSON.stringify(loaded.liveJournal)).not.toContain(
        'foreign replay',
      );
      expect(loaded.liveJournal).toHaveLength(1);
    } finally {
      gate.resolve();
      await pending?.catch(() => undefined);
      await bridge.shutdown();
    }
  });

  it('quarantines one factory teardown failure without blocking the other engine', async () => {
    const failure = new AcpChannelTeardownError(
      new Error('unconfirmed legacy resource'),
    );
    const legacy = vi.fn<ChannelFactory>().mockRejectedValue(failure);
    const handle = engineChannel('managed');
    const managed = vi.fn<ChannelFactory>().mockResolvedValue(handle.channel);
    const select = vi.fn<Selector>((context) =>
      context.request.sourceType === 'channel' ? 'legacy' : 'managed',
    );
    const bridge = makeBridge({
      sessionScope: 'thread',
      executionEngines: { legacy, managed, select },
    });
    try {
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A, sourceType: 'channel' }),
      ).rejects.toBe(failure);
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'healthy managed channel' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A, sourceType: 'channel' }),
      ).rejects.toBe(failure);
      expect(legacy).toHaveBeenCalledOnce();
      expect(managed).toHaveBeenCalledOnce();
      expect(bridge.sessionCount).toBe(1);
    } finally {
      await expect(bridge.shutdown()).rejects.toBe(failure);
    }
    expect(handle.killed).toBe(true);
  });

  it('keeps each idle deadline when the other channel is reused or exits', async () => {
    vi.useFakeTimers();
    const select = vi.fn<Selector>((context) =>
      context.request.sourceType === 'channel' ? 'legacy' : 'managed',
    );
    const { bridge, handles, legacy, managed } = pairedBridge(select, {
      channelIdleTimeoutMs: 1000,
    });
    try {
      const firstManaged = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const firstLegacy = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sourceType: 'channel',
      });
      await bridge.closeSession(firstLegacy.sessionId);
      await vi.advanceTimersByTimeAsync(100);
      const secondManaged = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.closeSession(firstManaged.sessionId);
      await bridge.closeSession(secondManaged.sessionId);
      await vi.advanceTimersByTimeAsync(900);
      expect(handles.legacy.killed).toBe(true);
      expect(handles.managed.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(handles.managed.killed).toBe(true);
      expect(legacy).toHaveBeenCalledOnce();
      expect(managed).toHaveBeenCalledOnce();
      expect(bridge.sessionCount).toBe(0);
    } finally {
      await bridge.shutdown();
      vi.useRealTimers();
    }
  });

  it.each(['unsupported', 'throw', 'reject'] as const)(
    'does not start either factory when selection fails with %s',
    async (mode) => {
      const failure = new Error('configuration could not be verified');
      const select = vi
        .fn<Selector>()
        .mockReturnValue('managed')
        .mockImplementationOnce(() => {
          if (mode === 'throw') throw failure;
          if (mode === 'reject') return Promise.reject(failure);
          return 'unexpected-engine' as Engine;
        });
      const release = vi.fn();
      const { bridge, legacy, managed } = pairedBridge(select, {
        maxSessions: 1,
        freshSessionAdmission: () => ({ release }),
      });
      try {
        const pending = bridge.spawnOrAttach({ workspaceCwd: WS_A });
        if (mode === 'unsupported')
          await expect(pending).rejects.toThrow('unsupported engine');
        else await expect(pending).rejects.toBe(failure);
        expect(legacy).not.toHaveBeenCalled();
        expect(managed).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        expect(session.sessionId).toBe('managed-1');
        expect(select).toHaveBeenCalledTimes(2);
        expect(managed).toHaveBeenCalledOnce();
        expect(legacy).not.toHaveBeenCalled();
      } finally {
        await bridge.shutdown();
      }
    },
  );

  it('rejects an identical id returned by the other engine without replacing the live owner', async () => {
    const handles = {
      legacy: engineChannel('legacy', {
        newSessionImpl: () => ({
          sessionId: SESSION_ID,
          _meta: { [ENGINE_META_KEY]: 'legacy' },
        }),
      }),
      managed: engineChannel('managed', {
        newSessionImpl: () => ({
          sessionId: SESSION_ID,
          _meta: { [ENGINE_META_KEY]: 'managed' },
        }),
      }),
    };
    const select = vi.fn<Selector>((context) =>
      context.request.sourceType === 'channel' ? 'legacy' : 'managed',
    );
    const { bridge } = pairedBridge(select, {}, handles);
    try {
      const original = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const epoch = bridge.getSessionEventEpoch(original.sessionId);
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A, sourceType: 'channel' }),
      ).rejects.toThrow('already live session id');
      expect(bridge.sessionCount).toBe(1);
      expect(bridge.getSessionEventEpoch(original.sessionId)).toBe(epoch);
      expect(handles.legacy.agent.extMethodCalls).toContainEqual({
        method: SERVE_CONTROL_EXT_METHODS.sessionClose,
        params: expect.objectContaining({ sessionId: SESSION_ID }),
      });
      expect(
        handles.managed.agent.extMethodCalls.filter(
          (call) => call.method === SERVE_CONTROL_EXT_METHODS.sessionClose,
        ),
      ).toHaveLength(0);
      await bridge.sendPrompt(original.sessionId, {
        sessionId: original.sessionId,
        prompt: [{ type: 'text', text: 'original owner survives' }],
      });
      expect(handles.managed.agent.promptCalls).toHaveLength(1);
      expect(handles.legacy.agent.promptCalls).toHaveLength(0);
      expect(handles.managed.killed).toBe(false);
    } finally {
      await bridge.shutdown();
    }
  });

  it.each([
    'empty missing owner',
    'empty matching owner',
    'null result',
  ] as const)(
    'quarantines an unaddressable new-session success: %s',
    async (receipt) => {
      const handles = {
        legacy: engineChannel('legacy'),
        managed: engineChannel('managed', {
          newSessionImpl: (_request, agent) => {
            if (agent.newSessionCalls.length === 1) {
              return {
                sessionId: 'managed-sibling',
                _meta: { [ENGINE_META_KEY]: 'managed' },
              };
            }
            if (receipt === 'null result')
              return null as unknown as NewSessionResponse;
            return {
              sessionId: '',
              _meta:
                receipt === 'empty matching owner'
                  ? { [ENGINE_META_KEY]: 'managed' }
                  : {},
            };
          },
        }),
      };
      const select = vi.fn<Selector>((context) =>
        context.request.sourceType === 'channel' ? 'legacy' : 'managed',
      );
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      const { bridge, legacy, managed } = pairedBridge(
        select,
        {
          maxSessions: 3,
          freshSessionAdmission: () => {
            const release = vi.fn();
            releases.push(release);
            return { release };
          },
        },
        handles,
      );
      let pending: Promise<unknown> | undefined;
      let siblingId: string | undefined;
      try {
        const sibling = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        siblingId = sibling.sessionId;
        pending = bridge
          .spawnOrAttach({ workspaceCwd: WS_A })
          .catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(handles.managed.agent.newSessionCalls).toHaveLength(2),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(() => bridge.getSessionSummary('')).toThrow(
          SessionNotFoundError,
        );
        expect(bridge.sessionCount).toBe(1);
        expect(releases[1]).not.toHaveBeenCalled();
        expect(
          handles.managed.agent.extMethodCalls.filter(
            (call) =>
              call.method === SERVE_CONTROL_EXT_METHODS.sessionClose &&
              call.params['sessionId'] === '',
          ),
        ).toHaveLength(0);
        await expect(
          bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ).rejects.toBeInstanceOf(BridgeChannelQuarantinedError);
        const other = await bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          sourceType: 'channel',
        });
        expect(other.sessionId).toBe('legacy-1');
        expect(legacy).toHaveBeenCalledOnce();
        expect(managed).toHaveBeenCalledOnce();
        expect(releases[1]).not.toHaveBeenCalled();
        await bridge.closeSession(sibling.sessionId);
        siblingId = undefined;
        expect(await pending).toMatchObject({
          message: expect.stringMatching(/execution engine/i),
        });
        expect(releases[1]).toHaveBeenCalledOnce();
        expect(handles.managed.killed).toBe(true);
        expect(handles.legacy.killed).toBe(false);
      } finally {
        if (siblingId)
          await bridge.closeSession(siblingId).catch(() => undefined);
        await bridge.shutdown();
        await pending;
      }
    },
  );

  it('retains branch admission through a timed-out raw restore and its close receipt', async () => {
    vi.useFakeTimers();
    const loadGate = deferred<void>();
    const closeGate = deferred<void>();
    const branchRelease = vi.fn();
    const branchAdmission = vi.fn();
    const handles = {
      managed: engineChannel('managed'),
      legacy: engineChannel('legacy', {
        loadSessionImpl: async () => {
          await loadGate.promise;
          return { _meta: { [ENGINE_META_KEY]: 'legacy' } };
        },
        extMethodImpl: async (method, params) => {
          if (method === SERVE_CONTROL_EXT_METHODS.sessionBranch)
            return { newSessionId: 'pending-legacy-branch' };
          if (method !== SERVE_CONTROL_EXT_METHODS.sessionClose) return {};
          if (params['sessionId'] === 'pending-legacy-branch')
            await closeGate.promise;
          return { closed: true };
        },
      }),
    };
    const select = vi.fn<Selector>().mockReturnValue('legacy');
    const { bridge } = pairedBridge(
      select,
      {
        sessionRestoreTimeoutMs: 20,
        channelIdleTimeoutMs: 1000,
        freshSessionAdmission: (context) => {
          if (context.operation === 'branch') {
            branchAdmission(context);
            return { release: branchRelease };
          }
          return { release: vi.fn() };
        },
      },
      handles,
    );
    let pending: Promise<unknown> | undefined;
    try {
      const source = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      pending = bridge
        .branchSession(source.sessionId, {})
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(handles.legacy.agent.loadSessionCalls).toHaveLength(1);
      expect(branchAdmission).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toBeInstanceOf(SessionRestoreTimeoutError);
      expect(branchRelease).not.toHaveBeenCalled();
      expect(handles.legacy.killed).toBe(false);
      expect(
        handles.legacy.agent.extMethodCalls.filter(
          (call) => call.method === SERVE_CONTROL_EXT_METHODS.sessionClose,
        ),
      ).toHaveLength(0);
      loadGate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(handles.legacy.agent.extMethodCalls).toContainEqual({
        method: SERVE_CONTROL_EXT_METHODS.sessionClose,
        params: expect.objectContaining({ sessionId: 'pending-legacy-branch' }),
      });
      expect(branchRelease).not.toHaveBeenCalled();
      closeGate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(branchRelease).toHaveBeenCalledOnce();
      expect(bridge.sessionCount).toBe(1);
      expect(() => bridge.getSessionSummary('pending-legacy-branch')).toThrow(
        SessionNotFoundError,
      );
      await expect(
        bridge.sendPrompt(source.sessionId, {
          sessionId: source.sessionId,
          prompt: [{ type: 'text', text: 'source remains usable' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    } finally {
      loadGate.resolve();
      closeGate.resolve();
      try {
        await vi.advanceTimersByTimeAsync(0);
        await pending;
        await bridge.shutdown();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('pages a live Managed transcript on the owner channel', async () => {
    const select = vi.fn<Selector>().mockReturnValue('managed');
    const handles = {
      legacy: engineChannel('legacy', {
        extMethodImpl: pagingExtMethod('legacy'),
      }),
      managed: engineChannel('managed', {
        extMethodImpl: pagingExtMethod('managed'),
      }),
    };
    const { bridge, legacy, managed } = pairedBridge(select, {}, handles);
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(legacy).not.toHaveBeenCalled();
      const page = await bridge.getSessionTranscriptPage({
        sessionId: session.sessionId,
        limit: 2,
      });
      expect(page).toMatchObject({
        v: 1,
        sessionId: session.sessionId,
        engine: 'managed',
      });
      expect(legacy).not.toHaveBeenCalled();
      expect(managed).toHaveBeenCalledOnce();
      expect(handles.legacy.agent.extMethodCalls).toEqual([]);
      expect(handles.managed.agent.extMethodCalls).toContainEqual({
        method: SERVE_STATUS_EXT_METHODS.sessionTranscript,
        params: {
          cwd: WS_A,
          sessionId: session.sessionId,
          limit: 2,
        },
      });
      const index = await bridge.getSessionTurnIndexPage({
        sessionId: session.sessionId,
        start: 0,
        limit: 2,
      });
      expect(index).toMatchObject({
        v: 1,
        sessionId: session.sessionId,
        snapshot: 'managed',
      });
      expect(legacy).not.toHaveBeenCalled();
      expect(handles.legacy.agent.extMethodCalls).toEqual([]);
      expect(handles.managed.agent.extMethodCalls).toContainEqual({
        method: SERVE_STATUS_EXT_METHODS.sessionTurnIndex,
        params: {
          cwd: WS_A,
          sessionId: session.sessionId,
          start: 0,
          limit: 2,
        },
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('pages an unknown session transcript through the legacy control channel', async () => {
    const select = vi.fn<Selector>().mockReturnValue('managed');
    const handles = {
      legacy: engineChannel('legacy', {
        extMethodImpl: pagingExtMethod('legacy'),
      }),
      managed: engineChannel('managed', {
        extMethodImpl: pagingExtMethod('managed'),
      }),
    };
    const { bridge, legacy, managed } = pairedBridge(select, {}, handles);
    try {
      const page = await bridge.getSessionTranscriptPage({
        sessionId: SESSION_ID,
        beforeRecordId: 'record-3',
      });
      expect(page).toMatchObject({
        v: 1,
        sessionId: SESSION_ID,
        engine: 'legacy',
      });
      expect(select).not.toHaveBeenCalled();
      expect(managed).not.toHaveBeenCalled();
      expect(legacy).toHaveBeenCalledOnce();
      expect(handles.managed.agent.extMethodCalls).toEqual([]);
      expect(handles.legacy.agent.extMethodCalls).toEqual([
        {
          method: SERVE_STATUS_EXT_METHODS.sessionTranscript,
          params: {
            cwd: WS_A,
            sessionId: SESSION_ID,
            beforeRecordId: 'record-3',
          },
        },
      ]);
    } finally {
      await bridge.shutdown();
    }
  });
});

function pagingExtMethod(engine: Engine) {
  return (method: string, params: Record<string, unknown>) => {
    if (method === SERVE_CONTROL_EXT_METHODS.sessionClose) {
      return { closed: true };
    }
    if (method === SERVE_STATUS_EXT_METHODS.sessionTranscript) {
      return {
        v: 1,
        sessionId: params['sessionId'],
        events: [],
        hasMore: false,
        engine,
      };
    }
    if (method === SERVE_STATUS_EXT_METHODS.sessionTurnIndex) {
      return {
        v: 1,
        sessionId: params['sessionId'],
        snapshot: engine,
        totalTurns: 0,
        start: 0,
        turns: [],
      };
    }
    throw new Error(`unexpected extMethod ${method}`);
  };
}
