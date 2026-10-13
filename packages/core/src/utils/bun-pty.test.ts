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

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getPtyBudgetStats,
  processPtyBudget,
  PtyLimitError,
  spawn,
} from './bun-pty.js';

const POSIX = process.platform !== 'win32';

const fdOf = (pty: unknown): number => (pty as { fd: number }).fd;

const expectFdClosed = (pty: unknown): void => {
  try {
    fs.fstatSync(fdOf(pty));
    throw new Error('expected the master fd to be closed, but fstat succeeded');
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe('EBADF');
  }
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe.skipIf(!POSIX)('BunPtyProcess', () => {
  it('streams child output through onData and reports the exit', async () => {
    const pty = spawn('/bin/sh', ['-c', 'echo BUN_PTY_ECHO_OK']);
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
    const pty = spawn('/bin/sh', []);
    let output = '';
    pty.onData((data) => (output += data));
    await waitFor(() => output.length > 0);
    pty.write('echo $((21+21))\n');
    expect(await waitFor(() => output.includes('42'))).toBe(true);
    pty.kill();
  }, 20_000);

  it('resizes the terminal the child observes', async () => {
    const pty = spawn('/bin/sh', []);
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
    const pty = spawn('/bin/sh', ['-c', 'echo READY; read x']);
    let output = '';
    pty.onData((data) => (output += data));
    expect(await waitFor(() => output.includes('READY'))).toBe(true);

    let exit: { exitCode: number; signal?: number } | undefined;
    pty.onExit((e) => (exit = e));
    pty.kill('SIGHUP');

    expect(await waitFor(() => exit !== undefined, 5_000)).toBe(true);
    expect(exit!.signal).toBe(1);
  }, 20_000);

  it('resumes output after pause/resume', async () => {
    const pty = spawn('/bin/sh', []);
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
    const pty = spawn('/bin/sh', [
      '-c',
      'echo READY; sleep 0.2; echo TAIL_AFTER_PAUSE; exit 7',
    ]);
    let output = '';
    pty.onData((data) => (output += data));
    let exits = 0;
    let exit: { exitCode: number; signal?: number } | undefined;
    pty.onExit((e) => {
      exits += 1;
      exit = e;
    });

    expect(await waitFor(() => output.includes('READY'))).toBe(true);
    pty.pause();

    expect(await waitFor(() => exits > 0, 5_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(exits).toBe(1);
    expect(exit!.exitCode).toBe(7);
    // Wrapper parity: a paused consumer receives no data, not even the tail.
    expect(output).not.toContain('TAIL_AFTER_PAUSE');
    expectFdClosed(pty);
  }, 20_000);

  it('keeps exit detection while paused output floods past 3 MB', async () => {
    // The raw flood is 3 MB and reaches the master as ~4.5 MB (ONLCR), so the
    // hold cap is sized explicitly to keep this a pause-hold exercise rather
    // than a limit-termination exercise.
    const pty = spawn('/bin/sh', ['-c', 'yes X | head -c 3000000; exit 0'], {
      limits: { pausedHoldBytes: 16 * 1024 * 1024 },
    });
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

  it('delivers a byte-exact stream across rapid no-gap pause/resume toggles', async () => {
    const LINES = 20_000;
    const pty = spawn('/bin/sh', [
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
    // Byte-exact: catches duplication, fragmentation, loss and reordering.
    expect(output).toBe(expected);
    // Line-by-line: every line value, in order.
    const lines = output.split('\r\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(LINES);
    for (let i = 0; i < LINES; i += 1) {
      expect(lines[i]).toBe(`LINE ${i}`);
    }
  }, 40_000);

  it('holds the entire flood while paused and resumes byte-exact', async () => {
    const LINES = 200_000;
    const pty = spawn('/bin/sh', [
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
    // Nothing dropped while paused — byte-exact, line-exact.
    expect(output.length).toBe(expected.length);
    expect(output).toBe(expected);
    const lines = output.split('\r\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(LINES);
    expect(lines[0]).toBe('X0');
    expect(lines[LINES - 1]).toBe(`X${LINES - 1}`);
  }, 40_000);

  it('releases the fd when flow-control pause is followed by cancel', async () => {
    const pty = spawn('/bin/sh', ['-c', 'sleep 30'], {
      handleFlowControl: true,
    });
    let exits = 0;
    let exit: { exitCode: number; signal?: number } | undefined;
    pty.onExit((e) => {
      exits += 1;
      exit = e;
    });

    pty.write('\x13'); // XOFF
    await new Promise((resolve) => setTimeout(resolve, 200));
    pty.kill('SIGHUP'); // cancel while paused

    expect(await waitFor(() => exits > 0, 5_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(exits).toBe(1);
    expect(exit!.signal).toBe(1);
    expectFdClosed(pty);
  }, 20_000);

  it('intercepts flow-control messages when handleFlowControl is on', async () => {
    const pty = spawn('/bin/sh', [], { handleFlowControl: true });
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
    const pty = spawn('/bin/sh', ['-c', 'echo RAW_BUFFER_OK'], {
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
    const pty = spawn('/bin/sh', ['-c', 'read x']);
    expect(typeof pty.process).toBe('string');
    expect(pty.process.length).toBeGreaterThan(0);
    expect(() => pty.clear()).not.toThrow();
    pty.kill();
  }, 20_000);
});

describe.skipIf(!POSIX)('bounded pause hold and resource limits', () => {
  type Spawned = ReturnType<typeof spawn>;

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

  it('terminates with an explicit error when a paused flood passes the per-pty hold cap', async () => {
    const LIMIT = 128 * 1024;
    const pty = spawn('/bin/sh', ['-c', 'yes X | head -c 2097152; sleep 30'], {
      limits: { pausedHoldBytes: LIMIT },
    });
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
    expect(await waitFor(() => errors.length > 0)).toBe(true);

    expect(errors.length).toBe(1);
    const error = errors[0]!;
    expect(error).toBeInstanceOf(PtyLimitError);
    expect(error.code).toBe('QWEN_PTY_OUTPUT_LIMIT');
    expect(error.limitKind).toBe('paused-hold-per-pty');
    expect(error.limit).toBe(LIMIT);
    expect(error.acceptedBytes).toBeGreaterThan(0);
    expect(error.acceptedBytes).toBeLessThanOrEqual(LIMIT);
    expect(error.hasUndeliveredData).toBe(true);

    const stats = pty.stats;
    expect(stats.resourceFailed).toBe(true);
    expect(stats.pausedBytes).toBe(0);

    // onExit stays reserved for real native exits: the product failure is
    // the error terminal state, never a fabricated exit code.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(exits).toBe(0);

    // Full teardown: master fd closed, child tree gone by real ownership.
    expectFdClosed(pty);
    expect(await waitForChildGone(pty)).toBe(true);

    // No auto-resume and no replay of the discarded hold.
    const before = output;
    pty.resume();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(output).toBe(before);

    // The process-wide hold ledger is released.
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(0);
  }, 30_000);

  it('holds a flood under the cap byte-exact and stays alive until resume', async () => {
    const LINES = 8000;
    const LIMIT = 512 * 1024;
    const pty = spawn(
      '/bin/sh',
      ['-c', `awk 'BEGIN{for(i=0;i<${LINES};i++)print "K" i}'; sleep 30`],
      { limits: { pausedHoldBytes: LIMIT } },
    );
    const { errors } = nextError(pty);
    let output = '';
    pty.onData((data) => {
      output += data;
    });

    pty.pause();
    expect(await waitFor(() => pty.stats.pausedBytes >= 50_000)).toBe(true);
    expect(pty.stats.pausedBytes).toBeLessThanOrEqual(LIMIT);
    expect(errors.length).toBe(0);
    fs.fstatSync(fdOf(pty)); // still open: nothing was terminated

    pty.resume();
    const expected =
      Array.from({ length: LINES }, (_, i) => `K${i}`).join('\r\n') + '\r\n';
    expect(await waitFor(() => output.includes(`K${LINES - 1}`))).toBe(true);
    expect(output).toBe(expected);

    pty.kill();
    expect(await waitForFdClosed(pty)).toBe(true);
    expect(getPtyBudgetStats().pausedHoldBytes).toBe(0);
  }, 30_000);

  it('enforces the process-wide hold budget across ptys without touching the first', async () => {
    const original = processPtyBudget.totalPausedHoldBytes;
    processPtyBudget.totalPausedHoldBytes = 160 * 1024;
    try {
      expect(getPtyBudgetStats().pausedHoldBytes).toBe(0);

      // A floods ~100 KB of master bytes (ONLCR included) and parks there,
      // well under the 160 KB global cap.
      const a = spawn('/bin/sh', [
        '-c',
        'awk \'BEGIN{for(i=0;i<15000;i++)print "A" i}\'; sleep 30',
      ]);
      const aErrors = nextError(a);
      let aOutput = '';
      a.onData((data) => {
        aOutput += data;
      });
      a.pause();
      expect(
        await waitFor(() => getPtyBudgetStats().pausedHoldBytes >= 95_000),
      ).toBe(true);

      // B floods megabytes: the shared cap, not B's own per-pty cap, ends it.
      const b = spawn('/bin/sh', ['-c', 'yes X | head -c 2097152; sleep 30']);
      const bErrors = nextError(b);
      b.onData(() => {});
      b.pause();
      expect(await waitFor(() => bErrors.errors.length > 0, 15_000)).toBe(true);
      expect(bErrors.errors.length).toBe(1);
      expect(bErrors.errors[0]!.code).toBe('QWEN_PTY_OUTPUT_LIMIT');
      expect(bErrors.errors[0]!.limitKind).toBe('paused-hold-process');
      expect(bErrors.errors[0]!.limit).toBe(160 * 1024);

      // Only B was terminated; A keeps its hold, its child, and zero errors.
      expect(a.stats.resourceFailed).toBe(false);
      expect(aErrors.errors.length).toBe(0);
      a.resume();
      expect(await waitFor(() => aOutput.includes('A9999'))).toBe(true);
      a.kill();
      expect(await waitForFdClosed(a)).toBe(true);
      expectFdClosed(b);
    } finally {
      processPtyBudget.totalPausedHoldBytes = original;
    }
  }, 40_000);

  it('terminates with an explicit error when queued writes pass the cap', async () => {
    const LIMIT = 64 * 1024;
    const pty = spawn('/bin/sh', ['-c', 'sleep 30'], {
      limits: { writeQueueBytes: LIMIT },
    });
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
    expect(error.hasUndeliveredData).toBe(false);

    expect(pty.stats.resourceFailed).toBe(true);
    expect(pty.stats.writeQueuedBytes).toBe(0);
    expectFdClosed(pty);
    expect(await waitForChildGone(pty)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(exits).toBe(0);
  }, 20_000);

  it('admits ptys up to the process-wide cap and frees the slot on close', async () => {
    const original = processPtyBudget.maxActivePtys;
    processPtyBudget.maxActivePtys = 1;
    try {
      expect(getPtyBudgetStats().activePtys).toBe(0);

      const first = spawn('/bin/sh', ['-c', 'sleep 30']);
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

      first.kill();
      expect(await waitFor(() => getPtyBudgetStats().activePtys === 0)).toBe(
        true,
      );

      const second = spawn('/bin/sh', ['-c', 'sleep 30']);
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

    const pty = spawn('/bin/sh', [
      '-c',
      'awk \'BEGIN{for(i=0;i<15000;i++)print "O" i}\'; sleep 30',
    ]);
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
