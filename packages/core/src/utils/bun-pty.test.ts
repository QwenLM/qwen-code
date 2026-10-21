/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behavioural regression for the Bun PTY backend (bun-pty.ts).
 *
 * The suite runs under vitest/Node: the backend drives the pinned native
 * addon directly from a main-thread async `fs.read` pump, so its observable
 * contract — output streaming, writes, resize reaching the child's terminal,
 * kill/exit, pause hold, flow control, encoding, and the bounded-hold /
 * write-queue / admission resource limits — is exercised directly here. The Bun-leg round-trip through the real `getPty()` seam lives in
 * bun-pty.node-bun.test.ts.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CONCURRENT_WEB_TERMINALS } from '../services/web-terminal-registry.js';
import { cleanupPtys, waitFor } from './bun-pty-test-utils.js';
import {
  getPtyBudgetStats,
  processPtyBudget,
  PtyLimitError,
  spawn,
} from './bun-pty.js';

type FsReadCallback = (
  err: NodeJS.ErrnoException | null,
  bytesRead: number,
  buffer: Buffer,
) => void;
type FsWriteCallback = (
  err: NodeJS.ErrnoException | null,
  written: number,
  buffer: Buffer,
) => void;

// The fd-lifetime tests decide exactly when an in-flight libuv op settles.
// node:fs is an ESM namespace (its exports cannot be redefined for
// vi.spyOn), so the module is mocked with a passthrough that captures read
// and write callbacks — and records closeSync — only while a test arms it.
const fsCapture = vi.hoisted(() => ({
  armed: false,
  reads: [] as Array<{
    buffer: Buffer;
    callback: (err: NodeJS.ErrnoException | null, bytesRead: number) => void;
  }>,
  writes: [] as Array<{
    callback: (err: NodeJS.ErrnoException | null, written: number) => void;
  }>,
  closes: [] as number[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    read: (...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (
        fsCapture.armed &&
        args.length === 6 &&
        typeof callback === 'function'
      ) {
        const buffer = args[1] as Buffer;
        fsCapture.reads.push({
          buffer,
          callback: (err, bytesRead) => {
            (callback as FsReadCallback)(err, bytesRead, buffer);
          },
        });
        return undefined;
      }
      return (actual.read as (...a: unknown[]) => unknown)(...args);
    },
    write: (...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (fsCapture.armed && typeof callback === 'function') {
        fsCapture.writes.push({
          callback: (err, written) => {
            (callback as FsWriteCallback)(err, written, Buffer.alloc(0));
          },
        });
        return undefined;
      }
      return (actual.write as (...a: unknown[]) => unknown)(...args);
    },
    closeSync: (fd: number) => {
      if (fsCapture.armed) fsCapture.closes.push(fd);
      actual.closeSync(fd);
    },
  };
});

const POSIX = process.platform !== 'win32';

// The OS pty driver occasionally inserts an extra CR before LF (a plain
// `script(1)` probe reproduces it on macOS), so strict byte identity is not
// an available oracle for a stream read through the master. Collapse runs of
// CR before LF; line content, order, duplication and loss still compare
// exactly.
const withoutPtyCrJitter = (stream: string): string =>
  stream.replace(/\r+\n/g, '\r\n');

const fdOf = (pty: unknown): number => (pty as { fd: number }).fd;

const expectFdClosed = (pty: unknown): void => {
  try {
    fs.fstatSync(fdOf(pty));
    throw new Error('expected the master fd to be closed, but fstat succeeded');
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe('EBADF');
  }
};

describe.skipIf(!POSIX)('BunPtyProcess', () => {
  const live: Array<ReturnType<typeof spawn>> = [];
  let baseline = getPtyBudgetStats();
  beforeEach(() => {
    baseline = getPtyBudgetStats();
  });
  const ownedSpawn: typeof spawn = (...args) => {
    const pty = spawn(...args);
    live.push(pty);
    return pty;
  };
  afterEach(() => cleanupPtys(live, baseline));

  it('streams child output through onData and reports the exit', async () => {
    const pty = ownedSpawn('/bin/sh', ['-c', 'echo BUN_PTY_ECHO_OK']);
    let output = '';
    const disposables = [pty.onData((data) => (output += data))];
    let exit: { exitCode: number; signal?: number } | undefined;
    disposables.push(pty.onExit((e) => (exit = e)));

    expect(await waitFor(() => output.includes('BUN_PTY_ECHO_OK'))).toBe(true);
    expect(await waitFor(() => exit !== undefined, 5_000)).toBe(true);
    expect(typeof pty.pid).toBe('number');
    expect(pty.pid).toBeGreaterThan(0);
    for (const dispose of disposables) dispose.dispose();
  }, 20_000);

  it('forwards writes to the child', async () => {
    const pty = ownedSpawn('/bin/sh', []);
    let output = '';
    pty.onData((data) => (output += data));
    await waitFor(() => output.length > 0);
    pty.write('echo $((21+21))\n');
    expect(await waitFor(() => output.includes('42'))).toBe(true);
    pty.kill();
  }, 20_000);

  it('sanitizes the inherited environment only when it comes from process.env', async () => {
    const keys = [
      'TMUX',
      'TMUX_PANE',
      'STY',
      'WINDOW',
      'WINDOWID',
      'TERMCAP',
      'COLUMNS',
      'LINES',
    ] as const;
    const original = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = `QWEN_SENTINEL_${key}`;
    const command =
      'printf "ENV=[%s|%s|%s|%s|%s|%s|%s|%s] TERM=[%s] PWD=[%s]" "$TMUX" "$TMUX_PANE" "$STY" "$WINDOW" "$WINDOWID" "$TERMCAP" "$COLUMNS" "$LINES" "$TERM" "$PWD"';
    const check = async (
      env: typeof process.env | undefined,
      expected: string,
    ) => {
      const pty = ownedSpawn('/bin/sh', ['-c', command], {
        ...(env === undefined ? {} : { env }),
        cwd: '/',
        name: 'xterm-qwen-sentinel',
      });
      let output = '';
      pty.onData((data) => (output += data));
      expect(await waitFor(() => output.includes(expected), 5000)).toBe(true);
      expect(output).toContain('TERM=[xterm-qwen-sentinel] PWD=[/]');
    };
    try {
      await check(undefined, 'ENV=[|||||||]');
      // Reference identity, not a spread copy, must exercise this branch.
      await check(process.env, 'ENV=[|||||||]');
      await check(
        { ...process.env },
        'ENV=[' + keys.map((key) => process.env[key]).join('|') + ']',
      );
    } finally {
      for (const key of keys) {
        const value = original.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 20_000);

  it('passes spawn-time geometry and cwd to the child before any resize', async () => {
    // Root differs from this test process cwd and has a stable physical path.
    expect(process.cwd()).not.toBe('/');
    const pty = ownedSpawn('/bin/sh', ['-c', 'stty size; pwd -P'], {
      cols: 103,
      rows: 37,
      cwd: '/',
    });
    let output = '';
    pty.onData((data) => (output += data));
    expect(await waitFor(() => output.includes('37 103\r\n/\r\n'), 5000)).toBe(
      true,
    );
    expect(pty.cols).toBe(103);
    expect(pty.rows).toBe(37);
  });

  it('resizes the terminal the child observes', async () => {
    const pty = ownedSpawn('/bin/sh', []);
    let output = '';
    pty.onData((data) => (output += data));
    await waitFor(() => output.length > 0);

    pty.resize(100, 40);
    expect(pty.cols).toBe(100);
    expect(pty.rows).toBe(40);
    pty.write('stty size\n');
    // stty prints "<rows> <cols>".
    expect(await waitFor(() => output.includes('40 100'))).toBe(true);
    expect(() => pty.resize(0, 10)).toThrow(/positive cols and rows/);
    pty.kill();
  }, 20_000);

  it('delivers the exit event after kill and reaps the child', async () => {
    const pty = ownedSpawn('/bin/sh', ['-c', 'echo READY; read x']);
    let output = '';
    pty.onData((data) => (output += data));
    expect(await waitFor(() => output.includes('READY'))).toBe(true);

    let exit: { exitCode: number; signal?: number } | undefined;
    pty.onExit((e) => (exit = e));
    pty.kill('SIGHUP');

    expect(await waitFor(() => exit !== undefined, 5_000)).toBe(true);
    expect(exit!.signal).toBe(1);
  }, 20_000);

  it('reports a throwing exit listener and continues delivery after a real child exit', async () => {
    const baseline = getPtyBudgetStats();
    const live = [ownedSpawn('/bin/sh', ['-c', 'exit 0'])];
    try {
      const pty = live[0]!;
      const first = vi.fn(() => {
        throw new Error('native exit listener boom');
      });
      const diagnostic = vi.fn((error: Error) => {
        throw error;
      });
      const second = vi.fn();
      pty.onExit(first);
      pty.on('error', diagnostic);
      pty.onExit(second);

      expect(await waitFor(() => second.mock.calls.length > 0, 5_000)).toBe(
        true,
      );
      expect(first).toHaveBeenCalledExactlyOnceWith({
        exitCode: 0,
        signal: 0,
      });
      expect(second).toHaveBeenCalledExactlyOnceWith({
        exitCode: 0,
        signal: 0,
      });
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic.mock.calls[0]![0].message).toBe(
        'pty exit listener threw: native exit listener boom',
      );
      expectFdClosed(pty);
    } finally {
      await cleanupPtys(live, baseline);
    }
  });

  it('resumes output after pause/resume', async () => {
    const pty = ownedSpawn('/bin/sh', []);
    let output = '';
    pty.onData((data) => (output += data));
    await waitFor(() => output.length > 0);

    pty.pause();
    pty.write('echo PAUSED_MARKER_7\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(output).not.toContain('PAUSED_MARKER_7');

    pty.resume();
    expect(await waitFor(() => output.includes('PAUSED_MARKER_7'))).toBe(true);
    pty.kill();
  }, 20_000);

  it('delivers exit exactly once and closes the fd when the child exits while paused', async () => {
    const baseline = getPtyBudgetStats();
    const live = [
      ownedSpawn('/bin/sh', [
        '-c',
        'echo READY; read x; echo TAIL_AFTER_PAUSE; exit 7',
      ]),
    ];
    try {
      const pty = live[0]!;
      let output = '';
      pty.onData((data) => (output += data));
      let exits = 0;
      let exit: { exitCode: number; signal?: number } | undefined;
      pty.onExit((e) => {
        exits += 1;
        exit = e;
      });

      expect(await waitFor(() => output.includes('READY'), 5_000)).toBe(true);
      pty.pause();
      pty.write('go\n');

      expect(await waitFor(() => exits > 0, 5_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(exits).toBe(1);
      expect(exit!.exitCode).toBe(7);
      // Wrapper parity: a paused consumer receives no data, not even the tail.
      expect(output).not.toContain('TAIL_AFTER_PAUSE');
      expectFdClosed(pty);
    } finally {
      await cleanupPtys(live, baseline);
    }
  }, 20_000);

  it('keeps exit detection while paused output floods past 3 MB', async () => {
    // The raw flood is 3 MB and reaches the master as ~4.5 MB (ONLCR), so the
    // hold cap is sized explicitly to keep the reads going: a parked pump
    // would leave the child blocked on write instead of exiting.
    const pty = ownedSpawn(
      '/bin/sh',
      ['-c', 'yes X | head -c 3000000; exit 0'],
      {
        limits: { pausedHoldBytes: 16 * 1024 * 1024 },
      },
    );
    pty.pause();
    let exits = 0;
    pty.onExit(() => {
      exits += 1;
    });

    expect(await waitFor(() => exits > 0, 10_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(exits).toBe(1);
    expectFdClosed(pty);
  }, 30_000);

  it('delivers the full stream across rapid no-gap pause/resume toggles', async () => {
    const LINES = 20_000;
    const pty = ownedSpawn('/bin/sh', [
      '-c',
      `awk 'BEGIN{for(i=0;i<${LINES};i++)print "LINE " i}'; sleep 30`,
    ]);
    let output = '';
    pty.onData((data) => (output += data));

    // Toggle while the flood is actively streaming, with no gap between
    // pause and resume, so resume() lands while a master-fd read is still in
    // flight — the exact shape of the shared-read-buffer race.
    expect(await waitFor(() => output.length > 0)).toBe(true);
    for (let i = 0; i < 500; i += 1) {
      pty.pause();
      pty.resume();
    }

    expect(
      await waitFor(() => output.includes(`LINE ${LINES - 1}`), 15_000),
    ).toBe(true);
    pty.kill();

    const expected =
      Array.from({ length: LINES }, (_, i) => `LINE ${i}`).join('\r\n') +
      '\r\n';
    // Catches duplication, fragmentation, loss and reordering; the pty's
    // extra CR before LF is not the backend's.
    expect(withoutPtyCrJitter(output)).toBe(expected);
    // Line-by-line: every line value, in order.
    const lines = withoutPtyCrJitter(output)
      .split('\r\n')
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(LINES);
    for (let i = 0; i < LINES; i += 1) {
      expect(lines[i]).toBe(`LINE ${i}`);
    }
  }, 40_000);

  it('holds the entire flood while paused and resumes it without loss', async () => {
    const LINES = 200_000;
    const pty = ownedSpawn('/bin/sh', [
      '-c',
      `awk 'BEGIN{for(i=0;i<${LINES};i++)print "X" i}'; sleep 30`,
    ]);
    let output = '';
    pty.onData((data) => (output += data));

    // Pause before the flood arrives: ~1.9 MB accumulates in the lossless
    // hold while the pump keeps reading at full speed (exit detection stays
    // live), and the child runs to its sleep 30 long before resume.
    pty.pause();
    await new Promise((r) => setTimeout(r, 2_000));
    pty.resume();

    expect(await waitFor(() => output.includes(`X${LINES - 1}`), 20_000)).toBe(
      true,
    );
    pty.kill();

    const expected =
      Array.from({ length: LINES }, (_, i) => `X${i}`).join('\r\n') + '\r\n';
    // Nothing dropped while paused — line-exact (the pty's extra CR before
    // LF aside).
    expect(withoutPtyCrJitter(output).length).toBe(expected.length);
    expect(withoutPtyCrJitter(output)).toBe(expected);
    const lines = withoutPtyCrJitter(output)
      .split('\r\n')
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(LINES);
    expect(lines[0]).toBe('X0');
    expect(lines[LINES - 1]).toBe(`X${LINES - 1}`);
  }, 40_000);

  it('releases the fd when flow-control pause is followed by cancel', async () => {
    const baseline = getPtyBudgetStats();
    const live = [
      ownedSpawn(
        '/bin/sh',
        ['-c', 'echo READY; read x; echo HELD_AFTER_XOFF; read y'],
        { handleFlowControl: true },
      ),
    ];
    try {
      const pty = live[0]!;
      let output = '';
      pty.onData((data) => (output += data));
      let exits = 0;
      let exit: { exitCode: number; signal?: number } | undefined;
      pty.onExit((e) => {
        exits += 1;
        exit = e;
      });

      expect(await waitFor(() => output.includes('READY'), 5_000)).toBe(true);
      const beforePause = output;
      pty.write('\x13'); // XOFF
      expect(pty.stats.paused).toBe(true);
      pty.write('go\n');
      const heldBytes = Buffer.byteLength('go\r\nHELD_AFTER_XOFF\r\n');
      expect(
        await waitFor(() => pty.stats.pausedBytes >= heldBytes, 5_000),
      ).toBe(true);
      expect(output).toBe(beforePause);
      expect(pty.stats.resourceFailed).toBe(false);
      pty.kill('SIGHUP'); // cancel while paused

      expect(await waitFor(() => exits > 0, 5_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(exits).toBe(1);
      expect(exit!.signal).toBe(1);
      expect(pty.stats.pausedBytes).toBe(0);
      expect(output).toBe(beforePause);
      expectFdClosed(pty);
    } finally {
      await cleanupPtys(live, baseline);
    }
  }, 20_000);

  it('intercepts flow-control messages when handleFlowControl is on', async () => {
    const pty = ownedSpawn('/bin/sh', [], { handleFlowControl: true });
    let output = '';
    pty.onData((data) => (output += data));
    await waitFor(() => output.length > 0);

    pty.write('\x13');
    pty.write('echo FLOW_CTRL_OK\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(output).not.toContain('FLOW_CTRL_OK');

    pty.write('\x11');
    expect(await waitFor(() => output.includes('FLOW_CTRL_OK'))).toBe(true);
    pty.kill();
  }, 20_000);

  it('passes raw buffers through with encoding null', async () => {
    const pty = ownedSpawn('/bin/sh', ['-c', 'echo RAW_BUFFER_OK'], {
      encoding: null,
    });
    let chunk: string | Buffer | undefined;
    pty.onData((data) => {
      chunk ??= data;
    });

    expect(await waitFor(() => chunk !== undefined)).toBe(true);
    expect(Buffer.isBuffer(chunk)).toBe(true);
    pty.kill();
  }, 20_000);

  it('exposes a process title', () => {
    const pty = ownedSpawn('/bin/sh', ['-c', 'read x']);
    expect(typeof pty.process).toBe('string');
    expect(pty.process.length).toBeGreaterThan(0);
    expect(() => pty.clear()).not.toThrow();
    pty.kill();
  }, 20_000);
});

describe.skipIf(!POSIX)('bounded pause hold and resource limits', () => {
  type Spawned = ReturnType<typeof spawn>;

  // Failure isolation: a test that aborts before its happy-path kill must
  // not leak a live child, an admission slot, or a charged hold into the
  // next case.
  const live: Spawned[] = [];
  const track = (pty: Spawned): Spawned => {
    live.push(pty);
    return pty;
  };
  afterEach(() => cleanupPtys(live));

  const nextError = (pty: Spawned): { errors: PtyLimitError[] } => {
    const errors: PtyLimitError[] = [];
    pty.on('error', (error: Error) => {
      errors.push(error as PtyLimitError);
    });
    return { errors };
  };

  const waitForFdClosed = (pty: Spawned): Promise<boolean> =>
    waitFor(() => {
      try {
        fs.fstatSync(fdOf(pty));
        return false;
      } catch {
        return true;
      }
    });

  const waitForChildGone = (pty: Spawned): Promise<boolean> =>
    waitFor(() => {
      try {
        process.kill(pty.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);

  it('parks reads at the per-pty hold cap: the child stays alive and the stream resumes byte-exact', async () => {
    const LIMIT = 128 * 1024;
    const LINES = 200_000;
    const pty = track(
      spawn(
        '/bin/sh',
        [
          '-c',
          `awk 'BEGIN{for(i=0;i<${LINES};i++)print "P" i}'; echo FLOOD_DONE; read x; echo GOT_$x`,
        ],
        { limits: { pausedHoldBytes: LIMIT } },
      ),
    );
    const { errors } = nextError(pty);
    let exits = 0;
    pty.onExit(() => {
      exits += 1;
    });
    let output = '';
    pty.onData((data) => {
      output += data;
    });

    pty.pause();
    expect(await waitFor(() => pty.stats.readParked)).toBe(true);
    const held = pty.stats.pausedBytes;
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThanOrEqual(LIMIT);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(held);

    // Parked, not failed: no error, no exit, nothing delivered, the hold no
    // longer grows, the fd is open and the child is alive — blocked on its
    // write behind the full kernel buffer, as behind the wrapper's paused
    // socket.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(pty.stats.readParked).toBe(true);
    expect(pty.stats.pausedBytes).toBe(held);
    expect(pty.stats.resourceFailed).toBe(false);
    expect(errors).toHaveLength(0);
    expect(exits).toBe(0);
    expect(output).toBe('');
    fs.fstatSync(fdOf(pty));
    expect(() => process.kill(pty.pid, 0)).not.toThrow();

    // resume() restarts the reads: nothing was dropped, and the child is
    // still interactive afterwards.
    pty.resume();
    expect(pty.stats.readParked).toBe(false);
    expect(await waitFor(() => output.includes('FLOOD_DONE'), 20_000)).toBe(
      true,
    );
    const expected =
      Array.from({ length: LINES }, (_, i) => `P${i}`).join('\r\n') +
      '\r\nFLOOD_DONE\r\n';
    expect(output).toBe(expected);
    pty.write('ok\n');
    expect(await waitFor(() => output.includes('GOT_ok'))).toBe(true);
    expect(await waitFor(() => exits === 1)).toBe(true);
    expect(errors).toHaveLength(0);
    expect(await waitForFdClosed(pty)).toBe(true);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(0);
  }, 40_000);

  it('reports the exit of a child killed while its reads are parked', async () => {
    // Linux reaps the killed child at once and the parked exit drains on the
    // fallback timer; macOS finishes the exit of a child with undrained
    // output only once the master is read again, which is why the shell
    // tool's cancel resumes before it signals. Either way exactly one real
    // exit is delivered and every budget is released.
    const LIMIT = 64 * 1024;
    const pty = track(
      spawn('/bin/sh', ['-c', 'yes X | head -c 4194304; sleep 30'], {
        limits: { pausedHoldBytes: LIMIT },
      }),
    );
    const { errors } = nextError(pty);
    let exits = 0;
    let exit: { exitCode: number; signal?: number } | undefined;
    pty.onExit((e) => {
      exits += 1;
      exit = e;
    });
    pty.onData(() => {});

    pty.pause();
    expect(await waitFor(() => pty.stats.readParked)).toBe(true);
    process.kill(-pty.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));
    pty.resume();

    expect(await waitFor(() => exits > 0)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(exits).toBe(1);
    expect(exit!.signal).toBe(9);
    expect(errors).toHaveLength(0);
    expect(await waitForFdClosed(pty)).toBe(true);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(0);
  }, 30_000);

  it('holds a flood under the cap without loss and stays alive until resume', async () => {
    const LINES = 8000;
    const expected =
      Array.from({ length: LINES }, (_, i) => `K${i}`).join('\r\n') + '\r\n';
    const expectedBytes = Buffer.byteLength(expected);
    // 54,890 master bytes include ONLCR expansion; only 64 bytes remain.
    const LIMIT = expectedBytes + 64;
    const pty = track(
      spawn(
        '/bin/sh',
        ['-c', `awk 'BEGIN{for(i=0;i<${LINES};i++)print "K" i}'; sleep 30`],
        { limits: { pausedHoldBytes: LIMIT } },
      ),
    );
    const { errors } = nextError(pty);
    let output = '';
    pty.onData((data) => {
      output += data;
    });

    pty.pause();
    // The OS pty's extra CR can push the hold past the logical byte count,
    // so wait for the whole flood rather than an exact value.
    expect(
      await waitFor(() => pty.stats.pausedBytes >= expectedBytes, 10_000),
    ).toBe(true);
    expect(output).toBe('');
    expect(pty.stats.resourceFailed).toBe(false);
    expect(pty.stats.pausedBytes).toBeLessThanOrEqual(LIMIT);
    expect(errors.length).toBe(0);
    fs.fstatSync(fdOf(pty)); // still open: nothing was terminated

    pty.resume();
    expect(
      await waitFor(() => Buffer.byteLength(output) >= expectedBytes, 10_000),
    ).toBe(true);
    expect(withoutPtyCrJitter(output)).toBe(expected);
    expect(errors).toHaveLength(0);
    expect(pty.stats.resourceFailed).toBe(false);

    pty.kill();
    expect(await waitForFdClosed(pty)).toBe(true);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(0);
  }, 30_000);

  it('parks the pty that reaches the process-wide hold budget without failing either', async () => {
    const original = processPtyBudget.totalPausedHoldBytes;
    const TOTAL = 160 * 1024;
    processPtyBudget.totalPausedHoldBytes = TOTAL;
    try {
      expect(getPtyBudgetStats().pausedHoldBytes).toBe(0);

      // A floods ~100 KB of master bytes (ONLCR included) and parks there,
      // well under the 160 KB global cap.
      const aLines = Array.from({ length: 15000 }, (_, i) => `A${i}`);
      const aExpected = aLines.join('\r\n') + '\r\n';
      const aExpectedBytes = Buffer.byteLength(aExpected);
      const a = track(
        spawn('/bin/sh', [
          '-c',
          'awk \'BEGIN{for(i=0;i<15000;i++)print "A" i}\'; sleep 30',
        ]),
      );
      const aErrors = nextError(a);
      let aOutput = '';
      a.onData((data) => {
        aOutput += data;
      });
      a.pause();
      // The OS pty occasionally emits an extra CR before LF (reproduced with
      // a plain `script(1)` probe on macOS), and the 25 ms poll can also step
      // over an exact value. Wait for the whole flood to be held instead.
      expect(
        await waitFor(() => a.stats.pausedBytes >= aExpectedBytes, 20_000),
      ).toBe(true);

      // B floods 3 MiB of master bytes: the shared total, not B's own 4 MiB
      // cap, parks it — exactly at the total, with no error and no kill.
      const b = track(
        spawn('/bin/sh', [
          '-c',
          'sleep 0.3; yes X | head -c 2097152; sleep 30',
        ]),
      );
      const bErrors = nextError(b);
      let bBytes = 0;
      b.onData((data) => {
        bBytes += Buffer.byteLength(data);
      });
      b.pause();
      expect(await waitFor(() => b.stats.readParked, 15_000)).toBe(true);
      expect(getPtyBudgetStats().pausedHoldBytes).toBe(TOTAL);
      expect(b.stats.pausedBytes).toBe(TOTAL - a.stats.pausedBytes);
      expect(bErrors.errors).toHaveLength(0);
      expect(b.stats.resourceFailed).toBe(false);
      expect(() => process.kill(b.pid, 0)).not.toThrow();

      // A keeps its hold, its child and zero errors, and replays every line.
      expect(a.stats.resourceFailed).toBe(false);
      expect(aErrors.errors).toHaveLength(0);
      a.resume();
      expect(
        await waitFor(() => aOutput.includes(`A${aLines.length - 1}`), 20_000),
      ).toBe(true);
      expect(withoutPtyCrJitter(aOutput)).toBe(aExpected);

      // B's own resume() restarts its reads and loses nothing.
      b.resume();
      expect(await waitFor(() => bBytes >= 3 * 1024 * 1024, 15_000)).toBe(true);
      expect(bErrors.errors).toHaveLength(0);
      a.kill();
      b.kill();
      expect(await waitForFdClosed(a)).toBe(true);
      expect(await waitForFdClosed(b)).toBe(true);
    } finally {
      processPtyBudget.totalPausedHoldBytes = original;
    }
  }, 40_000);

  it('terminates with an explicit error when queued writes pass the cap', async () => {
    const LIMIT = 64 * 1024;
    const pty = track(
      spawn('/bin/sh', ['-c', 'sleep 30'], {
        limits: { writeQueueBytes: LIMIT },
      }),
    );
    const { errors } = nextError(pty);
    let exits = 0;
    pty.onExit(() => {
      exits += 1;
    });

    // A synchronous burst cannot interleave with the async write drain, so
    // the queue grows monotonically until the cap rejects it.
    const chunk = Buffer.alloc(4096, 0x57);
    for (let i = 0; i < 40; i += 1) pty.write(chunk);

    expect(errors.length).toBe(1);
    const error = errors[0]!;
    expect(error).toBeInstanceOf(PtyLimitError);
    expect(error.code).toBe('QWEN_PTY_WRITE_LIMIT');
    expect(error.limitKind).toBe('write-queue-per-pty');
    expect(error.limit).toBe(LIMIT);
    expect(error.acceptedBytes).toBeGreaterThan(0);
    expect(error.acceptedBytes).toBeLessThanOrEqual(LIMIT);
    expect(error.hasUndeliveredData).toBe(true);
    expect(error.message).toContain('undelivered input was discarded');

    expect(pty.stats.resourceFailed).toBe(true);
    expect(pty.stats.writeQueuedBytes).toBe(0);
    // The close is deferred until the in-flight write settles, so it lands
    // asynchronously here — never synchronously at the cap trip.
    expect(await waitForFdClosed(pty)).toBe(true);
    expect(await waitForChildGone(pty)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(exits).toBe(0);
  }, 20_000);

  it('kills a foreground job in its own process group when a limit trips', async () => {
    // An interactive shell runs the job in a new process group, and this job
    // ignores SIGTERM and SIGHUP: signalling only the leader and the leader's
    // group would leave it running after the failure is reported.
    const job = `perl -e '$SIG{TERM}=$SIG{HUP}="IGNORE"; print "JOB $$\\n"; sleep 60'`;
    const pty = track(
      spawn(
        '/bin/bash',
        ['--norc', '--noprofile', '-i', '-c', `${job}; echo after`],
        { limits: { writeQueueBytes: 4096 } },
      ),
    );
    const { errors } = nextError(pty);
    let output = '';
    pty.onData((data) => {
      output += data;
    });
    expect(await waitFor(() => /JOB \d+\r?\n/.test(output))).toBe(true);
    const jobPid = Number(/JOB (\d+)/.exec(output)![1]);
    const psField = (field: string): string =>
      spawnSync('ps', ['-o', `${field}=`, '-p', String(jobPid)], {
        encoding: 'utf8',
      }).stdout.trim();
    // A reparented zombie still answers kill(pid, 0) until it is reaped.
    const jobLive = (): boolean => {
      try {
        process.kill(jobPid, 0);
      } catch {
        return false;
      }
      return !psField('stat').startsWith('Z');
    };
    try {
      expect(Number(psField('pgid'))).not.toBe(pty.pid);

      pty.write(Buffer.alloc(8192));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe('QWEN_PTY_WRITE_LIMIT');
      // SIGTERM is ignored; the SIGKILL pass after the grace period must
      // still reach the job by ownership.
      expect(await waitFor(() => !jobLive(), 5_000)).toBe(true);
      expect(await waitForChildGone(pty)).toBe(true);
    } finally {
      try {
        process.kill(jobPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, 20_000);

  it('delivers the reaped exit and skips the signal volley when a limit trips after the native exit', async (ctx) => {
    // Linux-only witness: macOS ends the master side as soon as the session
    // leader exits (a plain-pty probe reads EOF ~70 ms later even with a
    // HUP-ignoring grandchild), so the pump closes the fd before this write
    // and there is no drain window to trip a limit in — the write is a no-op
    // and the real exit is still delivered. The same guard is pinned on every
    // platform by bun-pty-failure-order.test.ts with a mocked native exit.
    if (process.platform !== 'linux') ctx.skip();
    // A grandchild holding the slave parks the observed exit inside the
    // drain window (the HUP trap keeps it alive past the session leader's
    // exit — Linux SIGHUPs the foreground group when the leader dies). A
    // write-queue trip in that window must not signal the reaped pid (it
    // may be recycled) and must not discard the real exit.
    const killSpy = vi.spyOn(process, 'kill');
    const pty = track(
      spawn('/bin/sh', ['-c', 'trap "" HUP; sleep 30 & exit 3'], {
        limits: { writeQueueBytes: 4096 },
      }),
    );
    const { errors } = nextError(pty);
    const order: string[] = [];
    pty.on('error', () => order.push('error'));
    let exit: { exitCode: number; signal?: number } | undefined;
    pty.onExit((e) => {
      order.push('exit');
      exit = e;
    });
    try {
      expect(await waitForChildGone(pty)).toBe(true);
      killSpy.mockClear();

      pty.write(Buffer.alloc(8192));

      expect(errors.length).toBe(1);
      expect(errors[0]!.code).toBe('QWEN_PTY_WRITE_LIMIT');
      // The real terminal status is delivered, not overwritten by the limit.
      expect(await waitFor(() => exit !== undefined)).toBe(true);
      // The structured failure must reach consumers before the parked exit:
      // they settle once, and the exit listener detaches the failure one.
      expect(order).toEqual(['error', 'exit']);
      expect(exit!.exitCode).toBe(3);
      expect(pty.stats.nativeExitRecord).toEqual({ exitCode: 3, signal: 0 });
      // No SIGTERM/SIGKILL at the reaped pid or its group — not even the
      // deferred safety net (this wait outlasts RESOURCE_KILL_GRACE_MS).
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(killSpy).not.toHaveBeenCalled();
      expect(await waitForFdClosed(pty)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  }, 20_000);

  it('leaves spawn headroom over the web-terminal admission cap', () => {
    // A full house of legitimate web terminals must not exhaust the
    // process-wide pty budget and starve the shell tool's spawns.
    expect(processPtyBudget.maxActivePtys).toBeGreaterThan(
      MAX_CONCURRENT_WEB_TERMINALS,
    );
  });

  it('admits ptys up to the process-wide cap and frees the slot on close', async () => {
    const original = processPtyBudget.maxActivePtys;
    processPtyBudget.maxActivePtys = 1;
    try {
      expect(getPtyBudgetStats().activePtys).toBe(0);

      const first = track(spawn('/bin/sh', ['-c', 'sleep 30']));
      let caught: unknown;
      try {
        spawn('/bin/sh', ['-c', 'sleep 30']);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PtyLimitError);
      const limitError = caught as PtyLimitError;
      expect(limitError.code).toBe('QWEN_PTY_ACTIVE_LIMIT');
      expect(limitError.limitKind).toBe('active-pty-count');
      expect(limitError.limit).toBe(1);
      // A refusal spawns nothing: the message must not claim a pty was
      // terminated, and acceptedBytes stays a byte count — zero here — not
      // a live-pty count.
      expect(limitError.message).toContain('no pty was spawned');
      expect(limitError.message).not.toContain('terminated');
      expect(limitError.acceptedBytes).toBe(0);

      first.kill();
      expect(await waitFor(() => getPtyBudgetStats().activePtys === 0)).toBe(
        true,
      );

      const second = track(spawn('/bin/sh', ['-c', 'sleep 30']));
      expect(second.pid).toBeGreaterThan(0);
      second.kill();
      expect(await waitFor(() => getPtyBudgetStats().activePtys === 0)).toBe(
        true,
      );
    } finally {
      processPtyBudget.maxActivePtys = original;
    }
  }, 30_000);

  it('tracks hold, queue and admit counts in the process budget stats', async () => {
    const baseline = getPtyBudgetStats();
    expect(baseline.pausedHoldBytes).toBe(0);
    expect(baseline.writeQueueBytes).toBe(0);

    const pty = track(
      spawn('/bin/sh', [
        '-c',
        'awk \'BEGIN{for(i=0;i<15000;i++)print "O" i}\'; sleep 30',
      ]),
    );
    pty.pause();
    expect(
      await waitFor(() => getPtyBudgetStats().pausedHoldBytes >= 50_000),
    ).toBe(true);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(pty.stats.pausedBytes);
    expect(getPtyBudgetStats().activePtys).toBeGreaterThanOrEqual(1);

    pty.resume();
    expect(await waitFor(() => getPtyBudgetStats().pausedHoldBytes === 0)).toBe(
      true,
    );
    pty.kill();
    expect(
      await waitFor(
        () => getPtyBudgetStats().activePtys === baseline.activePtys,
      ),
    ).toBe(true);
  }, 30_000);
});

describe.skipIf(!POSIX)('fd lifetime and write-error races', () => {
  const live: Array<ReturnType<typeof spawn>> = [];
  const ownedSpawn: typeof spawn = (...args) => {
    const pty = spawn(...args);
    live.push(pty);
    return pty;
  };

  const armFsCapture = (): (() => Promise<void>) => {
    const baseline = getPtyBudgetStats();
    fsCapture.armed = true;
    fsCapture.reads = [];
    fsCapture.writes = [];
    fsCapture.closes = [];
    return async () => {
      const errors: unknown[] = [];
      try {
        // Finish every captured operation while capture still owns it. EIO
        // stops the pump and write drain without dispatching another I/O.
        while (fsCapture.writes.length > 0 || fsCapture.reads.length > 0) {
          const callbacks = [
            ...fsCapture.writes.splice(0),
            ...fsCapture.reads.splice(0),
          ];
          for (const held of callbacks) {
            try {
              held.callback(eio(), 0);
            } catch (error) {
              errors.push(error);
            }
          }
        }
        try {
          await cleanupPtys(live, baseline);
        } catch (error) {
          errors.push(error);
        }
      } finally {
        fsCapture.armed = false;
        fsCapture.reads = [];
        fsCapture.writes = [];
        fsCapture.closes = [];
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Captured PTY cleanup failed');
      }
    };
  };

  const deliverOutput = (
    read: (typeof fsCapture.reads)[number],
    text: string,
  ) => {
    const bytes = Buffer.from(text, 'utf8');
    bytes.copy(read.buffer);
    read.callback(null, bytes.byteLength);
  };

  const eio = () => Object.assign(new Error('read EIO'), { code: 'EIO' });

  const spawnAndTripWriteCap = () => {
    const pty = ownedSpawn('/bin/sh', ['-c', 'sleep 30'], {
      limits: { writeQueueBytes: 64 * 1024 },
    });
    const errors: Error[] = [];
    pty.on('error', (error: Error) => errors.push(error));
    // A synchronous burst cannot interleave with the async write drain, so
    // the queue grows until the cap rejects it — with the first fs.write
    // held by the capture, terminateResourceFailure runs while writeActive.
    const chunk = Buffer.alloc(4096, 0x57);
    for (let i = 0; i < 40; i += 1) pty.write(chunk);
    expect(errors).toHaveLength(1);
    expect((errors[0] as PtyLimitError).code).toBe('QWEN_PTY_WRITE_LIMIT');
    return pty;
  };

  it('defers the fd close while a write is still owned by the threadpool', async () => {
    const cleanup = armFsCapture();
    const baseline = getPtyBudgetStats().activePtys;
    try {
      const pty = spawnAndTripWriteCap();
      const fd = fdOf(pty);
      expect(pty.stats.writeActive).toBe(true);
      expect(pty.stats.readInFlight).toBe(true);

      // fdClosed flipped and the admission slot is already released, but the
      // real close is deferred: closeSync must not run against a live op —
      // the recycled descriptor number would take the next open() instead.
      expect(getPtyBudgetStats().activePtys).toBe(baseline);
      const closesOf = () =>
        fsCapture.closes.filter((closed) => closed === fd).length;
      expect(closesOf()).toBe(0);

      // Settling the held read first must not close: the write is still
      // outstanding.
      fsCapture.reads.shift()!.callback(eio(), 0);
      expect(closesOf()).toBe(0);

      // The last outstanding op performs the close, exactly once.
      fsCapture.writes.shift()!.callback(null, 4096);
      expect(closesOf()).toBe(1);
      expectFdClosed(pty);
    } finally {
      await cleanup();
    }
  });

  it('defers the fd close while a read is still owned by the threadpool', async () => {
    const cleanup = armFsCapture();
    const baseline = getPtyBudgetStats().activePtys;
    try {
      const pty = spawnAndTripWriteCap();
      const fd = fdOf(pty);

      expect(getPtyBudgetStats().activePtys).toBe(baseline);
      const closesOf = () =>
        fsCapture.closes.filter((closed) => closed === fd).length;
      expect(closesOf()).toBe(0);

      // Settling the held write first must not close: the read is still
      // outstanding.
      fsCapture.writes.shift()!.callback(null, 4096);
      expect(closesOf()).toBe(0);

      // The read settling performs the close, exactly once.
      fsCapture.reads.shift()!.callback(eio(), 0);
      expect(closesOf()).toBe(1);
      expectFdClosed(pty);
    } finally {
      await cleanup();
    }
  });

  it('enforces the process-wide write-queue budget across ptys', async () => {
    const cleanup = armFsCapture();
    const original = processPtyBudget.totalWriteQueueBytes;
    const baseline = getPtyBudgetStats();
    const limit = baseline.writeQueueBytes + 96 * 1024;
    processPtyBudget.totalWriteQueueBytes = limit;
    try {
      const a = ownedSpawn('/bin/sh', ['-c', 'sleep 30']);
      const b = ownedSpawn('/bin/sh', ['-c', 'sleep 30']);
      const aErrors: Error[] = [];
      a.on('error', (error: Error) => aErrors.push(error));
      const bErrors: Error[] = [];
      b.on('error', (error: Error) => bErrors.push(error));

      // The capture holds every fs.write open, so queued bytes stay charged:
      // A parks 64 KiB under its own per-pty cap, and B's growth past the
      // shared 96 KiB total terminates B only.
      const chunk = Buffer.alloc(4096, 0x57);
      for (let i = 0; i < 16; i += 1) a.write(chunk);
      expect(aErrors).toHaveLength(0);
      expect(getPtyBudgetStats().writeQueueBytes).toBe(
        baseline.writeQueueBytes + 64 * 1024,
      );

      for (let i = 0; i < 16; i += 1) b.write(chunk);
      expect(bErrors).toHaveLength(1);
      const error = bErrors[0] as PtyLimitError;
      expect(error.code).toBe('QWEN_PTY_WRITE_LIMIT');
      expect(error.limitKind).toBe('write-queue-process');
      expect(error.limit).toBe(limit);
      expect(a.stats.resourceFailed).toBe(false);
      expect(getPtyBudgetStats().writeQueueBytes).toBe(
        baseline.writeQueueBytes + 64 * 1024,
      );

      // Settle the held writes, then the held reads, so both fds close.
      for (const held of fsCapture.writes.splice(0)) {
        held.callback(
          Object.assign(new Error('write EIO'), { code: 'EIO' }),
          0,
        );
      }
      for (const held of fsCapture.reads.splice(0)) {
        held.callback(eio(), 0);
      }
      expect(getPtyBudgetStats().writeQueueBytes).toBe(
        baseline.writeQueueBytes,
      );
      expectFdClosed(a);
      expectFdClosed(b);
    } finally {
      try {
        await cleanup();
      } finally {
        processPtyBudget.totalWriteQueueBytes = original;
      }
    }
  });

  it('keeps pumping when a data-listener failure is re-thrown by an error listener', async () => {
    const cleanup = armFsCapture();
    try {
      const pty = ownedSpawn('/bin/sh', ['-c', 'sleep 30']);
      const delivered: string[] = [];
      let throwOnce = true;
      pty.onData((data) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('data listener boom');
        }
        delivered.push(String(data));
      });
      const reported: Error[] = [];
      pty.on('error', (error: Error) => {
        reported.push(error);
        throw error;
      });

      // The data listener throws on the first chunk; reportListenerError
      // contains the error listener's re-throw (no throw escapes the fs
      // callback), the failure is still reported, and the pump still
      // re-arms — otherwise output stalls forever and no exit is ever
      // detected.
      expect(fsCapture.reads).toHaveLength(1);
      expect(() =>
        deliverOutput(fsCapture.reads.shift()!, 'chunk-one'),
      ).not.toThrow();
      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toBe(
        'pty data listener threw: data listener boom',
      );
      expect(fsCapture.reads).toHaveLength(1);
      expect(pty.stats.readInFlight).toBe(true);

      // Delivery resumes on the next chunk.
      deliverOutput(fsCapture.reads.shift()!, 'chunk-two');
      expect(delivered).toEqual(['chunk-two']);
      expect(pty.stats.readInFlight).toBe(true);

      fsCapture.reads.shift()!.callback(eio(), 0);
      expectFdClosed(pty);
    } finally {
      await cleanup();
    }
  });

  it('retries an EAGAIN write on a timer instead of spinning the event loop', async () => {
    const cleanup = armFsCapture();
    try {
      const pty = ownedSpawn('/bin/sh', ['-c', 'sleep 30']);
      const errors: Error[] = [];
      pty.on('error', (error: Error) => errors.push(error));
      pty.write('keystroke');
      expect(fsCapture.writes).toHaveLength(1);

      fsCapture.writes
        .shift()!
        .callback(
          Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }),
          0,
        );

      // A bare setImmediate retry would have issued the next fs.write by
      // the next check-phase turn; the timer-backed retry must not.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fsCapture.writes).toHaveLength(0);
      expect(errors).toHaveLength(0);

      // The retry lands on the read side's cadence rather than never.
      expect(await waitFor(() => fsCapture.writes.length === 1)).toBe(true);

      // Ending the pump cancels the armed retry: nothing may write after
      // the fd is closed.
      fsCapture.writes
        .shift()!
        .callback(
          Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }),
          0,
        );
      fsCapture.reads.shift()!.callback(eio(), 0);
      const writesAtClose = fsCapture.writes.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fsCapture.writes).toHaveLength(writesAtClose);
      expectFdClosed(pty);
    } finally {
      await cleanup();
    }
  });

  it('treats a write EIO as the expected teardown race and reports nothing', async () => {
    const cleanup = armFsCapture();
    try {
      const pty = ownedSpawn('/bin/sh', ['-c', 'sleep 30']);
      const errors: Error[] = [];
      pty.on('error', (error: Error) => errors.push(error));
      pty.write('keystroke');
      expect(fsCapture.writes).toHaveLength(1);
      expect(pty.stats.writeActive).toBe(true);

      // The child is gone; the write queue is dropped and nothing is
      // reported — the pump's read side owns the teardown, matching the
      // wrapper's swallowed EIO.
      fsCapture.writes
        .shift()!
        .callback(Object.assign(new Error('write EIO'), { code: 'EIO' }), 0);
      expect(errors).toHaveLength(0);
      expect(pty.stats.writeQueuedBytes).toBe(0);
      expect(pty.stats.writeActive).toBe(false);

      fsCapture.reads.shift()!.callback(eio(), 0);
      expectFdClosed(pty);
    } finally {
      await cleanup();
    }
  });

  it('reports a non-teardown write error with its errno code preserved', async () => {
    const cleanup = armFsCapture();
    try {
      const pty = ownedSpawn('/bin/sh', ['-c', 'sleep 30']);
      const errors: Error[] = [];
      pty.on('error', (error: Error) => errors.push(error));
      pty.write('keystroke');

      fsCapture.writes
        .shift()!
        .callback(
          Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
          0,
        );
      // Every downstream classifier keys on `code`; rewrapping without it
      // escapes isExpectedPtyRaceError and becomes an uncaught exception.
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('pty write failed:');
      expect((errors[0] as NodeJS.ErrnoException).code).toBe('EPIPE');

      fsCapture.reads.shift()!.callback(eio(), 0);
      expectFdClosed(pty);
    } finally {
      await cleanup();
    }
  });
});
