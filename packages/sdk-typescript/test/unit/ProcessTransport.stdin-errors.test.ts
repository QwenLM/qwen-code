/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessTransport } from '../../src/transport/ProcessTransport.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn, fork: vi.fn() }));

const transports: ProcessTransport[] = [];
function setup(stdin: Writable = new PassThrough()) {
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });
  spawn.mockReturnValue(child as unknown as ChildProcess);
  const stderr = vi.fn();
  const transport = new ProcessTransport({
    spawnInfo: {
      command: 'qwen-test',
      args: [],
      type: 'native',
      originalInput: 'qwen-test',
    },
    stderr,
  });
  transports.push(transport);
  return { child, transport, stdin, stderr };
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  vi.clearAllMocks();
});

describe('ProcessTransport stdin errors', () => {
  it('owns stdin error events instead of throwing an uncaught exception', () => {
    const { stdin, transport, stderr } = setup();
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => stdin.emit('error', error)).not.toThrow();
    expect(transport.isReady).toBe(false);
    expect(transport.exitError?.message).toContain('EPIPE');
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('CLI stdin error: write EPIPE'),
    );
  });

  it('retains an asynchronous write error through process termination', async () => {
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(error));
      },
    });
    const failed = new Promise<void>((resolve) =>
      stdin.once('error', () => resolve()),
    );
    const { child, transport } = setup(stdin);
    transport.write('prompt\n');
    await failed;
    expect(transport.isReady).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const outcome = transport.waitForExit();
    child.emit('close', 1, null);
    await expect(outcome).rejects.toMatchObject({ cause: error });
  });

  it('handles late stdin errors during explicit shutdown without inventing a failure', async () => {
    const { stdin, transport } = setup();
    await transport.close();
    expect(() =>
      stdin.emit('error', new Error('write after end')),
    ).not.toThrow();
    expect(transport.exitError).toBeNull();
  });

  it.each(['stdin-first', 'process-first'])(
    'retains an independent process failure after a clean close (%s)',
    async (order) => {
      const { child, stdin, transport } = setup();
      const pipeError = new Error('write EPIPE');
      const processError = new Error('kill ESRCH');
      if (order === 'stdin-first') stdin.emit('error', pipeError);
      child.emit('error', processError);
      if (order === 'process-first') stdin.emit('error', pipeError);
      const firstError = transport.exitError;
      Object.assign(child, { exitCode: 0 });
      child.emit('close', 0, null);
      await expect(transport.waitForExit()).rejects.toBe(firstError);
      expect(firstError?.message).toContain(
        order === 'stdin-first' ? 'EPIPE' : 'ESRCH',
      );
    },
  );
});
