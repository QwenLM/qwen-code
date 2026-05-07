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
}

class FakeAgent implements Agent {
  newSessionCalls: NewSessionRequest[] = [];
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
  async prompt(_p: PromptRequest): Promise<PromptResponse> {
    return { stopReason: 'end_turn' };
  }
  async cancel(_p: CancelNotification): Promise<void> {}
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
});
