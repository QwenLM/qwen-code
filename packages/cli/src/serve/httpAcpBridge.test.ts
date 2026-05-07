/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
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
});
