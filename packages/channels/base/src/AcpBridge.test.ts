import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  ACP_EVENT_LOOP_STALL_RESTART_MS,
  ACP_PERMISSION_RESPONSE_TIMEOUT_MS,
  ACP_START_TIMEOUT_MS,
  AcpBridge,
} from './AcpBridge.js';
import { CHANNEL_LOOP_MCP_SERVER_NAME } from './ChannelLoopTools.js';
import {
  ACP_PRIVATE_PARENT_CAPABILITY_ENV,
  ACP_PRIVATE_PARENT_CAPABILITY_META_KEY,
  CHANNEL_BTW_METHOD,
  CHANNEL_PROMPT_META_KEY,
  type ChannelLoopToolHandler,
  type ChannelPromptImage,
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

vi.mock('@agentclientprotocol/sdk', () => ({
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
  channelLoopMcpRegistered: boolean;
  handleExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  handleSessionUpdate(params: Record<string, unknown>): void;
  requestPermission(params: Record<string, unknown>): Promise<unknown>;
  handleClientMcpMessage(params: Record<string, unknown>): Promise<unknown>;
  registerChannelLoopMcpServer(): Promise<void>;
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

  it('registers the channel loop MCP server once across concurrent calls', async () => {
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

    const first = bridge.registerChannelLoopMcpServer();
    const second = bridge.registerChannelLoopMcpServer();

    expect(extMethod).toHaveBeenCalledTimes(1);
    pending.splice(0).forEach((resolve) => resolve());
    await Promise.all([first, second]);
    expect(bridge.channelLoopMcpRegistered).toBe(true);
  });

  it('waits for pending channel loop MCP registration before creating a session', async () => {
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

    const registration = bridge.registerChannelLoopMcpServer();
    const session = bridge.newSession('/tmp');
    await Promise.resolve();

    expect(newSession).not.toHaveBeenCalled();
    pending.splice(0).forEach((resolve) => resolve());
    await registration;

    await expect(session).resolves.toBe('s-1');
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('retries channel loop MCP registration when the runtime skips registration', async () => {
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({ skipped: true, reason: 'budget_warning_only' })
      .mockResolvedValueOnce({});
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    }) as unknown as TestableAcpBridge;
    bridge.connection = { extMethod };
    bridge.channelLoopMcpServer = {};

    await bridge.registerChannelLoopMcpServer();

    expect(bridge.channelLoopMcpRegistered).toBe(false);

    await bridge.registerChannelLoopMcpServer();

    expect(extMethod).toHaveBeenCalledTimes(2);
    expect(bridge.channelLoopMcpRegistered).toBe(true);
  });

  it('sanitizes skipped channel loop MCP registration reasons', async () => {
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
      await bridge.registerChannelLoopMcpServer();
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
    const backgroundResponses: Array<[string, string]> = [];
    bridge.on('backgroundResponse', (sessionId, text) => {
      backgroundResponses.push([sessionId, text]);
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
        },
      },
    });

    expect(backgroundResponses).toEqual([['s-1', 'Background final answer.']]);
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

    expect(toolCall.mock.calls.map(([event]) => event.kind)).toEqual([
      'other',
      'fetch',
    ]);
    expect(responseBoundary).toHaveBeenCalledOnce();
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
