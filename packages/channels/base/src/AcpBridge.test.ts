import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AcpBridge } from './AcpBridge.js';

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

describe('AcpBridge', () => {
  beforeEach(() => {
    child.instances.length = 0;
    child.spawn.mockClear();
  });

  it('kills the ACP child when it reports a large event loop stall', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });

    await bridge.start();
    const proc = child.instances[0]!;

    proc.stderr.write(
      '[perf] acp agent event loop stall: max=917512.388607ms\n',
    );

    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('does not kill the ACP child for a small event loop stall warning', async () => {
    const bridge = new AcpBridge({
      cliEntryPath: '/tmp/qwen',
      cwd: '/tmp',
    });

    await bridge.start();
    const proc = child.instances[0]!;

    proc.stderr.write('[perf] acp agent event loop stall: max=2500ms\n');

    expect(proc.kill).not.toHaveBeenCalled();
  });
});
