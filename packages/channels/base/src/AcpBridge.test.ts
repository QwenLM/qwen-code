import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACP_EVENT_LOOP_STALL_RESTART_MS, AcpBridge } from './AcpBridge.js';
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
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
  })),
}));

type TestableAcpBridge = AcpBridge & {
  child: { killed: boolean; exitCode: number | null };
  connection: {
    extMethod: ReturnType<typeof vi.fn>;
    newSession?: ReturnType<typeof vi.fn>;
  };
  channelLoopMcpServer: unknown;
  channelLoopToolHandlers: ChannelLoopToolHandler[];
  channelLoopMcpRegistered: boolean;
  handleExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  handleClientMcpMessage(params: Record<string, unknown>): Promise<unknown>;
  registerChannelLoopMcpServer(): Promise<void>;
  resolveChannelLoopToolHandler(sessionId: string): ChannelLoopToolHandler;
};

describe('AcpBridge', () => {
  beforeEach(() => {
    child.instances.length = 0;
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
});
