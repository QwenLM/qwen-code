/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryCommand } from './memory.js';

let stdoutListeners: ReturnType<typeof process.stdout.listeners>;
let stderrListeners: ReturnType<typeof process.stderr.listeners>;
beforeEach(() => {
  stdoutListeners = process.stdout.listeners('error');
  stderrListeners = process.stderr.listeners('error');
});
afterEach(() => {
  for (const listener of process.stdout.listeners('error'))
    if (!stdoutListeners.includes(listener))
      process.stdout.removeListener(
        'error',
        listener as (error: Error) => void,
      );
  for (const listener of process.stderr.listeners('error'))
    if (!stderrListeners.includes(listener))
      process.stderr.removeListener(
        'error',
        listener as (error: Error) => void,
      );
});

const fail = (message: string, error?: Error) => {
  throw error ?? new Error(message);
};

async function codexDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mem-'));
  await fs.writeFile(
    path.join(directory, 'MEMORY.md'),
    '# Topic\ncwd: /synthetic/project\nA durable fact.\n',
  );
  return directory;
}

it.each(['bare', 'safe-mode'])(
  'rejects confirmed import in %s before reading sources or authenticating',
  async (flag) => {
    await expect(
      yargs([`--${flag}`, 'memory', 'import', 'codex', '--apply'])
        .option(flag, { type: 'boolean' })
        .command(memoryCommand)
        .exitProcess(false)
        .fail(fail)
        .parseAsync(),
    ).rejects.toThrow('unavailable in bare or safe mode');
  },
);

it('rejects an unknown import source instead of running the Codex importer', async () => {
  // yargs reports the positional choice mismatch by throwing synchronously
  // out of fail(), before parseAsync() returns a promise.
  await expect(
    (async () =>
      yargs(['memory', 'import', 'claude'])
        .command(memoryCommand)
        .exitProcess(false)
        .fail(fail)
        .parseAsync())(),
  ).rejects.toThrow(/Invalid values/);
});

it('rejects a repeated --source instead of importing the default directory', async () => {
  const first = await codexDir();
  const second = await codexDir();
  await expect(
    yargs(['memory', 'import', 'codex', '--source', first, '--source', second])
      .command(memoryCommand)
      .exitProcess(false)
      .fail(fail)
      .parseAsync(),
  ).rejects.toThrow(/single --source/);
});

it('resolves the flushed write when the reader has already left (EPIPE)', async () => {
  const directory = await codexDir();
  const destroy = vi
    .spyOn(process.stdout, 'destroy')
    .mockReturnValue(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    a?: unknown,
    b?: unknown,
  ) => {
    const callback = (typeof a === 'function' ? a : b) as
      | ((error?: Error) => void)
      | undefined;
    if (callback) {
      const error = new Error('write EPIPE') as NodeJS.ErrnoException;
      error.code = 'EPIPE';
      callback(error);
    }
    return true;
  }) as typeof process.stdout.write);
  try {
    // A departed reader must not turn an already-committed result into an
    // exit-1 crash: the EPIPE write resolves instead of rejecting.
    await yargs(['memory', 'import', 'codex', '--source', directory, '--json'])
      .command(memoryCommand)
      .exitProcess(false)
      .fail(fail)
      .parseAsync();
    expect(() =>
      process.stdout.emit(
        'error',
        Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      ),
    ).not.toThrow();
    expect(destroy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    destroy.mockRestore();
  }
});

it('flushes the human-readable preview before completing', async () => {
  const directory = await codexDir();
  const callbacks: Array<() => void> = [];
  let unflushedWrites = 0;
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    a?: unknown,
    b?: unknown,
  ) => {
    const callback = (typeof a === 'function' ? a : b) as
      | (() => void)
      | undefined;
    if (callback) callbacks.push(callback);
    else unflushedWrites++;
    return true;
  }) as typeof process.stdout.write);
  let settled = false;
  try {
    const parsing = yargs(['memory', 'import', 'codex', '--source', directory])
      .command(memoryCommand)
      .exitProcess(false)
      .fail(fail)
      .parseAsync()
      .then(() => {
        settled = true;
      });
    await vi.waitFor(() =>
      expect(callbacks.length + unflushedWrites).toBeGreaterThan(0),
    );
    expect(settled).toBe(false);
    expect(unflushedWrites).toBe(0);
    for (const callback of callbacks) callback();
    await parsing;
  } finally {
    spy.mockRestore();
  }
});

it('flushes the --json preview envelope before completing', async () => {
  const directory = await codexDir();
  const callbacks: Array<() => void> = [];
  let unflushedWrites = 0;
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    a?: unknown,
    b?: unknown,
  ) => {
    const callback = (typeof a === 'function' ? a : b) as
      | (() => void)
      | undefined;
    if (callback) callbacks.push(callback);
    else unflushedWrites++;
    return true;
  }) as typeof process.stdout.write);
  let settled = false;
  try {
    const parsing = yargs([
      'memory',
      'import',
      'codex',
      '--source',
      directory,
      '--json',
    ])
      .command(memoryCommand)
      .exitProcess(false)
      .fail(fail)
      .parseAsync()
      .then(() => {
        settled = true;
      });
    await vi.waitFor(() =>
      expect(callbacks.length + unflushedWrites).toBeGreaterThan(0),
    );
    expect(settled).toBe(false);
    for (const callback of callbacks) callback();
    await parsing;
  } finally {
    spy.mockRestore();
  }
});
