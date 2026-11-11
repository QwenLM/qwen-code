/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '../../protocol/transcript/entry.js';
import {
  AppendChannel,
  nodeTranscriptFileSystem,
  type TranscriptCommitEntry,
  type TranscriptFileSystem,
} from './append-channel.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createFilePath(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'transcript-append-channel-'),
  );
  tempDirs.push(directory);
  return path.join(directory, 'nested', 'session.jsonl');
}

function title(value: string): Entry {
  return {
    type: 'custom-title',
    sessionId: 'session-1',
    customTitle: value,
  };
}

async function readEntries(filePath: string): Promise<Entry[]> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
}

describe('AppendChannel', () => {
  it('orders final resume validation after prior appends and before later appends', async () => {
    const filePath = await createFilePath();
    const channel = new AppendChannel({ filePath, flushIntervalMs: 60_000 });
    const before = channel.append([title('before')]);
    let releaseValidation!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validation = channel.withExclusiveRead(async () => {
      expect(await readEntries(filePath)).toEqual([title('before')]);
      started();
      await gate;
      return 'accepted';
    });
    const after = channel.append([title('after')]);
    const barrier = channel.barrier();
    await entered;
    expect(await readEntries(filePath)).toEqual([title('before')]);
    releaseValidation();
    expect(await validation).toBe('accepted');
    await Promise.all([before, after, barrier]);
    expect(await readEntries(filePath)).toEqual([
      title('before'),
      title('after'),
    ]);
    await channel.close();
  });

  it('does not accept resume past a failed prior append and permits later writes', async () => {
    const filePath = await createFilePath();
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    let denyAppend = true;
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 60_000,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        appendFile: async (...args) => {
          if (denyAppend) throw failure;
          await nodeTranscriptFileSystem.appendFile(...args);
        },
      },
    });
    const before = channel.append([title('before')]);
    let accepted = false;
    const validation = channel.withExclusiveRead(async () => {
      accepted = true;
    });
    await expect(before).rejects.toBe(failure);
    await expect(validation).rejects.toBe(failure);
    expect(accepted).toBe(false);
    denyAppend = false;
    const retry = channel.append([title('retry')]);
    await channel.barrier();
    await retry;
    await channel.close();
    expect(await readEntries(filePath)).toEqual([title('retry')]);
  });

  it('does not poison the append domain when final resume validation fails', async () => {
    const filePath = await createFilePath();
    const channel = new AppendChannel({ filePath, flushIntervalMs: 60_000 });
    const before = channel.append([title('before')]);
    const failure = new Error('snapshot changed');
    await expect(
      channel.withExclusiveRead(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await before;
    const after = channel.append([title('after')]);
    await channel.barrier();
    await after;
    expect(await readEntries(filePath)).toEqual([
      title('before'),
      title('after'),
    ]);
    await channel.close();
  });

  it('batches accepted entries and preserves submission order', async () => {
    const filePath = await createFilePath();
    const channel = new AppendChannel({ filePath, flushIntervalMs: 60_000 });

    const first = channel.append([title('first')]);
    const second = channel.append([title('second'), title('third')]);
    await channel.barrier();
    await Promise.all([first, second]);

    expect(await readEntries(filePath)).toMatchObject([
      { customTitle: 'first' },
      { customTitle: 'second' },
      { customTitle: 'third' },
    ]);
  });

  it('repairs a missing LF before appending a new complete record', async () => {
    const filePath = await createFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(title('existing')), 'utf8');
    const channel = new AppendChannel({ filePath, flushIntervalMs: 0 });

    await channel.append([title('appended')]);
    await channel.close();

    expect(await readEntries(filePath)).toMatchObject([
      { customTitle: 'existing' },
      { customTitle: 'appended' },
    ]);
  });

  it('retries first creation once when the directory disappears after mkdir', async () => {
    const filePath = await createFilePath();
    let mkdirCalls = 0;
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        mkdir: async (directoryPath, options) => {
          await nodeTranscriptFileSystem.mkdir(directoryPath, options);
          if (++mkdirCalls === 1) {
            await fs.rm(directoryPath, { recursive: true });
          }
        },
      },
    });

    await channel.append([title('first')]);
    await channel.close();

    expect(mkdirCalls).toBe(2);
    expect(await readEntries(filePath)).toEqual([title('first')]);
  });

  it('bounds first-creation ENOENT retries and permits a later submission', async () => {
    const filePath = await createFilePath();
    let removeDirectory = true;
    let mkdirCalls = 0;
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 60_000,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        mkdir: async (directoryPath, options) => {
          mkdirCalls++;
          await nodeTranscriptFileSystem.mkdir(directoryPath, options);
          if (removeDirectory) {
            await fs.rm(directoryPath, { recursive: true });
          }
        },
      },
    });

    const failedAppend = channel.append([title('failed')]);
    const failedBarrier = channel.barrier();
    await expect(failedAppend).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(failedBarrier).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mkdirCalls).toBe(2);

    removeDirectory = false;
    const retry = channel.append([title('retry')]);
    await channel.barrier();
    await retry;
    await channel.close();
    expect(await readEntries(filePath)).toEqual([title('retry')]);
  });

  it('preserves history and submission order after the original directory is restored', async () => {
    const filePath = await createFilePath();
    const channel = new AppendChannel({ filePath, flushIntervalMs: 60_000 });
    const first = channel.append([title('existing')]);
    await channel.barrier();
    await first;

    const directoryPath = path.dirname(filePath);
    const backupPath = `${directoryPath}-backup`;
    await fs.rename(directoryPath, backupPath);
    const failedAppend = channel.append([title('failed')]);
    const failedBarrier = channel.barrier();
    await expect(failedAppend).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(failedBarrier).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(directoryPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await fs.rename(backupPath, directoryPath);
    const second = channel.append([title('second')]);
    const third = channel.append([title('third')]);
    await channel.barrier();
    await Promise.all([second, third]);
    await channel.close();

    expect(await readEntries(filePath)).toEqual([
      title('existing'),
      title('second'),
      title('third'),
    ]);
  });

  it('recreates a missing transcript with only newly appended records', async () => {
    const filePath = await createFilePath();
    const channel = new AppendChannel({ filePath, flushIntervalMs: 0 });
    await channel.append([title('existing')]);
    await fs.unlink(filePath);

    await channel.append([title('continued')]);
    await channel.append([title('next')]);
    await channel.close();
    expect(await readEntries(filePath)).toEqual([
      title('continued'),
      title('next'),
    ]);
  });

  it('rejects a batch if its transcript disappears after opening and permits a later append', async () => {
    const filePath = await createFilePath();
    let removeBeforeAppend = false;
    const committed: TranscriptCommitEntry[] = [];
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        appendFile: async (...args) => {
          if (removeBeforeAppend) {
            removeBeforeAppend = false;
            await fs.unlink(args[0]);
          }
          await nodeTranscriptFileSystem.appendFile(...args);
        },
      },
      commitObserver: (_committedPath, entries) => {
        committed.push(...entries);
      },
    });
    await channel.append([title('existing')]);
    removeBeforeAppend = true;

    await expect(channel.append([title('failed')])).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(committed).toEqual([title('existing')]);
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await channel.append([title('retry')]);
    await channel.close();
    expect(await readEntries(filePath)).toEqual([title('retry')]);
    expect(committed).toEqual([title('existing'), title('retry')]);
  });

  it('writes an entry larger than maxBatchBytes as its own complete batch', async () => {
    const filePath = await createFilePath();
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      maxBatchBytes: 128,
    });
    const largeSummary: Entry = {
      type: 'summary',
      leafUuid: 'leaf-1',
      summary: 'x'.repeat(3 * 1024 * 1024),
    };

    await channel.append([title('before'), largeSummary, title('after')]);
    await channel.close();

    const entries = await readEntries(filePath);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toEqual(largeSummary);
  });

  it('publishes the whole append batch only after every chunk succeeds', async () => {
    const filePath = await createFilePath();
    const commits: Array<{
      filePath: string;
      entries: readonly TranscriptCommitEntry[];
    }> = [];
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      maxBatchBytes: 1,
      commitObserver: (committedPath, entries) => {
        commits.push({ filePath: committedPath, entries });
      },
    });
    const entries = [title('first'), title('second'), title('third')];

    await channel.append(entries);
    await channel.close();

    expect(commits).toEqual([{ filePath, entries }]);
  });

  it('rolls back the entire failed batch and permits a clean retry', async () => {
    const filePath = await createFilePath();
    let appendCalls = 0;
    const committed: TranscriptCommitEntry[] = [];
    const injectedFailure = Object.assign(new Error('disk full'), {
      code: 'ENOSPC',
    });
    const fileSystem: TranscriptFileSystem = {
      ...nodeTranscriptFileSystem,
      appendFile: async (targetPath, data, options) => {
        appendCalls++;
        if (appendCalls === 2) {
          throw injectedFailure;
        }
        await nodeTranscriptFileSystem.appendFile(targetPath, data, options);
      },
    };
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 60_000,
      maxBatchBytes: 1,
      fileSystem,
      commitObserver: (_committedPath, entries) => {
        committed.push(...entries);
      },
    });

    const append = channel.append([
      title('durable'),
      title('failed'),
      title('not-attempted'),
    ]);
    const barrier = channel.barrier();

    await expect(append).rejects.toBe(injectedFailure);
    await expect(barrier).rejects.toBe(injectedFailure);
    expect(await readEntries(filePath)).toEqual([]);
    expect(committed).toEqual([]);
    const retry = channel.append([
      title('durable'),
      title('failed'),
      title('not-attempted'),
    ]);
    await channel.barrier();
    await retry;
    expect(await readEntries(filePath)).toEqual([
      title('durable'),
      title('failed'),
      title('not-attempted'),
    ]);
    await channel.close();
  });

  it.each(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EBUSY', 'ETXTBSY'])(
    'removes a partially written batch on %s and preserves prior history',
    async (code) => {
      const filePath = await createFilePath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const original = `${JSON.stringify(title('original'))}\n`;
      await fs.writeFile(filePath, original);
      const committed: TranscriptCommitEntry[] = [];
      let full = true;
      const failure = Object.assign(new Error(`${code}: write failed`), {
        code,
        syscall: 'write',
      });
      const channel = new AppendChannel({
        filePath,
        flushIntervalMs: 0,
        fileSystem: {
          ...nodeTranscriptFileSystem,
          appendFile: async (target, bytes, options) => {
            if (full) {
              await fs.appendFile(target, bytes.subarray(0, bytes.length - 9));
              throw failure;
            }
            await fs.appendFile(target, bytes, options);
          },
        },
        commitObserver: (_committedPath, entries) => {
          committed.push(...entries);
        },
      });
      for (let i = 0; i < 2; i++) {
        await expect(channel.append([title('retry')])).rejects.toBe(failure);
        expect(await fs.readFile(filePath, 'utf8')).toBe(original);
        expect(committed).toEqual([]);
      }
      full = false;
      await channel.append([title('retry')]);
      await channel.append([title('next')]);
      await channel.close();
      expect(await readEntries(filePath)).toEqual([
        title('original'),
        title('retry'),
        title('next'),
      ]);
      expect(committed).toEqual([title('retry'), title('next')]);
    },
  );

  it.each(['ENOSPC', 'EPERM', 'EBUSY', 'ETXTBSY'])(
    'retries a %s rollback failure before new writes or commit notifications',
    async (code) => {
      const filePath = await createFilePath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const original = `${JSON.stringify(title('original'))}\n`;
      await fs.writeFile(filePath, original);
      let blocked = true;
      let appendCalls = 0;
      const committed: TranscriptCommitEntry[] = [];
      const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      const rollbackFailure = Object.assign(new Error('truncate failed'), {
        code,
        syscall: 'ftruncate',
      });
      const channel = new AppendChannel({
        filePath,
        flushIntervalMs: 0,
        fileSystem: {
          ...nodeTranscriptFileSystem,
          open: async (...args) => {
            const handle = await nodeTranscriptFileSystem.open(...args);
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'truncate')
                  return async (length: number) => {
                    if (blocked) throw rollbackFailure;
                    await target.truncate(length);
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          },
          appendFile: async (target, bytes, options) => {
            appendCalls++;
            if (blocked) {
              await fs.appendFile(target, bytes.subarray(0, 13));
              throw failure;
            }
            expect(await fs.readFile(target, 'utf8')).toBe(original);
            await fs.appendFile(target, bytes, options);
          },
        },
        commitObserver: (_committedPath, entries) => {
          committed.push(...entries);
        },
      });
      await expect(channel.append([title('retry')])).rejects.toBe(failure);
      const partial = await fs.readFile(filePath, 'utf8');
      expect(partial).toBe(
        original + JSON.stringify(title('retry')).slice(0, 13),
      );
      await expect(channel.append([title('still blocked')])).rejects.toBe(
        rollbackFailure,
      );
      expect(await fs.readFile(filePath, 'utf8')).toBe(partial);
      expect(appendCalls).toBe(1);
      expect(committed).toEqual([]);
      blocked = false;
      await channel.append([title('retry')]);
      await channel.close();
      expect(await readEntries(filePath)).toEqual([
        title('original'),
        title('retry'),
      ]);
      expect(committed).toEqual([title('retry')]);
    },
  );

  it('repairs only an incomplete final record after reopening', async () => {
    const filePath = await createFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const original = `${JSON.stringify(title('original'))}\n`;
    // Include a multi-byte character split halfway through its encoding.
    await fs.writeFile(
      filePath,
      Buffer.concat([
        Buffer.from(original + '{"customTitle":"'),
        Buffer.from('中').subarray(0, 2),
      ]),
    );
    const channel = new AppendChannel({ filePath, flushIntervalMs: 0 });
    await channel.append([title('next')]);
    await channel.close();
    expect(await fs.readFile(filePath, 'utf8')).toBe(
      original + JSON.stringify(title('next')) + '\n',
    );
  });

  it.each(['{"customTitle":"partial', '\u0000\u0000'])(
    'recovers an incomplete tail with Windows append-handle permissions (%j)',
    async (suffix) => {
      const filePath = await createFilePath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const original = `${JSON.stringify(title('original'))}\n`;
      await fs.writeFile(filePath, original + suffix);
      const channel = new AppendChannel({
        filePath,
        flushIntervalMs: 0,
        fileSystem: {
          ...nodeTranscriptFileSystem,
          open: async (targetPath, flags, mode) => {
            const handle = await nodeTranscriptFileSystem.open(
              targetPath,
              flags,
              mode,
            );
            // Windows append handles lack FILE_WRITE_DATA, even with read access.
            const appendOnly =
              typeof flags === 'number'
                ? (flags & fsConstants.O_APPEND) !== 0
                : flags.startsWith('a');
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'truncate' && appendOnly) {
                  return async () => {
                    throw Object.assign(
                      new Error('EPERM: operation not permitted, ftruncate'),
                      {
                        code: 'EPERM',
                        errno: -4048,
                        syscall: 'ftruncate',
                      },
                    );
                  };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          },
        },
      });

      try {
        await channel.append([title('recovered')]);
        await channel.append([title('continued')]);
        expect(await readEntries(filePath)).toEqual([
          title('original'),
          title('recovered'),
          title('continued'),
        ]);
      } finally {
        await channel.close().catch(() => undefined);
      }
    },
  );

  it('does not roll back bytes appended by another writer', async () => {
    const filePath = await createFilePath();
    const foreign = `${JSON.stringify(title('other writer'))}\n`;
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        appendFile: async (target) => {
          await fs.appendFile(target, foreign);
          throw failure;
        },
      },
    });
    await expect(channel.append([title('ours')])).rejects.toBe(failure);
    await expect(channel.append([title('next')])).rejects.toThrow(
      'refusing to discard unrelated data',
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe(foreign);
  });

  it('keeps non-storage failures fail-stop', async () => {
    const filePath = await createFilePath();
    const failure = Object.assign(new Error('I/O failure'), { code: 'EIO' });
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        appendFile: async () => {
          throw failure;
        },
      },
    });
    await expect(channel.append([title('failed')])).rejects.toBe(failure);
    expect(() => channel.append([title('next')])).toThrow(failure);
  });

  it.each(
    ['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'ETXTBSY'].flatMap((code) =>
      [false, true].map((existing) => ({ code, existing })),
    ),
  )(
    'retries consecutive $code denials on the same channel (existing=$existing)',
    async ({ code, existing }) => {
      const filePath = await createFilePath();
      let deny = false;
      let deniedOpens = 0;
      const failure = Object.assign(new Error(`${code}: open denied`), {
        code,
        syscall: 'open',
        path: filePath,
      });
      const channel = new AppendChannel({
        filePath,
        flushIntervalMs: 60_000,
        fileSystem: {
          ...nodeTranscriptFileSystem,
          open: async (...args) => {
            if (deny) {
              deniedOpens++;
              throw failure;
            }
            return nodeTranscriptFileSystem.open(...args);
          },
        },
      });
      if (existing) {
        const initial = channel.append([title('existing')]);
        await channel.barrier();
        await initial;
      }
      const original = existing ? await fs.readFile(filePath) : undefined;
      deny = true;
      for (let i = 0; i < 2; i++) {
        const append = channel.append([title('blocked')]);
        const barrier = channel.barrier();
        await expect(append).rejects.toBe(failure);
        await expect(barrier).rejects.toBe(failure);
        if (original) {
          expect(await fs.readFile(filePath)).toEqual(original);
        } else {
          await expect(fs.access(filePath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
      }
      expect(deniedOpens).toBe(2);
      deny = false;
      const retry = channel.append([title('retry')]);
      const next = channel.append([title('next')]);
      await channel.barrier();
      await Promise.all([retry, next]);
      await channel.close();
      expect(await readEntries(filePath)).toEqual([
        ...(existing ? [title('existing')] : []),
        title('retry'),
        title('next'),
      ]);
    },
  );

  it('does not poison local writes when the observer fails', async () => {
    const filePath = await createFilePath();
    const observerFailure = new Error('mirror output closed');
    let observerCalls = 0;
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      commitObserver: () => {
        observerCalls++;
        throw observerFailure;
      },
    });

    await channel.append([title('first')]);
    await channel.append([title('second')]);
    await channel.close();

    expect(observerCalls).toBe(2);
    expect(await readEntries(filePath)).toEqual([
      title('first'),
      title('second'),
    ]);
  });

  it('notifies the observer after an exclusive transcript is durable', async () => {
    const filePath = await createFilePath();
    const commits: TranscriptCommitEntry[][] = [];
    const channel = new AppendChannel({
      filePath,
      commitObserver: (_committedPath, entries) => {
        commits.push([...entries]);
      },
    });
    const entries = [title('fork root'), title('fork leaf')];

    await channel.createExclusive(entries);
    await channel.close();

    expect(commits).toEqual([entries]);
    expect(await readEntries(filePath)).toEqual(entries);
  });

  it('removes an exclusively created transcript when its first write fails', async () => {
    const filePath = await createFilePath();
    const writeError = Object.assign(new Error('no space left on device'), {
      code: 'ENOSPC',
    });
    const fileSystem: TranscriptFileSystem = {
      ...nodeTranscriptFileSystem,
      open: async (targetPath, flags, mode) => {
        const handle = await nodeTranscriptFileSystem.open(
          targetPath,
          flags,
          mode,
        );
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'writeFile') {
              return async () => {
                throw writeError;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const channel = new AppendChannel({ filePath, fileSystem });

    await expect(channel.createExclusive([title('fork')])).rejects.toBe(
      writeError,
    );
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(channel.barrier()).resolves.toBeUndefined();
  });

  it('orders delete after accepted appends and rejects later appends', async () => {
    const filePath = await createFilePath();
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 60_000,
    });

    const append = channel.append([title('before delete')]);
    await channel.deleteFile();
    await append;

    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => channel.append([title('after delete')])).toThrow(
      'AppendChannel is closed',
    );
  });

  it('keeps barriers and terminal operations usable after an exclusive-create collision', async () => {
    const barrierPath = await createFilePath();
    await fs.mkdir(path.dirname(barrierPath), { recursive: true });
    await fs.writeFile(barrierPath, 'existing\n', 'utf8');
    const barrierChannel = new AppendChannel({ filePath: barrierPath });

    await expect(barrierChannel.createExclusive([])).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(barrierChannel.barrier()).resolves.toBeUndefined();
    await expect(barrierChannel.deleteFile()).resolves.toBeUndefined();
    await expect(fs.access(barrierPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const closePath = await createFilePath();
    await fs.mkdir(path.dirname(closePath), { recursive: true });
    await fs.writeFile(closePath, 'existing\n', 'utf8');
    const closeChannel = new AppendChannel({ filePath: closePath });

    await expect(closeChannel.createExclusive([])).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(closeChannel.close()).resolves.toBeUndefined();
  });

  it('rejects appends accepted after close begins', async () => {
    const filePath = await createFilePath();
    let allowAppend: (() => void) | undefined;
    const appendGate = new Promise<void>((resolve) => {
      allowAppend = resolve;
    });
    const fileSystem: TranscriptFileSystem = {
      ...nodeTranscriptFileSystem,
      appendFile: async (targetPath, data, options) => {
        await appendGate;
        await nodeTranscriptFileSystem.appendFile(targetPath, data, options);
      },
    };
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 60_000,
      fileSystem,
    });

    const accepted = channel.append([title('accepted before close')]);
    const close = channel.close();
    expect(() => channel.append([title('rejected during close')])).toThrow(
      'AppendChannel is closing',
    );
    allowAppend?.();

    await Promise.all([accepted, close]);
    expect(await readEntries(filePath)).toMatchObject([
      { customTitle: 'accepted before close' },
    ]);
  });
});
