/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessTransport } from '../../src/transport/ProcessTransport.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn, fork: vi.fn() }));
const transports: ProcessTransport[] = [];

function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
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
  return { child, transport, stderr };
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  vi.clearAllMocks();
});

describe('ProcessTransport clean child exit', () => {
  it.each(['before-close', 'after-close'])(
    'does not turn a clean exit into failure for an EPIPE %s',
    async (order) => {
      const { child, transport } = setup();
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      if (order === 'before-close') child.stdin.emit('error', error);
      child.exitCode = 0;
      child.emit('close', 0, null);
      if (order === 'after-close') child.stdin.emit('error', error);
      await expect(transport.waitForExit()).resolves.toBeUndefined();
      expect(transport.exitError).toBeNull();
    },
  );

  it('preserves the first failure while separately reporting a later process error', () => {
    const { child, transport, stderr } = setup();
    const original = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    child.stdin.emit('error', original);
    child.emit('error', new Error('kill ESRCH'));
    expect(transport.exitError?.cause).toBe(original);
    expect(stderr.mock.calls.flat().join('\n')).toContain(
      'CLI process error: kill ESRCH',
    );
  });

  it('still rejects a nonzero exit after stdin failure', async () => {
    const { child, transport } = setup();
    const original = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    child.stdin.emit('error', original);
    child.exitCode = 1;
    child.emit('close', 1, null);
    await expect(transport.waitForExit()).rejects.toMatchObject({
      cause: original,
    });
  });
});
