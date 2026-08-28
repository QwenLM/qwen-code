/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { QwenDaemonProcess } from './qwenDaemonProcess.js';

type Listener = (...args: unknown[]) => void;

interface FakeChild {
  process: ChildProcess;
  kill: ReturnType<typeof vi.fn>;
  emitStdout: (text: string) => void;
  emitExit: (code: number, signal: string | null) => void;
}

function createFakeChild(): FakeChild {
  const listeners = new Map<string, Listener[]>();
  const on = (key: string, callback: Listener) => {
    const list = listeners.get(key) ?? [];
    list.push(callback);
    listeners.set(key, list);
  };
  const kill = vi.fn();
  return {
    kill,
    process: {
      stdout: {
        on: (event: string, cb: Listener) => on(`stdout:${event}`, cb),
      },
      stderr: {
        on: (event: string, cb: Listener) => on(`stderr:${event}`, cb),
      },
      once: (event: string, cb: Listener) => on(event, cb),
      kill,
      exitCode: null,
    } as unknown as ChildProcess,
    emitStdout(text: string) {
      for (const callback of listeners.get('stdout:data') ?? []) {
        callback(Buffer.from(text));
      }
    },
    emitExit(code: number, signal: string | null) {
      for (const callback of listeners.get('exit') ?? []) {
        callback(code, signal);
      }
    },
  };
}

describe('QwenDaemonProcess exit notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not report the exit of a child superseded by a workspace switch', async () => {
    const childA = createFakeChild();
    const childB = createFakeChild();
    spawnMock
      .mockReturnValueOnce(childA.process)
      .mockReturnValueOnce(childB.process);

    const daemon = new QwenDaemonProcess();
    const onExit = vi.fn();
    daemon.onExit = onExit;

    const startA = daemon.start('/cli.js', '/workspace-a');
    childA.emitStdout('qwen serve listening on http://127.0.0.1:4101\n');
    await startA;

    // A multi-root window opening a chat against another root respawns the
    // daemon and kills the first child; that child's later exit is not a
    // crash of the live daemon.
    const startB = daemon.start('/cli.js', '/workspace-b');
    childB.emitStdout('qwen serve listening on http://127.0.0.1:4102\n');
    await startB;

    expect(childA.kill).toHaveBeenCalled();
    childA.emitExit(0, 'SIGTERM');
    expect(onExit).not.toHaveBeenCalled();

    // The live daemon dying is still reported.
    childB.emitExit(1, null);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not report the exit of a child killed by dispose()', async () => {
    const childA = createFakeChild();
    spawnMock.mockReturnValueOnce(childA.process);

    const daemon = new QwenDaemonProcess();
    const onExit = vi.fn();
    daemon.onExit = onExit;

    const startA = daemon.start('/cli.js', '/workspace-a');
    childA.emitStdout('qwen serve listening on http://127.0.0.1:4101\n');
    await startA;

    daemon.dispose();
    childA.emitExit(0, 'SIGTERM');

    expect(onExit).not.toHaveBeenCalled();
  });
});
