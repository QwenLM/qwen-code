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
 * kill/exit, pause hold, flow control, encoding — is exercised directly
 * here. The Bun-leg round-trip through the real `getPty()` seam lives in
 * bun-pty.node-bun.test.ts.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spawn } from './bun-pty.js';

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

  it('keeps exit detection while paused output overflows the hold', async () => {
    const pty = spawn('/bin/sh', ['-c', 'yes X | head -c 3000000; exit 0']);
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
