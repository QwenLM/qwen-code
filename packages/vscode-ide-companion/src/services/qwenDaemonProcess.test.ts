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
  listenerCount: (key: string) => number;
}

function createFakeChild(): FakeChild {
  const listeners = new Map<string, Listener[]>();
  const on = (key: string, callback: Listener) => {
    const list = listeners.get(key) ?? [];
    list.push(callback);
    listeners.set(key, list);
  };
  const removeListener = (key: string, callback: Listener) => {
    const list = listeners.get(key);
    if (!list) return;
    listeners.set(
      key,
      list.filter((entry) => entry !== callback),
    );
  };
  const kill = vi.fn();
  return {
    kill,
    process: {
      stdout: {
        on: (event: string, cb: Listener) => on(`stdout:${event}`, cb),
        removeListener: (event: string, cb: Listener) =>
          removeListener(`stdout:${event}`, cb),
      },
      stderr: {
        on: (event: string, cb: Listener) => on(`stderr:${event}`, cb),
        removeListener: (event: string, cb: Listener) =>
          removeListener(`stderr:${event}`, cb),
      },
      once: (event: string, cb: Listener) => on(event, cb),
      kill,
      exitCode: null,
    } as unknown as ChildProcess,
    emitStdout(text: string) {
      for (const callback of [...(listeners.get('stdout:data') ?? [])]) {
        callback(Buffer.from(text));
      }
    },
    emitExit(code: number, signal: string | null) {
      for (const callback of [...(listeners.get('exit') ?? [])]) {
        callback(code, signal);
      }
    },
    listenerCount(key: string) {
      return listeners.get(key)?.length ?? 0;
    },
  };
}

async function settle(
  daemon: QwenDaemonProcess,
  child: FakeChild,
  workspace: string,
  port: number,
): Promise<void> {
  const start = daemon.start('/cli.js', workspace);
  child.emitStdout(`qwen serve listening on http://127.0.0.1:${port}\n`);
  await start;
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
    daemon.addExitListener(onExit);

    await settle(daemon, childA, '/workspace-a', 4101);

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

  it('notifies every registered listener when the live daemon exits', async () => {
    const childA = createFakeChild();
    spawnMock.mockReturnValueOnce(childA.process);

    const daemon = new QwenDaemonProcess();
    const first = vi.fn();
    const second = vi.fn();
    daemon.addExitListener(first);
    daemon.addExitListener(second);

    await settle(daemon, childA, '/workspace-a', 4101);
    childA.emitExit(1, null);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not notify listeners whose subscription was disposed', async () => {
    const childA = createFakeChild();
    spawnMock.mockReturnValueOnce(childA.process);

    const daemon = new QwenDaemonProcess();
    const onExit = vi.fn();
    const handle = daemon.addExitListener(onExit);

    await settle(daemon, childA, '/workspace-a', 4101);
    handle.dispose();
    childA.emitExit(1, null);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('does not report the exit of a child killed by dispose()', async () => {
    const childA = createFakeChild();
    spawnMock.mockReturnValueOnce(childA.process);

    const daemon = new QwenDaemonProcess();
    const onExit = vi.fn();
    daemon.addExitListener(onExit);

    await settle(daemon, childA, '/workspace-a', 4101);

    daemon.dispose();
    childA.emitExit(0, 'SIGTERM');

    expect(onExit).not.toHaveBeenCalled();
  });

  it('notifies superseded listeners when a workspace switch replaces the live daemon', async () => {
    const childA = createFakeChild();
    const childB = createFakeChild();
    spawnMock
      .mockReturnValueOnce(childA.process)
      .mockReturnValueOnce(childB.process);

    const daemon = new QwenDaemonProcess();
    const onExit = vi.fn();
    const onSuperseded = vi.fn();
    daemon.addExitListener(onExit);
    daemon.addSupersededListener(onSuperseded);

    await settle(daemon, childA, '/workspace-a', 4101);

    // The switch must tell hosts still bound to the old runtime that it is
    // gone — the suppressed exit notification never reaches them.
    const startB = daemon.start('/cli.js', '/workspace-b');
    expect(onSuperseded).toHaveBeenCalledTimes(1);

    childB.emitStdout('qwen serve listening on http://127.0.0.1:4102\n');
    await startB;

    childA.emitExit(0, 'SIGTERM');
    expect(onExit).not.toHaveBeenCalled();
    expect(onSuperseded).toHaveBeenCalledTimes(1);
  });

  it('does not treat dispose() as a supersede', async () => {
    const childA = createFakeChild();
    spawnMock.mockReturnValueOnce(childA.process);

    const daemon = new QwenDaemonProcess();
    const onSuperseded = vi.fn();
    daemon.addSupersededListener(onSuperseded);

    await settle(daemon, childA, '/workspace-a', 4101);
    daemon.dispose();

    expect(onSuperseded).not.toHaveBeenCalled();
  });

  it('stops retaining daemon output once startup settles', async () => {
    const childA = createFakeChild();
    spawnMock.mockReturnValueOnce(childA.process);

    const daemon = new QwenDaemonProcess();
    await settle(daemon, childA, '/workspace-a', 4101);

    // The daemon logs continuously for the whole IDE session; keeping the
    // data handlers attached would retain every byte in the extension host.
    expect(childA.listenerCount('stdout:data')).toBe(0);
    expect(childA.listenerCount('stderr:data')).toBe(0);
  });
});
