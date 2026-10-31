import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RequestError,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  ACP_EVENT_LOOP_STALL_RESTART_MS,
  ACP_PERMISSION_RESPONSE_TIMEOUT_MS,
  ACP_START_TIMEOUT_MS,
  AcpBridge,
  CHANNEL_TOOL_BIND_TIMEOUT_MS,
} from './AcpBridge.js';
import {
  CHANNEL_LOOP_MCP_SERVER_NAME,
  CHANNEL_LOOP_MCP_TOOLS,
  SESSION_MCP_RUNTIME_ADD_METHOD,
  SESSION_MCP_RUNTIME_REMOVE_METHOD,
} from './ChannelLoopTools.js';
import {
  ACP_PRIVATE_PARENT_CAPABILITY_ENV,
  ACP_PRIVATE_PARENT_CAPABILITY_META_KEY,
  CHANNEL_BTW_METHOD,
  CHANNEL_PROMPT_META_KEY,
  CHANNEL_OUTPUT_MODE_META_KEY,
  CHANNEL_TASK_RESULT_META_KEY,
  CHANNEL_TASK_RESULT_PARTIAL_META_KEY,
  CHANNEL_TASK_OUTPUT_META_KEY,
  ChannelPromptCancelledError,
  type ChannelLoopToolHandler,
  type ChannelPromptImage,
  type ChannelToolDefinition,
} from './ChannelAgentBridge.js';

const child = vi.hoisted(() => {
  class MockEmitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    on(eventName: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(eventName) ?? [];
      listeners.push(listener);
      this.listeners.set(eventName, listeners);
      return this;
    }

    emit(eventName: string, ...args: unknown[]): boolean {
      const listeners = this.listeners.get(eventName) ?? [];
      for (const listener of listeners) {
        listener(...args);
      }
      return listeners.length > 0;
    }
  }

  class MockStderr extends MockEmitter {
    write(data: string): void {
      this.emit('data', Buffer.from(data));
    }
  }

  class MockChild extends MockEmitter {
    stdout = {};
    stdin = {};
    stderr = new MockStderr();
    killed = false;
    exitCode: number | null = null;
    kill = vi.fn(() => {
      this.killed = true;
      this.exitCode = null;
      return true;
    });
  }

  let initializeImplementation: () => Promise<void> = () => Promise.resolve();
  return {
    instances: [] as MockChild[],
    clients: [] as Array<{
      requestPermission: (params: unknown) => Promise<unknown>;
    }>,
    connections: [] as Array<{
      initialize: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    }>,
    MockChild,
    initializeImplementation: () => initializeImplementation(),
    resetInitializeImplementation: () => {
      initializeImplementation = () => Promise.resolve();
    },
    setInitializeImplementation: (implementation: () => Promise<void>) => {
      initializeImplementation = implementation;
    },
    spawn: vi.fn(() => {
      const instance = new MockChild();
      child.instances.push(instance);
      return instance;
    }),
  };
});

vi.mock('node:child_process', () => ({
  spawn: child.spawn,
}));

vi.mock('node:stream', () => ({
  Readable: { toWeb: vi.fn(() => ({})) },
  Writable: { toWeb: vi.fn(() => ({})) },
}));

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => ({
  RequestError: (
    await importOriginal<typeof import('@agentclientprotocol/sdk')>()
  ).RequestError,
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn().mockImplementation((createClient) => {
    const client = createClient();
    const connection = {
      initialize: vi.fn(() => child.initializeImplementation()),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    child.clients.push(client);
    child.connections.push(connection);
    return connection;
  }),
}));

type TestableAcpBridge = AcpBridge & {
  child: { killed: boolean; exitCode: number | null };
  connection: {
    extMethod: ReturnType<typeof vi.fn>;
    newSession?: ReturnType<typeof vi.fn>;
    loadSession?: ReturnType<typeof vi.fn>;
    unstable_resumeSession?: ReturnType<typeof vi.fn>;
    setSessionMode?: ReturnType<typeof vi.fn>;
    prompt?: ReturnType<typeof vi.fn>;
  };
  knownSessionIds: Set<string>;
  sessionBindingTokens: Map<string, object | undefined>;
  toolCallKindsBySession: Map<string, Map<string, string>>;
  channelLoopMcpServer: unknown;
  channelLoopToolHandlers: ChannelLoopToolHandler[];
  channelLoopMcpBoundSessions: Set<string>;
  channelLoopMcpBindings: Map<string, Promise<boolean>>;
  handleExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  handleSessionUpdate(params: Record<string, unknown>): void;
  requestPermission(params: Record<string, unknown>): Promise<unknown>;
  handleClientMcpMessage(params: Record<string, unknown>): Promise<unknown>;
  registerChannelLoopMcpServer(sessionId: string): Promise<boolean>;
  resolveChannelLoopToolHandler(sessionId: string): ChannelLoopToolHandler;
};

function requestPermission(sessionId: string, toolCallId: string) {
  return child.clients[0]!.requestPermission({
    sessionId,
    toolCall: {
      toolCallId,
      kind: 'shell',
      title: 'Run command',
    },
    options: [{ optionId: 'cancel', name: 'Deny' }],
  });
}

describe('AcpBridge', () => {
  beforeEach(() => {
    child.instances.length = 0;
    child.clients.length = 0;
    child.connections.length = 0;
    child.spawn.mockClear();
    child.resetInitializeImplementation();
  });

  it('times out bridge initialization and stops the child', async () => {
    vi.useFakeTimers();
    try {
      child.setInitializeImplementation(() => new Promise(() => {}));
      const bridge = new AcpBridge({
        cliEntryPath: '/tmp/qwen',
        cwd: '/tmp',
      });

      const start = bridge.start();
      const rejection = expect(start).rejects.toThrow(
        `ACP initialization timed out after ${ACP_START_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(1000 + ACP_START_TIMEOUT_MS);

      await rejection;
      expect(child.instances[0]!.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs the private-parent capability handshake with the spawned child', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });

    await bridge.start();

    const spawnOptions = child.spawn.mock.calls[0]![2] as {
      env?: Record<string, string | undefined>;
    };
    const capability = spawnOptions.env?.[ACP_PRIVATE_PARENT_CAPABILITY_ENV];
    expect(typeof capability).toBe('string');
    expect(capability!.length).toBeGreaterThan(0);
    const initializeParams = child.connections[0]!.initialize.mock
      .calls[0]![0] as { _meta?: Record<string, unknown> };
    expect(
      initializeParams._meta?.[ACP_PRIVATE_PARENT_CAPABILITY_META_KEY],
    ).toBe(capability);
  });

  it('binds the channel loop MCP server to one session once across concurrent calls', async () => {
    const pending: Array<() => void> = [];
    const extMethod = vi.fn(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.connection = { extMethod };
    bridge.channelLoopMcpServer = {};

    const first = bridge.registerChannelLoopMcpServer('s-1');
    const second = bridge.registerChannelLoopMcpServer('s-1');

    expect(extMethod).toHaveBeenCalledTimes(1);
    expect(extMethod).toHaveBeenCalledWith(
      SESSION_MCP_RUNTIME_ADD_METHOD,
      expect.objectContaining({
        sessionId: 's-1',
        name: CHANNEL_LOOP_MCP_SERVER_NAME,
        config: expect.objectContaining({ type: 'sdk' }),
      }),
    );
    pending.splice(0).forEach((resolve) => resolve());
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(true);
  });

  it('binds each new session through the session-scoped runtime add', async () => {
    const extMethod = vi.fn().mockResolvedValue({});
    const newSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 's-1' })
      .mockResolvedValueOnce({ sessionId: 's-2' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession };
    bridge.channelLoopMcpServer = {};

    await expect(bridge.newSession('/tmp', { sourceId: 'qq' })).resolves.toBe(
      's-1',
    );
    await expect(bridge.newSession('/tmp', { sourceId: 'qq' })).resolves.toBe(
      's-2',
    );

    expect(extMethod.mock.calls).toEqual([
      [
        SESSION_MCP_RUNTIME_ADD_METHOD,
        expect.objectContaining({ sessionId: 's-1' }),
      ],
      [
        SESSION_MCP_RUNTIME_ADD_METHOD,
        expect.objectContaining({ sessionId: 's-2' }),
      ],
    ]);
  });

  it('waits for the pending bind before resolving session creation', async () => {
    const pending: Array<() => void> = [];
    const extMethod = vi.fn(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession };
    bridge.channelLoopMcpServer = {};

    let settled = false;
    const session = bridge.newSession('/tmp').then((sessionId) => {
      settled = true;
      return sessionId;
    });
    await vi.waitFor(() => expect(extMethod).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    pending.splice(0).forEach((resolve) => resolve());
    await expect(session).resolves.toBe('s-1');
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('leaves a session unbound when the runtime add rejects', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const extMethod = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime add failed'));
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession };
    bridge.channelLoopMcpServer = {};
    let output = '';
    try {
      await expect(bridge.newSession('/tmp')).resolves.toBe('s-1');
      output = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }

    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(false);
    expect(output).toContain('runtime add failed');
  });

  it('does not let a stale failed bind erase a newer successful bind', async () => {
    const pending: Array<{
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }> = [];
    let addCalls = 0;
    const extMethod = vi.fn((method: string) => {
      if (method !== SESSION_MCP_RUNTIME_ADD_METHOD) {
        return Promise.resolve({});
      }
      addCalls += 1;
      if (addCalls === 1) {
        return new Promise((resolve, reject) =>
          pending.push({ resolve, reject }),
        );
      }
      return Promise.resolve({});
    });
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession };
    bridge.channelLoopMcpServer = {};

    const firstSession = bridge.newSession('/tmp');
    await vi.waitFor(() => expect(addCalls).toBe(1));

    await bridge.discardSession('s-1');
    await expect(bridge.newSession('/tmp')).resolves.toBe('s-1');
    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(true);

    pending[0]!.reject(new Error('connection closed'));
    await expect(firstSession).resolves.toBe('s-1');

    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(true);
  });

  it('bounds session creation when the runtime add never settles', async () => {
    vi.useFakeTimers();
    try {
      const extMethod = vi.fn((method: string) =>
        method === SESSION_MCP_RUNTIME_ADD_METHOD
          ? new Promise(() => {})
          : Promise.resolve({}),
      );
      const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
      const bridge = new AcpBridge({
        cliEntryPath: '/tmp/qwen',
        cwd: '/tmp',
      }) as unknown as TestableAcpBridge;
      bridge.child = { killed: false, exitCode: null };
      bridge.connection = { extMethod, newSession };
      bridge.channelLoopMcpServer = {};

      const session = bridge.newSession('/tmp');
      await vi.advanceTimersByTimeAsync(CHANNEL_TOOL_BIND_TIMEOUT_MS);

      await expect(session).resolves.toBe('s-1');
      expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a discarded session closed when the runtime remove rejects', async () => {
    const extMethod = vi.fn((method: string) =>
      method === SESSION_MCP_RUNTIME_REMOVE_METHOD
        ? Promise.reject(new Error('remove failed'))
        : Promise.resolve({}),
    );
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession };
    bridge.channelLoopMcpServer = {};

    await bridge.newSession('/tmp');
    await expect(bridge.discardSession('s-1')).resolves.toBeUndefined();
    expect(bridge.knownSessionIds.has('s-1')).toBe(false);
    expect(extMethod).toHaveBeenCalledWith('qwen/control/session/close', {
      sessionId: 's-1',
    });
  });

  it('forwards the carried session id to the MCP server alongside the bound one', async () => {
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.channelLoopMcpServer = { handleMessage };

    await bridge.handleClientMcpMessage({
      server: CHANNEL_LOOP_MCP_SERVER_NAME,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      sessionId: 's-carried',
    });

    expect(handleMessage).toHaveBeenCalledWith(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { sessionId: undefined, carriedSessionId: 's-carried' },
    );
  });

  it('leaves a session unbound when the runtime skips the binding', async () => {
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({ skipped: true, reason: 'budget_warning_only' });
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession };
    bridge.channelLoopMcpServer = {};

    await expect(bridge.newSession('/tmp')).resolves.toBe('s-1');

    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(false);
    expect(bridge.knownSessionIds.has('s-1')).toBe(true);
  });

  it('re-attempts a skipped channel loop binding on the next prompt', async () => {
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({ skipped: true, reason: 'budget_warning_only' })
      .mockResolvedValue({});
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession, prompt };
    bridge.channelLoopMcpServer = {};

    await expect(bridge.newSession('/tmp')).resolves.toBe('s-1');
    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(false);

    await bridge.prompt('s-1', 'question');

    await vi.waitFor(() => expect(extMethod).toHaveBeenCalledTimes(2));
    expect(extMethod).toHaveBeenLastCalledWith(
      SESSION_MCP_RUNTIME_ADD_METHOD,
      expect.objectContaining({ sessionId: 's-1' }),
    );
    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(true);
  });

  it('binds a resumed session through the session-scoped runtime add', async () => {
    const extMethod = vi.fn().mockResolvedValue({});
    const unstable_resumeSession = vi.fn().mockResolvedValue({});
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, unstable_resumeSession };
    bridge.channelLoopMcpServer = {};

    await expect(
      bridge.loadSession('s-resume', '/tmp', { sourceId: 'qq' }),
    ).resolves.toBe('s-resume');

    expect(extMethod).toHaveBeenCalledWith(
      SESSION_MCP_RUNTIME_ADD_METHOD,
      expect.objectContaining({ sessionId: 's-resume' }),
    );
    expect(bridge.channelLoopMcpBoundSessions.has('s-resume')).toBe(true);
  });

  it('unbinds a discarded session through the runtime remove', async () => {
    const extMethod = vi.fn().mockResolvedValue({});
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod, newSession };
    bridge.channelLoopMcpServer = {};

    await bridge.newSession('/tmp');
    await bridge.discardSession('s-1');

    expect(extMethod).toHaveBeenCalledWith(
      SESSION_MCP_RUNTIME_REMOVE_METHOD,
      expect.objectContaining({ sessionId: 's-1' }),
    );
    expect(extMethod).toHaveBeenCalledWith('qwen/control/session/close', {
      sessionId: 's-1',
    });
    expect(bridge.channelLoopMcpBoundSessions.has('s-1')).toBe(false);
  });

  it('sanitizes skipped session binding reasons', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const extMethod = vi.fn().mockResolvedValue({
      skipped: true,
      reason: 'budget\n\u001b[31mforged',
    });
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.connection = { extMethod };
    bridge.channelLoopMcpServer = {};

    let output = '';
    try {
      await bridge.registerChannelLoopMcpServer('s-1');
      output = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }

    expect(output).toContain('budget\\n');
    expect(output).toContain('forged');
    expect(output).not.toContain('budget\n');
    expect(output).not.toContain('\u001b');
  });

  it('returns a synthetic payload ack for MCP notifications', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.channelLoopMcpServer = {
      handleMessage: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      bridge.handleClientMcpMessage({
        server: CHANNEL_LOOP_MCP_SERVER_NAME,
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
        sessionId: 's-1',
      }),
    ).resolves.toStrictEqual({
      payload: { jsonrpc: '2.0', id: 0, result: {} },
    });
  });

  it.each(['_qwencode/start_turn', '_probe/unknown'])(
    'preserves method-not-found for %s',
    async (method) => {
      const bridge = new AcpBridge({
        cliEntryPath: '/tmp/qwen',
        cwd: '/tmp',
      }) as unknown as TestableAcpBridge;
      const error = await bridge
        .handleExtMethod(method, { sessionId: 's-1' })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ code: -32601 });
    },
  );

  it('handles mid-turn queue drain requests from the ACP child', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;

    await expect(
      bridge.handleExtMethod('craft/drainMidTurnQueue', {
        sessionId: 's-1',
      }),
    ).resolves.toStrictEqual({ messages: [], hasQueuedPrompt: false });
  });

  it('claims Guard continuations only for a session owned by this bridge', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      newSession: vi.fn().mockResolvedValue({ sessionId: 's-1' }),
    };

    await expect(bridge.newSession('/tmp')).resolves.toBe('s-1');
    await expect(
      bridge.handleExtMethod('craft/claimTodoStopGuardContinuation', {
        sessionId: 's-1',
        promptId: 'bridge-owner',
      }),
    ).resolves.toStrictEqual({
      claimed: true,
      hasQueuedPrompt: false,
    });
    await expect(
      bridge.handleExtMethod('craft/claimTodoStopGuardContinuation', {
        sessionId: 'other-session',
      }),
    ).resolves.toStrictEqual({
      claimed: false,
      hasQueuedPrompt: false,
    });
  });

  it('forwards BTW through the ACP extension method for an owned session', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const extMethod = vi.fn().mockResolvedValue({
      sessionId: 's-1',
      answer: 'side answer',
    });
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod };
    bridge.knownSessionIds.add('s-1');

    await expect(bridge.btw('s-1', 'what changed?')).resolves.toEqual({
      sessionId: 's-1',
      answer: 'side answer',
    });
    expect(extMethod).toHaveBeenCalledWith(CHANNEL_BTW_METHOD, {
      sessionId: 's-1',
      question: 'what changed?',
    });
  });

  it('rejects BTW for unowned sessions and mismatched responses', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const extMethod = vi.fn().mockResolvedValue({
      sessionId: 'other',
      answer: null,
    });
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod };

    await expect(bridge.btw('s-1', 'question')).rejects.toThrow(
      'Unknown ACP session',
    );
    bridge.knownSessionIds.add('s-1');
    await expect(bridge.btw('s-1', 'question')).rejects.toThrow(
      'Invalid BTW response',
    );
  });

  it('accepts null BTW answers and rejects invalid answer types', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 's-1', answer: null })
      .mockResolvedValueOnce({ sessionId: 's-1', answer: 42 });
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod };
    bridge.knownSessionIds.add('s-1');

    await expect(bridge.btw('s-1', 'question')).resolves.toEqual({
      sessionId: 's-1',
      answer: null,
    });
    await expect(bridge.btw('s-1', 'question')).rejects.toThrow(
      'Invalid BTW response',
    );
  });

  it('stops waiting for an ACP BTW response when aborted', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const extMethod = vi.fn(() => new Promise(() => {}));
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod };
    bridge.knownSessionIds.add('s-1');
    const controller = new AbortController();

    const result = bridge.btw('s-1', 'question', controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a cancelled session claimable but rejects it after discard', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const extMethod = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      cancel,
      extMethod,
      newSession: vi.fn().mockResolvedValue({ sessionId: 's-1' }),
    } as TestableAcpBridge['connection'];

    await bridge.newSession('/tmp');
    await bridge.cancelSession('s-1');
    await expect(
      bridge.handleExtMethod('craft/claimTodoStopGuardContinuation', {
        sessionId: 's-1',
      }),
    ).resolves.toStrictEqual({
      claimed: true,
      hasQueuedPrompt: false,
    });

    await bridge.discardSession('s-1');
    await expect(
      bridge.handleExtMethod('craft/claimTodoStopGuardContinuation', {
        sessionId: 's-1',
      }),
    ).resolves.toStrictEqual({
      claimed: false,
      hasQueuedPrompt: false,
    });
    expect(extMethod).toHaveBeenCalledWith('qwen/control/session/close', {
      sessionId: 's-1',
    });
  });

  it('does not discard a session rebound to a newer route operation', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const extMethod = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod,
      newSession: vi.fn().mockResolvedValue({ sessionId: 'shared-session' }),
    } as TestableAcpBridge['connection'];
    const firstToken = {};
    const secondToken = {};

    await bridge.newSession('/tmp', undefined, firstToken);
    await bridge.newSession('/tmp', undefined, secondToken);
    await bridge.discardSession('shared-session', firstToken);
    expect(bridge.knownSessionIds.has('shared-session')).toBe(true);
    expect(extMethod).not.toHaveBeenCalled();

    await bridge.discardSession('shared-session', secondToken);
    expect(bridge.knownSessionIds.has('shared-session')).toBe(false);
    expect(bridge.sessionBindingTokens.has('shared-session')).toBe(false);
    expect(extMethod).toHaveBeenCalledOnce();
  });

  it('applies approval mode when creating a session', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const newSession = vi.fn().mockResolvedValue({ sessionId: 's-1' });
    const setSessionMode = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      newSession,
      setSessionMode,
    } as TestableAcpBridge['connection'];

    await expect(
      bridge.newSession('/tmp', { approvalMode: 'yolo' }),
    ).resolves.toBe('s-1');

    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: 's-1',
      modeId: 'yolo',
    });
    expect(newSession.mock.invocationCallOrder[0]).toBeLessThan(
      setSessionMode.mock.invocationCallOrder[0]!,
    );
  });

  it('closes a new session when applying its approval mode fails', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const modeError = new Error('mode rejected');
    const extMethod = vi.fn().mockRejectedValue(new Error('close failed'));
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod,
      newSession: vi.fn().mockResolvedValue({ sessionId: 's-1' }),
      setSessionMode: vi.fn().mockRejectedValue(modeError),
    } as TestableAcpBridge['connection'];

    let output = '';
    try {
      await expect(
        bridge.newSession('/tmp', { approvalMode: 'yolo' }),
      ).rejects.toBe(modeError);
      output = stderr.mock.calls.join('');
    } finally {
      stderr.mockRestore();
    }

    expect(extMethod).toHaveBeenCalledWith('qwen/control/session/close', {
      sessionId: 's-1',
    });
    expect(output).toContain(
      '[AcpBridge] Failed to close session s-1 after approval mode error: close failed',
    );
    expect(bridge.knownSessionIds.size).toBe(0);
    expect(bridge.sessionBindingTokens.size).toBe(0);
  });

  it('restores channel sessions through resume without replaying history', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const resumeSession = vi.fn().mockResolvedValue({});
    const setSessionMode = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      unstable_resumeSession: resumeSession,
      setSessionMode,
    } as TestableAcpBridge['connection'];
    const bindingToken = {};

    await expect(
      bridge.loadSession(
        'restored-session',
        '/tmp',
        { approvalMode: 'yolo' },
        bindingToken,
      ),
    ).resolves.toBe('restored-session');

    expect(resumeSession).toHaveBeenCalledWith({
      sessionId: 'restored-session',
      cwd: '/tmp',
      mcpServers: [],
    });
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: 'restored-session',
      modeId: 'yolo',
    });
    expect(bridge.knownSessionIds.has('restored-session')).toBe(true);
    expect(bridge.sessionBindingTokens.get('restored-session')).toBe(
      bindingToken,
    );
  });

  it('closes a restored session when applying its approval mode fails', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const modeError = new Error('mode rejected');
    const extMethod = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod,
      unstable_resumeSession: vi.fn().mockResolvedValue({}),
      setSessionMode: vi.fn().mockRejectedValue(modeError),
    } as TestableAcpBridge['connection'];

    await expect(
      bridge.loadSession('restored-session', '/tmp', {
        approvalMode: 'yolo',
      }),
    ).rejects.toBe(modeError);

    expect(extMethod).toHaveBeenCalledWith('qwen/control/session/close', {
      sessionId: 'restored-session',
    });
    expect(bridge.knownSessionIds.size).toBe(0);
    expect(bridge.sessionBindingTokens.size).toBe(0);
  });

  it('inherits the agent approval mode when no channel override is set', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const setSessionMode = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
      unstable_resumeSession: vi.fn().mockResolvedValue({}),
      setSessionMode,
    } as TestableAcpBridge['connection'];

    await bridge.newSession('/tmp');
    await bridge.loadSession('restored-session', '/tmp');

    expect(setSessionMode).not.toHaveBeenCalled();
  });

  it('returns only the final turn text after tool calls', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'Let me search. ');
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            kind: 'search',
            title: 'Search',
            status: 'pending',
          },
        });
        bridge.emit('textChunk', 's-1', 'Now I will read. ');
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-2',
            kind: 'read',
            title: 'Read',
            status: 'pending',
          },
        });
        bridge.emit('textChunk', 's-1', 'Final answer.');
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Final answer.',
    );
    expect(bridge.connection.prompt).toHaveBeenCalledWith({
      sessionId: 's-1',
      prompt: [{ type: 'text', text: 'question' }],
      _meta: { [CHANNEL_PROMPT_META_KEY]: true },
    });
  });

  it.each([undefined, 'per_task'] as const)(
    'consumes a task result only for %s',
    async (outputMode) => {
      const bridge = new AcpBridge({
        cliEntryPath: '/tmp/qwen',
        cwd: '/tmp',
      }) as unknown as TestableAcpBridge;
      const backgroundResponse = vi.fn();
      bridge.on('backgroundResponse', backgroundResponse);
      bridge.child = { killed: false, exitCode: null };
      const prompt = vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'Main result');
        for (const claimed of [true, false]) {
          bridge.handleSessionUpdate({
            sessionId: 's-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: claimed ? 'Task result' : 'Unrelated result',
              },
              _meta: {
                qwenDiscreteMessage: true,
                source: 'background_notification_response',
                [CHANNEL_TASK_OUTPUT_META_KEY]: claimed,
                backgroundTask: {
                  taskId: 'task-1',
                  kind: 'agent',
                  status: 'completed',
                  turnComplete: true,
                },
              },
            },
          });
        }
        return { _meta: { [CHANNEL_TASK_RESULT_META_KEY]: 'Task result' } };
      });
      bridge.connection = { extMethod: vi.fn(), prompt };
      await expect(
        bridge.prompt('s-1', 'question', { outputMode }),
      ).resolves.toBe(outputMode ? 'Task result' : 'Main result');
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          _meta: {
            [CHANNEL_PROMPT_META_KEY]: true,
            ...(outputMode
              ? { [CHANNEL_OUTPUT_MODE_META_KEY]: outputMode }
              : {}),
          },
        }),
      );
      expect(backgroundResponse).toHaveBeenCalledOnce();
      expect(backgroundResponse).toHaveBeenCalledWith(
        's-1',
        'Unrelated result',
        expect.any(Object),
      );
    },
  );

  it.each([false, true])(
    'reports task result partiality %s',
    async (partial) => {
      const bridge = new AcpBridge({
        cliEntryPath: '/tmp/qwen',
        cwd: '/tmp',
      }) as unknown as TestableAcpBridge;
      bridge.child = { killed: false, exitCode: null };
      bridge.connection = {
        extMethod: vi.fn(),
        prompt: vi.fn().mockResolvedValue({
          stopReason: 'end_turn',
          _meta: {
            [CHANNEL_TASK_RESULT_META_KEY]: 'Retained result',
            [CHANNEL_TASK_RESULT_PARTIAL_META_KEY]: partial,
          },
        }),
      };
      const onTaskResult = vi.fn();
      await expect(
        bridge.prompt('s-1', 'question', {
          outputMode: 'per_task',
          onTaskResult,
        }),
      ).resolves.toBe('Retained result');
      expect(onTaskResult).toHaveBeenCalledExactlyOnceWith({ partial });
      onTaskResult.mockClear();
      await bridge.prompt('s-1', 'question', { onTaskResult });
      expect(onTaskResult).not.toHaveBeenCalled();
    },
  );

  it('does not return retained main text when a task is cancelled remotely', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'Stale main result');
        return { stopReason: 'cancelled' };
      }),
    };
    await expect(
      bridge.prompt('s-1', 'question', { outputMode: 'per_task' }),
    ).rejects.toBeInstanceOf(ChannelPromptCancelledError);
  });

  it('preserves streamed text on remote cancellation in the default mode', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'Partial main result');
        return { stopReason: 'cancelled' };
      }),
    };
    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Partial main result',
    );
  });

  it('forwards the user-facing prompt projection to the daemon', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const prompt = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod: vi.fn(), prompt };

    await bridge.prompt('s-1', 'hidden context\n\nhello', {
      displayText: 'hello',
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 's-1',
      prompt: [{ type: 'text', text: 'hidden context\n\nhello' }],
      _meta: {
        [CHANNEL_PROMPT_META_KEY]: true,
        'qwen.daemon.promptDisplayText': 'hello',
      },
    });
  });

  it('sends multiple images before the text prompt', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const prompt = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod: vi.fn(), prompt };

    await bridge.prompt('s-1', 'describe both', {
      images: [
        { data: 'first', mimeType: 'image/png' },
        { data: 'second', mimeType: 'image/jpeg' },
      ],
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 's-1',
      prompt: [
        { type: 'image', data: 'first', mimeType: 'image/png' },
        { type: 'image', data: 'second', mimeType: 'image/jpeg' },
        { type: 'text', text: 'describe both' },
      ],
      _meta: { [CHANNEL_PROMPT_META_KEY]: true },
    });
  });

  it('sends a legacy-only image pair as one inline image block', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const prompt = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod: vi.fn(), prompt };

    await bridge.prompt('s-1', 'describe', {
      imageBase64: 'base64-image',
      imageMimeType: 'image/png',
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 's-1',
      prompt: [
        { type: 'image', data: 'base64-image', mimeType: 'image/png' },
        { type: 'text', text: 'describe' },
      ],
      _meta: { [CHANNEL_PROMPT_META_KEY]: true },
    });
  });

  it('drops malformed prompt image entries before the text prompt', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const prompt = vi.fn().mockResolvedValue({});
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = { extMethod: vi.fn(), prompt };

    await bridge.prompt('s-1', 'describe', {
      images: [
        { data: 'AQID', mimeType: 'image/png' },
        { data: '', mimeType: 'image/webp' },
        { data: 'BAUG', mimeType: '' },
        null as unknown as ChannelPromptImage,
      ],
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 's-1',
      prompt: [
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
        { type: 'text', text: 'describe' },
      ],
      _meta: { [CHANNEL_PROMPT_META_KEY]: true },
    });
  });

  it('excludes nested subagent text from the final response', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Nested research report.' },
            _meta: {
              parentToolCallId: 'agent-call-1',
              subagentType: 'Explore',
            },
          },
        });
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer.' },
          },
        });
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Final answer.',
    );
  });

  it('excludes discrete background notifications from the final response', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer.' },
          },
        });
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Background agent "Explore" completed.',
            },
            _meta: {
              source: 'background_notification',
              qwenDiscreteMessage: true,
            },
          },
        });
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Final answer.',
    );
  });

  it('emits discrete vision bridge notices as text chunks', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const textChunks: Array<[string, string]> = [];
    bridge.on('textChunk', (sessionId, text) => {
      textChunks.push([sessionId, text]);
    });

    bridge.handleSessionUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Vision bridge cancelled.' },
        _meta: {
          source: 'vision_bridge_notice',
          qwenDiscreteMessage: true,
        },
      },
    });

    expect(textChunks).toEqual([['s-1', 'Vision bridge cancelled.']]);
  });

  it('emits a completed background response separately from the active turn', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const backgroundResponses: unknown[][] = [];
    bridge.on('backgroundResponse', (sessionId, text, context) => {
      backgroundResponses.push([sessionId, text, context]);
    });
    const textChunks: Array<[string, string]> = [];
    bridge.on('textChunk', (sessionId, text) => {
      textChunks.push([sessionId, text]);
    });

    bridge.handleSessionUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Background final answer.' },
        _meta: {
          source: 'background_notification_response',
          qwenDiscreteMessage: true,
          backgroundTask: {
            taskId: 'agent-1',
            status: 'completed',
            kind: 'agent',
            label: 'dependency check',
            turnId: 'notification-turn-1',
            turnComplete: false,
          },
        },
      },
    });
    bridge.handleSessionUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          source: 'background_notification_response',
          qwenDiscreteMessage: true,
          backgroundTask: {
            taskId: 'agent-1',
            status: 'completed',
            kind: 'agent',
            label: 'dependency check',
            turnComplete: true,
            partial: true,
          },
        },
      },
    });
    for (const backgroundTask of [
      undefined,
      { taskId: '', status: 'completed', kind: 'agent' },
    ]) {
      bridge.handleSessionUpdate({
        sessionId: 's-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Legacy background answer.' },
          _meta: {
            source: 'background_notification_response',
            qwenDiscreteMessage: true,
            ...(backgroundTask ? { backgroundTask } : {}),
          },
        },
      });
    }

    expect(backgroundResponses).toEqual([
      [
        's-1',
        'Background final answer.',
        {
          taskId: 'agent-1',
          status: 'completed',
          kind: 'agent',
          label: 'dependency check',
          turnId: 'notification-turn-1',
          turnComplete: false,
        },
      ],
      [
        's-1',
        '',
        {
          taskId: 'agent-1',
          status: 'completed',
          kind: 'agent',
          label: 'dependency check',
          turnComplete: true,
          partial: true,
        },
      ],
      ['s-1', 'Legacy background answer.', undefined],
      ['s-1', 'Legacy background answer.', undefined],
    ]);
    expect(textChunks).toEqual([]);
  });

  it('ignores a rewritten background response to avoid duplicate delivery', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const backgroundResponses: Array<[string, string]> = [];
    bridge.on('backgroundResponse', (sessionId, text) => {
      backgroundResponses.push([sessionId, text]);
    });

    bridge.handleSessionUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Background final answer.' },
        _meta: {
          source: 'background_notification_response',
          qwenDiscreteMessage: true,
          rewritten: true,
        },
      },
    });

    expect(backgroundResponses).toEqual([]);
  });

  it('returns only the final slash-command output', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Compressing context...' },
            _meta: { source: 'slash_command' },
          },
        });
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Context compressed.' },
            _meta: { source: 'slash_command' },
          },
        });
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Context compressed.',
    );
  });

  it('prefers model text over slash-command output', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Slash output' },
            _meta: { source: 'slash_command' },
          },
        });
        bridge.emit('textChunk', 's-1', 'Model text');
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe('Model text');
  });

  it('clears slash-command output at response boundaries', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Stale slash output' },
            _meta: { source: 'slash_command' },
          },
        });
        bridge.emit('responseBoundary', 's-1');
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe('');
  });

  it('returns only the final turn text after auto-approved tool calls', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'Let me inspect. ');
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            kind: 'read',
            title: 'Read',
            status: 'in_progress',
          },
        });
        bridge.emit('textChunk', 's-1', 'Final answer.');
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Final answer.',
    );
  });

  it('forwards standard initial ACP tool kinds unchanged', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const toolCall = vi.fn();
    bridge.on('toolCall', toolCall);

    const kinds = [
      'read',
      'edit',
      'delete',
      'move',
      'search',
      'execute',
      'think',
      'fetch',
      'switch_mode',
      'other',
    ];
    for (const kind of kinds) {
      bridge.handleSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: `tool-${kind}`,
          kind,
          title: kind,
          status: 'in_progress',
        },
      });
    }

    expect(toolCall.mock.calls.map(([event]) => event.kind)).toEqual(kinds);
  });

  it('forwards a refined tool update without creating another response boundary', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const toolCall = vi.fn();
    const responseBoundary = vi.fn();
    bridge.on('toolCall', toolCall);
    bridge.on('responseBoundary', responseBoundary);

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-web-fetch',
        kind: 'other',
        title: 'web_fetch',
        status: 'pending',
      },
    });
    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-web-fetch',
        kind: 'fetch',
        title: 'WebFetch: weather',
        status: 'in_progress',
      },
    });

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-web-fetch',
        title: 'WebFetch: weather',
        status: 'in_progress',
      },
    });

    // The refined kind is retained for later kindless frames, not just the
    // refining one.
    expect(toolCall.mock.calls.map(([event]) => event.kind)).toEqual([
      'other',
      'fetch',
      'fetch',
    ]);
    expect(responseBoundary).toHaveBeenCalledOnce();
  });

  it('does not reset known tools or create orphan lifecycle cards', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const toolCall = vi.fn();
    bridge.on('toolCall', toolCall);
    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'known',
        kind: 'execute',
        status: 'in_progress',
      },
    });
    toolCall.mockClear();
    for (const toolCallId of ['known', 'orphan'])
      bridge.handleSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          _meta: { toolLifecycle: { v: 1, phase: 'ended' } },
        },
      });
    expect(toolCall).not.toHaveBeenCalled();
    expect(bridge.toolCallKindsBySession.get('session-1')?.get('known')).toBe(
      'execute',
    );
  });

  it('restores the initial kind on a kindless terminal tool update', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const toolCall = vi.fn();
    const responseBoundary = vi.fn();
    bridge.on('toolCall', toolCall);
    bridge.on('responseBoundary', responseBoundary);

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-shell',
        kind: 'execute',
        title: 'Run shell: echo $SECRET',
        status: 'in_progress',
        rawInput: { command: 'echo $SECRET' },
      },
    });
    toolCall.mockClear();
    responseBoundary.mockClear();

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-shell',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'secret' } },
        ],
        rawOutput: 'secret',
      },
    });

    expect(toolCall).toHaveBeenCalledOnce();
    expect(toolCall).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolCallId: 'tool-shell',
      kind: 'execute',
      title: '',
      status: 'completed',
      rawInput: undefined,
    });
    expect(responseBoundary).not.toHaveBeenCalled();
    expect(bridge.toolCallKindsBySession.has('session-1')).toBe(false);
  });

  it('does not retain kinds from terminal initial tool calls', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-search',
        kind: 'search',
        title: 'Search',
        status: 'completed',
      },
    });

    expect(bridge.toolCallKindsBySession.has('session-1')).toBe(false);
  });

  it('ignores meta-only shell progress heartbeats', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const toolCall = vi.fn();
    const responseBoundary = vi.fn();
    bridge.on('toolCall', toolCall);
    bridge.on('responseBoundary', responseBoundary);

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-shell',
        kind: 'execute',
        title: 'Run shell',
        status: 'in_progress',
      },
    });
    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-shell',
        status: 'in_progress',
        _meta: {
          toolName: 'run_shell_command',
          shellProgress: { type: 'shell_progress', elapsedMs: 1_000 },
        },
      },
    });

    expect(toolCall).toHaveBeenCalledOnce();
    expect(toolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'execute', title: 'Run shell' }),
    );
    expect(responseBoundary).toHaveBeenCalledOnce();
  });

  it('ignores meta-only subagent progress heartbeats', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const toolCall = vi.fn();
    const responseBoundary = vi.fn();
    bridge.on('toolCall', toolCall);
    bridge.on('responseBoundary', responseBoundary);

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-agent',
        kind: 'other',
        title: 'Agent: explore',
        status: 'in_progress',
      },
    });
    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-agent',
        status: 'in_progress',
        _meta: {
          subagentType: 'Explore',
          provenance: 'subagent',
          subagentProgress: true,
        },
      },
    });

    expect(toolCall).toHaveBeenCalledOnce();
    expect(toolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'other', title: 'Agent: explore' }),
    );
    expect(responseBoundary).toHaveBeenCalledOnce();
  });

  it('forwards kindful terminal updates that carry shell progress metadata', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    const toolCall = vi.fn();
    bridge.on('toolCall', toolCall);

    bridge.handleSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-shell',
        kind: 'execute',
        status: 'completed',
        _meta: {
          shellProgress: { type: 'shell_progress', elapsedMs: 1_000 },
        },
      },
    });

    expect(toolCall).toHaveBeenCalledOnce();
    expect(toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'execute', status: 'completed' }),
    );
  });

  it('preserves text when tool calls are not pending', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'Before. ');
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            kind: 'search',
            title: 'Search',
            status: 'completed',
          },
        });
        bridge.emit('textChunk', 's-1', 'After.');
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Before. After.',
    );
  });

  it('treats plan updates as turn boundaries for TodoWrite-only rounds', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'Updating todos. ');
        bridge.handleSessionUpdate({
          sessionId: 's-1',
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'Task', status: 'pending' }],
          },
        });
        bridge.emit('textChunk', 's-1', 'Done.');
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe('Done.');
  });

  it('treats permission requests as turn boundaries', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.child = { killed: false, exitCode: null };
    bridge.on('permissionRequest', (event) => {
      void bridge.respondToPermission(event.requestId, {
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      });
    });
    bridge.connection = {
      extMethod: vi.fn(),
      prompt: vi.fn(async () => {
        bridge.emit('textChunk', 's-1', 'I need permission. ');
        await bridge.requestPermission({
          sessionId: 's-1',
          toolCall: {
            toolCallId: 'tool-1',
            kind: 'shell',
            title: 'Run command',
          },
          options: [{ optionId: 'proceed_once', name: 'Allow' }],
        });
        bridge.emit('textChunk', 's-1', 'Final answer.');
      }),
    };

    await expect(bridge.prompt('s-1', 'question')).resolves.toBe(
      'Final answer.',
    );
  });

  it('rejects channel loop tool calls when no handler matches the session', () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.channelLoopToolHandlers = [
      {
        canHandle: () => false,
        create: vi.fn(),
        list: vi.fn(),
        cancel: vi.fn(),
      },
    ];

    expect(() => bridge.resolveChannelLoopToolHandler('s-2')).toThrow(
      'No channel loop handler matched session s-2.',
    );
  });

  it('uses the only channel loop tool handler when canHandle is omitted', () => {
    const handler: ChannelLoopToolHandler = {
      create: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
    };
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.channelLoopToolHandlers = [handler];

    expect(bridge.resolveChannelLoopToolHandler('s-1')).toBe(handler);
  });

  it('kills the ACP child when it reports a large event loop stall', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });
    const disconnected = vi.fn();
    bridge.on('disconnected', disconnected);

    await bridge.start();
    const proc = child.instances[0]!;
    proc.kill.mockImplementation(() => {
      proc.killed = true;
      proc.emit('exit', null, 'SIGKILL');
      return true;
    });

    proc.stderr.write(
      `[perf] acp agent event loop stall: max=${ACP_EVENT_LOOP_STALL_RESTART_MS + 1000}ms\n`,
    );

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(bridge.isConnected).toBe(false);
    expect(disconnected).toHaveBeenCalledWith(null, 'SIGKILL');
  });

  it('kills the ACP child when a stall line is coalesced with prior stderr', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });

    await bridge.start();
    const proc = child.instances[0]!;

    proc.stderr.write(
      `debug line\n[perf] acp agent event loop stall: max=${ACP_EVENT_LOOP_STALL_RESTART_MS + 1000}ms\n`,
    );

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not kill the ACP child for a small event loop stall warning', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });

    await bridge.start();
    const proc = child.instances[0]!;

    proc.stderr.write(
      `[perf] acp agent event loop stall: max=${ACP_EVENT_LOOP_STALL_RESTART_MS - 1000}ms\n`,
    );

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('ignores non-perf stderr that mentions an event loop stall', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });

    await bridge.start();
    const proc = child.instances[0]!;

    proc.stderr.write(
      `debug: acp agent event loop stall: max=${ACP_EVENT_LOOP_STALL_RESTART_MS + 1000}ms\n`,
    );

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('does not kill the ACP child again after it is already killed', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });

    await bridge.start();
    const proc = child.instances[0]!;
    proc.killed = true;

    proc.stderr.write(
      `[perf] acp agent event loop stall: max=${ACP_EVENT_LOOP_STALL_RESTART_MS + 1000}ms\n`,
    );

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('relays ACP permission requests instead of auto-approving them', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });
    const permissionRequest = vi.fn();
    const permissionResolved = vi.fn();
    bridge.on('permissionRequest', permissionRequest);
    bridge.on('permissionResolved', permissionResolved);

    await bridge.start();
    const request = {
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'shell',
        title: 'Run command',
      },
      options: [
        { optionId: 'proceed_once', name: 'Allow' },
        { optionId: 'cancel', name: 'Deny' },
      ],
    };

    const pending = child.clients[0]!.requestPermission(request);
    await Promise.resolve();

    expect(permissionRequest).toHaveBeenCalledTimes(1);
    const event = permissionRequest.mock.calls[0]![0];
    expect(event).toMatchObject({
      sessionId: 'session-1',
      request,
    });
    expect(event.requestId).toMatch(/^acp-permission-/);

    const response = { outcome: { outcome: 'selected', optionId: 'cancel' } };
    await expect(
      (
        bridge as unknown as TestableAcpBridge & {
          respondToPermission(
            requestId: string,
            response: typeof response,
          ): Promise<boolean>;
        }
      ).respondToPermission(event.requestId, response),
    ).resolves.toBe(true);
    await expect(pending).resolves.toEqual(response);
    expect(permissionResolved).toHaveBeenCalledWith({
      requestId: event.requestId,
      outcome: response.outcome,
    });
    await expect(
      (
        bridge as unknown as TestableAcpBridge & {
          respondToPermission(
            requestId: string,
            response: typeof response,
          ): Promise<boolean>;
        }
      ).respondToPermission(event.requestId, response),
    ).resolves.toBe(false);
  });

  it('allows permission request listeners to respond synchronously', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });
    const response: RequestPermissionResponse = {
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    };
    bridge.on('permissionRequest', (event) => {
      void bridge.respondToPermission(event.requestId, response);
    });

    await bridge.start();
    const pending = child.clients[0]!.requestPermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'shell',
        title: 'Run command',
      },
      options: [{ optionId: 'proceed_once', name: 'Allow' }],
    });

    await expect(pending).resolves.toEqual(response);
  });

  it('falls back to the tool call id for permission requests without a session id', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });
    const permissionRequest = vi.fn();
    bridge.on('permissionRequest', permissionRequest);

    await bridge.start();
    const pending = child.clients[0]!.requestPermission({
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'shell',
        title: 'Run command',
      },
      options: [{ optionId: 'cancel', name: 'Deny' }],
    });
    await Promise.resolve();

    const event = permissionRequest.mock.calls[0]![0];
    expect(event.sessionId).toBe('tool-1');
    await bridge.respondToPermission(event.requestId, {
      outcome: { outcome: 'cancelled' },
    });
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('resolves matching pending permissions as cancelled when a session is cancelled', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });
    const permissionRequest = vi.fn();
    const permissionResolved = vi.fn();
    bridge.on('permissionRequest', permissionRequest);
    bridge.on('permissionResolved', permissionResolved);

    await bridge.start();
    const first = requestPermission('session-1', 'tool-1');
    const second = requestPermission('session-2', 'tool-2');
    await Promise.resolve();

    const firstEvent = permissionRequest.mock.calls[0]![0];
    const secondEvent = permissionRequest.mock.calls[1]![0];
    await bridge.cancelSession('session-1');

    expect(child.connections[0]!.cancel).toHaveBeenCalledWith({
      sessionId: 'session-1',
    });
    await expect(first).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(permissionResolved).toHaveBeenCalledWith({
      requestId: firstEvent.requestId,
      outcome: { outcome: 'cancelled' },
    });
    expect(permissionResolved).not.toHaveBeenCalledWith({
      requestId: secondEvent.requestId,
      outcome: { outcome: 'cancelled' },
    });

    const response: RequestPermissionResponse = {
      outcome: { outcome: 'selected', optionId: 'cancel' },
    };
    await expect(
      bridge.respondToPermission(secondEvent.requestId, response),
    ).resolves.toBe(true);
    await expect(second).resolves.toEqual(response);
  });

  it('resolves pending permissions as cancelled after the response timeout', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });
    const permissionRequest = vi.fn();
    const permissionResolved = vi.fn();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    bridge.on('permissionRequest', permissionRequest);
    bridge.on('permissionResolved', permissionResolved);

    await bridge.start();

    vi.useFakeTimers();
    try {
      const pending = child.clients[0]!.requestPermission({
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'shell',
          title: 'Run command',
        },
        options: [{ optionId: 'cancel', name: 'Deny' }],
      });
      await Promise.resolve();
      const event = permissionRequest.mock.calls[0]![0];

      await vi.advanceTimersByTimeAsync(ACP_PERMISSION_RESPONSE_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'cancelled' },
      });
      expect(permissionResolved).toHaveBeenCalledWith({
        requestId: event.requestId,
        outcome: { outcome: 'cancelled' },
      });
      expect(stderr.mock.calls.join('')).toContain(
        `[AcpBridge] permission request ${event.requestId} timed out after ${ACP_PERMISSION_RESPONSE_TIMEOUT_MS}ms (session=session-1)`,
      );
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('resolves pending permissions as cancelled when the ACP child exits', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });
    const permissionRequest = vi.fn();
    const permissionResolved = vi.fn();
    bridge.on('permissionRequest', permissionRequest);
    bridge.on('permissionResolved', permissionResolved);

    await bridge.start();
    const pending = child.clients[0]!.requestPermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'shell',
        title: 'Run command',
      },
      options: [{ optionId: 'cancel', name: 'Deny' }],
    });
    await Promise.resolve();
    const event = permissionRequest.mock.calls[0]![0];

    child.instances[0]!.emit('exit', 1, null);

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(permissionResolved).toHaveBeenCalledWith({
      requestId: event.requestId,
      outcome: { outcome: 'cancelled' },
    });
  });

  it('resolves pending permissions as cancelled on stop', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;

    await bridge.start();
    bridge.knownSessionIds.add('session-1');
    bridge.sessionBindingTokens.set('session-1', {});
    const pending = child.clients[0]!.requestPermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'shell',
        title: 'Run command',
      },
      options: [{ optionId: 'cancel', name: 'Deny' }],
    });
    await Promise.resolve();

    bridge.stop();

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(bridge.knownSessionIds.size).toBe(0);
    expect(bridge.sessionBindingTokens.size).toBe(0);
  });
});

describe('AcpBridge channel tool diagnostics', () => {
  const DIAG_ENV = 'QWEN_CHANNEL_TOOL_DIAG';

  type DiagnosticsBridge = {
    channelLoopMcpBoundSessions: Set<string>;
    knownSessionIds: Set<string>;
    sessionOwners: Map<string, string>;
    channelLoopMcpServer: unknown;
    handleClientMcpMessage(
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };

  function diagBridge(handleMessage: ReturnType<typeof vi.fn>) {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as DiagnosticsBridge;
    bridge.channelLoopMcpServer = { handleMessage };
    bridge.knownSessionIds.add('s-known');
    bridge.sessionOwners.set('s-known', 'qqbot-main');
    return bridge;
  }

  function frame(
    bridge: DiagnosticsBridge,
    payload: Record<string, unknown>,
    sessionId?: string,
  ) {
    return bridge.handleClientMcpMessage({
      server: CHANNEL_LOOP_MCP_SERVER_NAME,
      payload,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  async function capture(run: () => Promise<void>): Promise<string> {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const previous = process.env[DIAG_ENV];
    process.env[DIAG_ENV] = '1';
    try {
      await run();
      return stderr.mock.calls.map((call) => String(call[0])).join('');
    } finally {
      stderr.mockRestore();
      if (previous === undefined) delete process.env[DIAG_ENV];
      else process.env[DIAG_ENV] = previous;
    }
  }

  it('writes nothing while the switch is off', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const previous = process.env[DIAG_ENV];
    delete process.env[DIAG_ENV];
    try {
      const bridge = diagBridge(
        vi.fn().mockResolvedValue({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [] },
        }),
      );
      await frame(
        bridge,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        's-known',
      );
      expect(stderr.mock.calls.join('')).not.toContain('channel-tool-diag');
    } finally {
      stderr.mockRestore();
      if (previous !== undefined) process.env[DIAG_ENV] = previous;
    }
  });

  it('skips methods it does not explain', async () => {
    const bridge = diagBridge(vi.fn().mockResolvedValue(undefined));
    const output = await capture(async () => {
      await frame(
        bridge,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        's-known',
      );
    });
    expect(output).not.toContain('channel-tool-diag');
  });

  it('prints the listed tool count for a bound session and its owner', async () => {
    const bridge = diagBridge(
      vi.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'a' }, { name: 'b' }] },
      }),
    );
    bridge.channelLoopMcpBoundSessions.add('s-known');
    const output = await capture(async () => {
      await frame(
        bridge,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        's-known',
      );
    });
    expect(output).toContain('method=tools/list');
    expect(output).toContain('tools=2');
    expect(output).toContain('bound=true');
    expect(output).toContain('known=true');
    expect(output).toContain('owner=qqbot-main');
  });

  it('prints the tool name and result error state for a tools/call', async () => {
    const bridge = diagBridge(
      vi.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: 'bad' }] },
      }),
    );
    bridge.channelLoopMcpBoundSessions.add('s-known');
    const output = await capture(async () => {
      await frame(
        bridge,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'qq_recall_message', arguments: {} },
        },
        's-known',
      );
    });
    expect(output).toContain('tool=qq_recall_message');
    expect(output).toContain('isError=true');
    expect(output).toContain('rpcError=none');
  });

  it('prints the JSON-RPC error arm of a failed tools/call', async () => {
    const bridge = diagBridge(
      vi.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'cron must be a non-empty string.' },
      }),
    );
    bridge.channelLoopMcpBoundSessions.add('s-known');
    const output = await capture(async () => {
      await frame(
        bridge,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'channel_loop_create', arguments: {} },
        },
        's-known',
      );
    });
    expect(output).toContain('tool=channel_loop_create');
    expect(output).toContain('isError=true');
    expect(output).toContain('rpcError=');
    expect(output).toContain('cron must be a non-empty string.');
  });

  it('resolves an owner for a known-but-unbound session from the carried id', async () => {
    const bridge = diagBridge(
      vi.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [] },
      }),
    );
    const output = await capture(async () => {
      await frame(
        bridge,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        's-known',
      );
    });
    expect(output).toContain('bound=false');
    expect(output).toContain('known=true');
    expect(output).toContain('owner=qqbot-main');
  });

  it('does not grant an owner to an id in neither ledger', async () => {
    const bridge = diagBridge(
      vi.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [] },
      }),
    );
    bridge.sessionOwners.set('s-unknown', 'qqbot-main');
    const output = await capture(async () => {
      await frame(
        bridge,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        's-unknown',
      );
    });
    expect(output).toContain('known=false');
    expect(output).toContain('owner=<none>');
  });

  it('sanitizes and caps an attacker-influenced tool name', async () => {
    const bridge = diagBridge(
      vi.fn().mockResolvedValue({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: false },
      }),
    );
    bridge.channelLoopMcpBoundSessions.add('s-known');
    const output = await capture(async () => {
      await frame(
        bridge,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: `\u001b[31m${'x'.repeat(200)}`,
            arguments: {},
          },
        },
        's-known',
      );
    });
    expect(output).not.toContain('\u001b');
    expect(output.length).toBeLessThan(600);
  });
});

// One bridge can serve several channels, and each channel registers the same
// tool names, so registration must scope tools by owner instead of dropping
// the second channel's copy. A session sees channel tools only after this
// bridge bound the channel_loop server to it.
describe('AcpBridge adapter channel tools', () => {
  type Internals = {
    registerChannelTool(tool: ChannelToolDefinition): void;
    sessionOwners: Map<string, string>;
    channelLoopMcpBoundSessions: Set<string>;
    knownSessionIds: Set<string>;
    child: { killed: boolean; exitCode: number | null } | null;
    connection: {
      extMethod: ReturnType<typeof vi.fn>;
      newSession: ReturnType<typeof vi.fn>;
    } | null;
    newSession(cwd: string, options?: { sourceId?: string }): Promise<string>;
    registerChannelLoopToolHandler(handler: ChannelLoopToolHandler): void;
    handleClientMcpMessage(
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };

  function internals(bridge: AcpBridge): Internals {
    return bridge as unknown as Internals;
  }

  let calls: string[] = [];

  function tool(name: string, owner: string | undefined, marker: string) {
    return {
      name,
      description: marker,
      inputSchema: { type: 'object', properties: {} },
      ...(owner === undefined ? {} : { owner }),
      handler: async () => {
        calls.push(marker);
        return marker;
      },
    };
  }

  /** Register tools, then bind sessions through the real session-scoped add. */
  async function bridged(
    tools: ChannelToolDefinition[],
    sessions: Array<{ sessionId: string; sourceId?: string }>,
  ): Promise<Internals> {
    const bridge = internals(
      new AcpBridge({ cliEntryPath: '/tmp/qwen', cwd: '/tmp' }),
    );
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn().mockResolvedValue({}),
      newSession: vi.fn(),
    };
    for (const entry of tools) bridge.registerChannelTool(entry);
    for (const session of sessions) {
      bridge.connection.newSession.mockResolvedValueOnce({
        sessionId: session.sessionId,
      });
      await bridge.newSession(
        '/tmp',
        session.sourceId === undefined
          ? undefined
          : { sourceId: session.sourceId },
      );
    }
    return bridge;
  }

  const frame = (
    bridge: Internals,
    payload: Record<string, unknown>,
    sessionId?: string,
  ) =>
    bridge.handleClientMcpMessage({
      server: CHANNEL_LOOP_MCP_SERVER_NAME,
      payload,
      ...(sessionId === undefined ? {} : { sessionId }),
    });

  const listTools = async (bridge: Internals, sessionId?: string) => {
    const response = (await frame(
      bridge,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      sessionId,
    )) as { payload: { result: { tools: Array<{ description: string }> } } };
    return response.payload.result.tools.map((entry) => entry.description);
  };

  const callTool = async (
    bridge: Internals,
    name: string,
    sessionId?: string,
  ) => {
    const response = (await frame(
      bridge,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: {} },
      },
      sessionId,
    )) as {
      payload: {
        result?: { content?: Array<{ text: string }>; isError?: boolean };
        error?: { message: string };
      };
    };
    return response.payload;
  };

  it('resolves a bound session to its own channel tool and handler', async () => {
    calls = [];
    const bridge = await bridged(
      [
        tool('shared_tool', 'bot-a', 'owned-a'),
        tool('shared_tool', 'bot-b', 'owned-b'),
        tool('shared_tool', undefined, 'global'),
      ],
      [
        { sessionId: 's-a', sourceId: 'bot-a' },
        { sessionId: 's-b', sourceId: 'bot-b' },
      ],
    );

    // Each channel's session sees its own copy; the ownerless twin is shadowed.
    expect(await listTools(bridge, 's-a')).toEqual(['owned-a']);
    expect(await listTools(bridge, 's-b')).toEqual(['owned-b']);

    expect(await callTool(bridge, 'shared_tool', 's-a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'owned-a' }] },
    });
    expect(await callTool(bridge, 'shared_tool', 's-b')).toMatchObject({
      result: { content: [{ type: 'text', text: 'owned-b' }] },
    });
    expect(calls).toEqual(['owned-a', 'owned-b']);
  });

  it('offers an ownerless tool to a bound session whose channel registered none', async () => {
    calls = [];
    const bridge = await bridged(
      [tool('shared_tool', undefined, 'global')],
      [{ sessionId: 's-plain', sourceId: 'bot-plain' }],
    );

    expect(await listTools(bridge, 's-plain')).toEqual(['global']);
    expect(await callTool(bridge, 'shared_tool', 's-plain')).toMatchObject({
      result: { content: [{ type: 'text', text: 'global' }] },
    });
    expect(calls).toEqual(['global']);
  });

  it('exposes nothing and fails the call for an unbound session', async () => {
    calls = [];
    const bridge = await bridged(
      [tool('qq_recall_message', 'qqbot-main', 'qq-moderation')],
      [{ sessionId: 's-qq', sourceId: 'qqbot-main' }],
    );

    // The bound session resolves...
    expect(await listTools(bridge, 's-qq')).toEqual(['qq-moderation']);

    // ...but a frame with no session, or a forged/stale one, resolves to
    // nothing — no channel tools, and no process-wide single-owner fallback.
    expect(await listTools(bridge)).toEqual([]);
    expect(await listTools(bridge, 's-forged')).toEqual([]);

    expect(await callTool(bridge, 'qq_recall_message')).toMatchObject({
      result: { isError: true },
    });
    expect(
      await callTool(bridge, 'qq_recall_message', 's-forged'),
    ).toMatchObject({ result: { isError: true } });
    expect(calls).toEqual([]);
  });

  it('does not let one bound session see or run another channel tool', async () => {
    calls = [];
    const bridge = await bridged(
      [
        tool('qq_tool', 'qqbot-main', 'qq'),
        tool('feishu_tool', 'feishu-main', 'feishu'),
      ],
      [
        { sessionId: 's-qq', sourceId: 'qqbot-main' },
        { sessionId: 's-feishu', sourceId: 'feishu-main' },
      ],
    );

    expect(await listTools(bridge, 's-qq')).toEqual(['qq']);
    expect(await listTools(bridge, 's-feishu')).toEqual(['feishu']);

    expect(await callTool(bridge, 'feishu_tool', 's-qq')).toMatchObject({
      error: { message: 'Unknown channel loop tool: feishu_tool' },
    });
    expect(calls).toEqual([]);
  });

  it('binds sessions that already exist when a channel registers tools later', async () => {
    calls = [];
    const bridge = internals(
      new AcpBridge({ cliEntryPath: '/tmp/qwen', cwd: '/tmp' }),
    );
    bridge.child = { killed: false, exitCode: null };
    bridge.connection = {
      extMethod: vi.fn().mockResolvedValue({}),
      newSession: vi.fn().mockResolvedValue({ sessionId: 's-late' }),
    };
    await bridge.newSession('/tmp', { sourceId: 'late-channel' });
    expect(bridge.channelLoopMcpBoundSessions.has('s-late')).toBe(false);

    bridge.registerChannelTool(tool('late_tool', 'late-channel', 'late'));
    await vi.waitFor(() =>
      expect(bridge.channelLoopMcpBoundSessions.has('s-late')).toBe(true),
    );

    expect(await listTools(bridge, 's-late')).toEqual(['late']);
  });

  it('offers the built-in loop tools to a bound session with a loop handler', async () => {
    const bridge = await bridged(
      [tool('qq_tool', 'qqbot-main', 'qq')],
      [{ sessionId: 's-qq', sourceId: 'qqbot-main' }],
    );
    bridge.registerChannelLoopToolHandler({
      create: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
    });
    const response = (await frame(
      bridge,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      },
      's-qq',
    )) as { payload: { result: { tools: Array<{ name: string }> } } };
    const names = response.payload.result.tools.map((entry) => entry.name);
    expect(names).toHaveLength(CHANNEL_LOOP_MCP_TOOLS.length + 1);
    expect(names).toContain('qq_tool');
    for (const loopTool of CHANNEL_LOOP_MCP_TOOLS) {
      expect(names).toContain(loopTool.name);
    }
  });

  it('rejects a name the built-in loop tools own', () => {
    const bridge = internals(
      new AcpBridge({ cliEntryPath: '/tmp/qwen', cwd: '/tmp' }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      bridge.registerChannelTool({
        name: 'channel_loop_create',
        description: 'shadow the loop tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => 'nope',
      });
      const channelTools = (
        bridge as unknown as {
          channelTools: Array<{ name: string }>;
        }
      ).channelTools;
      expect(channelTools).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });
});
