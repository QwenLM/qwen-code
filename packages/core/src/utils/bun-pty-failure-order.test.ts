/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { errorMonitor } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const packageName = `@lydell/node-pty-${process.platform}-${process.arch}`;
  const prebuild = `/__qwen_mock__/node-pty/prebuilds/${process.platform}-${process.arch}`;
  return {
    packageName,
    prebuild,
    pid: 987654321,
    fd: 987654322,
    retryWrites: false,
    captureWrite: false,
    writeCallback: undefined as
      | undefined
      | ((error: NodeJS.ErrnoException | null, bytes: number) => void),
    nativeExit: undefined as
      | undefined
      | ((code: number, signal: number) => void),
    readCallback: undefined as
      | undefined
      | ((error: NodeJS.ErrnoException | null, bytes: number) => void),
    read: vi.fn(),
    close: vi.fn(),
    write: vi.fn(),
    require: vi.fn(),
    resolve: vi.fn(),
  };
});

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: () =>
      Object.assign(
        (file: string) => {
          fake.require(file);
          if (file !== `${fake.prebuild}/pty.node`)
            throw new Error(`Blocked require: ${file}`);
          return {
            resize: vi.fn(),
            process: vi.fn(() => 'mock'),
            fork: (...args: unknown[]) => {
              if (typeof args[10] !== 'function')
                throw new Error('Missing native exit callback');
              fake.nativeExit = args[10] as typeof fake.nativeExit;
              return { pid: fake.pid, fd: fake.fd, pty: 'mock-only' };
            },
          };
        },
        {
          resolve: (specifier: string) => {
            fake.resolve(specifier);
            if (specifier !== fake.packageName)
              throw new Error(`Blocked resolve: ${specifier}`);
            return '/__qwen_mock__/node-pty/lib/index.js';
          },
        },
      ),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (file: string) => {
      if (file !== `${fake.prebuild}/spawn-helper`)
        throw new Error(`Blocked existsSync: ${file}`);
      return true;
    },
    read: (...args: unknown[]) => {
      fake.read(...args);
      if (args[0] !== fake.fd) throw new Error('Blocked unknown read FD');
      fake.readCallback = args[5] as typeof fake.readCallback;
    },
    write: (...args: unknown[]) => {
      fake.write(...args);
      if (!fake.retryWrites || args[0] !== fake.fd) {
        throw new Error('Blocked unexpected fs.write');
      }
      const callback = args[3];
      if (typeof callback !== 'function')
        throw new Error('Missing write callback');
      if (fake.captureWrite)
        fake.writeCallback = callback as typeof fake.writeCallback;
      else
        callback(
          Object.assign(new Error('mock EAGAIN'), { code: 'EAGAIN' }),
          0,
        );
    },
    closeSync: (fd: number) => {
      fake.close(fd);
      if (fd !== fake.fd) throw new Error('Blocked unknown close FD');
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  fake.nativeExit = undefined;
  fake.readCallback = undefined;
  fake.retryWrites = false;
  fake.captureWrite = false;
  fake.writeCallback = undefined;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === 'win32').each([false, true])(
  'preserves parked native exit and failure precedence (throwing subscriber: %s)',
  async (throwingSubscriber) => {
    vi.useFakeTimers();
    // Guard is installed BEFORE importing the real production module.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const { spawn, getPtyBudgetStats } = await import('./bun-pty.js');
    expect(getPtyBudgetStats()).toEqual({
      activePtys: 0,
      pausedHoldBytes: 0,
      writeQueueBytes: 0,
    });
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: 4096 },
    });
    try {
      expect(fake.resolve).toHaveBeenCalledExactlyOnceWith(fake.packageName);
      expect(fake.require).toHaveBeenCalledExactlyOnceWith(
        `${fake.prebuild}/pty.node`,
      );
      expect(fake.read).toHaveBeenCalledTimes(1);
      expect(pty.stats.readInFlight).toBe(true);
      expect(getPtyBudgetStats().activePtys).toBe(1);
      const order: string[] = [];
      const errors: Array<{ code?: string }> = [];
      const exits: unknown[] = [];
      const subscriberError = new Error(
        'injected synchronous error subscriber',
      );
      pty.on('error', (error) => {
        errors.push(error);
        order.push('error');
        if (throwingSubscriber) throw subscriberError;
      });
      pty.onExit((event) => {
        exits.push(event);
        order.push('exit');
      });
      fake.nativeExit!(3, 0);
      expect(order).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
      expect(() => pty.write(Buffer.alloc(8192))).not.toThrow();
      expect(order).toEqual(['error', 'exit']);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: 'QWEN_PTY_WRITE_LIMIT',
        limitKind: 'write-queue-per-pty',
        limit: 4096,
        acceptedBytes: 0,
        hasUndeliveredData: false,
      });
      expect(exits).toEqual([{ exitCode: 3, signal: 0 }]);
      expect(pty.stats).toMatchObject({
        resourceFailed: true,
        nativeExitRecord: { exitCode: 3, signal: 0 },
        readInFlight: true,
        writeQueuedBytes: 0,
      });
      expect(getPtyBudgetStats()).toEqual({
        activePtys: 0,
        pausedHoldBytes: 0,
        writeQueueBytes: 0,
      });
      expect(fake.close).not.toHaveBeenCalled();
      expect(fake.write).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      fake.readCallback!(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback = undefined;
      expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
      expect(pty.stats.readInFlight).toBe(false);
      fake.nativeExit!(9, 15);
      pty.write(Buffer.alloc(8192));
      vi.runAllTimers();
      expect(order).toEqual(['error', 'exit']);
      expect(pty.stats.nativeExitRecord).toEqual({ exitCode: 3, signal: 0 });
      expect(fake.read).toHaveBeenCalledTimes(1);
      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      fake.readCallback?.(
        Object.assign(new Error('mock cleanup EIO'), { code: 'EIO' }),
        0,
      );
    }
  },
);

it.skipIf(process.platform === 'win32').each(['end-pump', 'resource-failure'])(
  'paces EAGAIN writes and cancels the retry on %s',
  async (ending) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const { spawn, getPtyBudgetStats } = await import('./bun-pty.js');
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: 4096 },
    });
    try {
      fake.retryWrites = true;
      pty.write('input');
      expect(fake.write).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(20);
      expect(fake.write).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(1);
      if (ending === 'resource-failure') {
        pty.on('error', vi.fn());
        fake.nativeExit!(3, 0);
        pty.write(Buffer.alloc(8192));
        expect(pty.stats.resourceFailed).toBe(true);
      }
      fake.readCallback!(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback = undefined;
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(fake.write).toHaveBeenCalledTimes(6);
      expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
      expect(kill).not.toHaveBeenCalled();
      expect(getPtyBudgetStats()).toEqual({
        activePtys: 0,
        pausedHoldBytes: 0,
        writeQueueBytes: 0,
      });
    } finally {
      fake.readCallback?.(
        Object.assign(new Error('mock cleanup EIO'), { code: 'EIO' }),
        0,
      );
    }
  },
);

it
  .skipIf(process.platform === 'win32')
  .each(['parked-write-limit', 'write-callback-error'])(
  'contains throwing subscriber and delivers original error to later/once subscribers on %s',
  async (mode) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const { spawn, getPtyBudgetStats } = await import('./bun-pty.js');
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: 4096 },
    });
    const original: Array<Error & { code?: string }> = [];
    const thrown: unknown[] = [];
    const second = vi.fn();
    const once = vi.fn();
    const monitor = vi.fn();
    pty.on(errorMonitor, () => {
      throw new Error('injected monitor');
    });
    pty.on(errorMonitor, monitor);
    const sentinel = new Error('injected first subscriber throws');
    pty.on('error', (error) => {
      original.push(error);
      throw sentinel;
    });
    pty.on('error', second);
    pty.once('error', once);
    try {
      if (mode === 'parked-write-limit') {
        fake.nativeExit!(3, 0);
        try {
          pty.write(Buffer.alloc(8192));
        } catch (e) {
          thrown.push(e);
        }
      } else {
        fake.retryWrites = true;
        fake.captureWrite = true;
        for (let i = 0; i < 2; i++) {
          pty.write('input');
          expect(fake.writeCallback).toBeTypeOf('function');
          try {
            fake.writeCallback!(
              Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' }),
              0,
            );
          } catch (e) {
            thrown.push(e);
          }
        }
      }
    } finally {
      fake.readCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback = undefined;
      expect(kill).not.toHaveBeenCalled();
      expect(getPtyBudgetStats()).toEqual({
        activePtys: 0,
        pausedHoldBytes: 0,
        writeQueueBytes: 0,
      });
    }
    expect(thrown).toEqual([]);
    expect(original).toHaveLength(mode === 'parked-write-limit' ? 1 : 2);
    expect(second).toHaveBeenCalledTimes(original.length);
    for (const [index, error] of original.entries()) {
      expect(second.mock.calls[index]![0]).toBe(error);
      expect(monitor.mock.calls[index]![0]).toBe(error);
    }
    expect(monitor).toHaveBeenCalledTimes(original.length);
    expect(once).toHaveBeenCalledExactlyOnceWith(original[0]);
    expect(pty.listenerCount('error')).toBe(2);
  },
);

it.skipIf(process.platform === 'win32')(
  'contains a failing console fallback without skipping parked exit or cleanup',
  async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('injected diagnostic sink');
    });
    const { spawn, getPtyBudgetStats } = await import('./bun-pty.js');
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: 4096 },
    });
    const exit = vi.fn();
    pty.onExit(exit);
    try {
      fake.nativeExit!(3, 0);
      expect(() => pty.write(Buffer.alloc(8192))).not.toThrow();
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 'QWEN_PTY_WRITE_LIMIT' }),
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 3, signal: 0 });
    } finally {
      fake.readCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback = undefined;
    }
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
    expect(kill).not.toHaveBeenCalled();
    expect(getPtyBudgetStats()).toEqual({
      activePtys: 0,
      pausedHoldBytes: 0,
      writeQueueBytes: 0,
    });
  },
);

it.skipIf(process.platform === 'win32').each(['per-pty', 'process'])(
  'reports discarded queued input on the %s write cap',
  async (scope) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const { spawn, getPtyBudgetStats, processPtyBudget } = await import(
      './bun-pty.js'
    );
    const original = processPtyBudget.totalWriteQueueBytes;
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: scope === 'per-pty' ? 4096 : 8192 },
    });
    const errors: Array<
      Error & {
        code?: string;
        limitKind?: string;
        acceptedBytes?: number;
        hasUndeliveredData?: boolean;
      }
    > = [];
    pty.on('error', (error) => errors.push(error));
    try {
      if (scope === 'process') processPtyBudget.totalWriteQueueBytes = 4096;
      fake.retryWrites = true;
      fake.captureWrite = true;
      pty.write(Buffer.alloc(4096));
      expect(pty.stats.writeQueuedBytes).toBe(4096);
      expect(fake.writeCallback).toBeTypeOf('function');
      pty.pause();
      const readBuffer = fake.read.mock.calls.at(-1)![1] as Buffer;
      Buffer.from('held').copy(readBuffer);
      fake.readCallback!(null, 4);
      expect(getPtyBudgetStats()).toEqual({
        activePtys: 1,
        pausedHoldBytes: 4,
        writeQueueBytes: 4096,
      });
      fake.nativeExit!(3, 0);
      pty.write('x');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: 'QWEN_PTY_WRITE_LIMIT',
        limitKind: `write-queue-${scope}`,
        acceptedBytes: 4096,
        hasUndeliveredData: true,
      });
      expect(errors[0]!.message).toContain('undelivered input was discarded');
      expect(errors[0]!.message).not.toContain('undelivered output');
      expect(pty.stats.writeQueuedBytes).toBe(0);
      expect(fake.write).toHaveBeenCalledTimes(1);
      expect(getPtyBudgetStats()).toEqual({
        activePtys: 0,
        pausedHoldBytes: 0,
        writeQueueBytes: 0,
      });
    } finally {
      processPtyBudget.totalWriteQueueBytes = original;
      fake.writeCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.writeCallback = undefined;
      fake.readCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback = undefined;
    }
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
    expect(kill).not.toHaveBeenCalled();
    expect(getPtyBudgetStats()).toEqual({
      activePtys: 0,
      pausedHoldBytes: 0,
      writeQueueBytes: 0,
    });
  },
);

it.skipIf(process.platform === 'win32').each(['per-pty', 'process'])(
  'runs the native-suite cleanup hook against production refunds on the %s cap',
  async (scope) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const { spawn, getPtyBudgetStats, processPtyBudget } = await import(
      './bun-pty.js'
    );
    const { cleanupPtys } = await import('./bun-pty-test-utils.js');
    const original = processPtyBudget.totalWriteQueueBytes;
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: scope === 'per-pty' ? 4096 : 8192 },
    });
    pty.on('error', () => {});
    try {
      if (scope === 'process') processPtyBudget.totalWriteQueueBytes = 4096;
      fake.retryWrites = true;
      fake.captureWrite = true;
      pty.write(Buffer.alloc(4096));
      pty.pause();
      const readBuffer = fake.read.mock.calls.at(-1)![1] as Buffer;
      Buffer.from('held').copy(readBuffer);
      fake.readCallback!(null, 4);
      expect(getPtyBudgetStats()).toEqual({
        activePtys: 1,
        pausedHoldBytes: 4,
        writeQueueBytes: 4096,
      });
      fake.nativeExit!(3, 0);
      pty.write('x');

      // Use the very same cleanup implementation registered by the native
      // suite. Handle rejection before advancing time, then rethrow it so a
      // production refund leak fails at the cleanup assertion itself.
      const cleanup = cleanupPtys([pty]).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const { error } = await cleanup;
      if (error) throw error;
    } finally {
      processPtyBudget.totalWriteQueueBytes = original;
      fake.writeCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.writeCallback = undefined;
      fake.readCallback = undefined;
    }
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
    expect(kill).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === 'win32').each([undefined, 'SIGTERM'])(
  'still forwards %s when killing a live PTY',
  async (signal) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const { spawn } = await import('./bun-pty.js');
    const pty = spawn('mock-command-never-executed', [], { env: {} });
    try {
      expect(() => pty.kill(signal)).not.toThrow();
      expect(kill).toHaveBeenCalledExactlyOnceWith(
        fake.pid,
        signal ?? 'SIGHUP',
      );
      fake.nativeExit!(0, 0);
    } finally {
      fake.readCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback = undefined;
    }
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
  },
);

it
  .skipIf(process.platform === 'win32')
  .each(['native-exit', 'resource-failure'])(
  'does not signal again after %s',
  async (terminal) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Blocked process.kill');
    });
    const { spawn } = await import('./bun-pty.js');
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: 4096 },
    });
    pty.on('error', () => {});
    try {
      if (terminal === 'native-exit') {
        fake.nativeExit!(0, 0);
        expect(kill).not.toHaveBeenCalled();
      } else {
        pty.write(Buffer.alloc(8192));
        await vi.advanceTimersByTimeAsync(500);
        expect(kill.mock.calls).toEqual([
          [-fake.pid, 'SIGTERM'],
          [fake.pid, 'SIGTERM'],
          [-fake.pid, 'SIGKILL'],
          [fake.pid, 'SIGKILL'],
        ]);
      }
      kill.mockClear();
      pty.kill('SIGKILL');
      expect(kill).not.toHaveBeenCalled();
    } finally {
      fake.readCallback?.(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      fake.readCallback = undefined;
    }
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
  },
);

it
  .skipIf(process.platform === 'win32')
  .each([
    'exit-before-fallback',
    'exit-during-term-group',
    'exit-during-kill-group',
    'still-live-after-fd-close',
  ])(
  'preserves group fallback after %s without signalling a reaped leader',
  async (mode) => {
    vi.useFakeTimers();
    let descendantAlive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (Math.abs(pid) !== fake.pid) throw new Error('Blocked unknown PID');
      if (pid === -fake.pid && signal === 'SIGKILL') descendantAlive = false;
      if (
        pid === -fake.pid &&
        ((mode === 'exit-during-term-group' && signal === 'SIGTERM') ||
          (mode === 'exit-during-kill-group' && signal === 'SIGKILL'))
      ) {
        fake.nativeExit!(0, 15);
      }
      return true;
    });
    const { spawn, getPtyBudgetStats } = await import('./bun-pty.js');
    const pty = spawn('mock-command-never-executed', [], {
      env: {},
      limits: { writeQueueBytes: 4096 },
    });
    try {
      expect(fake.nativeExit).toBeTypeOf('function');
      pty.on('error', vi.fn());
      pty.write(Buffer.alloc(8192));
      expect(kill.mock.calls).toEqual(
        mode === 'exit-during-term-group'
          ? [[-fake.pid, 'SIGTERM']]
          : [
              [-fake.pid, 'SIGTERM'],
              [fake.pid, 'SIGTERM'],
            ],
      );
      expect(vi.getTimerCount()).toBe(1);
      if (mode === 'exit-before-fallback') {
        fake.nativeExit!(0, 15);
      }
      // Native leader exit does not prove TERM-resistant descendants exited.
      expect(descendantAlive).toBe(true);
      // Closing the fd and refunding budgets must also preserve group fallback.
      fake.readCallback!(
        Object.assign(new Error('mock EIO'), { code: 'EIO' }),
        0,
      );
      expect(fake.close).toHaveBeenCalledExactlyOnceWith(fake.fd);
      expect(getPtyBudgetStats()).toEqual({
        activePtys: 0,
        pausedHoldBytes: 0,
        writeQueueBytes: 0,
      });
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(499);
      expect(
        kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL'),
      ).toEqual([]);
      expect(descendantAlive).toBe(true);
      vi.advanceTimersByTime(1);
      expect(
        kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL'),
      ).toEqual(
        mode === 'still-live-after-fd-close'
          ? [
              [-fake.pid, 'SIGKILL'],
              [fake.pid, 'SIGKILL'],
            ]
          : [[-fake.pid, 'SIGKILL']],
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(descendantAlive).toBe(false);
      const signals = kill.mock.calls.slice();
      fake.nativeExit!(0, 15);
      vi.advanceTimersByTime(1000);
      expect(kill.mock.calls).toEqual(signals);
    } finally {
      if (pty.stats.readInFlight) {
        fake.readCallback!(
          Object.assign(new Error('cleanup EIO'), { code: 'EIO' }),
          0,
        );
      }
      fake.nativeExit!(0, 15);
    }
  },
);
