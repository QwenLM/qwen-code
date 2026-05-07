/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import {
  createHttpAcpBridge,
  SessionNotFoundError,
  type AcpChannel,
  type ChannelFactory,
} from './httpAcpBridge.js';

interface FakeAgentOpts {
  /** What the fake agent returns from `newSession`. */
  sessionIdPrefix?: string;
  /** Inject a per-call delay before responding to `initialize`. */
  initializeDelayMs?: number;
  /** Force `initialize` to throw. */
  initializeThrows?: Error;
  /**
   * Custom prompt handler. Default returns `end_turn` synchronously. Useful
   * for test cases that want to observe prompt ordering.
   */
  promptImpl?: (
    p: PromptRequest,
    self: FakeAgent,
  ) => Promise<PromptResponse> | PromptResponse;
}

class FakeAgent implements Agent {
  newSessionCalls: NewSessionRequest[] = [];
  promptCalls: PromptRequest[] = [];
  cancelCalls: CancelNotification[] = [];
  constructor(private readonly opts: FakeAgentOpts = {}) {}

  async initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    if (this.opts.initializeThrows) throw this.opts.initializeThrows;
    if (this.opts.initializeDelayMs) {
      await new Promise((r) => setTimeout(r, this.opts.initializeDelayMs));
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'fake-agent', version: '0' },
      authMethods: [],
      agentCapabilities: {},
    };
  }

  async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(p);
    const prefix = this.opts.sessionIdPrefix ?? 'sess';
    return { sessionId: `${prefix}:${p.cwd}` };
  }

  async loadSession(_p: LoadSessionRequest): Promise<LoadSessionResponse> {
    throw new Error('not implemented in test fake');
  }
  async authenticate(_p: AuthenticateRequest): Promise<AuthenticateResponse> {
    throw new Error('not implemented in test fake');
  }
  async prompt(p: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(p);
    if (this.opts.promptImpl) {
      return this.opts.promptImpl(p, this);
    }
    return { stopReason: 'end_turn' };
  }
  async cancel(p: CancelNotification): Promise<void> {
    this.cancelCalls.push(p);
  }
  async setSessionMode(
    _p: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    throw new Error('not implemented in test fake');
  }
  async setSessionConfigOption(
    _p: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    throw new Error('not implemented in test fake');
  }
}

interface ChannelHandle {
  channel: AcpChannel;
  agent: FakeAgent;
  killed: boolean;
}

/**
 * Create a paired in-memory NDJSON channel: bridge sees `clientChannel`,
 * fake agent sees `agentStream`. Each `TransformStream` carries one
 * direction.
 */
function makeChannel(opts: FakeAgentOpts = {}): ChannelHandle {
  const ab = new TransformStream<Uint8Array, Uint8Array>();
  const ba = new TransformStream<Uint8Array, Uint8Array>();
  const clientStream = ndJsonStream(ab.writable, ba.readable);
  const agentStream = ndJsonStream(ba.writable, ab.readable);
  const handle: ChannelHandle = {
    channel: undefined as unknown as AcpChannel,
    agent: new FakeAgent(opts),
    killed: false,
  };
  // Spin up the fake agent on the agent side.
  new AgentSideConnection(() => handle.agent, agentStream);
  handle.channel = {
    stream: clientStream,
    kill: async () => {
      handle.killed = true;
      try {
        await ab.writable.close();
      } catch {
        /* ignore */
      }
      try {
        await ba.writable.close();
      } catch {
        /* ignore */
      }
    },
  };
  return handle;
}

describe('createHttpAcpBridge', () => {
  it('spawns a session and returns the agent-assigned id', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = createHttpAcpBridge({ channelFactory: factory });

    const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
    expect(session.sessionId).toBe('sess:/work/a');
    expect(session.workspaceCwd).toBe('/work/a');
    expect(session.attached).toBe(false);
    expect(bridge.sessionCount).toBe(1);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.agent.newSessionCalls[0]?.cwd).toBe('/work/a');

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
    const bridge = createHttpAcpBridge({ channelFactory: factory });

    const first = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
    const second = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(true);
    expect(handles).toHaveLength(1); // only one child spawned
    expect(bridge.sessionCount).toBe(1);

    await bridge.shutdown();
  });

  it('does NOT reuse across workspaces', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = createHttpAcpBridge({ channelFactory: factory });

    const a = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
    const b = await bridge.spawnOrAttach({ workspaceCwd: '/work/b' });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.attached).toBe(false);
    expect(b.attached).toBe(false);
    expect(handles).toHaveLength(2);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('spawns fresh per call under sessionScope:thread', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = createHttpAcpBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    const first = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
    const second = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(false);
    expect(handles).toHaveLength(2);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('rejects relative workspace paths', async () => {
    const bridge = createHttpAcpBridge({
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
    const bridge = createHttpAcpBridge({ channelFactory: factory });

    const a = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
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
    const bridge = createHttpAcpBridge({ channelFactory: factory });

    // ACP SDK rewrites unhandled exceptions to a JSON-RPC Internal error
    // object (code -32603); the original message text is intentionally not
    // forwarded. Assert on rejection + resource cleanup.
    const err = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' }).then(
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
    const bridge = createHttpAcpBridge({
      channelFactory: factory,
      initializeTimeoutMs: 50,
    });

    await expect(
      bridge.spawnOrAttach({ workspaceCwd: '/work/a' }),
    ).rejects.toThrow(/initialize timed out/);
    expect(handles[0]?.killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('shutdown kills every live channel', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = createHttpAcpBridge({ channelFactory: factory });

    await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
    await bridge.spawnOrAttach({ workspaceCwd: '/work/b' });
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
    expect(handles.every((h) => h.killed)).toBe(true);
    expect(bridge.sessionCount).toBe(0);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

      const result = await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(result).toEqual({ stopReason: 'max_tokens' });
      expect(handles[0]?.agent.promptCalls).toHaveLength(1);

      await bridge.shutdown();
    });

    it('overrides a stale sessionId in the body with the routing id', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

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

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

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
      const bridge = createHttpAcpBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      await expect(bridge.cancelSession('unknown')).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
          kill: async () => {
            handle.killed = true;
          },
        };
      };
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
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
      bridge.respondToPermission(requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      const resolvedEvt = (await it.next()).value!;
      expect(resolvedEvt.type).toBe('permission_resolved');
      expect(resolvedEvt.data).toMatchObject({
        requestId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      subAbort.abort();
      await bridge.shutdown();
    });

    it('respondToPermission returns false for unknown requestId', async () => {
      const bridge = createHttpAcpBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const accepted = bridge.respondToPermission('does-not-exist', {
        outcome: { outcome: 'cancelled' },
      });
      expect(accepted).toBe(false);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });

      const [a, b] = await Promise.all([
        bridge.spawnOrAttach({ workspaceCwd: '/work/a' }),
        bridge.spawnOrAttach({ workspaceCwd: '/work/a' }),
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });

      await expect(
        bridge.spawnOrAttach({ workspaceCwd: '/work/a' }),
      ).rejects.toBeTruthy();

      // The retry must NOT see the rejected promise still parked in
      // inFlightSpawns — that would poison every future call.
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
      expect(session.sessionId).toBe('sess:/work/a');
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
        capturedConn = new AgentSideConnection(
          () => new FakeAgent(),
          agentStream,
        );
        return { stream: clientStream, kill: async () => {} };
      };
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
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

    it('readTextFile slices via line/limit', async () => {
      const { bridge, conn } = await setupForFs();
      const tmp = path.join(
        os.tmpdir(),
        `qwen-bridge-slice-${randomBytes(8).toString('hex')}.txt`,
      );
      await fsp.writeFile(tmp, 'a\nb\nc\nd\ne', 'utf8');
      try {
        const result = (await (
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
        expect(result.content).toBe('b\nc');
      } finally {
        await fsp.rm(tmp, { force: true });
        await bridge.shutdown();
      }
    });
  });

  describe('listWorkspaceSessions', () => {
    it('returns sessions matching the canonical workspace cwd', async () => {
      let n = 0;
      const factory: ChannelFactory = async () => {
        // Distinct sessionIdPrefix per spawn so two thread-scope sessions
        // in the same workspace get distinct ids (the FakeAgent encodes the
        // cwd into the id otherwise → collision).
        const h = makeChannel({ sessionIdPrefix: `s${n++}` });
        return h.channel;
      };
      const bridge = createHttpAcpBridge({
        sessionScope: 'thread',
        channelFactory: factory,
      });

      const a1 = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
      const a2 = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
      await bridge.spawnOrAttach({ workspaceCwd: '/work/b' });

      const aList = bridge.listWorkspaceSessions('/work/a');
      expect(aList).toHaveLength(2);
      expect(aList.map((s) => s.sessionId).sort()).toEqual(
        [a1.sessionId, a2.sessionId].sort(),
      );
      const bList = bridge.listWorkspaceSessions('/work/b');
      expect(bList).toHaveLength(1);
      const idleList = bridge.listWorkspaceSessions('/work/c');
      expect(idleList).toEqual([]);

      await bridge.shutdown();
    });

    it('canonicalizes the lookup path', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

      const list = bridge.listWorkspaceSessions('/work/./a');
      expect(list).toHaveLength(1);
      expect(list[0]?.workspaceCwd).toBe('/work/a');

      await bridge.shutdown();
    });

    it('returns empty for relative paths instead of throwing', async () => {
      const bridge = createHttpAcpBridge({
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
          kill: async () => {},
        };
      };
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });
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

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = createHttpAcpBridge({
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

  describe('subscribeEvents', () => {
    it('throws SessionNotFoundError for unknown session ids', () => {
      const bridge = createHttpAcpBridge({
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          kill: async () => {},
        };
      };
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

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

      const collected: Array<{ id: number; type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ id: e.id, type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('session_update');
      expect(collected[0]?.id).toBe(1);

      abort.abort();
      await bridge.shutdown();
    });

    it('shutdown closes live event subscriptions', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: '/work/a' });

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

      // Subscriber must unwind to completion (no events ever published).
      const events = await drain;
      expect(events).toEqual([]);
    });
  });
});
