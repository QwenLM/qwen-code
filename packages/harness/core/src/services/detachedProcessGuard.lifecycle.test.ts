/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  enableDetachedProcessGuard,
  prepareDetachedProcessGuard,
  guardDetachedProcess,
  stopDetachedProcessGuard,
  drainDetachedProcessGuard,
} from './detachedProcessGuard.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../utils/runLogger.js', () => ({ runLogger: { warn: vi.fn() } }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const electron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
let child: ChildProcess;
const children: ChildProcess[] = [];

function createGuard(): ChildProcess {
  const input = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    unref: vi.fn(),
    destroyed: false,
    writableEnded: false,
  });
  const instance = Object.assign(new EventEmitter(), {
    stdin: input,
    unref: vi.fn(),
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  children.push(instance);
  return instance;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'darwin',
  });
  child = createGuard();
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockReturnValue(child);
});

afterEach(async () => {
  const closing = drainDetachedProcessGuard();
  for (const instance of children.splice(0)) instance.emit('exit', 0, null);
  await Promise.resolve(closing).catch(() => {});
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Object.defineProperty(process, 'platform', platform);
  if (electron) Object.defineProperty(process.versions, 'electron', electron);
  else delete process.versions['electron'];
});

it('soft stop closes stdin without starting referenced reaping timers', () => {
  vi.useFakeTimers();
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  expect(stopDetachedProcessGuard()).toBeUndefined();
  expect(child.stdin!.end).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for guard exit before completing normal Worker shutdown', async () => {
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  let completed = false;
  const closing = drainDetachedProcessGuard();
  expect(drainDetachedProcessGuard()).toBe(closing);
  void closing.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  child.emit('exit', 0, null);
  await closing;
  expect(completed).toBe(true);
});

it('still waits for a replaced guard whose registration pipe failed', async () => {
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  child.stdin!.emit('error', new Error('EPIPE'));
  const replacement = createGuard();
  vi.mocked(spawn).mockReturnValue(replacement);
  prepareDetachedProcessGuard();
  let completed = false;
  const closing = drainDetachedProcessGuard().then(() => {
    completed = true;
  });
  replacement.emit('exit', 0, null);
  await Promise.resolve();
  expect(completed).toBe(false);
  child.emit('exit', 0, null);
  await closing;
});

it('escalates a stuck guard and waits for the real exit event', async () => {
  vi.useFakeTimers();
  Object.assign(child, { pid: 123 });
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  let completed = false;
  const closing = drainDetachedProcessGuard().then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(completed).toBe(false);
  child.emit('exit', null, 'SIGKILL');
  await closing;
  vi.useRealTimers();
});

it('rejects bounded shutdown when kill never produces an exit event', async () => {
  vi.useFakeTimers();
  Object.assign(child, { pid: 123 });
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  const closing = drainDetachedProcessGuard();
  const rejected = closing.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await rejected).toMatchObject({
    message: 'Process guard did not exit after SIGKILL',
  });
  // The process can still deliver a late exit after the bounded failure.
  child.emit('exit', null, 'SIGKILL');
  vi.useRealTimers();
});

it('does not spawn on opt-in or without opt-in, and reuses one guard for tasks', () => {
  prepareDetachedProcessGuard();
  expect(spawn).not.toHaveBeenCalled();
  enableDetachedProcessGuard();
  enableDetachedProcessGuard();
  expect(spawn).not.toHaveBeenCalled();
  prepareDetachedProcessGuard();
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledOnce();
  const task = Object.assign(new EventEmitter(), { pid: 123 });
  guardDetachedProcess(task as ChildProcess);
  expect(child.stdin!.write).toHaveBeenCalledWith('+123\n');
});

it('does not lazily create a guard after a task has already spawned', () => {
  enableDetachedProcessGuard();
  guardDetachedProcess(
    Object.assign(new EventEmitter(), { pid: 123 }) as ChildProcess,
  );
  expect(spawn).not.toHaveBeenCalled();
});

it('disables late preparation on stop, and permits a new explicit opt-in', () => {
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  stopDetachedProcessGuard();
  stopDetachedProcessGuard();
  expect(child.stdin!.end).toHaveBeenCalledOnce();
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledOnce();
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledTimes(2);
});

it('does not spawn on Windows', () => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  expect(spawn).not.toHaveBeenCalled();
});

it('launches Electron in Node mode while preserving inherited environment', () => {
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    value: 'test',
  });
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '0');
  vi.stubEnv('QWEN_GUARD_ENV_TEST', 'preserved');
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ['--eval', expect.any(String)],
    expect.objectContaining({
      windowsHide: true,
      env: expect.objectContaining({
        ELECTRON_RUN_AS_NODE: '1',
        QWEN_GUARD_ENV_TEST: 'preserved',
      }),
    }),
  );
});

it('preserves an inherited Electron Node-mode flag outside Electron', () => {
  delete process.versions['electron'];
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    expect.any(Array),
    expect.objectContaining({
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    }),
  );
});

it('uses the internal entry for a compiled Bun binary', () => {
  vi.stubGlobal('Bun', { main: '/$bunfs/root/qwen' });
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ['--internal-process-guard'],
    expect.any(Object),
  );
});

const faults = ['spawn-error', 'exit', 'close', 'pipe-error'] as const;
type GuardFault = (typeof faults)[number];
function failGuard(instance: ChildProcess, fault: GuardFault): void {
  if (fault === 'pipe-error') {
    instance.stdin!.emit(
      'error',
      Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
    );
  } else if (fault === 'spawn-error') {
    instance.emit(
      'error',
      Object.assign(new Error('resource unavailable'), { code: 'EAGAIN' }),
    );
  } else {
    instance.emit(fault, 1, null);
  }
}

it.each(faults)(
  'retries only on the next task after %s and registers it with the replacement',
  (fault) => {
    const replacement = createGuard();
    enableDetachedProcessGuard();
    prepareDetachedProcessGuard();
    failGuard(child, fault);
    expect(spawn).toHaveBeenCalledOnce(); // No eager restart loop.
    vi.mocked(spawn).mockReturnValue(replacement);
    prepareDetachedProcessGuard();
    expect(spawn).toHaveBeenCalledTimes(2);
    const task = Object.assign(new EventEmitter(), { pid: 456 });
    guardDetachedProcess(task as ChildProcess);
    expect(replacement.stdin!.write).toHaveBeenCalledExactlyOnceWith('+456\n');
    expect(child.stdin!.write).not.toHaveBeenCalled();
  },
);

it.each(faults)(
  'ignores late %s from the old guard after a replacement starts',
  (fault) => {
    enableDetachedProcessGuard();
    prepareDetachedProcessGuard();
    failGuard(child, 'spawn-error');
    const replacement = createGuard();
    vi.mocked(spawn).mockReturnValue(replacement);
    prepareDetachedProcessGuard();
    failGuard(child, fault);
    prepareDetachedProcessGuard();
    expect(spawn).toHaveBeenCalledTimes(2);
    guardDetachedProcess(
      Object.assign(new EventEmitter(), { pid: 789 }) as ChildProcess,
    );
    expect(replacement.stdin!.write).toHaveBeenCalledExactlyOnceWith('+789\n');
  },
);

it.each(faults)('does not restart on %s after stop', (fault) => {
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  stopDetachedProcessGuard();
  failGuard(child, fault);
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledOnce();
});

it('can retry after a synchronous spawn exception', () => {
  enableDetachedProcessGuard();
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw new Error('spawn threw');
  });
  expect(prepareDetachedProcessGuard).toThrow('spawn threw');
  prepareDetachedProcessGuard();
  expect(spawn).toHaveBeenCalledTimes(2);
});

it('keeps old task close notifications on the original registration pipe', () => {
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  const oldTask = Object.assign(new EventEmitter(), { pid: 123 });
  guardDetachedProcess(oldTask as ChildProcess);
  failGuard(child, 'pipe-error');
  const replacement = createGuard();
  vi.mocked(spawn).mockReturnValue(replacement);
  prepareDetachedProcessGuard();
  guardDetachedProcess(
    Object.assign(new EventEmitter(), { pid: 456 }) as ChildProcess,
  );
  oldTask.emit('close');
  expect(replacement.stdin!.write).toHaveBeenCalledExactlyOnceWith('+456\n');
});
