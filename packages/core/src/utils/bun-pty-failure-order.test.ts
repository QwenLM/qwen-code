/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
      callback(Object.assign(new Error('mock EAGAIN'), { code: 'EAGAIN' }), 0);
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
      if (throwingSubscriber) {
        expect(() => pty.write(Buffer.alloc(8192))).toThrow(subscriberError);
      } else {
        pty.write(Buffer.alloc(8192));
      }
      expect(order).toEqual(['error', 'exit']);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: 'QWEN_PTY_WRITE_LIMIT',
        limitKind: 'write-queue-per-pty',
        limit: 4096,
        acceptedBytes: 0,
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
