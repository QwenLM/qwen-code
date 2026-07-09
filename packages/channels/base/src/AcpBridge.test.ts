import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  ACP_EVENT_LOOP_STALL_RESTART_MS,
  ACP_PERMISSION_RESPONSE_TIMEOUT_MS,
  AcpBridge,
} from './AcpBridge.js';
import { CHANNEL_LOOP_MCP_SERVER_NAME } from './ChannelLoopTools.js';
import type { ChannelLoopToolHandler } from './ChannelAgentBridge.js';

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
      initialize: vi.fn().mockResolvedValue(undefined),
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
    prompt?: ReturnType<typeof vi.fn>;
  };
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

describe('AcpBridge', () => {
  beforeEach(() => {
    child.instances.length = 0;
    child.clients.length = 0;
    child.connections.length = 0;
    child.spawn.mockClear();
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
    ).resolves.toStrictEqual({ messages: [] });
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
    const first = child.clients[0]!.requestPermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'shell',
        title: 'Run command',
      },
      options: [{ optionId: 'cancel', name: 'Deny' }],
    });
    const second = child.clients[0]!.requestPermission({
      sessionId: 'session-2',
      toolCall: {
        toolCallId: 'tool-2',
        kind: 'shell',
        title: 'Run command',
      },
      options: [{ optionId: 'cancel', name: 'Deny' }],
    });
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
    });

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

    bridge.stop();

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});
