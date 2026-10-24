/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic wrapper tests: no native addon, fd, process or signal exists.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPtyBudgetStats, spawn } from './bun-pty.js';

// The product spawn entry rejects Windows; these fake-I/O tests do not
// validate ConPTY and must not claim that platform as covered.
const test = it.runIf(process.platform !== 'win32');

const io = vi.hoisted(() => ({
  read: null as null | {
    buffer: Buffer;
    done: (error: NodeJS.ErrnoException | null, bytes: number) => void;
  },
  exit: null as null | ((code: number, signal: number) => void),
  closes: vi.fn(),
  writes: vi.fn(),
}));
vi.mock('node:module', () => ({
  createRequire: () =>
    Object.assign(
      () => ({
        fork: (...args: unknown[]) => {
          io.exit = args[args.length - 1] as typeof io.exit;
          return { pid: 424242, fd: 424243, pty: 'fake' };
        },
        resize: vi.fn(),
      }),
      { resolve: () => '/fixture/node-pty/lib/index.js' },
    ),
}));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  read: (
    _fd: number,
    buffer: Buffer,
    _offset: number,
    _length: number,
    _position: null,
    done: NonNullable<typeof io.read>['done'],
  ) => {
    io.read = { buffer, done };
  },
  write: io.writes,
  closeSync: io.closes,
}));

function output(bytes: Buffer) {
  const pending = io.read!;
  io.read = null;
  bytes.copy(pending.buffer);
  pending.done(null, bytes.length);
}
function eof() {
  const pending = io.read!;
  io.read = null;
  pending.done(null, 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('refunds a paused replay even when data and error subscribers throw', () => {
  const baseline = getPtyBudgetStats();
  const pty = spawn('fake');
  const order: string[] = [];
  const first = vi.fn(() => {
    order.push('first');
    throw new Error('data boom');
  });
  const second = vi.fn(() => order.push('second'));
  const error = vi.fn(() => {
    order.push('error');
    throw new Error('error boom');
  });
  pty.onData(first);
  pty.onData(second);
  pty.on('error', error);
  try {
    pty.pause();
    output(Buffer.from('held bytes'));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(
      baseline.pausedHoldBytes + Buffer.byteLength('held bytes'),
    );
    expect(() => pty.resume()).not.toThrow();
    expect(first).toHaveBeenCalledExactlyOnceWith('held bytes');
    expect(second).toHaveBeenCalledExactlyOnceWith('held bytes');
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: 'pty data listener threw: data boom',
      }),
    );
    expect(order).toEqual(['first', 'error', 'second']);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(baseline.pausedHoldBytes);
    pty.resume();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(baseline.pausedHoldBytes);
  } finally {
    eof();
    io.exit!(0, 0);
  }
  expect(getPtyBudgetStats()).toEqual(baseline);
});

test('preserves the real exit through a throwing decoder-tail delivery', () => {
  const baseline = getPtyBudgetStats();
  const pty = spawn('fake');
  const exit = vi.fn();
  const data = vi.fn(() => {
    throw new Error('tail boom');
  });
  const error = vi.fn(() => {
    throw new Error('error boom');
  });
  pty.onData(data);
  pty.on('error', error);
  pty.onExit(exit);
  try {
    output(Buffer.from([0xe4, 0xb8]));
    expect(data).not.toHaveBeenCalled();
    io.exit!(7, 0);
    expect(exit).not.toHaveBeenCalled();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(data).toHaveBeenCalledExactlyOnceWith('\ufffd');
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: 'pty data listener threw: tail boom',
      }),
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 7, signal: 0 });
  } finally {
    // The timeout logically closed the fake fd while one read was pending.
    // Complete that exact callback; no private state is overwritten.
    eof();
  }
  expect(io.closes).toHaveBeenCalledOnce();
  expect(getPtyBudgetStats()).toEqual(baseline);
});

test('diagnoses an exit subscriber failure without skipping the next subscriber', () => {
  const baseline = getPtyBudgetStats();
  const pty = spawn('fake');
  const error = vi.fn(() => {
    throw new Error('error sink boom');
  });
  const exit = vi.fn();
  pty.on('error', error);
  pty.onExit(() => {
    throw new Error('exit boom');
  });
  pty.onExit(exit);
  eof();
  io.exit!(3, 0);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'pty exit listener threw: exit boom' }),
  );
  expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 3, signal: 0 });
  expect(getPtyBudgetStats()).toEqual(baseline);
});

test('explicitly fails an idle first write above the unchanged budget', () => {
  const baseline = getPtyBudgetStats();
  const pty = spawn('fake');
  const error = vi.fn();
  const exit = vi.fn();
  pty.on('error', error);
  pty.onExit(exit);
  try {
    pty.write(Buffer.alloc(1024 * 1024 + 1));
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'QWEN_PTY_WRITE_LIMIT' }),
    );
    expect(io.writes).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(getPtyBudgetStats().writeQueueBytes).toBe(baseline.writeQueueBytes);
  } finally {
    eof();
    io.exit!(0, 0);
  }
  expect(getPtyBudgetStats()).toEqual(baseline);
});
