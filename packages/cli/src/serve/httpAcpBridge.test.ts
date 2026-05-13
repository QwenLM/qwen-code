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
  InvalidPermissionOptionError,
  SessionNotFoundError,
  type AcpChannel,
  type ChannelFactory,
} from './httpAcpBridge.js';
import type { BridgeEvent } from './eventBus.js';

// Workspace fixtures must round-trip through `path.resolve` so the
// expected values match what the bridge canonicalizes internally on
// every platform — a literal `/work/a` resolves to `D:\work\a` on
// Windows and the assertion drifts. Same for the FakeAgent's
// `sess:<cwd>` synthetic id, since the cwd it sees is the post-resolve
// value the bridge passes through `connection.newSession`.
const WS_A = path.resolve(path.sep, 'work', 'a');
const WS_B = path.resolve(path.sep, 'work', 'b');
const SESS_A = `sess:${WS_A}`;

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
    // Stage 1.5 multi-session: one FakeAgent can host multiple
    // sessions (same as the real ACP agent), so each newSession call
    // returns a fresh id. Suffix by call-count so tests that issue
    // multiple newSession on the same channel get distinct ids.
    const count = this.newSessionCalls.length;
    const suffix = count === 1 ? '' : `#${count}`;
    return { sessionId: `${prefix}:${p.cwd}${suffix}` };
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
  /**
   * Resolve `channel.exited` without going through `kill()`. Optionally
   * supply exit info so the bridge's `session_died` event carries the
   * same `exitCode` / `signalCode` it would in a real crash (BX9_P).
   */
  crash: (info?: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }) => void;
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
  let resolveExited:
    | ((info?: {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      }) => void)
    | undefined;
  const exited = new Promise<
    { exitCode: number | null; signalCode: NodeJS.Signals | null } | undefined
  >((res) => {
    resolveExited = res;
  });
  const handle: ChannelHandle = {
    channel: undefined as unknown as AcpChannel,
    agent: new FakeAgent(opts),
    killed: false,
    /** Test hook: simulate an unexpected child crash. */
    crash: (info?: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    }) => resolveExited!(info),
  };
  // Spin up the fake agent on the agent side.
  new AgentSideConnection(() => handle.agent, agentStream);
  handle.channel = {
    stream: clientStream,
    exited,
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
      resolveExited!();
    },
    killSync: () => {
      // Test fake: just mark killed; the async streams will close
      // naturally on test cleanup. Mirrors the real spawn factory's
      // SIGKILL semantics (fire-and-forget).
      handle.killed = true;
      resolveExited!();
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

    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(session.sessionId).toBe(SESS_A);
    expect(session.workspaceCwd).toBe(WS_A);
    expect(session.attached).toBe(false);
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
    const bridge = createHttpAcpBridge({ channelFactory: factory });

    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

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

    const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const b = await bridge.spawnOrAttach({ workspaceCwd: WS_B });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.attached).toBe(false);
    expect(b.attached).toBe(false);
    expect(handles).toHaveLength(2);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('creates fresh session per call under sessionScope:thread (Stage 1.5 multi-session: shares channel)', async () => {
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
    const bridge = createHttpAcpBridge({ channelFactory: factory });

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
    const bridge = createHttpAcpBridge({
      channelFactory: factory,
      initializeTimeoutMs: 50,
    });

    await expect(bridge.spawnOrAttach({ workspaceCwd: WS_A })).rejects.toThrow(
      /initialize timed out/,
    );
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

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await bridge.spawnOrAttach({ workspaceCwd: WS_B });
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
    expect(handles.every((h) => h.killed)).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('killAllSync force-kills channels even after shutdown cleared byWorkspaceChannel (BkUyD)', async () => {
    // tanzhenxin BkUyD regression: shutdown clears
    // `byWorkspaceChannel` BEFORE awaiting per-child SIGTERM grace.
    // If the operator double-Ctrl+C's during that window,
    // killAllSync MUST still see the in-flight-being-killed
    // channels. Pre-fix: killAllSync iterated `byWorkspaceChannel`
    // and silently no-op'd; children orphaned. Fix: separate
    // `liveChannels` set, only emptied on channel.exited.
    const killSyncInvoked: number[] = [];
    let nextChannelTag = 0;
    const factory: ChannelFactory = async () => {
      const tag = nextChannelTag++;
      const h = makeChannel({ sessionIdPrefix: `s${tag}` });
      const realKillSync = h.channel.killSync;
      // Spy on killSync calls so we can assert the force-kill path
      // actually fired for every live channel.
      h.channel = {
        ...h.channel,
        kill: () =>
          // Never resolve — simulates a stuck SIGTERM grace window.
          new Promise(() => {}),
        killSync: () => {
          killSyncInvoked.push(tag);
          realKillSync();
        },
      };
      return h.channel;
    };
    const bridge = createHttpAcpBridge({ channelFactory: factory });
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await bridge.spawnOrAttach({ workspaceCwd: WS_B });

    // Kick off shutdown — its `channel.kill()` will hang on the
    // never-resolving Promise above, so `byWorkspaceChannel` clears
    // but the awaits never finish. This is the mid-drain state.
    const shutdownPromise = bridge.shutdown();
    // Yield twice so shutdown's sync prefix runs (clear maps,
    // publish session_died, start awaits).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Operator double-Ctrl+C arrives now.
    bridge.killAllSync();

    // Both channels' killSync was invoked. Pre-fix this would have
    // been an empty array.
    expect(killSyncInvoked).toHaveLength(2);

    // Cleanup: the never-resolving kill keeps shutdownPromise
    // pending forever. Don't await it (would hang the test). The
    // test runner GCs it when this `it` returns.
    void shutdownPromise;
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
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });

      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(1);

      // Subscribe so we can observe the session_died event.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Simulate a child crash (channel.exited resolves but we never called
      // kill() — entry is still in byId/byWorkspace at the moment of crash).
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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

    it('serializes concurrent model-change calls (FIFO)', async () => {
      const callOrder: string[] = [];
      const factory: ChannelFactory = async () => {
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });

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
      const bridge = createHttpAcpBridge({ channelFactory: factory });

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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
        createHttpAcpBridge({
          sessionScope: 'bogus' as unknown as 'single',
        }),
      ).toThrow(/Invalid sessionScope/);
    });

    it('rejects a non-positive initializeTimeoutMs', () => {
      expect(() => createHttpAcpBridge({ initializeTimeoutMs: 0 })).toThrow(
        /initializeTimeoutMs/,
      );
      expect(() => createHttpAcpBridge({ initializeTimeoutMs: -1 })).toThrow(
        /initializeTimeoutMs/,
      );
    });

    it('rejects NaN maxSessions (BRApy: silent fail-OPEN guard)', () => {
      // A typo / parse error in CLI / config that yields NaN must
      // NOT silently disable the daemon's resource cap. We fail
      // boot loud instead of serving unbounded.
      expect(() => createHttpAcpBridge({ maxSessions: NaN })).toThrow(
        /maxSessions: NaN/,
      );
      expect(() => createHttpAcpBridge({ maxSessions: -5 })).toThrow(
        /maxSessions: -5/,
      );
      // Explicit zero or Infinity remain valid "unlimited" sentinels.
      expect(() => createHttpAcpBridge({ maxSessions: 0 })).not.toThrow();
      expect(() =>
        createHttpAcpBridge({ maxSessions: Infinity }),
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });

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
      const bridge = createHttpAcpBridge({ channelFactory: factory });

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
        const ab = new TransformStream<Uint8Array, Uint8Array>();
        const ba = new TransformStream<Uint8Array, Uint8Array>();
        const clientStream = ndJsonStream(ab.writable, ba.readable);
        const agentStream = ndJsonStream(ba.writable, ab.readable);
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
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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

      const a1 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const a2 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.spawnOrAttach({ workspaceCwd: WS_B });

      const aList = bridge.listWorkspaceSessions(WS_A);
      expect(aList).toHaveLength(2);
      expect(aList.map((s) => s.sessionId).sort()).toEqual(
        [a1.sessionId, a2.sessionId].sort(),
      );
      const bList = bridge.listWorkspaceSessions(WS_B);
      expect(bList).toHaveLength(1);
      const idleList = bridge.listWorkspaceSessions('/work/c');
      expect(idleList).toEqual([]);

      await bridge.shutdown();
    });

    it('canonicalizes the lookup path', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = createHttpAcpBridge({ channelFactory: factory });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const list = bridge.listWorkspaceSessions('/work/./a');
      expect(list).toHaveLength(1);
      expect(list[0]?.workspaceCwd).toBe(WS_A);

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
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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

    it('shutdown closes live event subscriptions', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = createHttpAcpBridge({ channelFactory: factory });
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

  describe('maxSessions cap (chiga0 Rec 3)', () => {
    it('refuses NEW spawns past the cap with SessionLimitExceededError', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = createHttpAcpBridge({
        channelFactory: factory,
        maxSessions: 2,
        // `thread` so each call is a fresh session, not an attach.
        sessionScope: 'thread',
      });

      // First two spawns succeed.
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.spawnOrAttach({ workspaceCwd: WS_B });
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

    it('attach to an existing session under single scope is NOT counted toward the cap', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = createHttpAcpBridge({
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

      // But a NEW workspace (would need a fresh spawn) is rejected.
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_B }),
      ).rejects.toMatchObject({
        name: 'SessionLimitExceededError',
      });

      await bridge.shutdown();
    });

    it('killSession({requireZeroAttaches:true}) skips reap when another client attached (BQ9tV)', async () => {
      // Race: client A spawned (attached:false), then disconnected.
      // Before A's disconnect-reaper runs, client B POSTs /session
      // for the same workspace and gets attached:true. Without the
      // race guard, A's reaper would tear down B's session.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
      const bridge = createHttpAcpBridge({
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
});
