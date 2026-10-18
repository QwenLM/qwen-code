/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it, vi } from 'vitest';
import yargs from 'yargs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryCommand } from './memory.js';

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
    for (let i = 0; i < 1000 && callbacks.length + unflushedWrites === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(callbacks.length + unflushedWrites).toBeGreaterThan(0);
    expect(settled).toBe(false);
    for (const callback of callbacks) callback();
    await parsing;
  } finally {
    spy.mockRestore();
  }
});
