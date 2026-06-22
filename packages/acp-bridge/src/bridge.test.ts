/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  InitializeResponse,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionResponse,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  InvalidSessionScopeError,
  NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE,
  PromptQueueFullError,
  RestoreInProgressError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  SessionBusyError,
  SessionNotFoundError,
  WorkspaceMismatchError,
} from './bridgeErrors.js';
import { MAX_WORKSPACE_PATH_LENGTH } from './workspacePaths.js';
import { extractErrorMessage, extractErrorCode } from './bridge.js';
import type { ChannelFactory } from './channel.js';
import type { BridgeTelemetry } from './bridgeOptions.js';
import { createInMemoryChannel } from './inMemoryChannel.js';
import type { BridgeEvent } from './eventBus.js';
import { ApprovalMode, ShellExecutionService } from '@qwen-code/qwen-code-core';
import {
  FakeAgent,
  type ChannelHandle,
  makeBridge,
  makeChannel,
  WS_A,
  WS_B,
  SESS_A,
} from './internal/testUtils.js';

describe('createAcpSessionBridge', () => {
  it('accepts a valid BridgeOptions.eventRingSize at construction time', () => {
    // Smoke: positive finite integers are accepted; the underlying
    // EventBus ring-size threading is exercised end-to-end in
    // `eventBus.test.ts` ("default ring size is 8000 (#3803 §02
    // target)"). The bridge layer only contributes validation +
    // pass-through.
    expect(() => makeBridge({ eventRingSize: 1 })).not.toThrow();
    expect(() => makeBridge({ eventRingSize: 8000 })).not.toThrow();
    expect(() => makeBridge({ eventRingSize: 100_000 })).not.toThrow();
  });

  it('rejects an invalid eventRingSize at construction time', () => {
    expect(() => makeBridge({ eventRingSize: 0 })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() => makeBridge({ eventRingSize: -1 })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() => makeBridge({ eventRingSize: 1.5 })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() => makeBridge({ eventRingSize: Number.NaN })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() =>
      makeBridge({ eventRingSize: Number.POSITIVE_INFINITY }),
    ).toThrow(/Invalid eventRingSize/);
    // Upper-bound typo defense (1M cap). `80_000_000` here mimics the
    // common shell typo `--event-ring-size 80000000` vs `8000000`.
    expect(() => makeBridge({ eventRingSize: 80_000_000 })).toThrow(
      /Invalid eventRingSize/,
    );
  });

  it('uses bridge telemetry for channel/session/prompt dispatch and prompt metadata injection', async () => {
    const handle = makeChannel();
    const operations: string[] = [];
    const events: string[] = [];
    const spanAttributes = new Map<string, Record<string, unknown>>();
    const telemetry: BridgeTelemetry = {
      captureContext: () => {
        events.push('capture');
        return { captured: true };
      },
      async runWithContext(captured, fn) {
        events.push(
          `run:${(captured as { captured?: boolean } | undefined)?.captured === true}`,
        );
        return await fn();
      },
      async withSpan(operation, attributes, fn) {
        operations.push(operation);
        spanAttributes.set(operation, attributes);
        events.push(`span:${operation}:start`);
        try {
          return await fn();
        } finally {
          events.push(`span:${operation}:end`);
        }
      },
      event() {},
      injectPromptContext(request) {
        events.push('inject');
        const meta =
          (request as { _meta?: Record<string, unknown> })._meta ?? {};
        return {
          ...request,
          _meta: {
            ...meta,
            'qwen.telemetry.traceparent': 'daemon-traceparent',
          },
        };
      },
    };
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      telemetry,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    await bridge.sendPrompt(
      session.sessionId,
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
        _meta: {
          keep: 'value',
          'qwen.telemetry.traceparent': 'client-spoof',
        },
      } as PromptRequest,
      undefined,
      { clientId: session.clientId },
    );

    expect(operations).toEqual(
      expect.arrayContaining([
        'channel.spawn',
        'channel.initialize',
        'session.new',
        'prompt.dispatch',
      ]),
    );
    expect(events.slice(-4)).toEqual([
      'run:true',
      'span:prompt.dispatch:start',
      'inject',
      'span:prompt.dispatch:end',
    ]);
    expect(handle.agent.promptCalls[0]!._meta).toMatchObject({
      keep: 'value',
      'qwen.telemetry.traceparent': 'daemon-traceparent',
    });
    expect(session.clientId).toBeDefined();
    expect(spanAttributes.get('prompt.dispatch')).toMatchObject({
      'qwen-code.client_id': session.clientId,
    });
  });

  it('forwards childEnvOverrides to the channelFactory at spawn time (#4247 R6 line 216)', async () => {
    // Round 6 (wenshao R5 line 216): pre-fix `runQwenServe` set
    // `process.env` globally to pass the MCP budget config to the
    // ACP child. With concurrent embedded daemons, the last
    // `runQwenServe` to set the var would silently win for all
    // other daemons' subsequent spawns (because
    // `defaultSpawnChannelFactory` snapshots `process.env` AT
    // SPAWN TIME, not at runQwenServe time). The fix routes the
    // env through `BridgeOptions.childEnvOverrides` closed over
    // inside each bridge — so each bridge's spawn factory sees
    // ITS own overrides, regardless of what other daemons did.
    const seenEnvs: Array<Record<string, string | undefined> | undefined> = [];
    const factory: ChannelFactory = async (_cwd, env) => {
      // Snapshot the override map so later iterations don't
      // accidentally mutate the recorded value.
      seenEnvs.push(env ? { ...env } : env);
      return makeChannel().channel;
    };
    const bridge1 = makeBridge({
      channelFactory: factory,
      childEnvOverrides: {
        QWEN_SERVE_MCP_CLIENT_BUDGET: '5',
        QWEN_SERVE_MCP_BUDGET_MODE: 'enforce',
      },
    });
    const bridge2 = makeBridge({
      channelFactory: factory,
      childEnvOverrides: {
        QWEN_SERVE_MCP_CLIENT_BUDGET: '20',
        QWEN_SERVE_MCP_BUDGET_MODE: 'warn',
      },
    });
    await bridge1.spawnOrAttach({ workspaceCwd: WS_A });
    await bridge2.spawnOrAttach({ workspaceCwd: WS_A });
    expect(seenEnvs).toHaveLength(2);
    expect(seenEnvs[0]).toEqual({
      QWEN_SERVE_MCP_CLIENT_BUDGET: '5',
      QWEN_SERVE_MCP_BUDGET_MODE: 'enforce',
    });
    expect(seenEnvs[1]).toEqual({
      QWEN_SERVE_MCP_CLIENT_BUDGET: '20',
      QWEN_SERVE_MCP_BUDGET_MODE: 'warn',
    });
    await bridge1.shutdown();
    await bridge2.shutdown();
  });

  it('spawns a session and returns the agent-assigned id', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(session.sessionId).toBe(SESS_A);
    expect(session.workspaceCwd).toBe(WS_A);
    expect(session.attached).toBe(false);
    expect(session.clientId).toMatch(/^client_/);
    expect(bridge.sessionCount).toBe(1);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.agent.newSessionCalls[0]?.cwd).toBe(WS_A);

    await bridge.shutdown();
    expect(handles[0]?.killed).toBe(true);
  });

  it('reuses the existing session under sessionScope:single', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(true);
    expect(first.clientId).toMatch(/^client_/);
    expect(second.clientId).toMatch(/^client_/);
    expect(second.clientId).not.toBe(first.clientId);
    expect(handles).toHaveLength(1); // only one child spawned
    expect(bridge.sessionCount).toBe(1);

    await bridge.shutdown();
  });

  it('requests session status through the existing ACP channel', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/status/session/context') {
              return {
                v: 1,
                sessionId: params['sessionId'],
                workspaceCwd: WS_A,
                state: {},
              };
            }
            if (method === 'qwen/status/session/tasks') {
              return {
                v: 1,
                sessionId: params['sessionId'],
                now: 1_700_000_000_000,
                tasks: [],
              };
            }
            return {
              v: 1,
              sessionId: params['sessionId'],
              availableCommands: [],
              availableSkills: [],
            };
          },
        });
        handles.push(h);
        return h.channel;
      },
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    await expect(
      bridge.getSessionContextStatus(session.sessionId),
    ).resolves.toMatchObject({
      sessionId: session.sessionId,
      state: {},
    });
    await expect(
      bridge.getSessionSupportedCommandsStatus(session.sessionId),
    ).resolves.toMatchObject({
      sessionId: session.sessionId,
      availableCommands: [],
      availableSkills: [],
    });
    await expect(
      bridge.getSessionTasksStatus(session.sessionId),
    ).resolves.toMatchObject({
      sessionId: session.sessionId,
      tasks: [],
    });
    expect(handles[0]?.agent.extMethodCalls.map((c) => c.method)).toEqual([
      'qwen/status/session/context',
      'qwen/status/session/supported_commands',
      'qwen/status/session/tasks',
    ]);

    await bridge.shutdown();
  });

  it('requests session tasks status without waiting for the prompt queue', async () => {
    let releasePrompt: (() => void) | undefined;
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          promptImpl: async () => {
            await new Promise<void>((resolve) => {
              releasePrompt = resolve;
            });
            return { stopReason: 'end_turn' };
          },
          extMethodImpl: (method, params) => {
            if (method === 'qwen/status/session/tasks') {
              return {
                v: 1,
                sessionId: params['sessionId'],
                now: 1_700_000_000_000,
                tasks: [],
              };
            }
            throw new Error(`unexpected extMethod ${method}`);
          },
        });
        handles.push(h);
        return h.channel;
      },
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const prompt = bridge.sendPrompt(session.sessionId, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'never resolves until released' }],
    });

    await vi.waitFor(() => {
      expect(handles[0]?.agent.promptCalls).toHaveLength(1);
    });

    await expect(
      bridge.getSessionTasksStatus(session.sessionId),
    ).resolves.toMatchObject({
      sessionId: session.sessionId,
      tasks: [],
    });
    expect(handles[0]?.agent.promptCalls).toHaveLength(1);
    expect(handles[0]?.agent.extMethodCalls.map((c) => c.method)).toEqual([
      'qwen/status/session/tasks',
    ]);

    releasePrompt?.();
    await prompt;
    await bridge.shutdown();
  });

  it('refreshes extensions across live sessions and broadcasts merged results', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: (method, params) => {
            if (
              method === 'qwen/control/workspace/extensions/refresh' &&
              String(params['sessionId']).endsWith('#2')
            ) {
              throw new Error('refresh failed');
            }
            return {};
          },
        });
        handles.push(h);
        return h.channel;
      },
    });
    const first = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    const abort = new AbortController();
    const iter = bridge.subscribeEvents(first.sessionId, {
      signal: abort.signal,
    });
    const nextEvent = iter[Symbol.asyncIterator]().next();

    const result = await bridge.refreshExtensionsForAllSessions({
      status: 'updated',
      name: 'test-ext',
    });

    expect(result).toEqual({ refreshed: 1, failed: 1 });
    expect(handles[0]?.agent.extMethodCalls).toEqual([
      {
        method: 'qwen/control/workspace/extensions/refresh',
        params: { sessionId: first.sessionId },
      },
      {
        method: 'qwen/control/workspace/extensions/refresh',
        params: { sessionId: second.sessionId },
      },
    ]);
    const event = await nextEvent;
    expect(event.value).toMatchObject({
      type: 'extensions_changed',
      data: {
        status: 'updated',
        name: 'test-ext',
        refreshed: 1,
        failed: 1,
      },
    });
    abort.abort();
    await bridge.shutdown();
  });

  it('does not refresh or broadcast extensions when no sessions are live', async () => {
    const bridge = makeBridge();

    await expect(bridge.refreshExtensionsForAllSessions()).resolves.toEqual({
      refreshed: 0,
      failed: 0,
    });

    await bridge.shutdown();
  });

  it('skips dying sessions when refreshing extensions', async () => {
    let releaseKill: (() => void) | undefined;
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel();
        const originalKill = h.channel.kill;
        h.channel.kill = async () => {
          await new Promise<void>((resolve) => {
            releaseKill = resolve;
          });
          await originalKill();
        };
        handles.push(h);
        return h.channel;
      },
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const killPromise = bridge.killSession(session.sessionId);
    await vi.waitFor(() => {
      expect(releaseKill).toBeDefined();
    });

    await expect(bridge.refreshExtensionsForAllSessions()).resolves.toEqual({
      refreshed: 0,
      failed: 0,
    });
    expect(
      handles[0]?.agent.extMethodCalls.filter(
        (call) => call.method === 'qwen/control/workspace/extensions/refresh',
      ),
    ).toEqual([]);

    releaseKill?.();
    await killPromise;
    await bridge.shutdown();
  });

  it('rejects session status requests for unknown sessions', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });

    await expect(
      bridge.getSessionContextStatus('missing'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      bridge.getSessionSupportedCommandsStatus('missing'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      bridge.getSessionTasksStatus('missing'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('reuses an echoed daemon-issued client id on attach', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      clientId: first.clientId,
    });

    expect(second.attached).toBe(true);
    expect(second.clientId).toBe(first.clientId);

    await bridge.shutdown();
    expect(handles[0]?.killed).toBe(true);
  });

  it('detachClient unregisters only the detached client id', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    await bridge.detachClient(second.sessionId, second.clientId);

    await expect(
      bridge.sendPrompt(
        first.sessionId,
        {
          sessionId: first.sessionId,
          prompt: [{ type: 'text', text: 'still valid' }],
        },
        undefined,
        { clientId: first.clientId },
      ),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    await expect(
      bridge.sendPrompt(
        second.sessionId,
        {
          sessionId: second.sessionId,
          prompt: [{ type: 'text', text: 'detached' }],
        },
        undefined,
        { clientId: second.clientId },
      ),
    ).rejects.toBeInstanceOf(InvalidClientIdError);

    await bridge.shutdown();
  });

  it('detachClient preserves an echoed client id owned by an earlier attach', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      clientId: first.clientId,
    });
    expect(second.clientId).toBe(first.clientId);

    await bridge.detachClient(second.sessionId, second.clientId);

    await expect(
      bridge.sendPrompt(
        first.sessionId,
        {
          sessionId: first.sessionId,
          prompt: [{ type: 'text', text: 'still valid' }],
        },
        undefined,
        { clientId: first.clientId },
      ),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });

    await bridge.shutdown();
  });

  describe('recordHeartbeat', () => {
    it('updates the per-session timestamp for an anonymous heartbeat', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Anonymous heartbeats (no `X-Qwen-Client-Id`) bump only the session
      // watermark — every identified-client lookup must stay empty so a
      // future revocation policy doesn't see ghost timestamps.
      const before = Date.now();
      const result = bridge.recordHeartbeat(session.sessionId);
      const after = Date.now();

      expect(result.sessionId).toBe(session.sessionId);
      expect(result.clientId).toBeUndefined();
      expect(result.lastSeenAt).toBeGreaterThanOrEqual(before);
      expect(result.lastSeenAt).toBeLessThanOrEqual(after);

      const state = bridge.getHeartbeatState(session.sessionId);
      expect(state?.sessionLastSeenAt).toBe(result.lastSeenAt);
      expect(state?.clientLastSeenAt.size).toBe(0);

      await bridge.shutdown();
    });

    it('records per-client timestamps when a trusted client id is supplied', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = bridge.recordHeartbeat(session.sessionId, {
        clientId: session.clientId,
      });

      expect(result.clientId).toBe(session.clientId);
      const state = bridge.getHeartbeatState(session.sessionId);
      expect(state?.sessionLastSeenAt).toBe(result.lastSeenAt);
      expect(state?.clientLastSeenAt.get(session.clientId!)).toBe(
        result.lastSeenAt,
      );

      await bridge.shutdown();
    });

    it('throws SessionNotFoundError on unknown sessions', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      // No `session/spawnOrAttach` first — the bridge must reject before
      // touching any timestamp store.
      expect(() => bridge.recordHeartbeat('missing')).toThrow(
        SessionNotFoundError,
      );
      expect(bridge.getHeartbeatState('missing')).toBeUndefined();
      await bridge.shutdown();
    });

    it('rejects an unknown client id without bumping any timestamp', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Pre-validation guarantees an attacker holding a valid bearer
      // token can't mask client absence by spamming heartbeats with
      // forged ids — `sessionLastSeenAt` must stay undefined here.
      expect(() =>
        bridge.recordHeartbeat(session.sessionId, { clientId: 'forged' }),
      ).toThrow(InvalidClientIdError);

      const state = bridge.getHeartbeatState(session.sessionId);
      expect(state?.sessionLastSeenAt).toBeUndefined();
      expect(state?.clientLastSeenAt.size).toBe(0);

      await bridge.shutdown();
    });

    it('drops per-client last-seen on detach but preserves the session watermark', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      // Attach two clients so detaching one doesn't trigger
      // close-on-last-detach (which would remove the session entirely).
      const s1 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      bridge.recordHeartbeat(s1.sessionId, { clientId: s1.clientId });

      const before = bridge.getHeartbeatState(s1.sessionId);
      expect(before?.clientLastSeenAt.get(s1.clientId!)).toBeDefined();

      await bridge.detachClient(s1.sessionId, s1.clientId);

      const after = bridge.getHeartbeatState(s1.sessionId);
      // session watermark stays — diagnostics still see "this session
      // was alive at T"; per-client entry for s1 is gone since its
      // ref-count hit zero; s2's clientId is still present.
      expect(after?.sessionLastSeenAt).toBe(before?.sessionLastSeenAt);
      expect(after?.clientLastSeenAt.has(s1.clientId!)).toBe(false);

      await bridge.shutdown();
    });

    it('returns a snapshot map that callers cannot use to mutate live state', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      bridge.recordHeartbeat(session.sessionId, { clientId: session.clientId });

      const snapshot = bridge.getHeartbeatState(session.sessionId);
      // Mutating the returned map must NOT leak into the bridge — the
      // accessor exists so future PR 12 read-only routes can serialize
      // a snapshot without coupling to internal storage.
      (snapshot!.clientLastSeenAt as Map<string, number>).set('attacker', 0);

      const fresh = bridge.getHeartbeatState(session.sessionId);
      expect(fresh?.clientLastSeenAt.has('attacker')).toBe(false);

      await bridge.shutdown();
    });
  });

  it('loads an existing ACP session and registers it for daemon routes', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: () => ({ configOptions: [] }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const loaded = await bridge.loadSession({
      sessionId: 'persisted-1',
      workspaceCwd: WS_A,
    });

    expect(loaded).toEqual({
      sessionId: 'persisted-1',
      workspaceCwd: WS_A,
      attached: false,
      clientId: expect.stringMatching(/^client_/),
      createdAt: expect.any(String),
      state: { configOptions: [] },
      compactedReplay: [],
      liveJournal: [],
      lastEventId: 0,
    });
    expect(handles[0]?.agent.loadSessionCalls).toEqual([
      { sessionId: 'persisted-1', cwd: WS_A, mcpServers: [] },
    ]);
    expect(bridge.sessionCount).toBe(1);

    await expect(
      bridge.sendPrompt('persisted-1', {
        sessionId: 'ignored',
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(handles[0]?.agent.promptCalls[0]?.sessionId).toBe('persisted-1');

    await bridge.shutdown();
  });

  it('buffers load replay events until the restored session is registered', async () => {
    let capturedConn: AgentSideConnection | undefined;
    const factory: ChannelFactory = async () => {
      const { clientStream, agentStream } = createInMemoryChannel();
      const fakeAgent = new FakeAgent({
        loadSessionImpl: async (p) => {
          await capturedConn!.sessionUpdate({
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'replayed' },
            },
          });
          return {};
        },
      });
      capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
      return {
        stream: clientStream,
        exited: new Promise<
          | { exitCode: number | null; signalCode: NodeJS.Signals | null }
          | undefined
        >(() => {}),
        kill: async () => {},
        killSync: () => {},
      };
    };
    const bridge = makeBridge({ channelFactory: factory });

    const loaded = await bridge.loadSession({
      sessionId: 'persisted-history',
      workspaceCwd: WS_A,
    });
    const iterator = bridge
      .subscribeEvents(loaded.sessionId, { lastEventId: 0 })
      [Symbol.asyncIterator]();
    let timer: NodeJS.Timeout | undefined;
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for replay event')),
          500,
        );
      }),
    ]);
    if (timer) clearTimeout(timer);

    expect(next.value.type).toBe('session_update');
    expect(next.value.data).toMatchObject({
      sessionId: 'persisted-history',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'replayed' },
      },
    });

    await iterator.return?.();
    await bridge.shutdown();
  });

  it('resumes an existing ACP session without calling session/load', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        resumeSessionImpl: () => ({ modes: null }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const resumed = await bridge.resumeSession({
      sessionId: 'persisted-2',
      workspaceCwd: WS_A,
    });

    expect(resumed).toEqual({
      sessionId: 'persisted-2',
      workspaceCwd: WS_A,
      attached: false,
      clientId: expect.stringMatching(/^client_/),
      createdAt: expect.any(String),
      state: { modes: null },
      lastEventId: 0,
    });
    expect(handles[0]?.agent.loadSessionCalls).toHaveLength(0);
    expect(handles[0]?.agent.resumeSessionCalls).toEqual([
      { sessionId: 'persisted-2', cwd: WS_A, mcpServers: [] },
    ]);

    await bridge.shutdown();
  });

  it('attaches to an already live session and returns the cached restore state', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        // `_meta` is the permissive escape hatch on the ACP response
        // schema — any record-shaped payload survives the wire. The
        // assertions only need the bridge to forward it intact.
        loadSessionImpl: () => ({ _meta: { tag: 'restored-foo' } }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const loaded = await bridge.loadSession({
      sessionId: 'persisted-3',
      workspaceCwd: WS_A,
    });
    const attached = await bridge.resumeSession({
      sessionId: 'persisted-3',
      workspaceCwd: WS_A,
    });

    expect(loaded.attached).toBe(false);
    expect(loaded.state).toEqual({ _meta: { tag: 'restored-foo' } });
    // Late attachers must observe the SAME restore state the original
    // caller saw — `entry.restoreState` is cached at load time.
    expect(attached).toEqual({
      sessionId: 'persisted-3',
      workspaceCwd: WS_A,
      attached: true,
      clientId: expect.stringMatching(/^client_/),
      createdAt: expect.any(String),
      state: { _meta: { tag: 'restored-foo' } },
      lastEventId: expect.any(Number),
    });
    expect(attached.clientId).not.toBe(loaded.clientId);
    expect(handles[0]?.agent.loadSessionCalls).toHaveLength(1);
    expect(handles[0]?.agent.resumeSessionCalls).toHaveLength(0);

    await bridge.shutdown();
  });

  it('propagates the original ACP state to coalesced restore waiters', async () => {
    let releaseLoad: ((value: LoadSessionResponse) => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = resolve;
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const first = bridge.loadSession({
      sessionId: 'coalesce-state',
      workspaceCwd: WS_A,
    });
    // Wait for the first call to register inFlight before issuing
    // the second.
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();
    const second = bridge.loadSession({
      sessionId: 'coalesce-state',
      workspaceCwd: WS_A,
    });

    releaseLoad!({ _meta: { tag: 'restored-baz' } });
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.attached).toBe(false);
    expect(r1.state).toEqual({ _meta: { tag: 'restored-baz' } });
    expect(r2.attached).toBe(true);
    // Coalesced waiter sees the same state, not `{}`.
    expect(r2.state).toEqual({ _meta: { tag: 'restored-baz' } });

    await bridge.shutdown();
  });

  it('survives spawn-owner disconnect kill while a coalesced restore is mid-flight', async () => {
    let releaseLoad: ((value: LoadSessionResponse) => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = resolve;
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const first = bridge.loadSession({
      sessionId: 'race-target',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    // Second caller coalesces synchronously and reserves the attach.
    const second = bridge.loadSession({
      sessionId: 'race-target',
      workspaceCwd: WS_A,
    });

    releaseLoad!({});
    const r1 = await first;
    expect(r1.attached).toBe(false);

    // First caller "disconnected" — simulate by issuing the same
    // disconnect-cleanup the route handler would. The
    // `requireZeroAttaches` guard MUST see B's reserved attach and
    // skip the kill, otherwise B observes a 404'd sessionId on its
    // next call.
    await bridge.killSession(r1.sessionId, { requireZeroAttaches: true });

    // The session must still be alive for B.
    expect(bridge.sessionCount).toBe(1);
    const r2 = await second;
    expect(r2.attached).toBe(true);
    expect(r2.sessionId).toBe('race-target');

    await bridge.shutdown();
  });

  it('does not kill the channel when the last live session leaves while a restore is pending', async () => {
    let releaseLoad: ((value: LoadSessionResponse) => void) | undefined;
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = resolve;
          }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    // Spawn a regular session first, then kick off a slow restore on
    // the same channel.
    const spawned = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const restore = bridge.loadSession({
      sessionId: 'pending-restore',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    // Kill the only registered session; the channel must NOT die
    // because pendingRestoreIds is non-empty.
    await bridge.killSession(spawned.sessionId);
    expect(handles[0]?.killed).toBe(false);

    // Let the restore finish — it joins the channel as the new
    // sole session.
    releaseLoad!({});
    const restored = await restore;
    expect(restored.sessionId).toBe('pending-restore');
    expect(bridge.sessionCount).toBe(1);
    expect(handles[0]?.killed).toBe(false);

    await bridge.shutdown();
  });

  it('does not promote a restored session into the omitted-id attach default', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: () => ({}),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    await bridge.loadSession({
      sessionId: 'persisted-explicit',
      workspaceCwd: WS_A,
    });
    // A subsequent omitted-id `POST /session` (single scope) MUST
    // create a fresh session rather than silently attaching to the
    // explicitly restored one.
    const spawned = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(spawned.sessionId).not.toBe('persisted-explicit');
    expect(spawned.attached).toBe(false);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('maps an ACP missing persisted session to SessionNotFoundError', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: (p) => {
          throw RequestError.resourceNotFound(`session:${p.sessionId}`);
        },
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    await expect(
      bridge.loadSession({
        sessionId: 'missing-persisted',
        workspaceCwd: WS_A,
      }),
    ).rejects.toMatchObject({
      name: 'SessionNotFoundError',
      sessionId: 'missing-persisted',
    });
    expect(bridge.sessionCount).toBe(0);
    expect(handles[0]?.killed).toBe(false);

    await bridge.shutdown();
  });

  // The `isAcpSessionResourceNotFound` `message`-fallback path can't
  // be exercised through the FakeAgent end-to-end: the ACP SDK
  // normalizes non-RequestError throws to `-32603 Internal error`,
  // so a fake-agent thrown plain Object with `code: -32002` arrives
  // at the bridge as -32603 with the original message buried under
  // `data.details`. The fallback covers ACP variants that emit the
  // URI in `message` directly (without `data.uri`); the primary
  // `data.uri` path is covered by the test above. The exact-match
  // tightening (vs. substring) is exercised by inspection.

  it('rejects load while a resume for the same session is in flight', async () => {
    let releaseResume: (() => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        resumeSessionImpl: () =>
          new Promise<ResumeSessionResponse>((resolve) => {
            releaseResume = () => resolve({});
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const resume = bridge.resumeSession({
      sessionId: 'persisted-race',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseResume; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseResume).toBeDefined();

    await expect(
      bridge.loadSession({
        sessionId: 'persisted-race',
        workspaceCwd: WS_A,
      }),
    ).rejects.toBeInstanceOf(RestoreInProgressError);

    releaseResume?.();
    await resume;
    await bridge.shutdown();
  });

  it('rejects resume while a load for the same session is in flight (mirror of load-on-resume)', async () => {
    let releaseLoad: (() => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = () => resolve({});
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const load = bridge.loadSession({
      sessionId: 'persisted-mirror',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    // Resume coalescing onto load would silently subscribe the
    // resume client to history-replay frames it explicitly opted
    // out of; it must throw instead.
    await expect(
      bridge.resumeSession({
        sessionId: 'persisted-mirror',
        workspaceCwd: WS_A,
      }),
    ).rejects.toBeInstanceOf(RestoreInProgressError);

    releaseLoad?.();
    await load;
    await bridge.shutdown();
  });

  it('does not kill a shared channel when one of multiple pending restores fails', async () => {
    let releaseGood: (() => void) | undefined;
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: (p) => {
          if (p.sessionId === 'bad-restore') {
            throw RequestError.resourceNotFound(`session:${p.sessionId}`);
          }
          return new Promise<LoadSessionResponse>((resolve) => {
            releaseGood = () => resolve({});
          });
        },
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const good = bridge.loadSession({
      sessionId: 'good-restore',
      workspaceCwd: WS_A,
    });
    for (
      let i = 0;
      i < 50 && handles[0]?.agent.loadSessionCalls.length !== 1;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(handles[0]?.agent.loadSessionCalls[0]?.sessionId).toBe(
      'good-restore',
    );

    await expect(
      bridge.loadSession({
        sessionId: 'bad-restore',
        workspaceCwd: WS_A,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(handles[0]?.killed).toBe(false);

    releaseGood?.();
    await expect(good).resolves.toMatchObject({
      sessionId: 'good-restore',
      attached: false,
    });

    await bridge.shutdown();
  });

  it('does not surface an unhandledRejection when the channel exits after a successful restore', async () => {
    // Regression for the dangling-rejection bug: `transportClosed`
    // is a fresh `.then(throw)` promise per restore. If `withTimeout`
    // wins the race, `transportClosed` stays pending and a later
    // channel exit fires the inner `throw` with no observer attached
    // — Node 22 logs `unhandledRejection`, and
    // `--unhandled-rejections=throw` deployments crash the daemon.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ loadSessionImpl: () => ({}) });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const restored = await bridge.loadSession({
        sessionId: 'persisted-leak',
        workspaceCwd: WS_A,
      });
      expect(restored.attached).toBe(false);
      // Now resolve `channel.exited` AFTER the restore promise has
      // already settled. `transportClosed` was the race-loser, so
      // its `.then(throw)` fires now. With the `.catch(() => {})`
      // suppression in place, no `unhandledRejection` is emitted;
      // without it, the test would observe one.
      handles[0]!.crash({ exitCode: null, signalCode: null });
      // Give the rejection a tick to surface if it were unhandled.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await bridge.shutdown();
    }
  });

  it('shutdown awaits in-flight restores before resolving', async () => {
    // `shutdown()` adds `inFlightRestoreAwaits` to the wait list so
    // shutting the daemon down doesn't orphan a half-completed
    // restore. Verify by racing the restore-settled signal against
    // the shutdown-resolved signal: if shutdown is awaiting the
    // restore, the restore MUST settle first (or simultaneously
    // — `Promise.race` ties go to the earlier-registered handler,
    // which is the restore here).
    let releaseLoad: (() => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = () => resolve({});
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const restore = bridge.loadSession({
      sessionId: 'persisted-shutdown',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    const restoreFirst = restore
      .catch(() => undefined)
      .then(() => 'restore' as const);
    const shutdownFirst = bridge.shutdown().then(() => 'shutdown' as const);
    const winner = await Promise.race([restoreFirst, shutdownFirst]);
    expect(winner).toBe('restore');
    // Both must have settled cleanly by the end.
    await Promise.all([restoreFirst, shutdownFirst]);
  });

  it('rejects cross-workspace requests with WorkspaceMismatchError (#3803 §02)', async () => {
    // Per #3803 §02 (1 daemon = 1 workspace), `spawnOrAttach` calls
    // whose canonical `workspaceCwd` doesn't match `boundWorkspace`
    // throw `WorkspaceMismatchError`. The server route translates
    // this to a 400 with `code: 'workspace_mismatch'` so clients can
    // route to (or spawn) a daemon for the other workspace.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(a.sessionId).toBe(SESS_A);

    // Cross-workspace POST throws before touching the channel.
    // Single `.catch` capture — assert instance + carried fields off
    // the same caught value rather than firing the rejection twice.
    const err = await bridge
      .spawnOrAttach({ workspaceCwd: WS_B })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceMismatchError);
    expect((err as WorkspaceMismatchError).bound).toBe(WS_A);
    expect((err as WorkspaceMismatchError).requested).toBe(WS_B);

    // Only the original WS_A spawn succeeded — no channel spawned for WS_B.
    expect(handles).toHaveLength(1);
    expect(bridge.sessionCount).toBe(1);

    await bridge.shutdown();
  });

  it('WorkspaceMismatchError truncates oversized `requested` to MAX_WORKSPACE_PATH_LENGTH (defense-in-depth)', () => {
    // The route-level cap in `server.ts` rejects oversized `cwd`
    // bodies before reaching the bridge, but `WorkspaceMismatchError`
    // can be constructed directly by other callers (tests, embeds,
    // future entry points) or by passing pre-validated paths that
    // somehow grew. The constructor interpolates `requested` into
    // `.message` twice + downstream code echoes it on stderr +
    // `res.json` — without truncation a 10 MB string amplifies
    // ~6× per request. The truncation here is the cross-caller
    // belt-and-suspenders defense.
    const oversized = '/' + 'a'.repeat(MAX_WORKSPACE_PATH_LENGTH * 2);
    const err = new WorkspaceMismatchError('/work/bound', oversized);
    expect(err.requested.length).toBeLessThanOrEqual(
      MAX_WORKSPACE_PATH_LENGTH + 32, // truncation marker overhead
    );
    expect(err.requested.endsWith('…[truncated]')).toBe(true);
    // `.message` interpolates `requested` twice; both go through the
    // truncated form, so the message is bounded too.
    expect(err.message.length).toBeLessThan(
      MAX_WORKSPACE_PATH_LENGTH * 2 + 1024,
    );
    // Bound is operator-controlled — not truncated.
    expect(err.bound).toBe('/work/bound');
  });

  it('WorkspaceMismatchError passes through `requested` shorter than MAX_WORKSPACE_PATH_LENGTH untouched', () => {
    // Common case: legitimate `requested` paths (PATH_MAX is 4096 on
    // Linux, 1024 on macOS) should not be modified.
    const normal = '/work/different';
    const err = new WorkspaceMismatchError('/work/bound', normal);
    expect(err.requested).toBe(normal);
    expect(err.requested.endsWith('…[truncated]')).toBe(false);
  });

  it('creates fresh session per call under sessionScope:thread (Stage 1.5 multi-session: shares channel)', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Distinct sessions, both freshly created (neither is an attach).
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(false);
    // Stage 1.5 multi-session: the two thread-scope calls SHARE the
    // workspace's `qwen --acp` child. Only one `channelFactory` call.
    // Each `newSession()` call to the agent produces a distinct id.
    expect(handles).toHaveLength(1);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('per-request sessionScope:thread overrides daemon-wide single (#4175 PR 5)', async () => {
    // The daemon-wide default is `'single'` (the production default), so
    // a second `spawnOrAttach` against the same workspace WITHOUT a
    // per-request override would normally reuse the first session.
    // With `sessionScope: 'thread'` on the request, the bridge must
    // create a distinct session — proving the per-request override
    // wins over the construction-time default.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'single',
      channelFactory: factory,
    });

    const first = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(false);
    expect(handles).toHaveLength(1); // shared channel, distinct sessions
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('per-request sessionScope:single overrides daemon-wide thread (#4175 PR 5)', async () => {
    // Symmetric coverage: a daemon launched with `--sessionScope thread`
    // (uncommon but supported) must still honor `'single'` on the
    // request. The second call must reuse the first session.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    const first = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(true);
    expect(handles).toHaveLength(1);
    expect(bridge.sessionCount).toBe(1);

    await bridge.shutdown();
  });

  it('thread-scope first call does NOT pollute the single-scope attach slot (#4175 PR 5 mixed-scope leak)', async () => {
    // Regression for the leak the code-reviewer flagged: pre-fix, a
    // thread-scope spawn ALSO claimed the empty `defaultEntry` slot,
    // so a subsequent omitted-scope call (`effectiveScope = 'single'`
    // under the daemon default) would attach to what the first caller
    // was told was an isolated session. The fix gates the
    // `defaultEntry` stamp on `effectiveScope === 'single'` inside
    // `doSpawn`. This test exercises the exact mixed sequence and
    // asserts the omitted call gets a FRESH session.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'single', // daemon-wide default, the production shape
      channelFactory: factory,
    });

    const isolated = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    const shared = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    expect(isolated.sessionId).not.toBe(shared.sessionId);
    expect(isolated.attached).toBe(false);
    expect(shared.attached).toBe(false); // fresh, NOT attached to `isolated`
    expect(bridge.sessionCount).toBe(2);

    // A second omitted-scope call MUST attach to `shared` (the first
    // single-scope session), proving the slot is correctly populated
    // by the second call rather than by the thread-scope first call.
    const reattach = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(reattach.sessionId).toBe(shared.sessionId);
    expect(reattach.attached).toBe(true);

    await bridge.shutdown();
  });

  it('symmetric mixed-scope leak: single-first does NOT trap a later thread call into the single slot', async () => {
    // Mirror of the daemon-default-`'single'` + thread-first leak
    // regression: under daemon-default-`'thread'` an explicit `'single'`
    // first call legitimately claims the attach slot, and a SECOND
    // omitted-scope call (`effectiveScope = 'thread'` under the daemon
    // default) must then create a fresh session, NOT attach to the
    // single-scope first session. Confirms `effectiveScope` is what
    // gates attach-reuse, not just the daemon-wide default.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    const single = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    const omitted = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    expect(single.attached).toBe(false);
    expect(omitted.attached).toBe(false); // thread under daemon default
    expect(omitted.sessionId).not.toBe(single.sessionId);
    expect(bridge.sessionCount).toBe(2);

    // A second explicit `'single'` MUST attach to `single`, proving
    // the slot stayed correctly populated by the first call.
    const reattachSingle = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    expect(reattachSingle.sessionId).toBe(single.sessionId);
    expect(reattachSingle.attached).toBe(true);

    await bridge.shutdown();
  });

  it("concurrent mixed-scope spawns don't collide on the in-flight tracker (#4175 PR 5)", async () => {
    // The in-flight coalescing key is `workspaceKey` for `'single'` and
    // `${workspaceKey}#${randomUUID()}` for `'thread'`. A simultaneous
    // single+thread pair against the same workspace must not collide:
    // the `'single'` caller's `inFlightSpawns.get(workspaceKey)` must
    // not match the `'thread'` caller's tracker, and vice versa.
    //
    // Slow `initialize` so both calls reach `inFlightSpawns` before
    // either's spawn resolves — exercises the actual race window. The
    // shared workspace channel is created once (Stage 1.5
    // multi-session); the slow init also serializes the second
    // `ensureChannel` waiter under the same mutex, but the
    // `inFlightSpawns` tracker key differs by scope so the two
    // resolutions stay isolated.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        sessionIdPrefix: `s${handles.length}`,
        initializeDelayMs: 30,
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'single', // production default
      channelFactory: factory,
    });

    // Fire both calls before either's spawn has resolved.
    const [singleSess, threadSess] = await Promise.all([
      bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'single',
      }),
      bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      }),
    ]);

    // Distinct sessions — the thread caller did NOT attach to the
    // in-flight single spawn (or vice versa).
    expect(singleSess.sessionId).not.toBe(threadSess.sessionId);
    expect(singleSess.attached).toBe(false);
    expect(threadSess.attached).toBe(false);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('rejects an invalid per-request sessionScope with InvalidSessionScopeError', async () => {
    // Defense-in-depth: the route-layer validates strings, but a direct
    // bridge caller (test, embed, future entry point) could pass a
    // non-enum value. Throw a typed `InvalidSessionScopeError` so the
    // route's `sendBridgeError` translator returns the same 400
    // `code: 'invalid_session_scope'` it would have if the route had
    // caught the bad value first — keeping both layers in agreement
    // on the wire shape.
    const bridge = makeBridge();
    const err = await bridge
      .spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'bogus' as unknown as 'single',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSessionScopeError);
    expect((err as InvalidSessionScopeError).sessionScope).toBe('bogus');
    expect((err as InvalidSessionScopeError).message).toMatch(
      /Invalid sessionScope/,
    );
  });

  it('rejects relative workspace paths', async () => {
    const bridge = makeBridge({
      channelFactory: async () => {
        throw new Error('factory should not be called');
      },
    });
    await expect(
      bridge.spawnOrAttach({ workspaceCwd: 'relative/path' }),
    ).rejects.toThrow(/absolute path/);
  });

  it('canonicalizes the workspace key (single-scope reuses normalized paths)', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const aNoisy = await bridge.spawnOrAttach({ workspaceCwd: '/work/./a' });

    expect(a.sessionId).toBe(aNoisy.sessionId);
    expect(aNoisy.attached).toBe(true);
    expect(handles).toHaveLength(1);

    await bridge.shutdown();
  });

  it('kills the spawned channel and rejects when initialize fails', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        initializeThrows: new Error('handshake refused'),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    // ACP SDK rewrites unhandled exceptions to a JSON-RPC Internal error
    // object (code -32603); the original message text is intentionally not
    // forwarded. Assert on rejection + resource cleanup.
    const err = await bridge.spawnOrAttach({ workspaceCwd: WS_A }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(handles[0]?.killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('times out a stuck initialize', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ initializeDelayMs: 5_000 });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      channelFactory: factory,
      initializeTimeoutMs: 50,
    });

    await expect(bridge.spawnOrAttach({ workspaceCwd: WS_A })).rejects.toThrow(
      /initialize timed out/,
    );
    expect(handles[0]?.killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('shutdown kills the live channel and its multiplexed sessions', async () => {
    // Stage 1.5 multi-session under single-workspace mode (#3803 §02):
    // a daemon hosts one channel with N sessions multiplexed on it.
    // Shutdown kills that one channel and tears down every multiplexed
    // session.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: 's' });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(bridge.sessionCount).toBe(2);
    expect(handles).toHaveLength(1); // one channel multiplexing two sessions

    await bridge.shutdown();
    expect(handles[0]?.killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('killAllSync force-kills the live channel mid-shutdown (BkUyD)', async () => {
    // tanzhenxin BkUyD regression: pre-fix, `shutdown()` cleared the
    // live-channel reference BEFORE awaiting the child's SIGTERM
    // grace. A mid-drain double-Ctrl+C invoked `killAllSync`, found
    // nothing to force-kill, and `process.exit(1)` orphaned the
    // child. Under #3803 §02 the bridge has at most one channel, but
    // the invariant is the same: `channelInfo` MUST stay set until
    // `channel.exited` fires (OS-level reap), not be eagerly cleared
    // by `shutdown()`.
    const killSyncInvoked: string[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: 's' });
      const realKillSync = h.channel.killSync;
      h.channel = {
        ...h.channel,
        kill: () =>
          // Never resolve — simulates a stuck SIGTERM grace window.
          new Promise(() => {}),
        killSync: () => {
          killSyncInvoked.push('called');
          realKillSync();
        },
      };
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Kick off shutdown — its `channel.kill()` will hang on the
    // never-resolving Promise above, so the entry maps clear but
    // the channel-kill await never finishes. This is the mid-drain
    // state.
    const shutdownPromise = bridge.shutdown();
    // Yield twice so shutdown's sync prefix runs (clear maps,
    // publish session_died, start awaits).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Operator double-Ctrl+C arrives now.
    bridge.killAllSync();

    // The channel's killSync fired. Pre-fix this would have been an
    // empty array because `channelInfo` was cleared in shutdown's
    // sync prefix.
    expect(killSyncInvoked).toHaveLength(1);

    // Cleanup: the never-resolving kill keeps shutdownPromise
    // pending forever. Don't await it (would hang the test). The
    // test runner GCs it when this `it` returns.
    void shutdownPromise;
  });

  it('killAllSync force-kills the channel during the initialize handshake (tanzhenxin cold-spawn-window)', async () => {
    // tanzhenxin cold-spawn-window finding: the agent child exists
    // from the moment `channelFactory(boundWorkspace)` returns, but
    // pre-fix `aliveChannels.add(info)` ran only AFTER the
    // `initialize` handshake completed (up to `initTimeoutMs`,
    // default 10s). A double-Ctrl+C in that handshake window played
    // out as: first SIGINT entered `shutdown()` and awaited the
    // in-flight spawn; second SIGINT called `killAllSync()` against
    // an empty `aliveChannels` (the channel hadn't been added yet)
    // and `process.exit(1)` orphaned the child. The fix moves the
    // add + the `channel.exited` handler registration BEFORE the
    // `initialize` await; this test pins that the channel is
    // reachable via `killAllSync` during the handshake.
    const killSyncCalls: string[] = [];
    const factory: ChannelFactory = async () => {
      // Bespoke agent whose `initialize` never resolves — that's the
      // handshake-hanging window the finding is about. A real agent
      // can spend up to `initTimeoutMs` ms here before the bridge's
      // `withTimeout` aborts it.
      const ab = new TransformStream<Uint8Array, Uint8Array>();
      const ba = new TransformStream<Uint8Array, Uint8Array>();
      const clientStream = ndJsonStream(ab.writable, ba.readable);
      const agentStream = ndJsonStream(ba.writable, ab.readable);
      let resolveExited:
        | ((
            info?:
              | {
                  exitCode: number | null;
                  signalCode: NodeJS.Signals | null;
                }
              | undefined,
          ) => void)
        | undefined;
      const exited = new Promise<
        | { exitCode: number | null; signalCode: NodeJS.Signals | null }
        | undefined
      >((r) => {
        resolveExited = r;
      });
      const stuckAgent: Agent = {
        async initialize() {
          // Hang forever — the bridge's `withTimeout` would normally
          // bound this, but the test asserts behavior DURING the
          // handshake, so we let it sit until killAllSync resolves
          // `exited` and tears the channel down externally.
          return new Promise<InitializeResponse>(() => {});
        },
        async newSession() {
          throw new Error('newSession should not be reached');
        },
        async loadSession() {
          throw new Error('loadSession should not be reached');
        },
        async authenticate() {
          throw new Error('authenticate should not be reached');
        },
        async prompt() {
          throw new Error('prompt should not be reached');
        },
        async cancel() {
          /* no-op */
        },
        async setSessionMode() {
          throw new Error('setSessionMode should not be reached');
        },
        async setSessionConfigOption() {
          throw new Error('setSessionConfigOption should not be reached');
        },
      };
      new AgentSideConnection(() => stuckAgent, agentStream);
      return {
        stream: clientStream,
        exited,
        kill: async () => {
          resolveExited!(undefined);
        },
        killSync: () => {
          killSyncCalls.push('called');
          resolveExited!(undefined);
        },
      };
    };
    const bridge = makeBridge({
      channelFactory: factory,
      // Bump initializeTimeoutMs so it doesn't race with the
      // killAllSync we fire below. We're NOT testing the timeout
      // path — we're testing the cold-spawn window before it.
      initializeTimeoutMs: 30_000,
    });

    // Kick off a spawn — `initialize` hangs forever in this fake,
    // so the spawn promise never resolves naturally. Don't await
    // (would block the test); `.catch` keeps the rejection from
    // being unhandled when killAllSync eventually tears things down.
    const spawnPromise = bridge
      .spawnOrAttach({ workspaceCwd: WS_A })
      .catch(() => undefined);

    // Yield enough microtasks for `channelFactory` to return AND the
    // bridge's `info` creation + `aliveChannels.add(info)` + the
    // `channel.exited` handler registration to all run BEFORE the
    // bridge enters `await initialize`. Pre-fix the alive-set add
    // sat AFTER initialize, so any number of yields here would still
    // find an empty set when killAllSync fires below.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }

    // Operator double-Ctrl+C arrives during the handshake window.
    bridge.killAllSync();

    // Post-fix expectation: channel was added to `aliveChannels`
    // BEFORE the `initialize` await, so killAllSync iterates a set
    // containing it and fires killSync. Pre-fix this array would
    // have been empty — and `process.exit(1)` after this would have
    // orphaned the agent child.
    expect(killSyncCalls).toEqual(['called']);

    // Cleanup: spawnPromise resolves on its own once killSync's
    // `resolveExited` propagates through the bridge's
    // `channel.exited` handler and the IIFE's catch reaps the half-
    // initialized channel.
    void spawnPromise;
  });

  it('killSession marks the channel dying so concurrent spawnOrAttach gets a fresh channel', async () => {
    // After the last session is killed, `channel.kill()` runs through
    // its SIGTERM grace window before SIGKILL — up to 10s in the real
    // factory. During that window a concurrent `spawnOrAttach` MUST
    // get a FRESH channel, never the dying one. Pre-fix: `channelInfo`
    // stayed set with no `isDying` flag, so `ensureChannel` returned
    // the dying channel and `newSession()` either succeeded onto a
    // transport about to close (landing a sessionId that 404s on the
    // next request when `channel.exited` fires) or hung until the
    // newSession timeout. Fix: `killSession` sets `isDying = true`
    // synchronously before `await ci.channel.kill()`; `ensureChannel`
    // skips dying channels and spawns a fresh one.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      // Make kill() hang forever so the SIGTERM grace window stays
      // open for the test (simulates a slow-to-exit child).
      h.channel = { ...h.channel, kill: () => new Promise(() => {}) };
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(handles).toHaveLength(1);

    // Kick off killSession (the only session leaving triggers the
    // channel teardown). The kill() Promise never resolves, so the
    // method's await hangs — we fire-and-forget.
    const killPromise = bridge.killSession(first.sessionId);
    // Yield once so killSession's sync prefix runs (it marks
    // `isDying = true` synchronously before `await ci.channel.kill()`).
    await new Promise((r) => setImmediate(r));

    // A new spawn MUST get a FRESH channel, not reuse the dying one.
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(handles).toHaveLength(2);
    expect(second.sessionId).not.toBe(first.sessionId);
    // The second session is on the fresh channel (handles[1]), not
    // multiplexed onto the dying one (handles[0]).
    expect(handles[1]?.agent.newSessionCalls).toHaveLength(1);

    // Cleanup: both channels' kill() never resolves (factory above
    // overrides it). Don't await killSession or shutdown — same
    // pattern as the BkUyD test above. The test runner GCs the
    // dangling promises when this `it` returns.
    void killPromise;
  });

  it('doSpawn newSession-failure marks the empty channel dying so the next spawn gets a fresh one', async () => {
    // Parallel to "killSession marks the channel dying" above, but
    // covers the OTHER `isDying = true` site: `doSpawn`'s
    // `connection.newSession()` rejection path. When the channel's
    // first/only `newSession` fails (auth, bad config, agent crash
    // during init), the bridge marks the empty channel dying and
    // kicks off `channel.kill()`. The kill awaits a SIGTERM grace,
    // and during that window the next `spawnOrAttach` retry MUST
    // get a FRESH channel — not reuse the one whose newSession just
    // failed (which would re-issue newSession to a transport about
    // to close, almost certainly hanging or failing identically).
    // Pre-fix the equivalent code eagerly cleared `channelInfo` so
    // the BkUyD invariant was violated; the round-2 fix uses
    // `isDying` + `aliveChannels` instead.
    let factoryCount = 0;
    const killSyncCalls: string[] = [];
    const factory: ChannelFactory = async () => {
      const tag = `c${factoryCount++}`;
      // First channel's newSession rejects; subsequent channels succeed.
      const firstChannel = factoryCount === 1;
      const h = makeChannel({
        sessionIdPrefix: tag,
        newSessionImpl: firstChannel
          ? () => {
              throw new Error('agent refused newSession (test)');
            }
          : undefined,
      });
      const realKillSync = h.channel.killSync;
      h.channel = {
        ...h.channel,
        // Hang kill() so the SIGTERM grace stays open for the
        // duration of the test. We don't await spawnOrAttach's
        // rejection (which would block on the kill) — instead we
        // catch it via .catch() and yield enough cycles for the
        // sync prefix (`isDying = true`) to settle.
        kill: () => new Promise(() => {}),
        killSync: () => {
          killSyncCalls.push(tag);
          realKillSync();
        },
      };
      return h.channel;
    };
    // Thread scope so calls don't coalesce via `inFlightSpawns` —
    // the second spawn must not wait on the first one's hanging
    // doSpawn. Without thread scope the single-scope coalescing
    // would make `spawnOrAttach` call 2 await call 1's in-flight
    // promise (still pending on the never-resolving kill).
    const bridge = makeBridge({
      channelFactory: factory,
      sessionScope: 'thread',
    });

    // First spawn: newSession on c0 fails. `doSpawn`'s catch runs
    // `ci.isDying = true` synchronously, then `await ci.channel.kill()`
    // (hangs in this test). The original error never propagates
    // because the kill never resolves — so we DON'T await the
    // rejection. Capture it for cleanup.
    let firstErr: unknown;
    const firstAttempt = bridge
      .spawnOrAttach({ workspaceCwd: WS_A })
      .catch((err) => {
        firstErr = err;
      });

    // Yield enough times for `ensureChannel`'s spawn to complete,
    // newSession to reject, and doSpawn's catch sync prefix
    // (`ci.isDying = true`) to run before the kill-await hangs.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(factoryCount).toBe(1);

    // Second attempt: `ensureChannel` finds c0 with `isDying: true`,
    // skips it, spawns a fresh c1. Pre-fix the equivalent code
    // (eagerly clearing `channelInfo`) made this work via a
    // different mechanism that violated BkUyD; the current fix uses
    // `isDying` + `aliveChannels` for both correctness AND BkUyD.
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(factoryCount).toBe(2);
    expect(second.attached).toBe(false);

    // Both channels live in `aliveChannels` (c0 is dying but its
    // `channel.exited` hasn't fired; c1 is freshly attached).
    // `killAllSync` MUST find both.
    bridge.killAllSync();
    expect(killSyncCalls.sort()).toEqual(['c0', 'c1']);

    // Cleanup: firstAttempt is pending forever (kill never resolves).
    // Touch firstErr to satisfy linters about the variable.
    void firstAttempt;
    void firstErr;
  });

  it('killAllSync force-kills BOTH the dying channel AND the fresh attach-target (BkUyD overwrite race)', async () => {
    // The killSession → spawnOrAttach race opens a window where two
    // channels are simultaneously "alive" from the daemon's
    // perspective: the dying one (sessionIds.size === 0, in
    // SIGTERM grace) and the fresh one (just spawned to serve the new
    // request). Pre-fix `killAllSync()` iterated only `channelInfo`
    // (the fresh one), missing the dying channel and orphaning its
    // child when `process.exit(1)` fired before its SIGTERM
    // escalation timer. Fix: separate `aliveChannels: Set<ChannelInfo>`
    // that `killAllSync` iterates, only cleared by each channel's
    // `channel.exited` (the OS-reap signal).
    const killSyncCalls: string[] = [];
    let factoryCount = 0;
    const factory: ChannelFactory = async () => {
      const tag = `c${factoryCount++}`;
      const h = makeChannel({ sessionIdPrefix: tag });
      const realKillSync = h.channel.killSync;
      h.channel = {
        ...h.channel,
        // kill() hangs forever so the dying channel stays in
        // SIGTERM grace for the duration of the test.
        kill: () => new Promise(() => {}),
        killSync: () => {
          killSyncCalls.push(tag);
          realKillSync();
        },
      };
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Trigger the overwrite race: kill the only session → channel
    // marked dying, kill awaits a never-resolving Promise; then
    // spawn a new session → fresh channel, `channelInfo` reassigned.
    const killPromise = bridge.killSession(first.sessionId);
    await new Promise((r) => setImmediate(r));
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Both channels are alive from the OS's perspective. A
    // double-Ctrl+C arrives.
    bridge.killAllSync();

    // BOTH channels received killSync. Pre-fix only `c1` (the fresh
    // one in `channelInfo`) would have fired — `c0` was dying in
    // unreachable state and would have orphaned its child.
    expect(killSyncCalls.sort()).toEqual(['c0', 'c1']);

    // Cleanup: dangling never-resolving promises GC'd by the runner.
    void killPromise;
  });

  describe('sendPrompt', () => {
    it('forwards a prompt and returns the agent response', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({
          promptImpl: () => ({ stopReason: 'max_tokens' }),
        });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const result = await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(result).toEqual({ stopReason: 'max_tokens' });
      expect(handles[0]?.agent.promptCalls).toHaveLength(1);

      await bridge.shutdown();
    });

    it('ignores client retry when no turn_error made the session retryable', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({ channelFactory: async () => handle.channel });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'spoof retry' }],
        retry: true,
      } as PromptRequest);

      expect(handle.agent.promptCalls[0]).not.toHaveProperty('retry');
      expect(handle.agent.promptCalls[0]?._meta?.['qwen.daemon.retry']).toBe(
        undefined,
      );
      await bridge.shutdown();
    });

    it('strips client-spoofed retry metadata without a turn_error', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({ channelFactory: async () => handle.channel });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'spoof retry meta' }],
        _meta: { 'qwen.daemon.retry': true },
      } as PromptRequest);

      expect(handle.agent.promptCalls[0]?._meta?.['qwen.daemon.retry']).toBe(
        undefined,
      );
      await bridge.shutdown();
    });

    it('honors retry once after a turn_error', async () => {
      let calls = 0;
      const handle = makeChannel({
        promptImpl: () => {
          calls += 1;
          if (calls === 1) throw new Error('temporary failure');
          return { stopReason: 'end_turn' };
        },
      });
      const bridge = makeBridge({ channelFactory: async () => handle.channel });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const turnError = (async () => {
        for await (const event of iter) {
          if (event.type === 'turn_error') return event;
        }
        throw new Error('turn_error was not published');
      })();

      await expect(
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'first' }],
        }),
      ).rejects.toThrow();
      await turnError;

      await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'retry' }],
        retry: true,
      } as PromptRequest);

      expect(handle.agent.promptCalls[1]?._meta).toHaveProperty(
        'qwen.daemon.retry',
        true,
      );

      await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'second spoof' }],
        retry: true,
      } as PromptRequest);

      expect(handle.agent.promptCalls[2]).not.toHaveProperty('retry');
      expect(handle.agent.promptCalls[2]?._meta?.['qwen.daemon.retry']).toBe(
        undefined,
      );

      abort.abort();
      await bridge.shutdown();
    });

    it('echoes user_message_chunk to ALL session subscribers (cross-client sync)', async () => {
      // Cross-client sync fix: a prompt sent by client A must be visible
      // to every SSE subscriber of the same session — not just the
      // originator. Before the fix, the interactive prompt path forwarded
      // straight to the agent without publishing `user_message_chunk` to
      // the bus, so peer clients (B, C, ...) never saw A's input.
      const factory: ChannelFactory = async () =>
        makeChannel({ promptImpl: () => ({ stopReason: 'end_turn' }) }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abortA = new AbortController();
      const abortB = new AbortController();
      const iterA = bridge.subscribeEvents(session.sessionId, {
        signal: abortA.signal,
      });
      const iterB = bridge.subscribeEvents(session.sessionId, {
        signal: abortB.signal,
      });

      // Collect the first user_message_chunk each subscriber sees.
      const firstUserChunk = async (
        iter: AsyncIterable<{
          type: string;
          data: unknown;
          originatorClientId?: string;
        }>,
      ): Promise<{ originatorClientId?: string; data: unknown }> => {
        for await (const e of iter) {
          if (e.type !== 'session_update') continue;
          const update = (e.data as { update?: { sessionUpdate?: string } })
            ?.update;
          if (update?.sessionUpdate === 'user_message_chunk') {
            return { originatorClientId: e.originatorClientId, data: e.data };
          }
        }
        throw new Error('no user_message_chunk observed');
      };

      const aPromise = firstUserChunk(iterA);
      const bPromise = firstUserChunk(iterB);

      // Client A sends the prompt with its trusted clientId.
      await bridge.sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello from A' }],
        },
        undefined,
        { clientId: session.clientId },
      );

      const [aChunk, bChunk] = await Promise.all([aPromise, bPromise]);

      // Both subscribers saw the user input echoed to the bus.
      for (const chunk of [aChunk, bChunk]) {
        const update = (
          chunk.data as {
            update: {
              sessionUpdate: string;
              content: unknown;
              _meta?: unknown;
            };
          }
        ).update;
        expect(update.sessionUpdate).toBe('user_message_chunk');
        expect(update.content).toEqual({ type: 'text', text: 'hello from A' });
        // Originator stamp present so SDK `suppressOwnUserEcho` can dedup
        // on the originator's own UI.
        expect(chunk.originatorClientId).toBe(session.clientId);
        // Source marker distinguishes the bridge echo from agent content.
        expect((update._meta as { source?: string })?.source).toBe(
          'bridge-echo',
        );
      }

      abortA.abort();
      abortB.abort();
      await bridge.shutdown();
    });

    it('echoes one user_message_chunk per content block (multi-modal)', async () => {
      const factory: ChannelFactory = async () =>
        makeChannel({ promptImpl: () => ({ stopReason: 'end_turn' }) }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      const collected: Array<{ sessionUpdate: string; content: unknown }> = [];
      const drain = (async () => {
        for await (const e of iter) {
          if (e.type !== 'session_update') continue;
          const update = (
            e.data as { update?: { sessionUpdate?: string; content?: unknown } }
          )?.update;
          if (update?.sessionUpdate === 'user_message_chunk') {
            collected.push({
              sessionUpdate: update.sessionUpdate,
              content: update.content,
            });
            if (collected.length === 2) break;
          }
        }
      })();

      await bridge.sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [
            { type: 'text', text: 'describe this' },
            { type: 'resource_link', uri: 'file:///x.png', name: 'x.png' },
          ],
        },
        undefined,
        { clientId: session.clientId },
      );

      await drain;
      // One echo frame per content block, in order.
      expect(collected).toHaveLength(2);
      expect(collected[0]?.content).toEqual({
        type: 'text',
        text: 'describe this',
      });
      expect(collected[1]?.content).toMatchObject({ type: 'resource_link' });

      abort.abort();
      await bridge.shutdown();
    });

    it('broadcasts prompt_cancelled with originator attribution on cancelSession', async () => {
      // Cross-client sync: a cancel must surface as a first-class event
      // so peer subscribers don't have to infer it from the absence of
      // further agent chunks.
      const factory: ChannelFactory = async () =>
        makeChannel({ promptImpl: () => ({ stopReason: 'end_turn' }) }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const firstCancel = (async () => {
        for await (const e of iter) {
          if (e.type === 'prompt_cancelled') return e;
        }
        throw new Error('no prompt_cancelled observed');
      })();

      await bridge.cancelSession(session.sessionId, undefined, {
        clientId: session.clientId,
      });

      const evt = await firstCancel;
      expect(evt.type).toBe('prompt_cancelled');
      expect((evt.data as { sessionId: string }).sessionId).toBe(
        session.sessionId,
      );
      expect(evt.originatorClientId).toBe(session.clientId);

      abort.abort();
      await bridge.shutdown();
    });

    it('broadcasts prompt_cancelled to peers when the originator SSE aborts mid-prompt', async () => {
      // Cross-client sync: client disconnect (tab close / network drop /
      // laptop sleep) is the most common cancel trigger in production.
      // The `sendPrompt` `onAbort` path must publish `prompt_cancelled`
      // to peer subscribers — not just the explicit `cancelSession`
      // route. A regression here would silently re-open the gap.
      let releasePrompt: (() => void) | undefined;
      const factory: ChannelFactory = async () =>
        makeChannel({
          // Hang the prompt so it stays in-flight while we abort.
          promptImpl: async () => {
            await new Promise<void>((res) => {
              releasePrompt = res;
            });
            return { stopReason: 'cancelled' };
          },
        }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Peer subscriber (a DIFFERENT client watching the same session).
      const peerAbort = new AbortController();
      const peerIter = bridge.subscribeEvents(session.sessionId, {
        signal: peerAbort.signal,
      });
      const peerCancel = (async () => {
        for await (const e of peerIter) {
          if (e.type === 'prompt_cancelled') return e;
        }
        throw new Error('peer never saw prompt_cancelled');
      })();

      // Originator sends the (hanging) prompt, then its SSE/HTTP signal
      // aborts mid-flight (connection dropped).
      const promptAbort = new AbortController();
      const promptPromise = bridge
        .sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'long running' }],
          },
          promptAbort.signal,
          { clientId: session.clientId },
        )
        .catch(() => {
          // AbortError is expected — the originator's connection dropped.
        });

      // Give the queue worker a tick to start the prompt, then abort.
      await new Promise((r) => setTimeout(r, 10));
      promptAbort.abort();

      const evt = await peerCancel;
      expect(evt.type).toBe('prompt_cancelled');
      expect((evt.data as { sessionId: string }).sessionId).toBe(
        session.sessionId,
      );
      // Attributed to the prompt's originator (whose connection dropped).
      expect(evt.originatorClientId).toBe(session.clientId);

      // Let the hung promptImpl settle so shutdown doesn't wait on it.
      releasePrompt?.();
      await promptPromise;
      peerAbort.abort();
      await bridge.shutdown();
    });

    it('emits prompt_cancelled at most once when cancelSession races the SSE abort (D2)', async () => {
      // doudouOUC #4484 post-merge review (D2): a client that POSTs
      // /cancel and then immediately drops its socket triggers BOTH
      // `cancelSession` and the `sendPrompt` abort path for the same turn.
      // The `cancelBroadcast` latch must dedup so peers see exactly one
      // `prompt_cancelled`.
      let releasePrompt: (() => void) | undefined;
      const factory: ChannelFactory = async () =>
        makeChannel({
          promptImpl: async () => {
            await new Promise<void>((res) => {
              releasePrompt = res;
            });
            return { stopReason: 'cancelled' };
          },
        }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const peerAbort = new AbortController();
      const peerIter = bridge.subscribeEvents(session.sessionId, {
        signal: peerAbort.signal,
      });
      const cancelEvents: BridgeEvent[] = [];
      const collecting = (async () => {
        for await (const e of peerIter) {
          if (e.type === 'prompt_cancelled') cancelEvents.push(e);
        }
      })();

      const promptAbort = new AbortController();
      const promptPromise = bridge
        .sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'long running' }],
          },
          promptAbort.signal,
          { clientId: session.clientId },
        )
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 10));
      // Both cancel routes fire for the same active prompt.
      await bridge.cancelSession(
        session.sessionId,
        { sessionId: session.sessionId },
        { clientId: session.clientId },
      );
      promptAbort.abort();

      releasePrompt?.();
      await promptPromise;
      await new Promise((r) => setTimeout(r, 10));
      peerAbort.abort();
      await collecting;
      // Exactly one broadcast despite two cancel triggers.
      expect(cancelEvents).toHaveLength(1);
      await bridge.shutdown();
    });

    it('resets the cancel-broadcast latch per prompt (a second prompt re-broadcasts)', async () => {
      // Guards the `entry.cancelBroadcast = false` reset at prompt start: if it
      // were removed, every cancel after the first deduped turn would be
      // silently suppressed. Cancel prompt 1 (latch sets), then cancel prompt 2
      // — peers must see a SECOND prompt_cancelled.
      const releasers: Array<() => void> = [];
      const factory: ChannelFactory = async () =>
        makeChannel({
          promptImpl: async () =>
            new Promise<{ stopReason: 'cancelled' }>((res) => {
              releasers.push(() => res({ stopReason: 'cancelled' }));
            }),
        }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const peerAbort = new AbortController();
      const peerIter = bridge.subscribeEvents(session.sessionId, {
        signal: peerAbort.signal,
      });
      const cancelEvents: BridgeEvent[] = [];
      const collecting = (async () => {
        for await (const e of peerIter) {
          if (e.type === 'prompt_cancelled') cancelEvents.push(e);
        }
      })();

      const runTurn = async () => {
        const p = bridge
          .sendPrompt(
            session.sessionId,
            {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'x' }],
            },
            undefined,
            { clientId: session.clientId },
          )
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 10));
        await bridge.cancelSession(
          session.sessionId,
          { sessionId: session.sessionId },
          { clientId: session.clientId },
        );
        releasers.shift()?.();
        await p;
        await new Promise((r) => setTimeout(r, 5));
      };

      await runTurn(); // prompt 1: latch sets, 1 broadcast
      await runTurn(); // prompt 2: latch was reset at start → re-broadcasts
      peerAbort.abort();
      await collecting;
      expect(cancelEvents).toHaveLength(2);
      await bridge.shutdown();
    });

    it('emits a compensating prompt_cancelled{forward_failed} when the prompt forward rejects (C3)', async () => {
      // doudouOUC #4484 post-merge review (C3): the user echo is published
      // before the forward. If the forward itself rejects (transport died /
      // ACP error) without a user cancel, peers must still see the turn end
      // — otherwise they sit forever on the echoed input with no response.
      const h = makeChannel({
        promptImpl: async () => {
          throw new Error('forward boom');
        },
      });
      const cancelSpy = vi.spyOn(h.agent, 'cancel');
      const factory: ChannelFactory = async () => h.channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const peerAbort = new AbortController();
      const peerIter = bridge.subscribeEvents(session.sessionId, {
        signal: peerAbort.signal,
      });
      const peerCancel = (async () => {
        for await (const e of peerIter) {
          if (e.type === 'prompt_cancelled') return e;
        }
        throw new Error('peer never saw prompt_cancelled');
      })();

      await bridge
        .sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'will fail to forward' }],
          },
          undefined,
          { clientId: session.clientId },
        )
        .catch(() => {
          // forward rejection surfaces to the caller too.
        });

      const evt = await peerCancel;
      expect(evt.type).toBe('prompt_cancelled');
      expect((evt.data as { reason?: string }).reason).toBe('forward_failed');
      await vi.waitFor(() => {
        expect(cancelSpy).toHaveBeenCalledWith({
          sessionId: session.sessionId,
        });
      });
      peerAbort.abort();
      await bridge.shutdown();
    });

    it('stamps envelope originatorClientId on session_closed', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const firstClosed = (async () => {
        for await (const e of iter) {
          if (e.type === 'session_closed') return e;
        }
        throw new Error('no session_closed observed');
      })();

      await bridge.closeSession(session.sessionId, {
        clientId: session.clientId,
      });

      const evt = await firstClosed;
      // Envelope-level stamp (new) — sibling events use this field.
      expect(evt.originatorClientId).toBe(session.clientId);
      // Back-compat `data.closedBy` retained.
      expect((evt.data as { closedBy?: string }).closedBy).toBe(
        session.clientId,
      );

      abort.abort();
      await bridge.shutdown();
    });

    it('stamps envelope originatorClientId on session_metadata_updated', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const firstMeta = (async () => {
        for await (const e of iter) {
          if (e.type === 'session_metadata_updated') return e;
        }
        throw new Error('no session_metadata_updated observed');
      })();

      bridge.updateSessionMetadata(
        session.sessionId,
        { displayName: 'renamed session' },
        { clientId: session.clientId },
      );

      const evt = await firstMeta;
      expect(evt.originatorClientId).toBe(session.clientId);
      expect((evt.data as { displayName?: string }).displayName).toBe(
        'renamed session',
      );

      abort.abort();
      await bridge.shutdown();
    });

    it('overrides a stale sessionId in the body with the routing id', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      await bridge.sendPrompt(session.sessionId, {
        // Body claims a different sessionId — bridge must not honor it.
        sessionId: 'spoofed',
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(handles[0]?.agent.promptCalls[0]?.sessionId).toBe(
        session.sessionId,
      );

      await bridge.shutdown();
    });

    it('FIFO-serializes concurrent prompts on the same session', async () => {
      const order: string[] = [];
      let resolveFirst: (() => void) | undefined;
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({
          promptImpl: async (p) => {
            const tag =
              (p.prompt[0] as { text?: string } | undefined)?.text ?? '?';
            order.push(`start:${tag}`);
            if (tag === 'first') {
              await new Promise<void>((res) => {
                resolveFirst = res;
              });
            }
            order.push(`end:${tag}`);
            return { stopReason: 'end_turn' };
          },
        });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const p1 = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'first' }],
      });
      const p2 = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      });

      // Give the event loop a chance to run the agent's start handler.
      await new Promise((r) => setTimeout(r, 10));
      // The second prompt MUST NOT have started before the first ended.
      expect(order).toEqual(['start:first']);

      resolveFirst!();
      await Promise.all([p1, p2]);
      expect(order).toEqual([
        'start:first',
        'end:first',
        'start:second',
        'end:second',
      ]);

      await bridge.shutdown();
    });

    it('rejects prompts past the default per-session pending cap synchronously', async () => {
      let releaseFirst: (() => void) | undefined;
      const factory: ChannelFactory = async () =>
        makeChannel({
          promptImpl: async (p) => {
            const text =
              (p.prompt[0] as { text?: string } | undefined)?.text ?? '';
            if (text === 'hold') {
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
            }
            return { stopReason: 'end_turn' };
          },
        }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const accepted = Array.from({ length: 5 }, (_, i) =>
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: i === 0 ? 'hold' : `queued-${i}` }],
        }),
      );

      expect(() =>
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'overflow' }],
        }),
      ).toThrow(PromptQueueFullError);

      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      releaseFirst!();
      await Promise.all(accepted);
      await bridge.shutdown();
    });

    it.each([[0], [Infinity]])(
      'does not cap pending prompts when maxPendingPromptsPerSession is %s',
      async (maxPendingPromptsPerSession) => {
        let releaseFirst: (() => void) | undefined;
        const factory: ChannelFactory = async () =>
          makeChannel({
            promptImpl: async (p) => {
              const text =
                (p.prompt[0] as { text?: string } | undefined)?.text ?? '';
              if (text === 'hold') {
                await new Promise<void>((resolve) => {
                  releaseFirst = resolve;
                });
              }
              return { stopReason: 'end_turn' };
            },
          }).channel;
        const bridge = makeBridge({
          channelFactory: factory,
          maxPendingPromptsPerSession,
        });
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

        const accepted = Array.from({ length: 6 }, (_, i) =>
          bridge.sendPrompt(session.sessionId, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: i === 0 ? 'hold' : `queued-${i}` }],
          }),
        );

        await vi.waitFor(() => expect(releaseFirst).toBeDefined());
        releaseFirst!();
        await expect(Promise.all(accepted)).resolves.toHaveLength(6);
        await bridge.shutdown();
      },
    );

    it('releases a pending prompt slot after a failed prompt settles', async () => {
      let releaseFirst: (() => void) | undefined;
      let calls = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({
          promptImpl: async () => {
            calls += 1;
            if (calls === 1) {
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
              throw new Error('first prompt failed');
            }
            return { stopReason: 'end_turn' };
          },
        }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxPendingPromptsPerSession: 1,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const failed = bridge
        .sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'first' }],
        })
        .catch((err: unknown) => err);

      expect(() =>
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'overflow' }],
        }),
      ).toThrow(PromptQueueFullError);

      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      releaseFirst!();
      await expect(failed).resolves.toMatchObject({ code: -32603 });
      await expect(
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'after-failure' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      await bridge.shutdown();
    });

    it('does not count pre-aborted prompts against the pending cap', async () => {
      let releaseFirst: (() => void) | undefined;
      let calls = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({
          promptImpl: async () => {
            calls += 1;
            if (calls === 1) {
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
            }
            return { stopReason: 'end_turn' };
          },
        }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxPendingPromptsPerSession: 1,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const active = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'active' }],
      });

      const aborted = new AbortController();
      aborted.abort();
      expect(() =>
        bridge.sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'aborted' }],
          },
          aborted.signal,
        ),
      ).toThrow(/Prompt aborted/);

      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      releaseFirst!();
      await active;
      await expect(
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'after-abort' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      await bridge.shutdown();
    });

    it('does not count queued branchSession work against the prompt cap', async () => {
      let releaseBranch: (() => void) | undefined;
      const factory: ChannelFactory = async () =>
        makeChannel({
          extMethodImpl: async (method) => {
            if (method !== 'qwen/control/session/branch') return {};
            await new Promise<void>((resolve) => {
              releaseBranch = resolve;
            });
            return { newSessionId: 'branch-1', title: 'Branch 1' };
          },
          resumeSessionImpl: () => ({}),
        }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxPendingPromptsPerSession: 1,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const branch = bridge.branchSession(session.sessionId, {
        name: 'Branch 1',
      });
      const prompt = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'after-branch' }],
      });

      await vi.waitFor(() => expect(releaseBranch).toBeDefined());
      releaseBranch!();
      await expect(branch).resolves.toMatchObject({
        sessionId: 'branch-1',
        displayName: 'Branch 1',
      });
      await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
      await bridge.shutdown();
    });

    it('publishes session_branched only on the new session stream', async () => {
      const factory: ChannelFactory = async () =>
        makeChannel({
          extMethodImpl: async (method) => {
            if (method !== 'qwen/control/session/branch') return {};
            return { newSessionId: 'branch-1', title: 'Branch 1' };
          },
          resumeSessionImpl: () => ({}),
        }).channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const sourceAbort = new AbortController();
      const sourceIter = bridge
        .subscribeEvents(session.sessionId, { signal: sourceAbort.signal })
        [Symbol.asyncIterator]();

      const branch = await bridge.branchSession(session.sessionId, {
        name: 'Branch 1',
      });

      const sourceEvent = await Promise.race([
        sourceIter.next(),
        new Promise<'timeout'>((resolve) => setTimeout(resolve, 25, 'timeout')),
      ]);
      expect(sourceEvent).toBe('timeout');
      sourceAbort.abort();

      const sourceReplayAbort = new AbortController();
      const sourceReplayIter = bridge
        .subscribeEvents(session.sessionId, {
          lastEventId: 0,
          signal: sourceReplayAbort.signal,
        })
        [Symbol.asyncIterator]();
      const sourceReplayEvent = await Promise.race([
        sourceReplayIter.next(),
        new Promise<'timeout'>((resolve) => setTimeout(resolve, 25, 'timeout')),
      ]);
      expect(sourceReplayEvent).toMatchObject({
        value: { type: 'replay_complete' },
      });
      const sourceReplayNext = await Promise.race([
        sourceReplayIter.next(),
        new Promise<'timeout'>((resolve) => setTimeout(resolve, 25, 'timeout')),
      ]);
      expect(sourceReplayNext).toBe('timeout');
      sourceReplayAbort.abort();

      const branchedIter = bridge
        .subscribeEvents(branch.sessionId, { lastEventId: 0 })
        [Symbol.asyncIterator]();
      const replayed = await branchedIter.next();
      expect(replayed.value).toMatchObject({
        type: 'session_branched',
        data: {
          sourceSessionId: session.sessionId,
          newSessionId: branch.sessionId,
          displayName: 'Branch 1',
        },
      });

      await bridge.shutdown();
    });

    it('a failed prompt does not poison the queue for subsequent prompts', async () => {
      let promptCount = 0;
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({
          promptImpl: async () => {
            promptCount += 1;
            if (promptCount === 1) {
              throw new Error('first prompt boom');
            }
            return { stopReason: 'end_turn' };
          },
        });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const failed = await bridge
        .sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'a' }],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(failed).not.toBeNull();

      const ok = await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'b' }],
      });
      expect(ok).toEqual({ stopReason: 'end_turn' });

      await bridge.shutdown();
    });

    it('rejects launchSessionForkAgent while a prompt is active', async () => {
      let releasePrompt: (() => void) | undefined;
      const handle = makeChannel({
        promptImpl: async () =>
          new Promise<PromptResponse>((resolve) => {
            releasePrompt = () => resolve({ stopReason: 'end_turn' });
          }),
      });
      const bridge = makeBridge({ channelFactory: async () => handle.channel });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const active = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'active' }],
      });
      await vi.waitFor(() => expect(releasePrompt).toBeDefined());

      await expect(
        bridge.launchSessionForkAgent(session.sessionId, 'review this'),
      ).rejects.toBeInstanceOf(SessionBusyError);
      expect(
        handle.agent.extMethodCalls.some(
          (call) => call.method === 'qwen/control/session/fork_agent',
        ),
      ).toBe(false);

      releasePrompt!();
      await expect(active).resolves.toEqual({ stopReason: 'end_turn' });
      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      await expect(
        bridge.sendPrompt('unknown', {
          sessionId: 'unknown',
          prompt: [{ type: 'text', text: 'x' }],
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe('cancelSession', () => {
    it('forwards a cancel notification with the routing id', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      await bridge.cancelSession(session.sessionId);
      // Cancel is a notification — let it propagate before observing.
      await new Promise((r) => setTimeout(r, 10));
      expect(handles[0]?.agent.cancelCalls).toHaveLength(1);
      expect(handles[0]?.agent.cancelCalls[0]?.sessionId).toBe(
        session.sessionId,
      );

      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      await expect(bridge.cancelSession('unknown')).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
    });

    it('treats idle agent cancel as success', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({
          cancelImpl: () => {
            throw {
              code: -32603,
              message: 'Internal error',
              data: { details: 'Not currently generating' },
            };
          },
        });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      await expect(
        bridge.cancelSession(session.sessionId),
      ).resolves.toBeUndefined();
      expect(handles[0]?.agent.cancelCalls).toHaveLength(1);

      await bridge.shutdown();
    });

    it('treats idle agent cancel wording variants as success', async () => {
      const variants: unknown[] = [
        new Error(`${NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE} (session idle)`),
        {
          code: -32603,
          message: 'Internal error',
          data: { details: 'not currently generating' },
        },
      ];

      for (const err of variants) {
        const handles: ChannelHandle[] = [];
        const factory: ChannelFactory = async () => {
          const h = makeChannel({
            cancelImpl: () => {
              throw err;
            },
          });
          handles.push(h);
          return h.channel;
        };
        const bridge = makeBridge({ channelFactory: factory });
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

        await expect(
          bridge.cancelSession(session.sessionId),
        ).resolves.toBeUndefined();
        expect(handles[0]?.agent.cancelCalls).toHaveLength(1);

        await bridge.shutdown();
      }
    });
  });

  describe('permission flow', () => {
    /** Spin up a bridge with a hand-driven channel; returns the bridge,
     *  session, and a function the test uses to call `requestPermission`
     *  from the agent side. */
    async function setupForPermission() {
      let capturedConn: AgentSideConnection | undefined;
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        // The agent side gets an AgentSideConnection; that exposes a
        // ClientSideConnection-equivalent on its `agent` callback. We need
        // to drive `requestPermission` from the agent direction — for that
        // the agent calls back through its `connection` instance.
        const conn = new AgentSideConnection(() => fakeAgent, agentStream);
        // Save the connection — agent code uses `conn.requestPermission(...)`
        // which sends the JSON-RPC request to the bridge's BridgeClient.
        capturedConn = conn;
        const handle = { killed: false };
        handles.push(handle);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {
            handle.killed = true;
          },
          killSync: () => {
            handle.killed = true;
          },
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      return { bridge, session, conn: capturedConn!, handles };
    }

    it('publishes a permission_request event with a generated requestId and awaits a vote', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      // Fire requestPermission from the agent side.
      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });

      // Read the permission_request event off the bus.
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.done).toBe(false);
      const evt = next.value!;
      expect(evt.type).toBe('permission_request');
      const payload = evt.data as {
        requestId: string;
        sessionId: string;
        options: Array<{ optionId: string }>;
      };
      expect(typeof payload.requestId).toBe('string');
      expect(payload.requestId.length).toBeGreaterThan(0);
      expect(payload.sessionId).toBe(session.sessionId);
      expect(payload.options.map((o) => o.optionId)).toEqual(['allow', 'deny']);
      expect(bridge.pendingPermissionCount).toBe(1);

      // Vote.
      const accepted = bridge.respondToPermission(payload.requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      expect(accepted).toBe(true);

      // The agent's promise resolves.
      const response = (await respPromise) as {
        outcome: { outcome: string; optionId?: string };
      };
      expect(response.outcome.outcome).toBe('selected');
      expect(response.outcome.optionId).toBe('allow');
      expect(bridge.pendingPermissionCount).toBe(0);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('forwards permission vote metadata back to the agent response', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: 'tc-ask',
          title: 'AskUserQuestion: Ask user 1 question',
        },
        options: [
          { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
          { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
        ],
      });

      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.done).toBe(false);
      const payload = next.value!.data as { requestId: string };

      const responseWithAnswers = {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: {
          name: 'Alice',
          grade: 'Primary',
        },
        ignored: 'not forwarded',
      } satisfies RequestPermissionResponse & {
        answers: Record<string, string>;
        ignored: string;
      };
      const accepted = bridge.respondToPermission(
        payload.requestId,
        responseWithAnswers,
      );
      expect(accepted).toBe(true);

      const response = await respPromise;
      expect(response).toMatchObject({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: {
          name: 'Alice',
          grade: 'Primary',
        },
      });
      expect(response).not.toHaveProperty('ignored');

      subAbort.abort();
      await bridge.shutdown();
    });

    it('forwards session-scoped permission answers without arbitrary metadata', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: 'tc-ask-scoped',
          title: 'AskUserQuestion: Ask user 1 question',
        },
        options: [
          { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
          { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
        ],
      });

      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.done).toBe(false);
      const payload = next.value!.data as { requestId: string };

      const responseWithAnswers = {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: {
          name: 'Alice',
        },
        ignored: 'not forwarded',
      } satisfies RequestPermissionResponse & {
        answers: Record<string, string>;
        ignored: string;
      };
      const accepted = bridge.respondToSessionPermission(
        session.sessionId,
        payload.requestId,
        responseWithAnswers,
        { clientId: session.clientId },
      );
      expect(accepted).toBe(true);

      const response = await respPromise;
      expect(response).toMatchObject({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: {
          name: 'Alice',
        },
      });
      expect(response).not.toHaveProperty('ignored');

      subAbort.abort();
      await bridge.shutdown();
    });

    it('returns false (not InvalidClientIdError) when session exists but requestId is unknown and clientId is unregistered (#4335 / 3271978329 / 3272493792 / 3273077272)', async () => {
      // Wenshao review #4335 / 3271978329 (Critical) — error
      // precedence regression: the session-scoped vote route must
      // return `false` (→ 404) when the requestId isn't known to
      // the mediator, BEFORE validating `context.clientId`.
      // Without this guard a probe could fabricate a requestId,
      // supply an arbitrary `X-Qwen-Client-Id`, and distinguish
      // "this clientId is registered to this session" (proceeds
      // past resolveTrustedClientId then returns false → 404) from
      // "this clientId is not registered" (InvalidClientIdError →
      // 400) — a session-membership oracle.
      //
      // Wenshao review #4335 / 3272493792 — explicit test for the
      // fix from Round 7 so a future refactor can't silently
      // remove the short-circuit.
      //
      // Wenshao review #4335 / 3273077272 — also assert the stderr
      // breadcrumb that Round 8 promoted from debug-gated to
      // unconditional (`writeStderrLine`). Pinning the log call
      // means a future refactor that drops or downgrades the line
      // is caught even when the return value still happens to be
      // false for some other reason.
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        const { bridge, session } = await setupForPermission();

        // Session exists, requestId is unknown, clientId is fake.
        // The bridge MUST return false; pre-fix it threw
        // InvalidClientIdError (400).
        const result = bridge.respondToSessionPermission(
          session.sessionId,
          'unknown-req-id',
          { outcome: { outcome: 'cancelled' } },
          { clientId: 'fabricated-client-id' },
        );
        expect(result).toBe(false);
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('rejected permission vote'),
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('unknown-req-id'),
        );

        await bridge.shutdown();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('rejects cancel sentinel injection via {selected,"__cancelled__"} (#4335 / 3271420267)', async () => {
      // wenshao/qwen-latest review #4335 (3271420267) — the most
      // security-critical guard in this PR. The mediator recognizes
      // CANCEL_VOTE_SENTINEL ('__cancelled__') BEFORE validating the
      // option against allowedOptionIds, so a wire client sending
      // `{outcome:'selected', optionId:'__cancelled__'}` could
      // bypass ALL policy dispatch (designated/consensus/local-only)
      // and resolve the request as cancelled. The bridge guards
      // against this by throwing InvalidPermissionOptionError
      // BEFORE forwarding to mediator.vote — without a test, a
      // future refactor could silently remove the check.
      const { bridge, session, conn } = await setupForPermission();
      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      const payload = next.value!.data as { requestId: string };

      // Wire-injected sentinel via `selected` outcome — must
      // throw InvalidPermissionOptionError before reaching the
      // mediator.
      expect(() =>
        bridge.respondToSessionPermission(
          session.sessionId,
          payload.requestId,
          {
            outcome: { outcome: 'selected', optionId: '__cancelled__' },
          },
        ),
      ).toThrow(InvalidPermissionOptionError);

      // Pending was preserved — a legitimate vote still resolves.
      expect(bridge.pendingPermissionCount).toBe(1);
      bridge.respondToSessionPermission(session.sessionId, payload.requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      const response = (await respPromise) as {
        outcome: { outcome: string; optionId?: string };
      };
      expect(response.outcome.outcome).toBe('selected');
      expect(response.outcome.optionId).toBe('allow');

      subAbort.abort();
      await bridge.shutdown();
    });

    it('rejects votes whose optionId was not in the agent-offered set (BkwQI)', async () => {
      // BkwQI: bridge.respondToPermission validates the voter's
      // `optionId` against the original `options` the agent sent.
      // A client with the bearer can't forge a hidden outcome (e.g.
      // `ProceedAlways*` when the prompt's `hideAlwaysAllow` policy
      // suppressed it). Throws `InvalidPermissionOptionError`.
      const { bridge, session, conn } = await setupForPermission();
      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      const payload = next.value!.data as { requestId: string };

      // Forged optionId — NOT in the agent-offered set.
      expect(() =>
        bridge.respondToPermission(payload.requestId, {
          outcome: { outcome: 'selected', optionId: 'ProceedAlwaysProject' },
        }),
      ).toThrow(InvalidPermissionOptionError);

      // The pending permission is still alive — a valid vote can
      // still resolve it. (Throw didn't consume the pending entry.)
      expect(bridge.pendingPermissionCount).toBe(1);
      bridge.respondToPermission(payload.requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      const response = (await respPromise) as {
        outcome: { outcome: string; optionId?: string };
      };
      expect(response.outcome.optionId).toBe('allow');

      // Cancelled outcomes don't need an optionId, and aren't checked.
      // (Already covered by `cancelSession resolves outstanding
      // permissions as cancelled` below — call out the contract here.)

      subAbort.abort();
      await bridge.shutdown();
    });

    it('first-responder wins: a second vote returns false', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const evt = (await it.next()).value!;
      const requestId = (evt.data as { requestId: string }).requestId;

      const first = bridge.respondToPermission(requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      const second = bridge.respondToPermission(requestId, {
        outcome: { outcome: 'cancelled' },
      });
      expect(first).toBe(true);
      expect(second).toBe(false);

      await respPromise; // resolved by the first vote
      subAbort.abort();
      await bridge.shutdown();
    });

    it('publishes a permission_resolved event when a vote lands', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      bridge.respondToPermission(
        requestId,
        {
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
        { clientId: session.clientId },
      );

      const resolvedEvt = (await it.next()).value!;
      expect(resolvedEvt.type).toBe('permission_resolved');
      expect(resolvedEvt.originatorClientId).toBe(session.clientId);
      expect(resolvedEvt.data).toMatchObject({
        requestId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      subAbort.abort();
      await bridge.shutdown();
    });

    it('publishes permission_already_resolved when a scoped vote loses the race', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      const accepted = bridge.respondToSessionPermission(
        session.sessionId,
        requestId,
        {
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
        { clientId: session.clientId },
      );
      expect(accepted).toBe(true);
      const resolvedEvt = (await it.next()).value!;
      expect(resolvedEvt.type).toBe('permission_resolved');

      const second = bridge.respondToSessionPermission(
        session.sessionId,
        requestId,
        { outcome: { outcome: 'cancelled' } },
        { clientId: session.clientId },
      );
      expect(second).toBe(false);
      const alreadyEvt = (await it.next()).value!;
      expect(alreadyEvt.type).toBe('permission_already_resolved');
      expect(alreadyEvt.originatorClientId).toBeUndefined();
      expect(alreadyEvt.data).toMatchObject({
        requestId,
        sessionId: session.sessionId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      subAbort.abort();
      await bridge.shutdown();
    });

    it('session-scoped permission votes cannot resolve another session request', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      const wrongSession = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const accepted = bridge.respondToSessionPermission(
        wrongSession.sessionId,
        requestId,
        { outcome: { outcome: 'selected', optionId: 'allow' } },
        { clientId: wrongSession.clientId },
      );
      expect(accepted).toBe(false);
      expect(bridge.pendingPermissionCount).toBe(1);
      expect(
        bridge.respondToSessionPermission(
          wrongSession.sessionId,
          requestId,
          { outcome: { outcome: 'cancelled' } },
          { clientId: 'client-not-issued' },
        ),
      ).toBe(false);
      expect(bridge.pendingPermissionCount).toBe(1);

      bridge.respondToPermission(requestId, {
        outcome: { outcome: 'cancelled' },
      });
      expect(bridge.pendingPermissionCount).toBe(0);
      subAbort.abort();
      await bridge.shutdown();
    });

    it('session-scoped duplicate votes do not validate clients against another session', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      expect(
        bridge.respondToSessionPermission(
          session.sessionId,
          requestId,
          {
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
          { clientId: session.clientId },
        ),
      ).toBe(true);

      const wrongSession = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(
        bridge.respondToSessionPermission(
          wrongSession.sessionId,
          requestId,
          { outcome: { outcome: 'cancelled' } },
          { clientId: 'client-not-issued' },
        ),
      ).toBe(false);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('respondToSessionPermission throws SessionNotFoundError for unknown sessions', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });

      expect(() =>
        bridge.respondToSessionPermission('missing-session', 'req-1', {
          outcome: { outcome: 'cancelled' },
        }),
      ).toThrow(SessionNotFoundError);

      await bridge.shutdown();
    });

    it('rejects scoped votes whose optionId was not in the agent-offered set', async () => {
      const { bridge, session, conn } = await setupForPermission();
      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      const payload = next.value!.data as { requestId: string };

      expect(() =>
        bridge.respondToSessionPermission(
          session.sessionId,
          payload.requestId,
          {
            outcome: {
              outcome: 'selected',
              optionId: 'ProceedAlwaysProject',
            },
          },
          { clientId: session.clientId },
        ),
      ).toThrow(InvalidPermissionOptionError);

      expect(bridge.pendingPermissionCount).toBe(1);
      bridge.respondToSessionPermission(
        session.sessionId,
        payload.requestId,
        {
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
        { clientId: session.clientId },
      );
      const response = (await respPromise) as {
        outcome: { outcome: string; optionId?: string };
      };
      expect(response.outcome.optionId).toBe('allow');

      subAbort.abort();
      await bridge.shutdown();
    });

    it('rejects permission votes with unregistered client ids', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      expect(() =>
        bridge.respondToPermission(
          requestId,
          {
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
          { clientId: 'client-not-issued' },
        ),
      ).toThrow(InvalidClientIdError);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('respondToPermission returns false for unknown requestId', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const accepted = bridge.respondToPermission('does-not-exist', {
        outcome: { outcome: 'cancelled' },
      });
      expect(accepted).toBe(false);
      await bridge.shutdown();
    });

    it('returns false uniformly for unknown permission votes regardless of clientId registration (#4335 / 3272493777)', async () => {
      // Wenshao review #4335 / 3272493777 — error precedence: an
      // unknown requestId must return `false` (→ 404) regardless of
      // whether the supplied `clientId` is registered in any
      // session. The previous PR #4231 boundary returned 400 for
      // unregistered clientIds and 404 for registered ones, which
      // turned out to be a cross-session client-registration
      // oracle: a remote prober posting `POST /permission/<bogus>`
      // with various `X-Qwen-Client-Id` headers could distinguish
      // "this clientId is registered in some active session" (404)
      // from "not registered anywhere" (400). The session-scoped
      // route's matching fix landed in Round 7 (#3271978329); this
      // pins the symmetric posture for the legacy route and
      // explicitly inverts the assertion the pre-Round-7 test used
      // to make.
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Unregistered clientId — must NOT throw; uniform `false`.
      expect(
        bridge.respondToPermission(
          'does-not-exist',
          {
            outcome: { outcome: 'cancelled' },
          },
          { clientId: 'client-not-issued' },
        ),
      ).toBe(false);
      // Registered clientId — also `false`.
      expect(
        bridge.respondToPermission(
          'does-not-exist',
          {
            outcome: { outcome: 'cancelled' },
          },
          { clientId: session.clientId },
        ),
      ).toBe(false);
      // No clientId at all — `false` (unchanged behavior).
      expect(
        bridge.respondToPermission('does-not-exist', {
          outcome: { outcome: 'cancelled' },
        }),
      ).toBe(false);

      await bridge.shutdown();
    });

    it('cancelSession resolves outstanding permissions as cancelled', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      // Drain the permission_request event off the bus before cancelling
      // (resolving via cancel publishes a permission_resolved event;
      // ensure the consumer's queue isn't already full of unread frames).
      const it = iter[Symbol.asyncIterator]();
      await it.next();
      expect(bridge.pendingPermissionCount).toBe(1);

      await bridge.cancelSession(session.sessionId);

      const response = (await respPromise) as {
        outcome: { outcome: string };
      };
      expect(response.outcome.outcome).toBe('cancelled');
      expect(bridge.pendingPermissionCount).toBe(0);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('shutdown resolves outstanding permissions as cancelled', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      await it.next();
      expect(bridge.pendingPermissionCount).toBe(1);

      await bridge.shutdown();

      const response = (await respPromise) as {
        outcome: { outcome: string };
      };
      expect(response.outcome.outcome).toBe('cancelled');
      expect(bridge.pendingPermissionCount).toBe(0);

      subAbort.abort();
    });

    it('sendPrompt abort resolves pending permissions as cancelled (A-UsU)', async () => {
      // Regression test for the bug fix where `sendPrompt`'s
      // `onAbort` handler was missing the `cancelPendingForSession`
      // call. Without it, an HTTP client disconnecting mid-permission
      // would leave the agent stuck waiting on a vote that no SSE
      // subscriber would ever cast.
      //
      // FakeAgent's `prompt()` here issues a permission request and
      // then awaits a never-resolving promise, so the agent IS the
      // thing pending on the permission. When the test aborts the
      // sendPrompt, `cancelPendingForSession` resolves the
      // permission, which in turn lets the agent's prompt() throw
      // (it sees the cancelled outcome). Both sides settle.
      let conn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          promptImpl: async (p): Promise<PromptResponse> => {
            // Issue the permission request from inside prompt() so
            // it's correlated with the in-flight prompt the bridge
            // is awaiting.
            await (
              conn as unknown as {
                requestPermission(q: unknown): Promise<unknown>;
              }
            ).requestPermission({
              sessionId: p.sessionId,
              toolCall: { toolCallId: 'tc-1', title: 'x' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              ],
            });
            return { stopReason: 'cancelled' };
          },
        });
        conn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Kick off sendPrompt — agent will issue a permission request
      // that no SSE subscriber will vote on.
      const promptAbort = new AbortController();
      const promptResult = bridge
        .sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'x' }],
          },
          promptAbort.signal,
        )
        .catch(() => undefined);

      // Wait until the permission has been registered.
      for (let i = 0; i < 50 && bridge.pendingPermissionCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(bridge.pendingPermissionCount).toBe(1);

      // Abort the prompt — the bug being regressed: the abort
      // handler must call `cancelPendingForSession` so the pending
      // permission resolves as cancelled (otherwise the agent's
      // `requestPermission` blocks forever).
      promptAbort.abort();

      // Wait for the permission to resolve as cancelled. With the
      // bug present this would hang until the test timeout.
      for (let i = 0; i < 50 && bridge.pendingPermissionCount > 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(bridge.pendingPermissionCount).toBe(0);

      await bridge.shutdown();
      await promptResult;
    });
  });

  describe('modelServiceId honored at session create', () => {
    /** Build a channel that records `unstable_setSessionModel` calls. */
    function setup(opts: { setModelImpl?: () => Promise<unknown> } = {}) {
      const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { sessionId: string; modelId: string }) => {
                setModelCalls.push({
                  sessionId: req.sessionId,
                  modelId: req.modelId,
                });
                if (opts.setModelImpl) await opts.setModelImpl();
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      return { bridge, setModelCalls };
    }

    it('applies modelServiceId via unstable_setSessionModel after newSession', async () => {
      const { bridge, setModelCalls } = setup();
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'qwen3-coder',
      });
      expect(session.attached).toBe(false);
      expect(setModelCalls).toHaveLength(1);
      expect(setModelCalls[0]?.sessionId).toBe(session.sessionId);
      expect(setModelCalls[0]?.modelId).toBe('qwen3-coder');
      await bridge.shutdown();
    });

    it('does NOT call setSessionModel when modelServiceId is omitted', async () => {
      const { bridge, setModelCalls } = setup();
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(setModelCalls).toHaveLength(0);
      await bridge.shutdown();
    });

    it('keeps the session alive on model-switch failure and publishes model_switch_failed', async () => {
      // Contract (per #3889 review A05Ym): when the agent rejects the
      // requested model at create-session time, the session is still
      // operational on the agent's default model. The caller gets a
      // sessionId they can retry the model switch against (via
      // POST /session/:id/model) and observe via the SSE stream.
      // Tearing the session down would force the caller into a 500
      // with no way to recover.
      const { bridge } = setup({
        setModelImpl: async () => {
          throw new Error('unknown model');
        },
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'definitely-not-a-real-model',
      });
      expect(session.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);
      // The model_switch_failed event must be on the bus for any
      // subscriber that subscribes with `lastEventId: 0` (replay).
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const it = iter[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value?.type).toBe('model_switch_failed');
      expect(first.value?.data).toMatchObject({
        sessionId: session.sessionId,
        requestedModelId: 'definitely-not-a-real-model',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('attaches to the existing session on retry after a model-switch failure', async () => {
      // Per the same A05Ym contract: a follow-up `spawnOrAttach` for
      // the same workspace finds the existing session (rather than
      // re-spawning a fresh one), and a retry of the model switch
      // through `POST /session/:id/model` is the documented recovery
      // path. We exercise just the attach side here.
      const { bridge } = setup({
        setModelImpl: async () => {
          throw new Error('first attempt rejected');
        },
      });

      const first = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'try-1',
      });
      expect(first.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);

      // Second attach (no modelServiceId so we don't re-trigger the
      // failing setModel) reuses the same session.
      const second = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
      });
      expect(second.attached).toBe(true);
      expect(second.sessionId).toBe(first.sessionId);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
    });
  });

  describe('channel exit cleanup (child-crash recovery)', () => {
    it('removes the SessionEntry when the channel terminates unexpectedly', async () => {
      const handles: ChannelHandle[] = [];
      let n = 0;
      const factory: ChannelFactory = async () => {
        // Distinct sessionIdPrefix per spawn so the post-crash retry gets
        // a different sessionId than the dead session — verifies the
        // bridge spawned a NEW child rather than reusing.
        const h = makeChannel({ sessionIdPrefix: `gen${n++}` });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });

      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(1);

      // Subscribe so we can observe the session_died event.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Simulate a child crash (channel.exited resolves but we never called
      // kill() — entry is still in byId / defaultEntry at the moment of crash).
      handles[0]?.crash();

      // Drain the bus — first frame is `session_died`.
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.done).toBe(false);
      expect(next.value?.type).toBe('session_died');

      // After the crash handler runs, the entry should be gone.
      // (await one microtask in case the handler is still resolving.)
      await Promise.resolve();
      expect(bridge.sessionCount).toBe(0);

      // A subsequent spawnOrAttach for the same workspace must NOT reuse
      // the dead session; it spawns fresh (attached: false) with a new id.
      const fresh = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(fresh.attached).toBe(false);
      expect(fresh.sessionId).not.toBe(session.sessionId);
      expect(handles).toHaveLength(2);

      abort.abort();
      await bridge.shutdown();
    });

    it('exit fired on planned shutdown does NOT trigger the unexpected-cleanup path', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // No subscribers; planned shutdown removes the entry first, THEN
      // calls channel.kill() which resolves channel.exited. The cleanup
      // .then() handler runs but sees byId.get(sessionId) === undefined
      // (already removed), so it no-ops and doesn't double-publish.
      await bridge.shutdown();

      // Re-subscribing throws SessionNotFoundError (not a stale state).
      expect(() => bridge.subscribeEvents(session.sessionId)).toThrow();
      expect(bridge.sessionCount).toBe(0);
    });
  });

  describe('model-change FIFO + failure recovery', () => {
    it('publishes model_switch_failed and surfaces the error when the agent rejects', async () => {
      let attempts = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async () => {
                attempts += 1;
                if (attempts > 1) throw new Error('agent denied');
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'first',
      });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Second attach with a NEW model — agent rejects. Per #3889
      // review A-UsJ the attach path now SWALLOWS the model-switch
      // failure (matches the create-session path's existing
      // behavior): the session is fully operational on its current
      // model, and returning an error without the sessionId would
      // deny the caller any way to recover. The visible signal is
      // the `model_switch_failed` SSE event (asserted below).
      const attached = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'rejected',
      });
      expect(attached.attached).toBe(true);
      expect(attached.sessionId).toBe(session.sessionId);

      // Crucially: the session is still alive (we didn't tear it down
      // because it's a SHARED session). Other clients keep working.
      expect(bridge.sessionCount).toBe(1);

      // And cross-client observability: a model_switch_failed event
      // surfaced on the bus so attached clients learn the agent denied
      // the model change. (We subscribed AFTER the first spawn, so the
      // initial `model_switched` from spawn-time isn't in this iter
      // unless we'd passed lastEventId=0; the failed switch is the only
      // event we expect to observe live.)
      const it = iter[Symbol.asyncIterator]();
      const failed = await it.next();
      expect(failed.value?.type).toBe('model_switch_failed');
      expect(
        (failed.value?.data as { requestedModelId?: string })?.requestedModelId,
      ).toBe('rejected');

      abort.abort();
      await bridge.shutdown();
    });

    it('does NOT reconcile when applyModelServiceId roundtrip fails on attach', async () => {
      // F4oaj: the attach-time model apply (`applyModelServiceId`) gates
      // reconcile on the same `succeeded` flag as `setSessionModel`. When the
      // agent rejects `unstable_setSessionModel`, `publishModelSwitched` never
      // runs and the cache is unchanged, so reconciliation must be skipped (no
      // status read) — otherwise a corrective `model_switched` would be paired
      // with the `model_switch_failed`. The agent's status deliberately drifts
      // so any (incorrect) reconcile would produce an observable corrective.
      let statusReads = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/session/context') {
              statusReads += 1;
              return Promise.resolve({
                state: { models: { currentModelId: 'qwen-turbo' } },
              });
            }
            return Promise.resolve({});
          },
        });
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async () => {
                throw new Error('agent denied');
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      // Spawn WITHOUT a model so the only model apply is the failing one on the
      // second attach (a spawn-time apply would succeed and legitimately read
      // status, muddying the assertion).
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Attach with a model — the agent rejects it. The attach swallows the
      // failure (shared session stays alive) and surfaces it as a bus event.
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'rejected',
      });

      const it = iter[Symbol.asyncIterator]();
      const failed = await it.next();
      expect(failed.value?.type).toBe('model_switch_failed');
      // Give any (incorrectly) scheduled reconcile a tick to fire.
      await new Promise((r) => setTimeout(r, 10));
      expect(statusReads).toBe(0);
      abort.abort();
      await bridge.shutdown();
    });

    it('serializes concurrent model-change calls (FIFO)', async () => {
      const callOrder: string[] = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { modelId: string }) => {
                callOrder.push(`enter:${req.modelId}`);
                // Simulate an agent that takes time to apply.
                await new Promise((r) => setTimeout(r, 30));
                callOrder.push(`exit:${req.modelId}`);
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      // First call spawns the session AND applies model "A".
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'A',
      });

      // Two concurrent attaches with different models. Without the FIFO
      // they'd interleave (enter:B, enter:C, exit:B, exit:C).
      await Promise.all([
        bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          modelServiceId: 'B',
        }),
        bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          modelServiceId: 'C',
        }),
      ]);

      // Strict sequencing: each `setSessionModel` exits before the next
      // one enters.
      const noEnter = callOrder.findIndex(
        (s, i) =>
          s.startsWith('enter:') &&
          i > 0 &&
          callOrder[i - 1]!.startsWith('enter:'),
      );
      expect(noEnter).toBe(-1);
      await bridge.shutdown();
    });
  });

  describe('attach honors modelServiceId on existing session', () => {
    /** Channel + agent factory that records every set-model call. */
    function setupRecording() {
      const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { sessionId: string; modelId: string }) => {
                setModelCalls.push({
                  sessionId: req.sessionId,
                  modelId: req.modelId,
                });
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      return { factory, setModelCalls };
    }

    it('applies modelServiceId on attach via unstable_setSessionModel', async () => {
      const { factory, setModelCalls } = setupRecording();
      const bridge = makeBridge({ channelFactory: factory });

      // First call spawns; second call attaches with a DIFFERENT model.
      const first = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'model-A',
      });
      const second = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'model-B',
      });

      expect(second.attached).toBe(true);
      expect(second.sessionId).toBe(first.sessionId);
      // Two set-model calls: one at create time, one at attach time.
      expect(setModelCalls.map((c) => c.modelId)).toEqual([
        'model-A',
        'model-B',
      ]);

      await bridge.shutdown();
    });

    it('attach without modelServiceId does NOT issue setSessionModel', async () => {
      const { factory, setModelCalls } = setupRecording();
      const bridge = makeBridge({ channelFactory: factory });

      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'model-A',
      });
      // Plain attach — no model preference passed.
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      expect(setModelCalls).toEqual([
        { sessionId: expect.any(String), modelId: 'model-A' },
      ]);

      await bridge.shutdown();
    });
  });

  describe('sendPrompt fail-fast on transport close', () => {
    it('rejects in-flight prompt when channel.exited fires', async () => {
      // Build a channel whose `prompt()` never resolves naturally;
      // exposing the `crash()` hook lets us trigger channel.exited.
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<
        | { exitCode: number | null; signalCode: NodeJS.Signals | null }
        | undefined
      >((r) => {
        resolveExited = () => r(undefined);
      });
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        // Fake agent's prompt() never replies — we want the bridge's
        // race-against-exited to be the only resolution path.
        const stuckAgent: Agent = {
          async initialize() {
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentInfo: { name: 'stuck', version: '0' },
              authMethods: [],
              agentCapabilities: {},
            };
          },
          async newSession(p) {
            return { sessionId: `stuck:${p.cwd}` };
          },
          async loadSession() {
            throw new Error('not impl');
          },
          async authenticate() {
            throw new Error('not impl');
          },
          async prompt() {
            return new Promise(() => {}); // hang forever
          },
          async cancel() {},
          async setSessionMode() {
            throw new Error('not impl');
          },
          async setSessionConfigOption() {
            throw new Error('not impl');
          },
        };
        new AgentSideConnection(() => stuckAgent, agentStream);
        return {
          stream: clientStream,
          exited,
          kill: async () => resolveExited!(),
          killSync: () => resolveExited!(),
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const promptResult = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });

      // Trigger transport close mid-flight.
      setTimeout(() => resolveExited!(), 50);

      await expect(promptResult).rejects.toThrow(/channel closed/i);
      await bridge.shutdown();
    });
  });

  describe('opts validation', () => {
    it('rejects an invalid sessionScope', () => {
      expect(() =>
        makeBridge({
          sessionScope: 'bogus' as unknown as 'single',
        }),
      ).toThrow(/Invalid sessionScope/);
    });

    it('rejects a non-positive initializeTimeoutMs', () => {
      expect(() => makeBridge({ initializeTimeoutMs: 0 })).toThrow(
        /initializeTimeoutMs/,
      );
      expect(() => makeBridge({ initializeTimeoutMs: -1 })).toThrow(
        /initializeTimeoutMs/,
      );
    });

    it('rejects NaN maxSessions (BRApy: silent fail-OPEN guard)', () => {
      // A typo / parse error in CLI / config that yields NaN must
      // NOT silently disable the daemon's resource cap. We fail
      // boot loud instead of serving unbounded.
      expect(() => makeBridge({ maxSessions: NaN })).toThrow(
        /maxSessions: NaN/,
      );
      expect(() => makeBridge({ maxSessions: -5 })).toThrow(/maxSessions: -5/);
      // Explicit zero or Infinity remain valid "unlimited" sentinels.
      expect(() => makeBridge({ maxSessions: 0 })).not.toThrow();
      expect(() => makeBridge({ maxSessions: Infinity })).not.toThrow();
    });

    it.each([
      ['negative', -5],
      ['float', 1.5],
      ['NaN', Number.NaN],
    ])('rejects invalid maxPendingPromptsPerSession (%s)', (_label, value) => {
      expect(() => makeBridge({ maxPendingPromptsPerSession: value })).toThrow(
        /maxPendingPromptsPerSession/,
      );
    });

    it('accepts disabled maxPendingPromptsPerSession sentinels', () => {
      expect(() =>
        makeBridge({ maxPendingPromptsPerSession: 0 }),
      ).not.toThrow();
      expect(() =>
        makeBridge({ maxPendingPromptsPerSession: Infinity }),
      ).not.toThrow();
    });
  });

  describe('concurrent spawn coalescing (single scope)', () => {
    it('two parallel calls for the same workspace spawn ONE channel', async () => {
      let spawnCount = 0;
      const factory: ChannelFactory = async () => {
        spawnCount += 1;
        // Tiny delay so the second call's check arrives before the first
        // resolves — this is the race window without coalescing.
        await new Promise((r) => setTimeout(r, 10));
        return makeChannel().channel;
      };
      const bridge = makeBridge({ channelFactory: factory });

      const [a, b] = await Promise.all([
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ]);

      expect(spawnCount).toBe(1);
      expect(a.sessionId).toBe(b.sessionId);
      // Exactly one of the two callers reports `attached: false` (the spawn
      // owner); the other reports `attached: true`.
      expect([a.attached, b.attached].sort()).toEqual([false, true]);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
    });

    it('clears the in-flight slot on rejection so the next call can retry', async () => {
      let attempt = 0;
      const factory: ChannelFactory = async () => {
        attempt += 1;
        if (attempt === 1) {
          // First spawn fails the initialize handshake.
          const h = makeChannel({
            initializeThrows: new Error('boom'),
          });
          return h.channel;
        }
        return makeChannel().channel;
      };
      const bridge = makeBridge({ channelFactory: factory });

      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toBeTruthy();

      // The retry must NOT see the rejected promise still parked in
      // inFlightSpawns — that would poison every future call.
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(session.sessionId).toBe(SESS_A);
      expect(session.attached).toBe(false);
      expect(attempt).toBe(2);

      await bridge.shutdown();
    });
  });

  describe('BridgeClient file proxy (Stage 1: same-host trust)', () => {
    /** Spawn an agent that drives readTextFile/writeTextFile from the agent
     *  side, exercising the BridgeClient proxy. */
    async function setupForFs() {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        capturedConn = new AgentSideConnection(
          () => new FakeAgent(),
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      return { bridge, session, conn: capturedConn! };
    }

    it('writeTextFile writes to local fs', async () => {
      const { bridge, conn } = await setupForFs();
      const tmp = path.join(
        os.tmpdir(),
        `qwen-bridge-write-${randomBytes(8).toString('hex')}.txt`,
      );
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: tmp,
          content: 'hello bridge',
        });
        const content = await fsp.readFile(tmp, 'utf8');
        expect(content).toBe('hello bridge');
      } finally {
        await fsp.rm(tmp, { force: true });
        await bridge.shutdown();
      }
    });

    it('writeTextFile leaves no .tmp turd in the target directory (BSA0D)', async () => {
      // Verify the atomic write-then-rename pattern doesn't leak the
      // intermediate temp file. After a successful write, only the
      // target should exist in the directory.
      const { bridge, conn } = await setupForFs();
      const dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-bridge-atomic-'),
      );
      const tmp = path.join(dir, 'target.txt');
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: tmp,
          content: 'atomic',
        });
        const entries = await fsp.readdir(dir);
        // Only the target should remain — no `target.txt.<pid>.<ts>.tmp`.
        expect(entries).toEqual(['target.txt']);
        expect(await fsp.readFile(tmp, 'utf8')).toBe('atomic');
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile rejects files past the size cap (BSA0E)', async () => {
      // Cap is 100 MiB; create a 1 KiB sentinel and monkey-patch the
      // path's stat-reported size to exceed the cap by re-pointing
      // readTextFile at /dev/zero (which fs.stat reports as size 0
      // on Linux), so we can't easily simulate a 100MB file in unit
      // tests. Instead, confirm the cap path is reachable via
      // direct invocation by stubbing fs.stat through a sparse file.
      //
      // Sparse file: `truncate -s 200M` creates a 200 MiB hole that
      // costs zero blocks. fs.stat reports size=200MiB; fs.readFile
      // would balloon RSS but we throw before that.
      const { bridge, conn } = await setupForFs();
      const sparse = path.join(
        os.tmpdir(),
        `qwen-bridge-sparse-${randomBytes(8).toString('hex')}.bin`,
      );
      const fh = await fsp.open(sparse, 'w');
      try {
        await fh.truncate(200 * 1024 * 1024); // 200 MiB hole
        await fh.close();
        // Error message is wrapped by the JSON-RPC layer; assert via
        // the structured envelope's data.details rather than the
        // outer "Internal error" string.
        await expect(
          (
            conn as unknown as {
              readTextFile(p: {
                path: string;
                sessionId: string;
              }): Promise<unknown>;
            }
          ).readTextFile({ sessionId: 'unused', path: sparse }),
        ).rejects.toMatchObject({
          data: {
            details: expect.stringMatching(/exceeds the.*byte daemon cap/),
          },
        });
      } finally {
        await fsp.rm(sparse, { force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile rejects non-regular files even when size=0 (BX8YO)', async () => {
      // Char devices / FIFOs / procfs entries report size=0 but
      // produce unbounded data on read. Use a FIFO as the portable
      // probe (chrdev / procfs not always available).
      //
      // Hard-skip on Windows: the platform doesn't have FIFOs at the
      // OS level. Git-Bash and similar shells ship a `mkfifo` binary
      // that succeeds-with-degeneration (creates a regular file or
      // silently does nothing), which then makes the test assert
      // against the wrong error shape and look like a regression.
      // The bridge's `!stats.isFile()` check itself is platform-
      // agnostic; Linux + macOS coverage is sufficient.
      if (process.platform === 'win32') return;
      const { bridge, conn } = await setupForFs();
      const fifoPath = path.join(
        os.tmpdir(),
        `qwen-bridge-fifo-${randomBytes(8).toString('hex')}`,
      );
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('mkfifo', [fifoPath]);
      } catch {
        // Skip if mkfifo not on PATH for some reason.
        await bridge.shutdown();
        return;
      }
      try {
        await expect(
          (
            conn as unknown as {
              readTextFile(p: {
                path: string;
                sessionId: string;
              }): Promise<unknown>;
            }
          ).readTextFile({ sessionId: 'unused', path: fifoPath }),
        ).rejects.toMatchObject({
          data: { details: expect.stringMatching(/not a regular file/) },
        });
      } finally {
        await fsp.rm(fifoPath, { force: true });
        await bridge.shutdown();
      }
    });

    it('writeTextFile preserves symlinks (BX8Yw)', async () => {
      // Pre-fix: rename replaced the symlink with a regular file,
      // leaving the original target unchanged. Verify the target's
      // content is what was written and the symlink is preserved.
      const { bridge, conn } = await setupForFs();
      const dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-bridge-symlink-'),
      );
      const target = path.join(dir, 'target.txt');
      const link = path.join(dir, 'link.txt');
      await fsp.writeFile(target, 'original target', 'utf8');
      await fsp.symlink(target, link);
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: link,
          content: 'updated through symlink',
        });
        // Target got the new content.
        expect(await fsp.readFile(target, 'utf8')).toBe(
          'updated through symlink',
        );
        // Link is still a symlink, not a regular file.
        const linkStat = await fsp.lstat(link);
        expect(linkStat.isSymbolicLink()).toBe(true);
        // Reading through the link still goes to the target.
        expect(await fsp.readFile(link, 'utf8')).toBe(
          'updated through symlink',
        );
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        await bridge.shutdown();
      }
    });

    it('writeTextFile preserves dangling symlinks (BfFvO)', async () => {
      // Symlink whose target doesn't exist yet — `fs.realpath` throws
      // ENOENT. Pre-fix: the catch silently fell back to writing to
      // params.path (the symlink), and rename replaced the symlink
      // with a regular file (the original BX8Yw bug, masked for
      // dangling targets). Fix uses `fs.readlink` to disambiguate.
      if (process.platform === 'win32') return; // symlinks need admin on Windows
      const { bridge, conn } = await setupForFs();
      const dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-bridge-dangling-'),
      );
      const target = path.join(dir, 'target.txt'); // not created yet
      const link = path.join(dir, 'link.txt');
      await fsp.symlink(target, link);
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: link,
          content: 'created through dangling symlink',
        });
        // Target now exists with the content.
        expect(await fsp.readFile(target, 'utf8')).toBe(
          'created through dangling symlink',
        );
        // Link is STILL a symlink (not replaced by a regular file).
        const linkStat = await fsp.lstat(link);
        expect(linkStat.isSymbolicLink()).toBe(true);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile returns full content by default', async () => {
      const { bridge, conn } = await setupForFs();
      const tmp = path.join(
        os.tmpdir(),
        `qwen-bridge-read-${randomBytes(8).toString('hex')}.txt`,
      );
      await fsp.writeFile(
        tmp,
        'line one\nline two\nline three\nline four',
        'utf8',
      );
      try {
        const result = (await (
          conn as unknown as {
            readTextFile(p: {
              path: string;
              sessionId: string;
            }): Promise<{ content: string }>;
          }
        ).readTextFile({ sessionId: 'unused', path: tmp })) as {
          content: string;
        };
        expect(result.content).toContain('line one');
        expect(result.content).toContain('line four');
      } finally {
        await fsp.rm(tmp, { force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile slices via line/limit (ACP 1-based line)', async () => {
      const { bridge, conn } = await setupForFs();
      const tmp = path.join(
        os.tmpdir(),
        `qwen-bridge-slice-${randomBytes(8).toString('hex')}.txt`,
      );
      await fsp.writeFile(tmp, 'a\nb\nc\nd\ne', 'utf8');
      try {
        // line:1, limit:2 means "first two lines" per ACP spec (1-based).
        const first = (await (
          conn as unknown as {
            readTextFile(p: {
              path: string;
              sessionId: string;
              line?: number;
              limit?: number;
            }): Promise<{ content: string }>;
          }
        ).readTextFile({
          sessionId: 'unused',
          path: tmp,
          line: 1,
          limit: 2,
        })) as { content: string };
        expect(first.content).toBe('a\nb');

        // line:3, limit:2 → lines 3 and 4.
        const middle = (await (
          conn as unknown as {
            readTextFile(p: {
              path: string;
              sessionId: string;
              line?: number;
              limit?: number;
            }): Promise<{ content: string }>;
          }
        ).readTextFile({
          sessionId: 'unused',
          path: tmp,
          line: 3,
          limit: 2,
        })) as { content: string };
        expect(middle.content).toBe('c\nd');
      } finally {
        await fsp.rm(tmp, { force: true });
        await bridge.shutdown();
      }
    });
  });

  describe('listWorkspaceSessions', () => {
    it('returns sessions matching the bound workspace cwd', async () => {
      let n = 0;
      const factory: ChannelFactory = async () => {
        // Distinct sessionIdPrefix per spawn so two thread-scope sessions
        // in the same workspace get distinct ids (the FakeAgent encodes the
        // cwd into the id otherwise → collision).
        const h = makeChannel({ sessionIdPrefix: `s${n++}` });
        return h.channel;
      };
      const bridge = makeBridge({
        sessionScope: 'thread',
        channelFactory: factory,
      });

      const a1 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const a2 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const aList = bridge.listWorkspaceSessions(WS_A);
      expect(aList).toHaveLength(2);
      expect(aList.map((s) => s.sessionId).sort()).toEqual(
        [a1.sessionId, a2.sessionId].sort(),
      );
      // Querying a different workspace returns an empty list (the
      // bridge only hosts `boundWorkspace` per #3803 §02; a UI asking
      // for sessions in some other path is correct to see "none").
      const bList = bridge.listWorkspaceSessions(WS_B);
      expect(bList).toEqual([]);
      const idleList = bridge.listWorkspaceSessions('/work/c');
      expect(idleList).toEqual([]);

      await bridge.shutdown();
    });

    it('canonicalizes the lookup path', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const list = bridge.listWorkspaceSessions('/work/./a');
      expect(list).toHaveLength(1);
      expect(list[0]?.workspaceCwd).toBe(WS_A);

      await bridge.shutdown();
    });

    it('returns empty for relative paths instead of throwing', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      expect(bridge.listWorkspaceSessions('relative/path')).toEqual([]);
    });
  });

  describe('setSessionModel', () => {
    /** Set up a channel where the agent records setSessionModel calls. */
    async function setup() {
      const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        // Augment the agent with the unstable model setter via a proxy so we
        // don't need to extend the FakeAgent class with optional methods.
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { sessionId: string; modelId: string }) => {
                setModelCalls.push({
                  sessionId: req.sessionId,
                  modelId: req.modelId,
                });
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      return { bridge, session, setModelCalls };
    }

    it('forwards modelId to the agent and overrides body sessionId', async () => {
      const { bridge, session, setModelCalls } = await setup();
      const response = await bridge.setSessionModel(session.sessionId, {
        sessionId: 'spoofed',
        modelId: 'qwen3-coder',
      });
      expect(response).toEqual({});
      expect(setModelCalls[0]?.sessionId).toBe(session.sessionId);
      expect(setModelCalls[0]?.modelId).toBe('qwen3-coder');
      await bridge.shutdown();
    });

    it('publishes a model_switched event on success', async () => {
      const { bridge, session } = await setup();
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      await bridge.setSessionModel(session.sessionId, {
        sessionId: session.sessionId,
        modelId: 'qwen3-coder',
      });
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.value?.type).toBe('model_switched');
      expect(next.value?.data).toEqual({
        sessionId: session.sessionId,
        modelId: 'qwen3-coder',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('stamps model events with the trusted originator client id', async () => {
      const { bridge, session } = await setup();
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      await bridge.setSessionModel(
        session.sessionId,
        {
          sessionId: session.sessionId,
          modelId: 'qwen3-coder',
        },
        { clientId: session.clientId },
      );
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.value?.type).toBe('model_switched');
      expect(next.value?.originatorClientId).toBe(session.clientId);
      abort.abort();
      await bridge.shutdown();
    });

    it('rejects unregistered client ids on session-scoped requests', async () => {
      const { bridge, session } = await setup();
      await expect(
        bridge.sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
          },
          undefined,
          { clientId: 'client-not-issued' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientIdError);
      await expect(
        bridge.cancelSession(session.sessionId, undefined, {
          clientId: 'client-not-issued',
        }),
      ).rejects.toBeInstanceOf(InvalidClientIdError);
      await expect(
        bridge.setSessionModel(
          session.sessionId,
          {
            sessionId: session.sessionId,
            modelId: 'qwen3-coder',
          },
          { clientId: 'client-not-issued' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientIdError);
      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      await expect(
        bridge.setSessionModel('unknown', {
          sessionId: 'unknown',
          modelId: 'qwen3-coder',
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe('executeShellCommand permission policy', () => {
    function mockShellExecute(output = 'ok') {
      return vi.spyOn(ShellExecutionService, 'execute').mockResolvedValue({
        pid: 123,
        result: Promise.resolve({
          rawOutput: Buffer.from(output),
          output,
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 123,
          executionMethod: 'none',
        }),
      });
    }

    async function setupShellSession() {
      const handle = makeChannel();
      const bridge = makeBridge({
        sessionShellCommandEnabled: true,
        channelFactory: async () => handle.channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      return { bridge, session, handle };
    }

    it('rejects direct shell by default before executing the command', async () => {
      const shellSpy = mockShellExecute();
      const { bridge, session } = await setupShellSession();
      const disabledBridge = makeBridge({
        channelFactory: async () => {
          throw new Error('disabled shell should not spawn a channel');
        },
      });

      await expect(
        disabledBridge.executeShellCommand(session.sessionId, 'echo hi'),
      ).rejects.toBeInstanceOf(SessionShellDisabledError);
      expect(shellSpy).not.toHaveBeenCalled();

      await bridge.shutdown();
      await disabledBridge.shutdown();
      shellSpy.mockRestore();
    });

    it('requires a client id before checking whether the session exists', async () => {
      const shellSpy = mockShellExecute();
      const bridge = makeBridge({
        sessionShellCommandEnabled: true,
        channelFactory: async () => {
          throw new Error('missing client id should not spawn a channel');
        },
      });

      await expect(
        bridge.executeShellCommand('unknown-session', 'echo hi'),
      ).rejects.toBeInstanceOf(SessionShellClientRequiredError);
      expect(shellSpy).not.toHaveBeenCalled();

      await bridge.shutdown();
      shellSpy.mockRestore();
    });

    it('rejects unregistered client ids when direct shell is enabled', async () => {
      const shellSpy = mockShellExecute();
      const { bridge, session } = await setupShellSession();

      await expect(
        bridge.executeShellCommand(session.sessionId, 'echo hi', undefined, {
          clientId: 'client-not-issued',
        }),
      ).rejects.toBeInstanceOf(InvalidClientIdError);
      expect(shellSpy).not.toHaveBeenCalled();

      await bridge.shutdown();
      shellSpy.mockRestore();
    });

    it('executes and stamps events when the client id belongs to the session', async () => {
      const shellSpy = mockShellExecute('hello\n');
      const { bridge, session } = await setupShellSession();
      const abort = new AbortController();
      const events = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      const result = await bridge.executeShellCommand(
        session.sessionId,
        'echo hello',
        undefined,
        { clientId: session.clientId },
      );

      expect(result).toEqual({
        exitCode: 0,
        output: 'hello\n',
        aborted: false,
      });
      expect(shellSpy).toHaveBeenCalledTimes(1);
      const it = events[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value?.type).toBe('user_shell_command');
      expect(first.value?.originatorClientId).toBe(session.clientId);

      abort.abort();
      await bridge.shutdown();
      shellSpy.mockRestore();
    });
  });

  describe('setSessionApprovalMode (#4175 Wave 4 PR 17)', () => {
    /**
     * #4282 fold-in 4 (qwen-latest C1). Build a channel factory whose
     * extMethod handler answers `qwen/control/session/approval_mode`
     * with the expected `{previous, current}` shape. Tracks invocations
     * so the guard-ordering tests can assert that the ACP call did NOT
     * happen when the persist contract was already violated upfront.
     */
    function approvalModeFactoryWithCallTracker(): {
      factory: ChannelFactory;
      getCalls: () => Array<{ method: string }>;
    } {
      const calls: Array<{ method: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: (method, params) => {
            calls.push({ method });
            if (method === 'qwen/control/session/approval_mode') {
              return Promise.resolve({
                previous: 'default',
                current: (params as { mode: string }).mode,
              });
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      return { factory, getCalls: () => calls };
    }

    it('throws BEFORE the ACP roundtrip when persist:true but no callback wired', async () => {
      // The previous post-ACP placement of the persist guard meant a
      // missing callback produced a 500 *after* the ACP child had
      // already applied the mode change — observable to other in-flight
      // requests but invisible to the caller. Pre-call ordering closes
      // that window; assert by checking the ACP `extMethod` was never
      // invoked when the guard fires.
      const { factory, getCalls } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.YOLO,
          { persist: true },
          undefined,
        ),
      ).rejects.toThrow(/persistApprovalMode/);
      expect(
        getCalls().some(
          (c) => c.method === 'qwen/control/session/approval_mode',
        ),
      ).toBe(false);
      await bridge.shutdown();
    });

    it('persist:false bypasses the guard regardless of callback wiring', async () => {
      // Symmetric coverage for the guard: when `persist` is omitted /
      // false, the missing callback is irrelevant and the ACP call must
      // proceed normally. Without this check, a future regression that
      // moves the guard could over-restrict the no-persist path.
      const { factory } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const res = await bridge.setSessionApprovalMode(
        session.sessionId,
        ApprovalMode.YOLO,
        { persist: false },
        undefined,
      );
      expect(res.persisted).toBe(false);
      expect(res.mode).toBe('yolo');
      await bridge.shutdown();
    });

    it('serializes concurrent approval-mode changes through the per-session queue (A3)', async () => {
      // doudouOUC #4484 post-merge review (A3): two concurrent
      // `setSessionApprovalMode` calls must not interleave their ACP
      // roundtrips, otherwise the last `approval_mode_changed` published
      // can disagree with the mode the child actually settled on. The
      // `approvalModeQueue` enforces FIFO. Detect by tracking concurrent
      // in-flight ext calls (must never exceed 1) and the start/end order.
      let inFlight = 0;
      let maxInFlight = 0;
      const order: string[] = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: async (method, params) => {
            if (method === 'qwen/control/session/approval_mode') {
              const mode = (params as { mode: string }).mode;
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              order.push(`start:${mode}`);
              await new Promise((r) => setTimeout(r, 10));
              order.push(`end:${mode}`);
              inFlight -= 1;
              return { previous: 'default', current: mode };
            }
            return {};
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await Promise.all([
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.YOLO,
          { persist: false },
          undefined,
        ),
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.DEFAULT,
          { persist: false },
          undefined,
        ),
      ]);
      // Never overlapped, and the second roundtrip began only after the
      // first fully completed.
      expect(maxInFlight).toBe(1);
      expect(order).toEqual([
        'start:yolo',
        'end:yolo',
        'start:default',
        'end:default',
      ]);
      await bridge.shutdown();
    });

    it('serializes persist + publish too, not just the extMethod (A3, persist:true)', async () => {
      // Regression for the wenshao Critical: covering only the extMethod left
      // persist+publish outside the queue, so two concurrent persist:true
      // changes could interleave their persist phases and publish out of
      // order. Make persist slow + inversely ordered to the calls; assert the
      // published approval_mode_changed events still come out in call order
      // (A then B), proving persist+publish run inside the serialized work.
      const { factory } = approvalModeFactoryWithCallTracker();
      // persist for 'yolo' is SLOWER than for 'default' — if persist ran
      // outside the queue, 'default' would publish before 'yolo'.
      const persistDelay: Record<string, number> = { yolo: 30, default: 1 };
      const bridge = makeBridge({
        channelFactory: factory,
        persistApprovalMode: async (_ws: string, mode: string) => {
          await new Promise((r) => setTimeout(r, persistDelay[mode] ?? 1));
        },
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const published: string[] = [];
      const collecting = (async () => {
        for await (const e of iter) {
          if (e.type === 'approval_mode_changed') {
            published.push((e.data as { next: string }).next);
          }
        }
      })();

      await Promise.all([
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.YOLO,
          { persist: true },
          undefined,
        ),
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.DEFAULT,
          { persist: true },
          undefined,
        ),
      ]);
      await new Promise((r) => setTimeout(r, 20));
      abort.abort();
      await collecting;
      // In call order despite yolo's slower persist — persist+publish are
      // serialized inside the queue, so default can't overtake yolo.
      expect(published).toEqual(['yolo', 'default']);
      await bridge.shutdown();
    });

    it('a failed approval-mode change does not poison the queue (A3 tail-swallow)', async () => {
      // The approvalModeQueue tail-swallows failures so a rejected change
      // can't wedge every subsequent one. First call rejects; the second
      // must still run and succeed.
      let call = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: async (method, params) => {
            if (method === 'qwen/control/session/approval_mode') {
              call += 1;
              if (call === 1) throw new Error('approval boom');
              return {
                previous: 'default',
                current: (params as { mode: string }).mode,
              };
            }
            return {};
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // The ACP layer wraps the agent-side throw as a generic JSON-RPC
      // error; we only care that the first change rejects.
      await expect(
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.YOLO,
          { persist: false },
          undefined,
        ),
      ).rejects.toThrow();

      // Queue not poisoned — the next change still resolves.
      const res = await bridge.setSessionApprovalMode(
        session.sessionId,
        ApprovalMode.DEFAULT,
        { persist: false },
        undefined,
      );
      expect(res.mode).toBe('default');
      await bridge.shutdown();
    });

    it('echoPromptToSessionBus tolerates a non-array prompt (D6 guard)', async () => {
      // The Array.isArray guard means a malformed body that slips past the
      // type contract degrades to "no echo" rather than throwing mid-send.
      const { factory } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const userChunks: BridgeEvent[] = [];
      const collecting = (async () => {
        for await (const e of iter) {
          const u = (e.data as { update?: { sessionUpdate?: string } })?.update;
          if (u?.sessionUpdate === 'user_message_chunk') userChunks.push(e);
        }
      })();

      // prompt is not an array → the Array.isArray guard returns early.
      // Capture the outcome rather than swallowing it: if the guard were
      // removed, echoPromptToSessionBus would throw a TypeError on
      // `undefined.length` and sendPrompt would reject WITH that TypeError —
      // so asserting the error (if any) is NOT a TypeError makes the test
      // fail when the guard is gone (the previous `.catch(() => {})` passed
      // regardless — dead-code-safe, wenshao).
      const caught: unknown = await bridge
        .sendPrompt(
          session.sessionId,
          { sessionId: session.sessionId, prompt: undefined as never },
          undefined,
          { clientId: session.clientId },
        )
        .catch((e) => e);

      await new Promise((r) => setTimeout(r, 10));
      abort.abort();
      await collecting;
      expect(caught).not.toBeInstanceOf(TypeError);
      expect(userChunks).toHaveLength(0);
      await bridge.shutdown();
    });

    it('broadcasts approval_mode_changed to peer sessions when persisted (#4282 fold-in 4 S2)', async () => {
      // When `persist:true` succeeds the change becomes the workspace
      // default, so a peer session needs to know its next ACP child
      // will spawn into a different mode. The session-scoped publish
      // remains the authoritative signal for the requester; the
      // workspace broadcast is the informational mirror for peers.
      const { factory } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({
        channelFactory: factory,
        persistApprovalMode: async () => {},
      });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const aborts = [new AbortController(), new AbortController()];
      const itA = bridge
        .subscribeEvents(a.sessionId, { signal: aborts[0]!.signal })
        [Symbol.asyncIterator]();
      const itB = bridge
        .subscribeEvents(b.sessionId, { signal: aborts[1]!.signal })
        [Symbol.asyncIterator]();
      await bridge.setSessionApprovalMode(
        a.sessionId,
        ApprovalMode.YOLO,
        { persist: true },
        undefined,
      );
      // #4297 fold-in 1: requester gets the event exactly once (via
      // its own session-scoped publish); the broadcast skips the
      // requester so the SDK reducer's `approvalModeChangedCount`
      // increments by 1, not 2, on the requesting client.
      const aFirst = await itA.next();
      expect(aFirst.value?.type).toBe('approval_mode_changed');
      expect(aFirst.value?.data).toMatchObject({
        sessionId: a.sessionId,
        previous: 'default',
        next: 'yolo',
        persisted: true,
      });
      // Race A's next event against a 50ms timer to confirm no second
      // delivery (which would be the duplicate the broadcast used to
      // produce).
      const aTimedSecond = await Promise.race([
        itA.next().then((v) => ({ kind: 'event' as const, v })),
        new Promise((r) => setTimeout(r, 50)).then(() => ({
          kind: 'timeout' as const,
        })),
      ]);
      expect(aTimedSecond.kind).toBe('timeout');
      // Peer session B still receives the workspace-scoped mirror.
      const bFirst = await itB.next();
      expect(bFirst.value?.type).toBe('approval_mode_changed');
      expect(bFirst.value?.data).toMatchObject({
        sessionId: a.sessionId,
        previous: 'default',
        next: 'yolo',
        persisted: true,
      });
      aborts.forEach((a) => a.abort());
      await bridge.shutdown();
    });

    it('does NOT broadcast to peers when persisted is false', async () => {
      // Symmetric coverage: ephemeral changes affect only the
      // requesting session and must not surface on peer SSE buses, or
      // peer UIs would react to a workspace-wide change that didn't
      // happen.
      const { factory } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({ channelFactory: factory });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const aborts = [new AbortController(), new AbortController()];
      const itA = bridge
        .subscribeEvents(a.sessionId, { signal: aborts[0]!.signal })
        [Symbol.asyncIterator]();
      const itB = bridge
        .subscribeEvents(b.sessionId, { signal: aborts[1]!.signal })
        [Symbol.asyncIterator]();
      await bridge.setSessionApprovalMode(
        a.sessionId,
        ApprovalMode.YOLO,
        { persist: false },
        undefined,
      );
      const aFirst = await itA.next();
      expect(aFirst.value?.type).toBe('approval_mode_changed');
      // Race the peer subscriber against a 50ms timer. Without a
      // timeout the test would hang because no event is expected.
      const timed = await Promise.race([
        itB.next().then((v) => ({ kind: 'event' as const, v })),
        new Promise((r) => setTimeout(r, 50)).then(() => ({
          kind: 'timeout' as const,
        })),
      ]);
      expect(timed.kind).toBe('timeout');
      aborts.forEach((a) => a.abort());
      await bridge.shutdown();
    });
  });

  describe('generateSessionRecap (#4175 follow-up)', () => {
    function recapFactory(
      respond: (
        params: Record<string, unknown>,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>,
    ): ChannelFactory {
      return async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/control/session/recap') {
              return Promise.resolve(respond(params));
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
    }

    it('forwards through the ACP child and returns the recap verbatim', async () => {
      const recapText =
        'Refactoring the auth middleware. Next: regenerate the integration fixtures.';
      let observedParams: Record<string, unknown> | undefined;
      const bridge = makeBridge({
        channelFactory: recapFactory((params) => {
          observedParams = params;
          return { sessionId: params['sessionId'], recap: recapText };
        }),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = await bridge.generateSessionRecap(session.sessionId);
      expect(result).toEqual({
        sessionId: session.sessionId,
        recap: recapText,
      });
      expect(observedParams).toEqual({ sessionId: session.sessionId });
      await bridge.shutdown();
    });

    it('preserves a null recap (best-effort failure surface)', async () => {
      const bridge = makeBridge({
        channelFactory: recapFactory((params) => ({
          sessionId: params['sessionId'],
          recap: null,
        })),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = await bridge.generateSessionRecap(session.sessionId);
      expect(result.recap).toBeNull();
      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown sessionId', async () => {
      const bridge = makeBridge({
        channelFactory: recapFactory(() => ({
          sessionId: 'never',
          recap: null,
        })),
      });
      await expect(
        bridge.generateSessionRecap('does-not-exist'),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      await bridge.shutdown();
    });
  });

  describe('addRuntimeMcpServer (T2.8 #4514)', () => {
    /**
     * Build a channel factory whose ACP `extMethod` handler returns a
     * configurable response for `qwen/control/workspace/mcp/runtime-add`.
     */
    function runtimeAddFactory(
      respond: (
        params: Record<string, unknown>,
      ) =>
        | Record<string, unknown>
        | Promise<Record<string, unknown>>
        | Promise<never>,
    ): ChannelFactory {
      return async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/control/workspace/mcp/runtime-add') {
              return Promise.resolve(respond(params));
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
    }

    it('returns the success shape and broadcasts mcp_server_added', async () => {
      const bridge = makeBridge({
        channelFactory: runtimeAddFactory((params) => ({
          name: params['name'],
          transport: 'stdio',
          replaced: false,
          shadowedSettings: false,
          toolCount: 3,
          originatorClientId: params['originatorClientId'],
        })),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const it = bridge
        .subscribeEvents(session.sessionId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      const result = await bridge.addRuntimeMcpServer(
        'test-server',
        { command: 'node', args: ['server.js'] },
        'client-1',
      );
      expect(result).toEqual({
        name: 'test-server',
        transport: 'stdio',
        replaced: false,
        shadowedSettings: false,
        toolCount: 3,
        originatorClientId: 'client-1',
      });
      const next = await it.next();
      expect(next.value?.type).toBe('mcp_server_added');
      expect(next.value?.data).toMatchObject({
        name: 'test-server',
        transport: 'stdio',
        replaced: false,
        shadowedSettings: false,
        toolCount: 3,
        originatorClientId: 'client-1',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('does not emit event when result is skipped (budget_warning_only)', async () => {
      const bridge = makeBridge({
        channelFactory: runtimeAddFactory(() => ({
          name: 'test-server',
          skipped: true,
          reason: 'budget_warning_only',
        })),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const it = bridge
        .subscribeEvents(session.sessionId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      const result = await bridge.addRuntimeMcpServer(
        'test-server',
        { command: 'node', args: ['server.js'] },
        'client-1',
      );
      expect(result).toEqual({
        name: 'test-server',
        skipped: true,
        reason: 'budget_warning_only',
      });
      // No event should have been emitted — verify by checking that
      // the async iterator has nothing ready (next() would hang).
      // Use Promise.race with a short timeout to confirm no event.
      const noEvent = await Promise.race([
        it.next().then(() => 'got_event'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 50)),
      ]);
      expect(noEvent).toBe('timeout');
      abort.abort();
      await bridge.shutdown();
    });

    it('throws with errorKind acp_channel_unavailable when no ACP channel is live', async () => {
      // Create a bridge but do NOT spawn any session
      const bridge = makeBridge({});
      const err = await bridge
        .addRuntimeMcpServer(
          'test-server',
          { command: 'node', args: ['server.js'] },
          'client-1',
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { data?: { errorKind?: string } }).data?.errorKind).toBe(
        'acp_channel_unavailable',
      );
      await bridge.shutdown();
    });

    it('stamps mcp_server_added with the originator clientId', async () => {
      const bridge = makeBridge({
        channelFactory: runtimeAddFactory((params) => ({
          name: params['name'],
          transport: 'sse',
          replaced: true,
          shadowedSettings: true,
          toolCount: 5,
          originatorClientId: params['originatorClientId'],
        })),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const it = bridge
        .subscribeEvents(session.sessionId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      await bridge.addRuntimeMcpServer(
        'my-mcp',
        { url: 'http://localhost:3000/sse' },
        session.clientId!,
      );
      const next = await it.next();
      expect(next.value?.originatorClientId).toBe(session.clientId);
      abort.abort();
      await bridge.shutdown();
    });
  });

  describe('removeRuntimeMcpServer (T2.8 #4514)', () => {
    /**
     * Build a channel factory whose ACP `extMethod` handler returns a
     * configurable response for `qwen/control/workspace/mcp/runtime-remove`.
     */
    function runtimeRemoveFactory(
      respond: (
        params: Record<string, unknown>,
      ) =>
        | Record<string, unknown>
        | Promise<Record<string, unknown>>
        | Promise<never>,
    ): ChannelFactory {
      return async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/control/workspace/mcp/runtime-remove') {
              return Promise.resolve(respond(params));
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
    }

    it('returns the removed shape and broadcasts mcp_server_removed', async () => {
      const bridge = makeBridge({
        channelFactory: runtimeRemoveFactory((params) => ({
          name: params['name'],
          removed: true,
          wasShadowingSettings: false,
          originatorClientId: params['originatorClientId'],
        })),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const it = bridge
        .subscribeEvents(session.sessionId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      const result = await bridge.removeRuntimeMcpServer(
        'test-server',
        'client-2',
      );
      expect(result).toEqual({
        name: 'test-server',
        removed: true,
        wasShadowingSettings: false,
        originatorClientId: 'client-2',
      });
      const next = await it.next();
      expect(next.value?.type).toBe('mcp_server_removed');
      expect(next.value?.data).toMatchObject({
        name: 'test-server',
        wasShadowingSettings: false,
        originatorClientId: 'client-2',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('does not emit event when result is skipped (not_present)', async () => {
      const bridge = makeBridge({
        channelFactory: runtimeRemoveFactory(() => ({
          name: 'ghost',
          skipped: true,
          reason: 'not_present',
        })),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const it = bridge
        .subscribeEvents(session.sessionId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      const result = await bridge.removeRuntimeMcpServer('ghost', 'client-2');
      expect(result).toEqual({
        name: 'ghost',
        skipped: true,
        reason: 'not_present',
      });
      // No event should have been emitted
      const noEvent = await Promise.race([
        it.next().then(() => 'got_event'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 50)),
      ]);
      expect(noEvent).toBe('timeout');
      abort.abort();
      await bridge.shutdown();
    });

    it('throws with errorKind acp_channel_unavailable when no ACP channel is live', async () => {
      const bridge = makeBridge({});
      const err = await bridge
        .removeRuntimeMcpServer('test-server', 'client-2')
        .catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { data?: { errorKind?: string } }).data?.errorKind).toBe(
        'acp_channel_unavailable',
      );
      await bridge.shutdown();
    });
  });

  describe('subscribeEvents', () => {
    it('throws SessionNotFoundError for unknown session ids', () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      expect(() => bridge.subscribeEvents('unknown')).toThrow(
        SessionNotFoundError,
      );
    });

    it('publishes session_update events to subscribers when the agent sends them', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        // Build a channel pair where we capture the agent-side connection
        // so we can drive sessionUpdate notifications from the test.
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Send a sessionUpdate from the agent side (fire-and-forget).
      void capturedConn!.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi' },
        },
      });

      const collected: Array<{ id?: number; type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ id: e.id, type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('session_update');
      expect(collected[0]?.id).toBe(1);

      abort.abort();
      await bridge.shutdown();
    });

    it('splits a2ui tool updates and publishes a sanitized original frame', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const text =
        '[{"version":"v0.9","createSurface":{"surfaceId":"s1","components":[]}},{"version":"v0.9","updateComponents":{"surfaceId":"s2","components":[]}}]\nfallback summary';

      void capturedConn!.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          _meta: {
            serverId: 'a2ui-ui',
            toolName: 'mcp__a2ui-ui__present_ui',
          },
          content: [{ type: 'content', content: { type: 'text', text } }],
          rawOutput: text,
        },
      });

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 3) break;
      }
      expect(collected.map((e) => e.type)).toEqual([
        'session_update',
        'session_update',
        'session_update',
      ]);
      expect(collected[0]?.data).toMatchObject({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'a2ui',
          a2ui: {
            surfaceId: 's1',
            callId: 'call-1',
            commands: [
              {
                version: 'v0.9',
                createSurface: { surfaceId: 's1', components: [] },
              },
            ],
          },
          _meta: { source: 'a2ui-bridge' },
        },
      });
      expect(collected[1]?.data).toMatchObject({
        update: {
          sessionUpdate: 'a2ui',
          a2ui: {
            surfaceId: 's2',
            callId: 'call-1',
            commands: [
              {
                version: 'v0.9',
                updateComponents: { surfaceId: 's2', components: [] },
              },
            ],
          },
          _meta: { source: 'a2ui-bridge' },
        },
      });
      expect(collected[2]?.data).toMatchObject({
        update: {
          sessionUpdate: 'tool_call_update',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'fallback summary' },
            },
          ],
          rawOutput: 'fallback summary',
        },
      });

      abort.abort();
      await bridge.shutdown();
    });

    it('shutdown closes live event subscriptions', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      const drain = (async () => {
        const events: unknown[] = [];
        for await (const e of iter) {
          events.push(e);
        }
        return events;
      })();

      // Give the subscriber a tick to register.
      await new Promise((r) => setTimeout(r, 10));
      await bridge.shutdown();

      // Subscriber must unwind to completion. Per #3889 review A05Ys
      // the bus now publishes a terminal `session_died` event before
      // closing on shutdown, so SSE subscribers can distinguish
      // daemon shutdown from a transient network error.
      const events = (await drain) as Array<{ type: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('session_died');
    });
  });

  // PR 14b: ext-notification handler for child→bridge MCP budget events.
  // Translates `qwen/notify/session/mcp-budget-event` into session-scoped
  // SSE frames (`mcp_budget_warning` / `mcp_child_refused_batch`).
  describe('extNotification — MCP budget events (PR 14b)', () => {
    it('publishes mcp_budget_warning when the child fires the warning event', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: session.sessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );

      const collected: Array<{ id?: number; type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ id: e.id, type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('mcp_budget_warning');
      // PR 14b drops the routing fields (`v`, `sessionId`, `kind`)
      // from `data` since the SSE envelope already encodes them.
      expect(collected[0]?.data).toEqual({
        liveCount: 4,
        reservedCount: 4,
        budget: 4,
        thresholdRatio: 0.75,
        mode: 'warn',
      });
      expect(collected[0]?.id).toBe(1);

      abort.abort();
      await bridge.shutdown();
    });

    it('publishes mcp_child_refused_batch when the child fires the refused-batch event', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: session.sessionId,
          kind: 'refused_batch',
          refusedServers: [
            { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
          ],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'enforce',
        },
      );

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('mcp_child_refused_batch');
      expect(collected[0]?.data).toEqual({
        refusedServers: [
          { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
        ],
        budget: 1,
        liveCount: 1,
        reservedCount: 1,
        mode: 'enforce',
      });

      abort.abort();
      await bridge.shutdown();
    });

    it('publishes terminal_sequence when the child fires terminalSequence notification', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification(
        'qwen/notify/session/terminal-sequence',
        {
          v: 1,
          sessionId: session.sessionId,
          terminalSequence: '\x07',
        },
      );

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('terminal_sequence');
      expect(collected[0]?.data).toEqual({ terminalSequence: '\x07' });

      abort.abort();
      await bridge.shutdown();
    });

    it('drops unknown extNotification methods, kinds, and missing sessionIds silently', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Unknown method — drop.
      void capturedConn!.extNotification('qwen/notify/session/unknown-event', {
        sessionId: session.sessionId,
        kind: 'budget_warning',
      });
      // Missing sessionId — drop.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        { kind: 'budget_warning' },
      );
      // Unknown kind — drop.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        { sessionId: session.sessionId, kind: 'mystery_kind' },
      );
      // Resolvable sessionId but session id doesn't exist — drop.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          sessionId: 'nonexistent',
          kind: 'budget_warning',
          liveCount: 1,
          reservedCount: 1,
          budget: 1,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );
      // Real event — must arrive AFTER all drops above.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: session.sessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );

      const collected: Array<{ type: string }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type });
        if (collected.length === 1) break;
      }
      // Exactly one event got through. Codex review fix #1 changed
      // the "unknown sessionId" path from drop to buffer — the
      // `nonexistent` frame above is now sitting in the early-event
      // buffer (it never registers, so it'll TTL out). All other
      // drops (unknown method, missing sessionId, unknown kind)
      // remain hard-drops.
      expect(collected).toEqual([{ type: 'mcp_budget_warning' }]);

      abort.abort();
      await bridge.shutdown();
    });

    it('buffers events for a not-yet-registered sessionId, drains them on registration (codex fix #1)', async () => {
      // Codex review round 1, finding #1: budget events fired during
      // a session's startup window (between `connection.newSession`
      // dispatching and `byId.set`) reach `BridgeClient.extNotification`
      // with a valid sessionId but no matching entry. Pre-fix those
      // were dropped silently; post-fix they're buffered and replayed
      // via `drainEarlyEvents` so SSE subscribers see them as the
      // FIRST frames of the new session.
      //
      // This test exercises the buffer + drain mechanism directly,
      // pre-buffering for a sessionId that doesn't yet exist, then
      // creating that session via newSessionImpl-controlled id and
      // verifying the drain replayed the frame onto the new EventBus.
      // (Forcing the actual production race window is timing-flaky;
      // the mechanism is the invariant we care about.)
      let capturedConn: AgentSideConnection | undefined;
      // Use sessionScope: 'thread' + a deterministic id-prefix so
      // `spawnOrAttach` returns an id we can pre-target.
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({ sessionIdPrefix: 'pre-buffer' });
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'thread',
      });

      // Boot ANY session first to get the channel + BridgeClient
      // alive (factory + AgentSideConnection are constructed lazily
      // on first spawn). After this, subsequent spawns share the
      // channel and BridgeClient.
      const seed = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Pre-buffer for the NEXT thread-scope session id. FakeAgent
      // names them `<prefix>:<cwd>#<n>`; the seed was call 1
      // (suffix ''), the next will be call 2 (suffix '#2').
      const futureSessionId = `pre-buffer:${WS_A}#2`;
      expect(seed.sessionId).not.toBe(futureSessionId);

      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: futureSessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );

      // Give the bridge's reader loop a tick to dispatch the
      // notification onto BridgeClient.extNotification — it goes
      // through `bufferEarlyEvent` because `futureSessionId` isn't
      // in `byId` yet.
      await new Promise((r) => setTimeout(r, 50));

      // Now create the future session. `createSessionEntry`'s new
      // `drainEarlyEvents` call replays the buffered frame onto the
      // freshly-constructed EventBus.
      const target = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(target.sessionId).toBe(futureSessionId);

      // Subscribe with `lastEventId: 0` so the replay-ring drain
      // path runs (live-only subscriptions skip the ring per
      // `eventBus.ts` semantics). Production SSE clients reconnecting
      // with `Last-Event-ID: 0` get this same behavior.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(target.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const collected: Array<{ id?: number; type: string }> = [];
      for await (const e of iter) {
        collected.push({ id: e.id, type: e.type });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('mcp_budget_warning');
      // Drained frame went through `events.publish`, so it gets an
      // `id` — PR 14b events are session-scoped + replayable.
      expect(collected[0]?.id).toBe(1);

      abort.abort();
      await bridge.shutdown();
    });

    it('tombstones closed sessionIds so late notifications cannot leak into a future load of the same id (codex round 5 fix)', async () => {
      // Codex round 5 finding: pre-fix, after a session was killed
      // / closed, a late `extNotification` from its dying child for
      // the same id would land in `earlyEvents`. If the SAME
      // sessionId came back via `session/load`/`session/resume`
      // within the 60s TTL, `drainEarlyEvents` would replay stale
      // prior-session telemetry onto the NEW subscriber.
      //
      // Fix: every `byId.delete(sid)` site now calls
      // `BridgeClient.markSessionClosed(sid)`, which tombstones the
      // id (rejecting future `bufferEarlyEvent` calls for it) and
      // purges any frames already buffered for it.
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          loadSessionImpl: () => ({ configOptions: [] }),
        });
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });

      // 1) Spawn session A — id = SESS_A.
      const sess = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const sessionId = sess.sessionId;
      expect(sessionId).toBe(SESS_A);

      // 2) Close session A — calls byId.delete + markSessionClosed.
      await bridge.closeSession(sessionId);

      // 3) Simulate a LATE notification from the (now-defunct)
      // child for the closed sessionId. Pre-fix this would land in
      // `earlyEvents`. Post-fix the tombstone rejects it.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );
      // Give the bridge's read loop time to dispatch the notification.
      await new Promise((r) => setTimeout(r, 50));

      // 4) Re-load the SAME persisted sessionId via session/load.
      // createSessionEntry runs drainEarlyEvents — pre-fix the stale
      // frame would be replayed onto the new session's bus.
      const loaded = await bridge.loadSession({
        sessionId,
        workspaceCwd: WS_A,
      });
      expect(loaded.sessionId).toBe(sessionId);

      // 5) Subscribe with lastEventId: 0 to drain the replay ring.
      // Post-fix, no `mcp_budget_warning` should be in the ring
      // (the late notification was dropped at buffer time, not
      // drained on registration).
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(loaded.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const collected: Array<{ type: string }> = [];
      const drainPromise = (async () => {
        for await (const e of iter) {
          collected.push({ type: e.type });
        }
      })();
      // Give the iterator a tick to pull replay frames.
      await new Promise((r) => setTimeout(r, 50));
      abort.abort();
      await drainPromise;

      // No mcp_budget_warning leaked through.
      expect(collected.filter((e) => e.type === 'mcp_budget_warning')).toEqual(
        [],
      );

      await bridge.shutdown();
    });

    it('purges buffered guardrail events when restore fails so retry-success does not replay stale frames (codex round 7 fix)', async () => {
      // Codex round 7 finding: round-6 added `markRestoreInFlight`
      // so `bufferEarlyEvent` accepts frames for tombstoned ids
      // during a restore. If the restore FAILS, pre-fix
      // `clearRestoreInFlight` only released the allow-list and
      // left buffered frames in `earlyEvents[id]`. A subsequent
      // successful retry (`session/load` of the same id within
      // 60s) would `drainEarlyEvents` those stale frames into the
      // new session.
      //
      // Fix: failure path now calls `markSessionClosed` which both
      // re-tombstones the id AND purges `earlyEvents[id]`.
      let capturedConn: AgentSideConnection | undefined;
      let loadAttempt = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        // First load attempt fails; second attempt succeeds. The
        // child's notification fires DURING the failing first
        // attempt — pre-fix it would survive the failure.
        const fakeAgent = new FakeAgent({
          loadSessionImpl: async (req, agent) => {
            loadAttempt += 1;
            if (loadAttempt === 1) {
              // Buffer a guardrail event for this restore window
              // BEFORE failing, simulating the round-6-allow-list
              // behavior.
              void agent;
              void capturedConn!.extNotification(
                'qwen/notify/session/mcp-budget-event',
                {
                  v: 1,
                  sessionId: req.sessionId,
                  kind: 'budget_warning',
                  liveCount: 4,
                  reservedCount: 4,
                  budget: 4,
                  thresholdRatio: 0.75,
                  mode: 'warn',
                },
              );
              // Tiny yield so the bridge dispatches the notification
              // before we throw.
              await new Promise((r) => setTimeout(r, 5));
              throw new Error('simulated transient load failure');
            }
            return { configOptions: [] };
          },
        });
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });

      // Pre-tombstone: spawn + close session with the id we'll later load.
      const sess = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const sessionId = sess.sessionId;
      await bridge.closeSession(sessionId);

      // First load — fails after the child queues a guardrail event.
      // ACP wraps the agent throw as a JSON-RPC "Internal error";
      // the original message lives in `data.details` but the assertion
      // only needs to verify the load rejected.
      await expect(
        bridge.loadSession({ sessionId, workspaceCwd: WS_A }),
      ).rejects.toThrow();

      // Retry — succeeds. Pre-fix this would replay the queued
      // guardrail event onto the new session's bus.
      const loaded = await bridge.loadSession({
        sessionId,
        workspaceCwd: WS_A,
      });
      expect(loaded.sessionId).toBe(sessionId);

      // Verify no stale guardrail event leaked.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(loaded.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const collected: Array<{ type: string }> = [];
      const drainPromise = (async () => {
        for await (const e of iter) {
          collected.push({ type: e.type });
        }
      })();
      await new Promise((r) => setTimeout(r, 50));
      abort.abort();
      await drainPromise;
      expect(collected.filter((e) => e.type === 'mcp_budget_warning')).toEqual(
        [],
      );

      await bridge.shutdown();
    });
  });

  describe('extNotification — in-session model update (A1, #4511)', () => {
    it('promotes current_model_update to model_switched when no bridge roundtrip is in flight', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-max',
      });

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      // Promoted to model_switched with currentModelId mapped to modelId.
      expect(collected[0]?.type).toBe('model_switched');
      expect(collected[0]?.data).toEqual({
        sessionId: session.sessionId,
        modelId: 'qwen-max',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('suppresses current_model_update while a bridge model roundtrip is in flight', async () => {
      // Hang the agent's unstable_setSessionModel so the bridge roundtrip
      // stays in flight (modelRoundtripInFlight = true). The concurrent
      // in-session current_model_update must be suppressed; only the bridge's
      // own model_switched (after the roundtrip) reaches the bus.
      let releaseModel: (() => void) | undefined;
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return () =>
                new Promise<Record<string, never>>((res) => {
                  releaseModel = () => res({});
                });
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        capturedConn = new AgentSideConnection(
          () => augmented as Agent,
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Start a bridge-driven model change; it hangs → roundtrip in flight.
      const modelChange = bridge
        .setSessionModel(
          session.sessionId,
          { sessionId: session.sessionId, modelId: 'qwen-max' },
          undefined,
        )
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 10));

      // Concurrent in-session notification — must be SUPPRESSED.
      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-turbo',
      });
      await new Promise((r) => setTimeout(r, 10));

      // Release the hung roundtrip → the bridge publishes its authoritative one.
      releaseModel?.();
      await modelChange;

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      // Exactly the bridge's model_switched (qwen-max) — the suppressed
      // qwen-turbo notification did NOT produce a second model_switched.
      expect(collected[0]?.type).toBe('model_switched');
      expect((collected[0]?.data as { modelId?: string }).modelId).toBe(
        'qwen-max',
      );
      abort.abort();
      await bridge.shutdown();
    });

    it('drops malformed model-update params (non-string ids) without throwing or emitting', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        capturedConn = new AgentSideConnection(
          () => new FakeAgent(),
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const seen: string[] = [];
      const collecting = (async () => {
        for await (const e of iter) seen.push(e.type);
      })();

      // Non-string currentModelId / missing sessionId → early return, no throw.
      await capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 123 as unknown as string,
      });
      await capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        currentModelId: 'qwen-max',
      });
      await new Promise((r) => setTimeout(r, 10));
      abort.abort();
      await collecting;
      expect(seen.filter((t) => t === 'model_switched')).toEqual([]);
      await bridge.shutdown();
    });

    it('drops a model-update for an unknown sessionId (no entry, no buffer)', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        capturedConn = new AgentSideConnection(
          () => new FakeAgent(),
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const seen: string[] = [];
      const collecting = (async () => {
        for await (const e of iter) seen.push(e.type);
      })();

      await capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: 'nonexistent-session',
        currentModelId: 'qwen-max',
      });
      await new Promise((r) => setTimeout(r, 10));
      abort.abort();
      await collecting;
      // Unlike the MCP-budget path (which buffers unknown ids), model-update
      // drops them — the real session's bus sees nothing.
      expect(seen.filter((t) => t === 'model_switched')).toEqual([]);
      await bridge.shutdown();
    });

    it('stamps originatorClientId from the active prompt on the promoted model_switched', async () => {
      // While a prompt with a clientId is in flight, the session entry carries
      // activePromptOriginatorClientId; the promoted model_switched must
      // inherit it so peers can attribute the change.
      let releasePrompt: (() => void) | undefined;
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          promptImpl: async () => {
            await new Promise<void>((res) => {
              releasePrompt = res;
            });
            return { stopReason: 'end_turn' };
          },
        });
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Hang a prompt with a clientId → activePromptOriginatorClientId set.
      const promptDone = bridge
        .sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
          },
          undefined,
          { clientId: session.clientId },
        )
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 10));

      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-max',
      });

      const collected: Array<{ type: string; originatorClientId?: string }> =
        [];
      for await (const e of iter) {
        if (e.type === 'model_switched') {
          collected.push({
            type: e.type,
            originatorClientId: e.originatorClientId,
          });
          break;
        }
      }
      expect(collected[0]?.originatorClientId).toBe(session.clientId);
      releasePrompt?.();
      await promptDone;
      abort.abort();
      await bridge.shutdown();
    });
  });

  describe('extNotification — followup_suggestion', () => {
    it('publishes followup_suggestion when the child fires a prompt-suggestion notification', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification(
        'qwen/notify/session/prompt-suggestion',
        {
          v: 1,
          sessionId: session.sessionId,
          suggestion: 'Run the tests?',
          promptId: `${session.sessionId}########3`,
        },
      );

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('followup_suggestion');
      expect(collected[0]?.data).toMatchObject({
        sessionId: session.sessionId,
        suggestion: 'Run the tests?',
        promptId: `${session.sessionId}########3`,
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('drops malformed prompt-suggestion payloads', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        capturedConn = new AgentSideConnection(
          () => new FakeAgent(),
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const seen: string[] = [];
      const collecting = (async () => {
        for await (const e of iter) seen.push(e.type);
      })();

      void capturedConn!.extNotification(
        'qwen/notify/session/prompt-suggestion',
        { v: 1, sessionId: session.sessionId, suggestion: '' },
      );
      void capturedConn!.extNotification(
        'qwen/notify/session/prompt-suggestion',
        { v: 1, sessionId: session.sessionId, promptId: 'p1' },
      );
      void capturedConn!.extNotification(
        'qwen/notify/session/prompt-suggestion',
        { v: 1 },
      );
      void capturedConn!.extNotification(
        'qwen/notify/session/prompt-suggestion',
        {
          v: 1,
          sessionId: session.sessionId,
          suggestion: 123 as unknown as string,
          promptId: 'p1',
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      abort.abort();
      await collecting;
      expect(seen.filter((t) => t === 'followup_suggestion')).toEqual([]);
      await bridge.shutdown();
    });

    it('drops prompt-suggestion after session is closed', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        capturedConn = new AgentSideConnection(
          () => new FakeAgent(),
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.closeSession(session.sessionId);

      void capturedConn!.extNotification(
        'qwen/notify/session/prompt-suggestion',
        {
          v: 1,
          sessionId: session.sessionId,
          suggestion: 'stale',
          promptId: 'p1',
        },
      );
      // No throw — silently dropped.
      await bridge.shutdown();
    });
  });

  describe('extNotification — session title update', () => {
    const titleFactory =
      (capture: (conn: AgentSideConnection) => void): ChannelFactory =>
      async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        capture(new AgentSideConnection(() => new FakeAgent(), agentStream));
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };

    it('rebroadcasts a child title-update as session_metadata_updated', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const bridge = makeBridge({
        channelFactory: titleFactory((c) => (capturedConn = c)),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification('qwen/notify/session/title-update', {
        v: 1,
        sessionId: session.sessionId,
        title: 'Fix login button on mobile',
        titleSource: 'auto',
      });

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('session_metadata_updated');
      expect(collected[0]?.data).toMatchObject({
        sessionId: session.sessionId,
        displayName: 'Fix login button on mobile',
        titleSource: 'auto',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('drops malformed title-update payloads', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const bridge = makeBridge({
        channelFactory: titleFactory((c) => (capturedConn = c)),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const seen: string[] = [];
      const collecting = (async () => {
        for await (const e of iter) seen.push(e.type);
      })();

      // Missing title / empty title / non-string title / missing sessionId.
      void capturedConn!.extNotification('qwen/notify/session/title-update', {
        v: 1,
        sessionId: session.sessionId,
      });
      void capturedConn!.extNotification('qwen/notify/session/title-update', {
        v: 1,
        sessionId: session.sessionId,
        title: '',
      });
      void capturedConn!.extNotification('qwen/notify/session/title-update', {
        v: 1,
        sessionId: session.sessionId,
        title: 123 as unknown as string,
      });
      void capturedConn!.extNotification('qwen/notify/session/title-update', {
        v: 1,
        title: 'orphan',
      });
      await new Promise((r) => setTimeout(r, 10));
      abort.abort();
      await collecting;
      expect(seen.filter((t) => t === 'session_metadata_updated')).toEqual([]);
      await bridge.shutdown();
    });
  });

  describe('maxSessions cap (chiga0 Rec 3)', () => {
    it('refuses NEW spawns past the cap with SessionLimitExceededError', async () => {
      let n = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({ sessionIdPrefix: `s${n++}` }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 2,
        // `thread` so each call is a fresh session, not an attach.
        sessionScope: 'thread',
      });

      // First two spawns succeed.
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(2);

      // Third hits the cap.
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toMatchObject({
        name: 'SessionLimitExceededError',
        limit: 2,
      });
      // Cap rejection must NOT register a new session.
      expect(bridge.sessionCount).toBe(2);

      await bridge.shutdown();
    });

    it('per-request thread overrides cannot bypass the cap (#4175 PR 5 amplification guard)', async () => {
      // The cap exists to bound child-process / RSS / MCP amplification
      // — the new `'thread'` per-request override is exactly the kind of
      // request a single-scope daemon could be hammered with by a
      // multi-window client. A future refactor that gated the cap on
      // `defaultSessionScope` (instead of `effectiveScope`) would
      // silently let `'thread'` overrides bypass the limit. Pin the
      // contract here.
      let n = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({ sessionIdPrefix: `s${n++}` }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 2,
        sessionScope: 'single', // production default
      });

      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(bridge.sessionCount).toBe(2);

      await expect(
        bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          sessionScope: 'thread',
        }),
      ).rejects.toMatchObject({
        name: 'SessionLimitExceededError',
        limit: 2,
      });
      expect(bridge.sessionCount).toBe(2);

      await bridge.shutdown();
    });

    it('attach to an existing session under single scope is NOT counted toward the cap', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 1,
        sessionScope: 'single',
      });

      // First call spawns.
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);

      // Second call to the SAME workspace attaches — cap doesn't apply.
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      expect(b.sessionId).toBe(a.sessionId);
      expect(bridge.sessionCount).toBe(1);

      // A cross-workspace request rejects with WorkspaceMismatchError
      // (#3803 §02) — the bridge is bound to one workspace.
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_B }),
      ).rejects.toBeInstanceOf(WorkspaceMismatchError);

      await bridge.shutdown();
    });

    it('killSession({requireZeroAttaches:true}) skips reap when another client attached (BQ9tV)', async () => {
      // Race: client A spawned (attached:false), then disconnected.
      // Before A's disconnect-reaper runs, client B POSTs /session
      // for the same workspace and gets attached:true. Without the
      // race guard, A's reaper would tear down B's session.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      // Simulate client B's attach in the race window.
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      // Client A's disconnect-reaper fires now.
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      // Session must SURVIVE — client B is still using it.
      const c = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(c.attached).toBe(true);
      expect(c.sessionId).toBe(a.sessionId);
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
    });

    it('in-flight coalescing race: B attaches via inFlight before A reaps (BRSCi)', async () => {
      // The harder coalescing path: A and B BOTH await the same
      // doSpawn. When the spawn resolves, B's continuation must bump
      // attachCount BEFORE A's route-handler-equivalent calls
      // killSession. Slow-spawn factory → kick off both calls in
      // parallel → confirm B's session survives A's reap.
      let resolveSpawn: (() => void) | undefined;
      const slowFactory: ChannelFactory = async () => {
        await new Promise<void>((r) => {
          resolveSpawn = r;
        });
        return makeChannel().channel;
      };
      const bridge = makeBridge({
        channelFactory: slowFactory,
        sessionScope: 'single',
      });
      const aPromise = bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Wait a tick so A's spawnOrAttach reaches `await doSpawn`.
      await new Promise((r) => setTimeout(r, 5));
      // Now B comes in and finds A's promise in inFlightSpawns.
      const bPromise = bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await new Promise((r) => setTimeout(r, 5));
      // Release the spawn — both A and B's awaits now resolve.
      resolveSpawn!();
      const [a, b] = await Promise.all([aPromise, bPromise]);
      expect(a.attached).toBe(false);
      expect(b.attached).toBe(true);
      expect(b.sessionId).toBe(a.sessionId);
      // Client A's disconnect-reaper fires AFTER B has bumped
      // attachCount (which the in-flight branch now does pre-await).
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      // Session must survive — B was the late attacher.
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
    });

    it('detachClient does NOT reap when spawn owner is still alive (BkwQP)', async () => {
      // BkwQP refinement: the BX (tanzhenxin issue 2) detach-reap path
      // was eager and killed live sessions. Scenario: A spawns
      // (attached: false, hasn't opened SSE yet); B attaches
      // (attachCount: 1); B disconnects → detachClient. detachClient
      // must NOT kill A's still-valid session. Reap is only safe
      // when the spawn owner ALSO indicated they want it (via the
      // killSession-bail tombstone).
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      expect(bridge.sessionCount).toBe(1);
      // B disconnects — but A is alive. detachClient must NOT reap.
      await bridge.detachClient(b.sessionId);
      // Session survives — A would have 404'd on every subsequent
      // request otherwise.
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
    });

    it('detachClient completes deferred reap when spawn owner ALSO disconnected (BkwQP+tanzhenxin issue 2)', async () => {
      // Scenario: A spawns + disconnects (spawn-owner reap bails
      // because B already bumped attachCount); B attaches +
      // disconnects (detachClient decrements). With the tombstone
      // set during the spawn-owner bail, B's detach now completes
      // the deferred reap.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      expect(bridge.sessionCount).toBe(1);
      // A's disconnect-reaper fires: requireZeroAttaches:true bails
      // (attachCount===1 from B) but sets `spawnOwnerWantedKill`.
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      expect(bridge.sessionCount).toBe(1); // bailed, no reap
      // B disconnects: detachClient decrements attachCount→0 AND
      // sees the tombstone → completes the deferred reap.
      await bridge.detachClient(b.sessionId);
      expect(bridge.sessionCount).toBe(0);
      await bridge.shutdown();
    });

    it('detachClient does NOT reap when an SSE subscriber is live (tanzhenxin issue 2)', async () => {
      // Counterpart: when client C is actively subscribed, detach
      // from a transient B must NOT reap C's session.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      // C opens an SSE subscription (counts as "live consumer").
      const sub = bridge.subscribeEvents(a.sessionId);
      const sublooper = (async () => {
        for await (const _ev of sub) {
          /* drain */
        }
      })();
      // Yield so the iterator's start-up runs and the subscriber
      // registers on the EventBus.
      await new Promise((r) => setImmediate(r));
      // B disconnects → detach. Session must survive.
      await bridge.detachClient(b.sessionId);
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
      await sublooper.catch(() => {});
    });

    it('killSession({requireZeroAttaches:true}) DOES reap when no other client attached (BQ9tV)', async () => {
      // Counterpart to the above: when the spawn-owner truly was
      // alone, the reaper must still reap. This pins the guard's
      // negative path so a future change can't accidentally make
      // it always-skip.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);
      // No second attach. Reaper fires.
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      expect(bridge.sessionCount).toBe(0);
      await bridge.shutdown();
    });

    it('maxSessions: 0 disables the cap', async () => {
      // Distinct sessionIdPrefix per spawn so each call gets a unique
      // sessionId (otherwise they'd collide in `byId` and only the
      // last would remain — making `sessionCount` stay at 1).
      let n = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({ sessionIdPrefix: `s${n++}` }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 0,
        sessionScope: 'thread',
      });
      // 5 spawns is far past the would-be default of 20 isn't, but
      // it's enough to confirm the cap is disabled (with default of
      // 20 a thread-scope flood could go 5 deep without hitting it
      // anyway, so we use a smaller test value with 0/disabled
      // explicit so a regression that re-enabled some default cap
      // would still surface).
      for (let i = 0; i < 5; i++) {
        await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      }
      expect(bridge.sessionCount).toBe(5);
      await bridge.shutdown();
    });

    it('Stage 1.5 multi-session: N sessions on same workspace share ONE channel', async () => {
      // The headline of the Stage 1.5 refactor — multiple thread-scope
      // sessions on one workspace pay for one `qwen --acp` child, not
      // N children. LaZzyMan + tanzhenxin pushed for this; the agent
      // already supports it via `acpAgent.ts:194 sessions:
      // Map<string, Session>`.
      let factoryCalls = 0;
      const factory: ChannelFactory = async () => {
        factoryCalls++;
        return makeChannel({ sessionIdPrefix: `s${factoryCalls}` }).channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 0,
        sessionScope: 'thread',
      });
      // Spin up 5 sessions on the same workspace.
      const sessions = await Promise.all(
        Array.from({ length: 5 }, () =>
          bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ),
      );
      // 5 distinct sessions...
      expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(5);
      expect(bridge.sessionCount).toBe(5);
      // ...but only ONE channelFactory call (= one child process).
      expect(factoryCalls).toBe(1);
      await bridge.shutdown();
    });

    it('Stage 1.5: killSession on one of N sessions does NOT kill the shared channel', async () => {
      // Counterpart guarantee: tearing down one session must not take
      // its siblings with it. The channel stays alive while
      // `channelInfo.sessionIds.size > 0`.
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'thread',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const c = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(handles).toHaveLength(1);
      // Kill one — the other two stay.
      await bridge.killSession(b.sessionId);
      expect(bridge.sessionCount).toBe(2);
      expect(handles[0]?.killed).toBe(false);
      // Kill the second — last one alive.
      await bridge.killSession(a.sessionId);
      expect(bridge.sessionCount).toBe(1);
      expect(handles[0]?.killed).toBe(false);
      // Kill the last — NOW the channel is killed.
      await bridge.killSession(c.sessionId);
      expect(bridge.sessionCount).toBe(0);
      expect(handles[0]?.killed).toBe(true);
      await bridge.shutdown();
    });

    it('Stage 1.5: channel.exited tears down ALL multiplexed sessions', async () => {
      // When the shared child dies (crash, kill, network gone), all
      // sessions on it die together — they're truly co-fated. Each
      // session's bus gets its own `session_died` event so each SSE
      // subscriber learns the bad news on their own stream.
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'thread',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const c = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(3);

      // Subscribe so we can observe each session_died.
      const eventsByA: BridgeEvent[] = [];
      const eventsByB: BridgeEvent[] = [];
      const eventsByC: BridgeEvent[] = [];
      const drainA = (async () => {
        for await (const ev of bridge.subscribeEvents(a.sessionId))
          eventsByA.push(ev);
      })();
      const drainB = (async () => {
        for await (const ev of bridge.subscribeEvents(b.sessionId))
          eventsByB.push(ev);
      })();
      const drainC = (async () => {
        for await (const ev of bridge.subscribeEvents(c.sessionId))
          eventsByC.push(ev);
      })();
      // Let the subscriptions register before crashing.
      await new Promise((r) => setImmediate(r));

      // Simulate channel-level crash (child exited).
      handles[0]?.crash();
      await Promise.all([drainA, drainB, drainC]);

      expect(eventsByA[eventsByA.length - 1]?.type).toBe('session_died');
      expect(eventsByB[eventsByB.length - 1]?.type).toBe('session_died');
      expect(eventsByC[eventsByC.length - 1]?.type).toBe('session_died');
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    });
  });

  describe('closeSession', () => {
    it('publishes session_closed and removes session from maps', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(1);

      const events: BridgeEvent[] = [];
      const drain = (async () => {
        for await (const ev of bridge.subscribeEvents(session.sessionId))
          events.push(ev);
      })();
      await new Promise((r) => setImmediate(r));

      await bridge.closeSession(session.sessionId);
      await drain;

      expect(bridge.sessionCount).toBe(0);
      const closedEvent = events.find((e) => e.type === 'session_closed');
      expect(closedEvent).toBeDefined();
      expect((closedEvent?.data as { reason: string }).reason).toBe(
        'client_close',
      );

      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session', async () => {
      const bridge = makeBridge();
      await expect(bridge.closeSession('nonexistent')).rejects.toThrow(
        SessionNotFoundError,
      );
      await bridge.shutdown();
    });

    it('resolves pending permissions as cancelled', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | {
                exitCode: number | null;
                signalCode: NodeJS.Signals | null;
              }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const conn = capturedConn!;

      const events: BridgeEvent[] = [];
      const drain = (async () => {
        for await (const ev of bridge.subscribeEvents(session.sessionId))
          events.push(ev);
      })();
      await new Promise((r) => setImmediate(r));

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });

      await new Promise((r) => setImmediate(r));
      expect(bridge.pendingPermissionCount).toBe(1);

      await bridge.closeSession(session.sessionId);
      await drain;

      const result = (await respPromise) as {
        outcome: { outcome: string };
      };
      expect(result.outcome.outcome).toBe('cancelled');
      expect(bridge.pendingPermissionCount).toBe(0);
      const resolvedIndex = events.findIndex(
        (e) => e.type === 'permission_resolved',
      );
      const closedIndex = events.findIndex((e) => e.type === 'session_closed');
      expect(resolvedIndex).toBeGreaterThanOrEqual(0);
      expect(closedIndex).toBeGreaterThan(resolvedIndex);
      expect(events[resolvedIndex]?.data).toMatchObject({
        outcome: { outcome: 'cancelled' },
      });

      await bridge.shutdown();
    });

    it('routes per-entry channel bookkeeping via channelInfoForEntry, not the module-scoped channelInfo (#4325)', async () => {
      // Regression guard for #4325 (wenshao review on F1 #4319).
      //
      // The bug pre-fix: `closeSession` (and `killSession`) captured
      // `const ci = channelInfo` — the module-scoped CURRENT attach
      // target — rather than `channelInfoForEntry(entry)`. The two
      // diverge during the channel-overlap window (A dying, B freshly
      // spawned as `channelInfo`): closing a session whose `entry.channel
      // = A` would (1) skip `A.sessionIds.delete()` because
      // `B.channel !== A.channel`, leaving A's sessionIds set pinned past
      // the close, and (2) call `markSessionClosed` on B's client
      // instead of A's, evaluating B's kill condition with stale
      // assumptions about its session count — potentially killing B
      // unnecessarily and forcing a third spawn.
      //
      // Constructing the exact overlap state deterministically requires
      // factory-internal hooks not currently exposed (A only becomes
      // `isDying` when its sessionIds drains to 0, and that drain path
      // also removes the session from `byId` synchronously — so by the
      // time channelInfo could move to B, every session that was on A is
      // gone from `byId` and thus unreachable to `closeSession`). The
      // full overlap regression test is deferred to a follow-up that
      // adds the necessary test-only factory inspection seam.
      //
      // What this smoke test guards: under the normal single-channel
      // case, `closeSession` still drives the channel's lifecycle
      // correctly — channel kill fires after the last session closes,
      // which is the most-load-bearing behavior in the fix's neighborhood
      // and would fail trivially if a future refactor reverted to the
      // module-scoped `channelInfo` capture without thinking through
      // the case where the helper returns `undefined`.
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(handles).toHaveLength(1);
      expect(handles[0]?.killed).toBe(false);

      await bridge.closeSession(session.sessionId);

      // Channel kill must have fired — proves `closeSession` correctly
      // located the entry's channel via `channelInfoForEntry(entry)`
      // (which returns the channel matching `entry.channel`) and
      // triggered the L2163-2165 "kill on last session" branch. A
      // reverted fix that captured `channelInfo` after the entry was
      // gone from `byId` would also pass this assertion, but the
      // diff-review-time visibility of the `channelInfoForEntry` call
      // is the primary defense.
      expect(handles[0]?.killed).toBe(true);
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    });

    it('killSession routes per-entry channel bookkeeping via channelInfoForEntry (#4325 symmetric)', async () => {
      // Symmetric smoke guard for #4325 (wenshao review on this PR).
      // `killSession` received the same `channelInfo` →
      // `channelInfoForEntry(entry)` fix at `bridge.ts:3182` as
      // `closeSession` did. The closeSession smoke above doesn't
      // exercise the killSession code path, so a future refactor
      // reverting only killSession would pass that test trivially.
      // Same single-channel caveat: the channel-overlap race itself
      // isn't deterministic without test-only factory hooks; this
      // smoke verifies the most-load-bearing behavior — kill fires
      // and tears down the channel — which would fail if a revert
      // captured a stale module-scoped `channelInfo`.
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(handles).toHaveLength(1);
      expect(handles[0]?.killed).toBe(false);

      await bridge.killSession(session.sessionId);

      expect(handles[0]?.killed).toBe(true);
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    });
  });

  describe('updateSessionMetadata', () => {
    it('publishes session_metadata_updated event', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const events: BridgeEvent[] = [];
      const sub = bridge.subscribeEvents(session.sessionId);
      const drain = (async () => {
        for await (const ev of sub) events.push(ev);
      })();
      await new Promise((r) => setImmediate(r));

      bridge.updateSessionMetadata(session.sessionId, {
        displayName: 'Test Session',
      });

      await new Promise((r) => setImmediate(r));
      const metaEvent = events.find(
        (e) => e.type === 'session_metadata_updated',
      );
      expect(metaEvent).toBeDefined();
      expect((metaEvent?.data as { displayName: string }).displayName).toBe(
        'Test Session',
      );

      await bridge.closeSession(session.sessionId);
      await drain;
      await bridge.shutdown();
    });

    it('rejects displayName values with control characters', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      expect(() =>
        bridge.updateSessionMetadata(session.sessionId, {
          displayName: 'bad\nname',
        }),
      ).toThrow(InvalidSessionMetadataError);

      await bridge.closeSession(session.sessionId);
      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session', () => {
      const bridge = makeBridge();
      expect(() =>
        bridge.updateSessionMetadata('nonexistent', {
          displayName: 'test',
        }),
      ).toThrow(SessionNotFoundError);
    });
  });

  describe('enriched listWorkspaceSessions', () => {
    it('includes createdAt and metadata fields', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const sessions = bridge.listWorkspaceSessions(WS_A);
      expect(sessions).toHaveLength(1);
      const s = sessions[0]!;
      expect(s.createdAt).toBeDefined();
      expect(typeof s.createdAt).toBe('string');
      expect(typeof s.clientCount).toBe('number');
      expect(typeof s.hasActivePrompt).toBe('boolean');
      expect(s.hasActivePrompt).toBe(false);

      await bridge.shutdown();
    });
  });

  describe('publishWorkspaceEvent + knownClientIds (issue #4175 PR 16)', () => {
    it('fans out a workspace event onto every active session bus', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      const aFrames: BridgeEvent[] = [];
      const bFrames: BridgeEvent[] = [];
      const collect = async (
        sessionId: string,
        target: BridgeEvent[],
        signal: AbortSignal,
      ) => {
        for await (const frame of bridge.subscribeEvents(sessionId, {
          signal,
        })) {
          target.push(frame);
        }
      };
      const ctrl = new AbortController();
      const tasks = Promise.all([
        collect(a.sessionId, aFrames, ctrl.signal),
        collect(b.sessionId, bFrames, ctrl.signal),
      ]);
      // Yield once so the subscribe handlers register.
      await new Promise((resolve) => setImmediate(resolve));

      bridge.publishWorkspaceEvent({
        type: 'memory_changed',
        data: {
          scope: 'workspace',
          filePath: '/work/QWEN.md',
          mode: 'append',
          bytesWritten: 5,
        },
      });

      // Yield so the bus's async push reaches both subscribers.
      await new Promise((resolve) => setImmediate(resolve));

      expect(aFrames.some((f) => f.type === 'memory_changed')).toBe(true);
      expect(bFrames.some((f) => f.type === 'memory_changed')).toBe(true);

      ctrl.abort();
      await tasks.catch(() => {});
      await bridge.shutdown();
    });

    it('returns an empty knownClientIds set when no clients are attached', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const ids = bridge.knownClientIds();
      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(0);
      await bridge.shutdown();
    });

    it('aggregates clientIds across sessions in knownClientIds()', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      const ids = bridge.knownClientIds();
      expect(ids.size).toBe(2);
      expect(ids.has(a.clientId!)).toBe(true);
      expect(ids.has(b.clientId!)).toBe(true);

      // Snapshot semantics: mutating the returned Set must not
      // affect future calls. The interface returns
      // `ReadonlySet<string>` so cast through `Set<string>` to attempt
      // a mutation; the live registry must stay intact.
      (ids as Set<string>).delete(a.clientId!);
      const fresh = bridge.knownClientIds();
      expect(fresh.size).toBe(2);

      await bridge.shutdown();
    });
  });
});

// ============================================================
// F3 Commit 8 — bridge-level integration for the multi-client
// permission mediator. Mediator unit tests cover strategy logic
// (35 tests in `permissionMediator.test.ts`); these exercise the
// HTTP-bridge surface specifically:
//   - `bridge.permissionPolicy` accessor wired through the mediator
//   - F3 BridgeOptions validation (positive-integer quorum)
// ============================================================
describe('createAcpSessionBridge — F3 multi-client permission coordination', () => {
  it('exposes the active permission policy through bridge.permissionPolicy (default first-responder)', () => {
    const bridge = makeBridge({});
    expect(bridge.permissionPolicy).toBe('first-responder');
  });

  it('reflects the configured policy when BridgeOptions.permissionPolicy is set', () => {
    const bridge = makeBridge({ permissionPolicy: 'consensus' });
    expect(bridge.permissionPolicy).toBe('consensus');
  });

  it('throws on non-positive-integer permissionConsensusQuorum', () => {
    expect(() =>
      makeBridge({
        permissionPolicy: 'consensus',
        permissionConsensusQuorum: 0,
      }),
    ).toThrow(/positive integer/);
    expect(() =>
      makeBridge({
        permissionPolicy: 'consensus',
        permissionConsensusQuorum: 1.5,
      }),
    ).toThrow(/positive integer/);
  });
});

// ============================================================
// BridgeOptions.onDiagnosticLine — verify the tee callback
// receives writeServeDebugLine output when QWEN_SERVE_DEBUG=1.
// ============================================================
describe('onDiagnosticLine', () => {
  const originalDebug = process.env['QWEN_SERVE_DEBUG'];
  afterEach(() => {
    if (originalDebug === undefined) delete process.env['QWEN_SERVE_DEBUG'];
    else process.env['QWEN_SERVE_DEBUG'] = originalDebug;
  });

  it('receives writeServeDebugLine output when QWEN_SERVE_DEBUG=1', async () => {
    process.env['QWEN_SERVE_DEBUG'] = '1';
    const captured: Array<{ line: string; level?: string }> = [];

    // Thread scope → two distinct sessions sharing one channel.
    let capturedConn: InstanceType<typeof AgentSideConnection> | undefined;
    const factory: ChannelFactory = async () => {
      const { clientStream, agentStream } = createInMemoryChannel();
      const fakeAgent = new FakeAgent();
      const conn = new AgentSideConnection(() => fakeAgent, agentStream);
      capturedConn = conn;
      return {
        stream: clientStream,
        exited: new Promise<
          | { exitCode: number | null; signalCode: NodeJS.Signals | null }
          | undefined
        >(() => {}),
        kill: async () => {},
        killSync: () => {},
      };
    };

    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
      onDiagnosticLine: (line, level) => captured.push({ line, level }),
    });

    const sessionA = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const sessionB = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    // Issue a permission request on session A via the agent side.
    const subAbort = new AbortController();
    const iter = bridge.subscribeEvents(sessionA.sessionId, {
      signal: subAbort.signal,
    });

    // Fire requestPermission from the agent side (same pattern as
    // setupForPermission in the permission_request tests above).
    void (
      capturedConn as unknown as {
        requestPermission(p: unknown): Promise<unknown>;
      }
    ).requestPermission({
      sessionId: sessionA.sessionId,
      toolCall: { toolCallId: 'tc-diag', title: 'test-tool' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });

    // Read the permission_request event to get the requestId.
    const it2 = iter[Symbol.asyncIterator]();
    const next = await it2.next();
    expect(next.done).toBe(false);
    const payload = next.value!.data as { requestId: string };

    // Vote using session B's sessionId → cross-session rejection path
    // which triggers teeServeDebugLine (bridge.ts line ~2253).
    const accepted = bridge.respondToSessionPermission(
      sessionB.sessionId,
      payload.requestId,
      { outcome: { outcome: 'cancelled' } },
    );
    expect(accepted).toBe(false);

    // Verify the onDiagnosticLine callback received the debug line.
    expect(captured.some((e) => e.line.includes('qwen serve debug: '))).toBe(
      true,
    );
    expect(
      captured.some((e) => e.line.includes('rejected permission vote')),
    ).toBe(true);
    expect(
      captured.every((e) => e.level === undefined || e.level === 'info'),
    ).toBe(true);

    subAbort.abort();
    await bridge.shutdown();
  });

  it('does not invoke callback when QWEN_SERVE_DEBUG is off', async () => {
    delete process.env['QWEN_SERVE_DEBUG'];
    const captured: Array<{ line: string; level?: string }> = [];

    let capturedConn: InstanceType<typeof AgentSideConnection> | undefined;
    const factory: ChannelFactory = async () => {
      const { clientStream, agentStream } = createInMemoryChannel();
      const fakeAgent = new FakeAgent();
      const conn = new AgentSideConnection(() => fakeAgent, agentStream);
      capturedConn = conn;
      return {
        stream: clientStream,
        exited: new Promise<
          | { exitCode: number | null; signalCode: NodeJS.Signals | null }
          | undefined
        >(() => {}),
        kill: async () => {},
        killSync: () => {},
      };
    };

    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
      onDiagnosticLine: (line, level) => captured.push({ line, level }),
    });

    const sessionA = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const sessionB = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    const subAbort = new AbortController();
    const iter = bridge.subscribeEvents(sessionA.sessionId, {
      signal: subAbort.signal,
    });

    void (
      capturedConn as unknown as {
        requestPermission(p: unknown): Promise<unknown>;
      }
    ).requestPermission({
      sessionId: sessionA.sessionId,
      toolCall: { toolCallId: 'tc-diag2', title: 'test-tool' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });

    const it2 = iter[Symbol.asyncIterator]();
    const next = await it2.next();
    const payload = next.value!.data as { requestId: string };

    // Same cross-session vote — but QWEN_SERVE_DEBUG is off.
    bridge.respondToSessionPermission(sessionB.sessionId, payload.requestId, {
      outcome: { outcome: 'cancelled' },
    });

    // Callback must NOT have been invoked.
    expect(captured).toHaveLength(0);

    subAbort.abort();
    await bridge.shutdown();
  });
});

describe('extractErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('extracts details from JSON-RPC error object', () => {
    expect(
      extractErrorMessage({
        code: -32603,
        message: 'Internal error',
        data: { details: 'session not found' },
      }),
    ).toBe('session not found');
  });

  it('extracts provider messages from JSON-RPC error data', () => {
    expect(
      extractErrorMessage({
        code: -32603,
        message: 'Internal error',
        data: {
          code: 'ServiceUnavailable',
          message: '<503> model serving is throttled',
        },
      }),
    ).toBe('<503> model serving is throttled');
  });

  it('extracts details from Error subclasses with JSON-RPC data', () => {
    expect(
      extractErrorMessage(
        new RequestError(-32603, 'Internal error', {
          details: 'session not found',
        }),
      ),
    ).toBe('session not found');
  });

  it('extracts string data from Error subclasses with JSON-RPC data', () => {
    expect(
      extractErrorMessage(
        new RequestError(-32603, 'Internal error', 'session not found'),
      ),
    ).toBe('session not found');
  });

  it('extracts string data from JSON-RPC error object', () => {
    expect(
      extractErrorMessage({
        code: -32603,
        message: 'Internal error',
        data: 'session not found',
      }),
    ).toBe('session not found');
  });

  it('falls back to message when data.details is missing', () => {
    expect(
      extractErrorMessage({ code: -32600, message: 'Invalid Request' }),
    ).toBe('Invalid Request');
  });

  it('falls back to message when data.details is empty string', () => {
    expect(
      extractErrorMessage({
        code: -32603,
        message: 'Internal error',
        data: { details: '' },
      }),
    ).toBe('Internal error');
  });

  it('converts string to itself', () => {
    expect(extractErrorMessage('plain string')).toBe('plain string');
  });

  it('converts null via String()', () => {
    expect(extractErrorMessage(null)).toBe('null');
  });

  it('converts undefined via String()', () => {
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });

  it('extracts message from plain object with message property', () => {
    expect(extractErrorMessage({ message: 'custom error' })).toBe(
      'custom error',
    );
  });

  it('converts object without message via String()', () => {
    expect(extractErrorMessage({ foo: 'bar' })).toBe('[object Object]');
  });
});

describe('extractErrorCode', () => {
  it('returns string code as-is', () => {
    expect(extractErrorCode({ code: 'NETWORK_ERROR' })).toBe('NETWORK_ERROR');
  });

  it('converts numeric code to string', () => {
    expect(extractErrorCode({ code: -32603 })).toBe('-32603');
  });

  it('returns undefined for non-object', () => {
    expect(extractErrorCode('not an object')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(extractErrorCode(null)).toBeUndefined();
  });

  it('returns undefined when code is missing', () => {
    expect(extractErrorCode({ message: 'no code' })).toBeUndefined();
  });

  it('returns undefined when code is not string or number', () => {
    expect(extractErrorCode({ code: true })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2.3 side-channel state layer: publish helpers + reconciliation + snapshot
// ---------------------------------------------------------------------------

describe('createHttpAcpBridge — side-channel state layer (#4511)', () => {
  describe('publish helpers cache + generation', () => {
    it('publishModelSwitched updates cache and publishes model_switched', async () => {
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async () => ({});
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      await bridge.setSessionModel(
        session.sessionId,
        { sessionId: session.sessionId, modelId: 'qwen-max' },
        undefined,
      );

      const it2 = iter[Symbol.asyncIterator]();
      const next = await it2.next();
      expect(next.value?.type).toBe('model_switched');
      expect((next.value?.data as { modelId: string }).modelId).toBe(
        'qwen-max',
      );
      abort.abort();
      await bridge.shutdown();
    });

    it('publishApprovalModeChanged publishes approval_mode_changed on setSessionApprovalMode', async () => {
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/control/session/approval_mode') {
              return Promise.resolve({
                previous: 'default',
                current: (params as { mode: string }).mode,
              });
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      await bridge.setSessionApprovalMode(
        session.sessionId,
        ApprovalMode.YOLO,
        { persist: false },
      );

      const it2 = iter[Symbol.asyncIterator]();
      const next = await it2.next();
      expect(next.value?.type).toBe('approval_mode_changed');
      expect((next.value?.data as { next: string }).next).toBe(
        ApprovalMode.YOLO,
      );
      abort.abort();
      await bridge.shutdown();
    });
  });

  describe('extNotification — in-session mode update (A2)', () => {
    it('promotes current_mode_update to approval_mode_changed when no bridge roundtrip is in flight', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModeId: 'auto-edit',
      });

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('approval_mode_changed');
      expect((collected[0]?.data as { next: string }).next).toBe('auto-edit');
      abort.abort();
      await bridge.shutdown();
    });

    it('suppresses current_mode_update while a bridge approval-mode roundtrip is in flight', async () => {
      let releaseMode: (() => void) | undefined;
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method) => {
            if (method.includes('approval_mode')) {
              return new Promise<Record<string, unknown>>((res) => {
                releaseMode = () =>
                  res({ previous: 'default', current: 'yolo' });
              });
            }
            return {};
          },
        });
        capturedConn = new AgentSideConnection(
          () => fakeAgent as Agent,
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      const modeChange = bridge
        .setSessionApprovalMode(session.sessionId, ApprovalMode.YOLO, {
          persist: false,
        })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 10));

      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModeId: 'auto',
      });
      await new Promise((r) => setTimeout(r, 10));

      releaseMode!();
      await modeChange;

      const seen: string[] = [];
      for await (const e of iter) {
        seen.push(e.type);
        if (e.type === 'approval_mode_changed') break;
      }
      // Only the bridge's own approval_mode_changed (yolo) — the suppressed
      // 'auto' notification did NOT produce a second event.
      expect(seen.filter((t) => t === 'approval_mode_changed')).toHaveLength(1);
      abort.abort();
      await bridge.shutdown();
    });

    it('drops malformed mode-update params without throwing', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Missing currentModeId
      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
      });
      // Non-string currentModeId
      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModeId: 42,
      });
      await new Promise((r) => setTimeout(r, 50));

      // No events should have been produced (no approval_mode_changed).
      // Send a known good one to break the iterator.
      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-max',
      });

      const seen: string[] = [];
      for await (const e of iter) {
        seen.push(e.type);
        if (e.type === 'model_switched') break;
      }
      expect(seen.filter((t) => t === 'approval_mode_changed')).toEqual([]);
      abort.abort();
      await bridge.shutdown();
    });

    it('drops a current_mode_update with an unknown mode id (enum guard)', async () => {
      // The agent can reach this receive path without `Session.setMode`'s
      // enum validation, so a bogus mode id must be dropped here before it
      // fans out to SSE clients / the SDK reducer's state.approvalMode.
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Well-formed string, but not a known approval mode.
      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModeId: 'totally-bogus',
      });
      await new Promise((r) => setTimeout(r, 50));

      // A known good model-update breaks the iterator; the bogus mode must
      // not have produced an approval_mode_changed (or a legacy dual-emit).
      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-max',
      });

      const seen: string[] = [];
      for await (const e of iter) {
        seen.push(e.type);
        if (e.type === 'model_switched') break;
      }
      expect(seen.filter((t) => t === 'approval_mode_changed')).toEqual([]);
      expect(seen.filter((t) => t === 'session_update')).toEqual([]);
      abort.abort();
      await bridge.shutdown();
    });

    it('dual-emits a legacy session_update on the setMode path (no legacyFrameSent)', async () => {
      // The ACP `session/set_mode` path has no `sendUpdate`, so the demux
      // owns the IDE-companion compat frame: one approval_mode_changed plus
      // one legacy session_update{current_mode_update}.
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModeId: 'auto-edit',
      });

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (e.type === 'session_update') break;
      }
      expect(collected.map((c) => c.type)).toEqual([
        'approval_mode_changed',
        'session_update',
      ]);
      // Canonical ACP-nested shape so the companion's standard
      // data.update.sessionUpdate switch recognises it.
      const update = (
        collected[1]?.data as {
          update?: { sessionUpdate?: string; currentModeId?: string };
        }
      ).update;
      expect(update?.sessionUpdate).toBe('current_mode_update');
      expect(update?.currentModeId).toBe('auto-edit');
      abort.abort();
      await bridge.shutdown();
    });

    it('suppresses the legacy dual-emit when legacyFrameSent is true (exit_plan_mode path)', async () => {
      // `Session.sendCurrentModeUpdateNotification` already published the
      // legacy session_update via `sendUpdate` before this extNotification,
      // so the demux must promote to approval_mode_changed only — emitting
      // its own dual-emit would deliver the legacy frame to the companion
      // twice for one mode change.
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModeId: 'auto-edit',
        legacyFrameSent: true,
      });
      await new Promise((r) => setTimeout(r, 50));

      // A known good model-update breaks the iterator; assert exactly one
      // approval_mode_changed and NO legacy session_update from this path.
      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-max',
      });

      const seen: string[] = [];
      for await (const e of iter) {
        seen.push(e.type);
        if (e.type === 'model_switched') break;
      }
      expect(seen.filter((t) => t === 'approval_mode_changed')).toHaveLength(1);
      expect(seen.filter((t) => t === 'session_update')).toEqual([]);
      abort.abort();
      await bridge.shutdown();
    });
  });

  describe('A5 — session snapshot on attach', () => {
    it('yields session_snapshot after replay_complete when snapshot=true', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Promote a model change to populate the cache.
      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-turbo',
      });
      await new Promise((r) => setTimeout(r, 20));

      // Subscribe with snapshot=true (triggers replay_complete + snapshot).
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
        snapshot: true,
      });

      const collected: BridgeEvent[] = [];
      for await (const e of iter) {
        collected.push(e);
        if (e.type === 'session_snapshot') break;
      }
      const rc = collected.find((e) => e.type === 'replay_complete');
      const snap = collected.find((e) => e.type === 'session_snapshot');
      expect(rc).toBeDefined();
      expect(snap).toBeDefined();
      expect(collected.indexOf(snap!)).toBeGreaterThan(collected.indexOf(rc!));
      expect(
        (snap!.data as { currentModelId: string | null }).currentModelId,
      ).toBe('qwen-turbo');
      abort.abort();
      await bridge.shutdown();
    });

    it('carries currentApprovalMode in the snapshot when an approval-mode change was promoted', async () => {
      // The other A5 tests only seed currentModelId, so the
      // publishApprovalModeChanged → entry.currentApprovalMode → snapshot
      // pipeline is otherwise untested at the bridge level: a typo writing
      // the wrong field would leave currentApprovalMode null and slip past.
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Promote an in-session mode change to populate currentApprovalMode
      // (flows through onModePromoted → publishApprovalModeChanged).
      void capturedConn!.extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModeId: 'auto-edit',
      });
      await new Promise((r) => setTimeout(r, 20));

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
        snapshot: true,
      });

      const collected: BridgeEvent[] = [];
      for await (const e of iter) {
        collected.push(e);
        if (e.type === 'session_snapshot') break;
      }
      const snap = collected.find((e) => e.type === 'session_snapshot');
      expect(snap).toBeDefined();
      expect(
        (snap!.data as { currentApprovalMode: string | null })
          .currentApprovalMode,
      ).toBe('auto-edit');
      abort.abort();
      await bridge.shutdown();
    });

    it('does NOT yield session_snapshot when snapshot is not set', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Promote a model change so there IS cache state.
      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-turbo',
      });
      await new Promise((r) => setTimeout(r, 20));

      // Subscribe WITHOUT snapshot.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });

      // After replay_complete, send a known event to break the loop.
      const collected: BridgeEvent[] = [];
      // Publish something after a short delay so the iterator eventually yields.
      setTimeout(() => {
        void capturedConn!.extNotification('qwen/notify/session/model-update', {
          v: 1,
          sessionId: session.sessionId,
          currentModelId: 'qwen-max',
        });
      }, 30);

      for await (const e of iter) {
        collected.push(e);
        // Stop after we see replay_complete + one more real event.
        if (
          collected.some((c) => c.type === 'replay_complete') &&
          collected.some((c) => c.type === 'model_switched')
        )
          break;
      }
      expect(
        collected.find((e) => e.type === 'session_snapshot'),
      ).toBeUndefined();
      abort.abort();
      await bridge.shutdown();
    });

    it('yields session_snapshot up front on a fresh connection (no Last-Event-ID)', async () => {
      // Regression for the A5 primary use case: a fresh attach has no
      // `Last-Event-ID`, so the bus never emits `replay_complete` (the whole
      // replay block is gated on `lastEventId !== undefined`). Keying the
      // snapshot solely off `replay_complete` made it silently no-op exactly
      // when a client most needs to seed state — on initial attach.
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      void capturedConn!.extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: session.sessionId,
        currentModelId: 'qwen-turbo',
      });
      await new Promise((r) => setTimeout(r, 20));

      // Fresh subscribe — snapshot=true, NO lastEventId.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
        snapshot: true,
      });

      const it2 = iter[Symbol.asyncIterator]();
      const first = await it2.next();
      // The very first frame must be the snapshot (no replay precedes it).
      expect(first.value?.type).toBe('session_snapshot');
      expect(
        (first.value?.data as { currentModelId: string | null }).currentModelId,
      ).toBe('qwen-turbo');
      abort.abort();
      await bridge.shutdown();
    });

    it('seeds snapshot from newSession response without any intermediate notification (cold attach)', async () => {
      // F7qEJ: seedSnapshotCaches fills the cache from the newSession
      // response alone — no extNotification or setSessionModel needed.
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          newSessionImpl: (p) =>
            Promise.resolve({
              sessionId: `sess:${p.cwd}`,
              models: {
                currentModelId: 'qwen-plus',
                availableModels: [{ modelId: 'qwen-plus', name: 'Qwen Plus' }],
              },
              modes: {
                currentModeId: 'auto-edit',
                availableModes: [
                  { modeId: 'auto-edit', id: 'auto-edit', name: 'Auto Edit' },
                ],
              },
            }),
        });
        new AgentSideConnection(() => fakeAgent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Subscribe with snapshot=true, no lastEventId — pure cold attach.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
        snapshot: true,
      });
      const it2 = iter[Symbol.asyncIterator]();
      const first = await it2.next();
      expect(first.value?.type).toBe('session_snapshot');
      const data = first.value?.data as {
        currentModelId: string | null;
        currentApprovalMode: string | null;
      };
      expect(data.currentModelId).toBe('qwen-plus');
      expect(data.currentApprovalMode).toBe('auto-edit');
      abort.abort();
      await bridge.shutdown();
    });
  });

  describe('§2.2 — post-roundtrip reconciliation', () => {
    const makeReconcileFactory =
      (
        sessionContextModelId: string | undefined,
        opts: { throwOnStatus?: boolean } = {},
      ): ChannelFactory =>
      async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/session/context') {
              if (opts.throwOnStatus) {
                throw new Error('status read failed');
              }
              return Promise.resolve({
                state: { models: { currentModelId: sessionContextModelId } },
              });
            }
            return Promise.resolve({});
          },
        });
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async () => ({});
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };

    it('publishes a corrective model_switched when the agent state drifted from cache', async () => {
      // Switch to qwen-max, but the agent's real state is qwen-turbo (e.g.
      // an agent-side override). Reconciliation must emit a corrective
      // model_switched so peers converge on the agent's truth.
      const bridge = makeBridge({
        channelFactory: makeReconcileFactory('qwen-turbo'),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      await bridge.setSessionModel(
        session.sessionId,
        { sessionId: session.sessionId, modelId: 'qwen-max' },
        undefined,
      );

      const seen: Array<{ type: string; modelId?: string }> = [];
      for await (const e of iter) {
        seen.push({
          type: e.type,
          modelId: (e.data as { modelId?: string })?.modelId,
        });
        if (seen.filter((s) => s.type === 'model_switched').length === 2) break;
      }
      const switches = seen.filter((s) => s.type === 'model_switched');
      // First the requested change, then the corrective one from reconcile.
      expect(switches[0]?.modelId).toBe('qwen-max');
      expect(switches[1]?.modelId).toBe('qwen-turbo');
      abort.abort();
      await bridge.shutdown();
    });

    it('does NOT publish a corrective event when agent state matches cache', async () => {
      // Stateful agent: `sessionContext` echoes the last model the bridge
      // set, so reconciliation always finds cache == agent truth and never
      // emits a corrective. Two distinct changes must therefore produce
      // exactly two model_switched events, with no duplicates in between.
      let lastModel: string | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/session/context') {
              return Promise.resolve({
                state: { models: { currentModelId: lastModel } },
              });
            }
            return Promise.resolve({});
          },
        });
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (p: { modelId: string }) => {
                lastModel = p.modelId;
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      await bridge.setSessionModel(
        session.sessionId,
        { sessionId: session.sessionId, modelId: 'qwen-max' },
        undefined,
      );
      // Second distinct change terminates the iterator; a spurious
      // corrective would surface as a duplicate model_switched.
      await bridge.setSessionModel(
        session.sessionId,
        { sessionId: session.sessionId, modelId: 'qwen-plus' },
        undefined,
      );

      const switches: string[] = [];
      for await (const e of iter) {
        if (e.type === 'model_switched') {
          switches.push((e.data as { modelId: string }).modelId);
          if (switches.includes('qwen-plus')) break;
        }
      }
      expect(switches).toEqual(['qwen-max', 'qwen-plus']);
      abort.abort();
      await bridge.shutdown();
    });

    it('swallows a failed status read without crashing or masking the original change', async () => {
      const bridge = makeBridge({
        channelFactory: makeReconcileFactory(undefined, {
          throwOnStatus: true,
        }),
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      await expect(
        bridge.setSessionModel(
          session.sessionId,
          { sessionId: session.sessionId, modelId: 'qwen-max' },
          undefined,
        ),
      ).resolves.toBeDefined();

      const it2 = iter[Symbol.asyncIterator]();
      const next = await it2.next();
      // The original model_switched is delivered; reconcile failure stays in
      // the operator log (no bus event the SDK cannot decode).
      expect(next.value?.type).toBe('model_switched');
      expect((next.value?.data as { modelId: string }).modelId).toBe(
        'qwen-max',
      );
      abort.abort();
      await bridge.shutdown();
    });

    it('does NOT reconcile when the model roundtrip itself fails', async () => {
      // The agent's unstable_setSessionModel rejects, so publishModelSwitched
      // never runs and the cache is unchanged. Reconciliation must be skipped
      // (no status read), and the only bus event is model_switch_failed —
      // never a corrective model_switched paired with the failure.
      let statusReads = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/session/context') {
              statusReads += 1;
              return Promise.resolve({
                state: { models: { currentModelId: 'qwen-turbo' } },
              });
            }
            return Promise.resolve({});
          },
        });
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async () => {
                throw new Error('agent refused model switch');
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      await expect(
        bridge.setSessionModel(
          session.sessionId,
          { sessionId: session.sessionId, modelId: 'qwen-max' },
          undefined,
        ),
      ).rejects.toThrow();

      const it2 = iter[Symbol.asyncIterator]();
      const next = await it2.next();
      expect(next.value?.type).toBe('model_switch_failed');
      // Give any (incorrectly) scheduled reconcile a tick to fire.
      await new Promise((r) => setTimeout(r, 10));
      expect(statusReads).toBe(0);
      abort.abort();
      await bridge.shutdown();
    });

    it('re-runs reconcile when a newer change publishes during the status read (generation rerun)', async () => {
      // Anti-lost-reconcile: while reconcile for change A awaits its status
      // RPC, a second change B publishes (bumping the generation). B's own
      // reconcile bails on the in-flight guard, so without the `rerun` path
      // B would never be reconciled. Gate the FIRST status read until B has
      // published; assert the FIRST read is discarded (generation changed)
      // and a SECOND read fires after the guard releases, whose corrective
      // reflects the agent's truth read AFTER B — not a stale read for A.
      let statusReads = 0;
      let releaseFirstStatus: (() => void) | undefined;
      const firstStatusGate = new Promise<void>((res) => {
        releaseFirstStatus = res;
      });
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/session/context') {
              statusReads += 1;
              // Agent truth drifts from both A and B, so the post-rerun
              // read produces an observable corrective.
              const payload = {
                state: { models: { currentModelId: 'qwen-turbo' } },
              };
              return statusReads === 1
                ? firstStatusGate.then(() => payload)
                : Promise.resolve(payload);
            }
            return Promise.resolve({});
          },
        });
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async () => ({});
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // A: publishes gen=1; its reconcile starts and blocks on the gate.
      await bridge.setSessionModel(
        session.sessionId,
        { sessionId: session.sessionId, modelId: 'qwen-max' },
        undefined,
      );
      // B: publishes gen=2 while A's reconcile is still awaiting the gated
      // status read; B's own reconcile bails on the in-flight guard.
      await bridge.setSessionModel(
        session.sessionId,
        { sessionId: session.sessionId, modelId: 'qwen-plus' },
        undefined,
      );
      // Now let A's status read resolve — it must detect the generation
      // change, discard its (stale) read, and re-run.
      releaseFirstStatus!();

      const switches: string[] = [];
      for await (const e of iter) {
        if (e.type === 'model_switched') {
          switches.push((e.data as { modelId: string }).modelId);
          if (switches.includes('qwen-turbo')) break;
        }
      }
      // The two requested changes, then ONE corrective from the rerun.
      expect(switches).toEqual(['qwen-max', 'qwen-plus', 'qwen-turbo']);
      // Two reads total: the gated (discarded) one + the rerun.
      expect(statusReads).toBe(2);
      abort.abort();
      await bridge.shutdown();
    });

    it('publishes a corrective approval_mode_changed when the agent mode drifted from cache', async () => {
      // approvalMode analog of the model drift test. The bridge sets YOLO,
      // but the agent's real mode is `plan` (e.g. an agent-side exit_plan_mode
      // restore). Reconciliation reads `state.modes.currentModeId` — a
      // DIFFERENT status shape from the model branch — and must emit a
      // corrective approval_mode_changed with next:'plan' so peers converge
      // on the agent's truth.
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/control/session/approval_mode') {
              return Promise.resolve({
                previous: 'default',
                current: (params as { mode: string }).mode,
              });
            }
            if (method === 'qwen/status/session/context') {
              return Promise.resolve({
                state: { modes: { currentModeId: 'plan' } },
              });
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => fakeAgent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      await bridge.setSessionApprovalMode(
        session.sessionId,
        ApprovalMode.YOLO,
        { persist: false },
        undefined,
      );

      const nexts: string[] = [];
      for await (const e of iter) {
        if (e.type === 'approval_mode_changed') {
          nexts.push((e.data as { next: string }).next);
          if (nexts.length === 2) break;
        }
      }
      // First the requested change, then the corrective one from reconcile.
      expect(nexts[0]).toBe('yolo');
      expect(nexts[1]).toBe('plan');
      abort.abort();
      await bridge.shutdown();
    });

    it('does NOT reconcile when the approval-mode roundtrip itself fails', async () => {
      // approvalMode analog of the model roundtrip-fail test. The agent's
      // approval_mode ext rejects, so publishApprovalModeChanged never runs
      // and the cache is unchanged. Reconciliation must be skipped (no status
      // read) and no corrective approval_mode_changed must reach the bus.
      let statusReads = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method) => {
            if (method === 'qwen/control/session/approval_mode') {
              throw new Error('agent refused approval-mode switch');
            }
            if (method === 'qwen/status/session/context') {
              statusReads += 1;
              return Promise.resolve({
                state: { modes: { currentModeId: 'plan' } },
              });
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => fakeAgent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const nexts: string[] = [];
      const collecting = (async () => {
        for await (const e of iter) {
          if (e.type === 'approval_mode_changed') {
            nexts.push((e.data as { next: string }).next);
          }
        }
      })();

      await expect(
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.YOLO,
          { persist: false },
          undefined,
        ),
      ).rejects.toThrow();

      // Give any (incorrectly) scheduled reconcile a tick to fire.
      await new Promise((r) => setTimeout(r, 10));
      expect(statusReads).toBe(0);
      expect(nexts).toEqual([]);
      abort.abort();
      await collecting;
      await bridge.shutdown();
    });

    it('drops unknown agent-returned approval mode without publishing a corrective event', async () => {
      // F7qEL / F8E2h: when the agent returns a mode not in
      // KNOWN_APPROVAL_MODES, the approvalMode reconcile branch should
      // drop it (action=dropped reason=unknown_mode) instead of
      // broadcasting an invalid approval_mode_changed. We trigger the
      // approvalMode reconcile via setSessionApprovalMode (not via
      // modelServiceId, which only reconciles the model branch).
      let statusReads = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/control/session/approval_mode') {
              return Promise.resolve({
                previous: 'default',
                current: (params as { mode: string }).mode,
              });
            }
            if (method === 'qwen/status/session/context') {
              statusReads += 1;
              // Agent claims a mode that's NOT in KNOWN_APPROVAL_MODES.
              return Promise.resolve({
                state: { modes: { currentModeId: 'super-yolo' } },
              });
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => fakeAgent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      const modeEvents: string[] = [];
      const collecting = (async () => {
        for await (const e of iter) {
          if (e.type === 'approval_mode_changed') {
            modeEvents.push((e.data as { next: string }).next);
          }
        }
      })();

      // setSessionApprovalMode triggers reconcileAfterRoundtrip(entry,
      // 'approvalMode'). The status read returns 'super-yolo' which
      // isn't in KNOWN_APPROVAL_MODES — reconcile must DROP it.
      await bridge.setSessionApprovalMode(
        session.sessionId,
        ApprovalMode.YOLO,
        { persist: false },
        undefined,
      );

      // Wait for reconcile to fire (async microtask chain).
      await new Promise((r) => setTimeout(r, 50));
      // Positive assertion: reconcile DID execute (status was read).
      // Without this, a future refactor that disables reconcile would
      // make the modeEvents assertion pass vacuously.
      expect(statusReads).toBe(1);
      // Only the original mode change should appear — no corrective
      // for the unknown 'super-yolo' value from the agent.
      expect(modeEvents).toEqual(['yolo']);
      abort.abort();
      await collecting;
      await bridge.shutdown();
    });

    it('syncs peer session cache on persisted approval-mode change (snapshot reflects new mode)', async () => {
      // F7qEK: when session A persists a mode change, peer session B's
      // cache should be updated so a subsequent snapshot on B reports
      // the new workspace default — not the stale pre-change value.
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/control/session/approval_mode') {
              return Promise.resolve({
                previous: 'default',
                current: (params as { mode: string }).mode,
              });
            }
            if (method === 'qwen/status/session/context') {
              // Status RPC returns agent's authoritative mode. After the
              // persist, the agent is on 'yolo' — return it so reconcile
              // sees no drift and does not emit a corrective.
              return Promise.resolve({
                state: { modes: { currentModeId: 'yolo' } },
              });
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => fakeAgent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'thread',
        persistApprovalMode: async () => {},
      });
      // Two sessions in the same workspace (thread scope → each attach
      // creates a new session).
      const sessionA = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const sessionB = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

      // Persist a mode change on A.
      await bridge.setSessionApprovalMode(
        sessionA.sessionId,
        ApprovalMode.YOLO,
        { persist: true },
        undefined,
      );

      // Subscribe on B with snapshot — should reflect the persisted mode.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(sessionB.sessionId, {
        signal: abort.signal,
        snapshot: true,
      });
      const it2 = iter[Symbol.asyncIterator]();
      const first = await it2.next();
      expect(first.value?.type).toBe('session_snapshot');
      expect(
        (first.value?.data as { currentApprovalMode: string | null })
          .currentApprovalMode,
      ).toBe('yolo');
      abort.abort();
      await bridge.shutdown();
    });
  });
});

describe('channelIdleTimeoutMs', () => {
  it('kills the channel immediately when timeout is 0 (default)', async () => {
    const handle = makeChannel();
    const factory: ChannelFactory = async () => handle.channel;
    const bridge = makeBridge({ channelFactory: factory });
    const session = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    expect(bridge.sessionCount).toBe(1);
    await bridge.closeSession(session.sessionId);
    expect(bridge.sessionCount).toBe(0);
    expect(handle.killed).toBe(true);
    await bridge.shutdown();
  });

  it('reuses warm channel during idle window when timeout > 0', async () => {
    let factoryCalls = 0;
    const factory: ChannelFactory = async () => {
      factoryCalls++;
      return makeChannel().channel;
    };
    const bridge = makeBridge({
      channelFactory: factory,
      channelIdleTimeoutMs: 60_000,
    });
    const session = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    expect(factoryCalls).toBe(1);

    await bridge.closeSession(session.sessionId);

    const session2 = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    expect(factoryCalls).toBe(1);
    expect(bridge.sessionCount).toBe(1);

    await bridge.closeSession(session2.sessionId);
    await bridge.shutdown();
  });

  it('kills channel after idle timeout expires (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      let factoryCalls = 0;
      const factory: ChannelFactory = async () => {
        factoryCalls++;
        return handle.channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        channelIdleTimeoutMs: 5_000,
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(factoryCalls).toBe(1);

      await bridge.closeSession(session.sessionId);
      expect(handle.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(handle.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(handle.killed).toBe(true);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels idle timer when new session arrives', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      let factoryCalls = 0;
      const factory: ChannelFactory = async () => {
        factoryCalls++;
        return handle.channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        channelIdleTimeoutMs: 5_000,
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      await bridge.closeSession(session.sessionId);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(handle.killed).toBe(false);

      const session2 = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(factoryCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(handle.killed).toBe(false);

      await bridge.closeSession(session2.sessionId);
      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('preheat', () => {
  it('spawns channel that is reused by first session', async () => {
    let factoryCalls = 0;
    const factory: ChannelFactory = async () => {
      factoryCalls++;
      return makeChannel().channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    await bridge.preheat();
    expect(factoryCalls).toBe(1);

    const session = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    expect(session.sessionId).toBeDefined();
    expect(factoryCalls).toBe(1);
    expect(bridge.sessionCount).toBe(1);

    await bridge.closeSession(session.sessionId);
    await bridge.shutdown();
  });

  it('is a no-op after shutdown', async () => {
    let factoryCalls = 0;
    const factory: ChannelFactory = async () => {
      factoryCalls++;
      return makeChannel().channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    await bridge.shutdown();
    await bridge.preheat();
    expect(factoryCalls).toBe(0);
  });

  it('arms idle timer on preheated channel when channelIdleTimeoutMs > 0', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      let factoryCalls = 0;
      const factory: ChannelFactory = async () => {
        factoryCalls++;
        return handle.channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        channelIdleTimeoutMs: 5_000,
      });
      await bridge.preheat();
      expect(factoryCalls).toBe(1);
      expect(handle.killed).toBe(false);

      // First session cancels the preheat idle timer and reuses channel
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(factoryCalls).toBe(1);

      // Advance past preheat timer — channel should survive (timer cancelled)
      await vi.advanceTimersByTimeAsync(6_000);
      expect(handle.killed).toBe(false);

      // Close session — new idle timer starts
      await bridge.closeSession(session.sessionId);
      expect(handle.killed).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(handle.killed).toBe(true);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Session idle reaper
// ---------------------------------------------------------------------------
describe('session idle reaper', () => {
  it('reaps an orphaned session whose client crashed (no detach sent)', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 5_000,
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(bridge.sessionCount).toBe(1);

      // Simulate client crash: client never sends detach, but SSE
      // dropped and no heartbeat. clientIds still > 0 — only the
      // reaper can catch this.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT reap a session with an active prompt and client', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel({
        promptImpl: () => new Promise<never>(() => {}),
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 2_000,
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      const promptPromise = bridge
        .sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hi' }],
        })
        .catch(() => {});
      await vi.waitFor(() => {
        expect(handle.agent.promptCalls).toHaveLength(1);
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
      await promptPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT reap a session with a live SSE subscriber', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 2_000,
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      // Subscribe BEFORE detach so the subscriber keeps the session alive
      const abort = new AbortController();
      bridge.subscribeEvents(session.sessionId, { signal: abort.signal });
      // Detach — close-on-last-detach checks subscriberCount > 0 → skips
      await bridge.detachClient(session.sessionId, session.clientId);
      expect(bridge.sessionCount).toBe(1);

      // Advance past idle timeout — subscriber still protects from reaper
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.sessionCount).toBe(1);

      // Drop the subscriber — reaper catches it on next tick
      abort.abort();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT reap a session with an active prompt (no SSE, no heartbeat)', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel({
        promptImpl: () => new Promise<never>(() => {}),
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 2_000,
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const promptPromise = bridge
        .sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hi' }],
        })
        .catch(() => {});
      await vi.waitFor(() => {
        expect(handle.agent.promptCalls).toHaveLength(1);
      });

      // No subscriber, client registered but prompt active → reaper skips
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
      await promptPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('is disabled when sessionReapIntervalMs is 0', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 0,
        sessionIdleTimeoutMs: 1_000,
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is disabled when sessionIdleTimeoutMs is 0', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 0,
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes session_closed with reason idle_timeout via closeSession opts', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });

    const events: BridgeEvent[] = [];
    const abort = new AbortController();
    const iter = bridge.subscribeEvents(session.sessionId, {
      signal: abort.signal,
    });
    const reading = (async () => {
      for await (const ev of iter) {
        events.push(ev);
        if (ev.type === 'session_closed') {
          abort.abort();
          break;
        }
      }
    })();

    await bridge.closeSession(session.sessionId, undefined, {
      reason: 'idle_timeout',
    });
    await reading;
    const closedEv = events.find((e) => e.type === 'session_closed');
    expect(closedEv).toBeDefined();
    expect((closedEv!.data as { reason: string }).reason).toBe('idle_timeout');

    await bridge.shutdown();
  });

  it('closeSession defaults to reason client_close', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });

    const events: BridgeEvent[] = [];
    const abort = new AbortController();
    const iter = bridge.subscribeEvents(session.sessionId, {
      signal: abort.signal,
    });
    const reading = (async () => {
      for await (const ev of iter) {
        events.push(ev);
        if (ev.type === 'session_closed') {
          abort.abort();
          break;
        }
      }
    })();

    await bridge.closeSession(session.sessionId);
    await reading;
    const closedEv = events.find((e) => e.type === 'session_closed');
    expect(closedEv).toBeDefined();
    expect((closedEv!.data as { reason: string }).reason).toBe('client_close');

    await bridge.shutdown();
  });

  it('reaps multiple orphaned sessions in one tick', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 3_000,
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(bridge.sessionCount).toBe(3);

      // No detach — simulates client crash. Reaper catches all 3.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('session with recent heartbeat survives reaper', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 5_000,
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      // No detach — simulates a crashed client that still sends heartbeats
      // (e.g. a headless API client with a keepalive loop).
      await vi.advanceTimersByTimeAsync(4_000);
      bridge.recordHeartbeat(session.sessionId);
      expect(bridge.sessionCount).toBe(1);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(bridge.sessionCount).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaper is stopped on shutdown (no post-shutdown errors)', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 2_000,
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      await bridge.shutdown();

      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('triggers channel idle timer after reaping the last session', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionReapIntervalMs: 1_000,
        sessionIdleTimeoutMs: 3_000,
        channelIdleTimeoutMs: 2_000,
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      await bridge.detachClient(session.sessionId, session.clientId);

      // Close-on-last-detach fires immediately — session gone
      expect(bridge.sessionCount).toBe(0);
      // Channel should still be alive — channelIdleTimeoutMs grace
      expect(handle.killed).toBe(false);

      // Channel idle timer fires after 2s
      await vi.advanceTimersByTimeAsync(2_000);
      expect(handle.killed).toBe(true);

      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Close on last client detach
// ---------------------------------------------------------------------------
describe('close on last client detach', () => {
  it('closes the session when the last client detaches', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      sessionReapIntervalMs: 0,
    });
    const session = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    expect(bridge.sessionCount).toBe(1);

    await bridge.detachClient(session.sessionId, session.clientId);
    expect(bridge.sessionCount).toBe(0);

    await bridge.shutdown();
  });

  it('does NOT close when other clients remain', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      sessionReapIntervalMs: 0,
    });
    const s1 = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    const s2 = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    expect(s2.attached).toBe(true);
    expect(bridge.sessionCount).toBe(1);

    await bridge.detachClient(s1.sessionId, s1.clientId);
    expect(bridge.sessionCount).toBe(1);

    await bridge.detachClient(s2.sessionId, s2.clientId);
    expect(bridge.sessionCount).toBe(0);

    await bridge.shutdown();
  });

  it('closes immediately on last detach (session removed from byId)', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      sessionReapIntervalMs: 0,
    });
    const session = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    expect(bridge.sessionCount).toBe(1);

    // Last client detaches — session closed immediately, no reaper needed
    await bridge.detachClient(session.sessionId, session.clientId);
    expect(bridge.sessionCount).toBe(0);

    // Session is gone from bridge but getHeartbeatState returns undefined
    expect(bridge.getHeartbeatState(session.sessionId)).toBeUndefined();

    await bridge.shutdown();
  });
});

describe('activePromptCount and lastActivityAt', () => {
  it('activePromptCount is 0 and lastActivityAt is null before any activity', () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    expect(bridge.activePromptCount).toBe(0);
    expect(bridge.lastActivityAt).toBeNull();
  });

  it('lastActivityAt is set after spawning a session', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    const before = Date.now();
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const after = Date.now();

    expect(bridge.lastActivityAt).not.toBeNull();
    expect(bridge.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(bridge.lastActivityAt).toBeLessThanOrEqual(after);
    expect(bridge.activePromptCount).toBe(0);

    await bridge.shutdown();
  });

  it('activePromptCount increments during prompt and decrements after', async () => {
    let releasePrompt: (() => void) | undefined;
    const handle = makeChannel({
      promptImpl: () =>
        new Promise<PromptResponse>((resolve) => {
          releasePrompt = () => resolve({ stopReason: 'end_turn' });
        }),
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Start prompt (don't await — it blocks until released)
    const promptPromise = bridge.sendPrompt(session.sessionId, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'test' }],
    });

    // Wait for prompt to reach the agent
    await vi.waitFor(() => {
      expect(handle.agent.promptCalls).toHaveLength(1);
    });

    expect(bridge.activePromptCount).toBe(1);
    const duringPromptActivity = bridge.lastActivityAt;
    expect(duringPromptActivity).not.toBeNull();

    // Release prompt
    releasePrompt!();
    await promptPromise;

    expect(bridge.activePromptCount).toBe(0);
    // lastActivityAt should be updated after prompt ends
    expect(bridge.lastActivityAt).toBeGreaterThanOrEqual(duringPromptActivity!);

    await bridge.shutdown();
  });

  it('activePromptCount tracks multiple concurrent sessions', async () => {
    const releasers: Array<() => void> = [];
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          promptImpl: () =>
            new Promise<PromptResponse>((resolve) => {
              releasers.push(() => resolve({ stopReason: 'end_turn' }));
            }),
        });
        handles.push(h);
        return h.channel;
      },
    });

    const s1 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const s2 = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });

    // Start prompts on both sessions
    const p1 = bridge.sendPrompt(s1.sessionId, {
      sessionId: s1.sessionId,
      prompt: [{ type: 'text', text: 'test1' }],
    });
    const p2 = bridge.sendPrompt(s2.sessionId, {
      sessionId: s2.sessionId,
      prompt: [{ type: 'text', text: 'test2' }],
    });

    // Wait for both prompts to reach agents
    await vi.waitFor(() => {
      const totalPrompts = handles.reduce(
        (sum, h) => sum + h.agent.promptCalls.length,
        0,
      );
      expect(totalPrompts).toBeGreaterThanOrEqual(2);
    });

    expect(bridge.activePromptCount).toBe(2);

    // Release first prompt
    releasers[0]!();
    await p1;
    expect(bridge.activePromptCount).toBe(1);

    // Release second prompt
    releasers[1]!();
    await p2;
    expect(bridge.activePromptCount).toBe(0);

    await bridge.shutdown();
  });

  it('lastActivityAt updates on prompt start and end', async () => {
    let releasePrompt: (() => void) | undefined;
    const handle = makeChannel({
      promptImpl: () =>
        new Promise<PromptResponse>((resolve) => {
          releasePrompt = () => resolve({ stopReason: 'end_turn' });
        }),
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const afterSpawn = bridge.lastActivityAt!;

    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 5));

    const promptPromise = bridge.sendPrompt(session.sessionId, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'test' }],
    });

    await vi.waitFor(() => {
      expect(handle.agent.promptCalls).toHaveLength(1);
    });

    const afterPromptStart = bridge.lastActivityAt!;
    expect(afterPromptStart).toBeGreaterThanOrEqual(afterSpawn);

    await new Promise((r) => setTimeout(r, 5));

    releasePrompt!();
    await promptPromise;

    const afterPromptEnd = bridge.lastActivityAt!;
    expect(afterPromptEnd).toBeGreaterThanOrEqual(afterPromptStart);

    await bridge.shutdown();
  });

  it('activePromptCount does not go negative when closeSession cancels an active prompt', async () => {
    let rejectPrompt: ((error?: unknown) => void) | undefined;
    const handle = makeChannel({
      promptImpl: () =>
        new Promise<PromptResponse>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      cancelImpl: () => {
        rejectPrompt?.(new Error('cancelled'));
      },
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    const promptResult = bridge
      .sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'test' }],
      })
      .then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );

    await vi.waitFor(() => {
      expect(handle.agent.promptCalls).toHaveLength(1);
    });
    expect(bridge.activePromptCount).toBe(1);

    await bridge.closeSession(session.sessionId);
    expect(bridge.activePromptCount).toBe(0);

    const result = await promptResult;
    expect(result.ok).toBe(false);
    expect(bridge.activePromptCount).toBe(0);

    await bridge.shutdown();
  });

  it('activePromptCount does not go negative when killSession cancels an active prompt', async () => {
    let rejectPrompt: ((error?: unknown) => void) | undefined;
    const handle = makeChannel({
      promptImpl: () =>
        new Promise<PromptResponse>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      cancelImpl: () => {
        rejectPrompt?.(new Error('cancelled'));
      },
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    const promptResult = bridge
      .sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'test' }],
      })
      .then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );

    await vi.waitFor(() => {
      expect(handle.agent.promptCalls).toHaveLength(1);
    });
    expect(bridge.activePromptCount).toBe(1);

    await bridge.killSession(session.sessionId);
    expect(bridge.activePromptCount).toBe(0);
    expect(bridge.sessionCount).toBe(0);

    const result = await promptResult;
    expect(result.ok).toBe(false);
    expect(bridge.activePromptCount).toBe(0);

    await bridge.shutdown();
  });

  it('activePromptCount returns to 0 when channel crashes during a hung prompt', async () => {
    const handle = makeChannel({
      promptImpl: () => new Promise<PromptResponse>(() => {}),
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    const promptResult = bridge
      .sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'test' }],
      })
      .then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );

    await vi.waitFor(() => {
      expect(handle.agent.promptCalls).toHaveLength(1);
    });
    expect(bridge.activePromptCount).toBe(1);

    handle.crash();

    await vi.waitFor(() => {
      expect(bridge.activePromptCount).toBe(0);
      expect(bridge.sessionCount).toBe(0);
    });

    const result = await promptResult;
    expect(result.ok).toBe(false);
    expect(bridge.activePromptCount).toBe(0);

    await bridge.shutdown();
  });

  it('queued prompt rejects when the channel crashes before it starts', async () => {
    const handle = makeChannel({
      promptImpl: () => new Promise<PromptResponse>(() => {}),
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    const promptA = bridge
      .sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'prompt A' }],
      })
      .then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );

    await vi.waitFor(() => {
      expect(handle.agent.promptCalls).toHaveLength(1);
    });

    const promptB = bridge
      .sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'prompt B' }],
      })
      .then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );

    handle.crash();

    const [resultA, resultB] = await Promise.all([promptA, promptB]);

    expect(handle.agent.promptCalls).toHaveLength(1);
    expect(resultA.ok).toBe(false);
    expect(resultB.ok).toBe(false);
    if (resultB.ok) {
      throw new Error('queued prompt unexpectedly resolved');
    }
    expect(resultB.error).toBeInstanceOf(SessionNotFoundError);

    await vi.waitFor(() => {
      expect(bridge.activePromptCount).toBe(0);
      expect(bridge.sessionCount).toBe(0);
    });

    await bridge.shutdown();
  });
});

/**
 * `enqueueMidTurnMessage` backs the web-shell mid-turn drain: the browser
 * pushes a message typed during a turn, the ACP child drains it via
 * `craft/drainMidTurnQueue` (answered by BridgeClient.extMethod). The accept
 * gate is the exactly-once linchpin — it must reject when the session is idle
 * so the browser's own next-turn queue stays the single delivery path in the
 * settle-window race.
 */
describe('createAcpSessionBridge — mid-turn message queue (enqueueMidTurnMessage)', () => {
  function hangingPromptFactory(): {
    factory: ChannelFactory;
    release: () => void;
  } {
    let release: (() => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        promptImpl: async () => {
          await new Promise<void>((res) => {
            release = res;
          });
          return { stopReason: 'end_turn' };
        },
      }).channel;
    return { factory, release: () => release?.() };
  }

  it('rejects (accepted:false) when the session is idle', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(bridge.enqueueMidTurnMessage(session.sessionId, 'later')).toEqual({
      accepted: false,
    });
    await bridge.shutdown();
  });

  it('accepts while a turn is in flight, then rejects again once it settles', async () => {
    const { factory, release } = hangingPromptFactory();
    const bridge = makeBridge({ channelFactory: factory });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const promptPromise = bridge
      .sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'run tools' }],
        },
        undefined,
        { clientId: session.clientId },
      )
      .catch(() => {});

    // Let the FIFO worker pick up the (hanging) prompt before asserting.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      bridge.enqueueMidTurnMessage(session.sessionId, 'also check tests'),
    ).toEqual({ accepted: true });

    // Settle the turn → the queue flips back to idle and the undrained copy is
    // dropped server-side (the browser resends it as the next turn).
    release();
    await promptPromise;
    expect(
      bridge.enqueueMidTurnMessage(session.sessionId, 'next time'),
    ).toEqual({ accepted: false });
    await bridge.shutdown();
  });

  it('rejects a whitespace-only message even while busy', async () => {
    const { factory, release } = hangingPromptFactory();
    const bridge = makeBridge({ channelFactory: factory });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const promptPromise = bridge
      .sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'x' }],
        },
        undefined,
        { clientId: session.clientId },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.enqueueMidTurnMessage(session.sessionId, '   ')).toEqual({
      accepted: false,
    });
    release();
    await promptPromise;
    await bridge.shutdown();
  });

  it('throws SessionNotFoundError for an unknown session', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    expect(() => bridge.enqueueMidTurnMessage('nope', 'hi')).toThrow(
      SessionNotFoundError,
    );
    await bridge.shutdown();
  });

  it('drains the queue through the child connection; a second drain is empty', async () => {
    let release: (() => void) | undefined;
    const handle = makeChannel({
      promptImpl: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { stopReason: 'end_turn' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const prompt = bridge
      .sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        },
        undefined,
        { clientId: session.clientId },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    bridge.enqueueMidTurnMessage(session.sessionId, 'm1');
    bridge.enqueueMidTurnMessage(session.sessionId, 'm2');

    // The child pulls them via the ext-method the real Session calls between
    // tool batches — exercising bridge queue ⇄ BridgeClient.extMethod end to end.
    const drained = await handle.agentConnection.extMethod(
      'craft/drainMidTurnQueue',
      { sessionId: session.sessionId },
    );
    expect(drained).toEqual({ messages: ['m1', 'm2'] });
    // Spliced out, so the next batch's drain is empty.
    expect(
      await handle.agentConnection.extMethod('craft/drainMidTurnQueue', {
        sessionId: session.sessionId,
      }),
    ).toEqual({ messages: [] });

    release?.();
    await prompt;
    await bridge.shutdown();
  });

  it('clears undrained messages at settle — not re-drained on the next turn', async () => {
    const releases: Array<() => void> = [];
    const handle = makeChannel({
      promptImpl: async () => {
        await new Promise<void>((r) => {
          releases.push(r);
        });
        return { stopReason: 'end_turn' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const send = (text: string) =>
      bridge
        .sendPrompt(
          session.sessionId,
          { sessionId: session.sessionId, prompt: [{ type: 'text', text }] },
          undefined,
          { clientId: session.clientId },
        )
        .catch(() => {});
    const drain = () =>
      handle.agentConnection.extMethod('craft/drainMidTurnQueue', {
        sessionId: session.sessionId,
      });

    // Turn 1: enqueue, do NOT drain, then settle.
    const t1 = send('t1');
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.enqueueMidTurnMessage(session.sessionId, 'leftover')).toEqual(
      {
        accepted: true,
      },
    );
    releases[0]!();
    await t1;

    // Turn 2: the drain must be empty — the leftover was dropped at turn-1
    // settle, NOT carried into turn 2's first batch. (Deleting the settle-clear
    // line makes this return ['leftover'].)
    const t2 = send('t2');
    await new Promise((r) => setTimeout(r, 10));
    expect(await drain()).toEqual({ messages: [] });

    releases[1]!();
    await t2;
    await bridge.shutdown();
  });

  it('keeps the queue across a back-to-back prompt FIFO, clearing only at true idle', async () => {
    const releases: Array<() => void> = [];
    const handle = makeChannel({
      promptImpl: async () => {
        await new Promise<void>((r) => {
          releases.push(r);
        });
        return { stopReason: 'end_turn' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const send = (text: string) =>
      bridge
        .sendPrompt(
          session.sessionId,
          { sessionId: session.sessionId, prompt: [{ type: 'text', text }] },
          undefined,
          { clientId: session.clientId },
        )
        .catch(() => {});

    const p1 = send('p1');
    await new Promise((r) => setTimeout(r, 10));
    const p2 = send('p2'); // queued behind p1 ⇒ pendingPromptCount = 2
    expect(bridge.enqueueMidTurnMessage(session.sessionId, 'x')).toEqual({
      accepted: true,
    });

    releases[0]!(); // settle p1 — session still busy (p2 pending), so NOT idle
    await new Promise((r) => setTimeout(r, 10));
    // Survived the p1→p2 boundary: the clear only fires at true idle.
    expect(
      await handle.agentConnection.extMethod('craft/drainMidTurnQueue', {
        sessionId: session.sessionId,
      }),
    ).toEqual({ messages: ['x'] });

    releases[1]!();
    await Promise.all([p1, p2]);
    await bridge.shutdown();
  });

  it('rejects a non-member client id (mirrors /prompt and /btw authorization)', async () => {
    // The route forwards the client-declared id; the bridge must authorize it
    // against THIS session before queuing — a token-holding client bound to
    // another session must not push into this turn. The check runs before the
    // idle/empty gates, so it throws even on an idle session.
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(() =>
      bridge.enqueueMidTurnMessage(session.sessionId, 'sneaky', {
        clientId: 'client-not-issued',
      }),
    ).toThrow(InvalidClientIdError);
    await bridge.shutdown();
  });

  it('stamps the drained injection frame with the originator client id', async () => {
    // End-to-end: the trusted client id passed to enqueue is recorded on the
    // queue entry and surfaces as the published frame's `originatorClientId`, so
    // only that client dedupes its own pending queue (a peer must keep its copy).
    let release: (() => void) | undefined;
    const handle = makeChannel({
      promptImpl: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { stopReason: 'end_turn' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const prompt = bridge
      .sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        },
        undefined,
        { clientId: session.clientId },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(
      bridge.enqueueMidTurnMessage(session.sessionId, 'hi', {
        clientId: session.clientId,
      }),
    ).toEqual({ accepted: true });

    // Subscribe before the drain so the live injection frame is captured. The
    // hanging prompt publishes nothing in between, so it is the first frame.
    const abort = new AbortController();
    const iter = bridge.subscribeEvents(session.sessionId, {
      signal: abort.signal,
    });
    const drained = await handle.agentConnection.extMethod(
      'craft/drainMidTurnQueue',
      { sessionId: session.sessionId },
    );
    expect(drained).toEqual({ messages: ['hi'] });

    const it = iter[Symbol.asyncIterator]();
    const next = await it.next();
    expect(next.value?.type).toBe('mid_turn_message_injected');
    expect(next.value?.originatorClientId).toBe(session.clientId);
    expect(next.value?.data).toMatchObject({ messages: ['hi'] });

    abort.abort();
    release?.();
    await prompt;
    await bridge.shutdown();
  });

  it('rejects past MAX_MID_TURN_QUEUE_DEPTH (20) — the DoS bound', async () => {
    const { factory, release } = hangingPromptFactory();
    const bridge = makeBridge({ channelFactory: factory });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const promptPromise = bridge
      .sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        },
        undefined,
        { clientId: session.clientId },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    // First 20 accepted, 21st rejected (browser keeps it for the next turn).
    for (let i = 0; i < 20; i++) {
      expect(bridge.enqueueMidTurnMessage(session.sessionId, `m${i}`)).toEqual({
        accepted: true,
      });
    }
    expect(bridge.enqueueMidTurnMessage(session.sessionId, 'overflow')).toEqual(
      { accepted: false },
    );

    release();
    await promptPromise;
    await bridge.shutdown();
  });

  it('trims the message before queuing (drain returns the trimmed text)', async () => {
    let release: (() => void) | undefined;
    const handle = makeChannel({
      promptImpl: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { stopReason: 'end_turn' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const prompt = bridge
      .sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        },
        undefined,
        { clientId: session.clientId },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(
      bridge.enqueueMidTurnMessage(session.sessionId, '   hello   '),
    ).toEqual({ accepted: true });
    const drained = await handle.agentConnection.extMethod(
      'craft/drainMidTurnQueue',
      { sessionId: session.sessionId },
    );
    expect(drained).toEqual({ messages: ['hello'] });

    release?.();
    await prompt;
    await bridge.shutdown();
  });
});
