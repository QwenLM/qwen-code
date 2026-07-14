/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addChannelMemoryEntries,
  appendChannelMemory,
  CHANNEL_MEMORY_FILE_NAME,
  clearChannelMemory,
  getChannelMemoryFilePath,
  getLegacyChannelMemoryFilePath,
  listChannelMemoryEntries,
  MAX_CHANNEL_MEMORY_BYTES,
  readChannelMemory,
  removeChannelMemoryEntries,
  type ChannelMemoryTarget,
  updateChannelMemoryEntry,
} from './channel-memory.js';
import {
  parseChannelMemoryDocument,
  parseLegacyChannelMemory,
  serializeChannelMemoryDocument,
} from './channel-memory-document.js';

interface ReadRace {
  jsonPath: string;
  legacyPath: string;
  jsonRead: () => void;
  waitToReadLegacy: () => Promise<void>;
  jsonIntercepted: boolean;
  legacyIntercepted: boolean;
}

const fsFailure = vi.hoisted(() => ({
  tempSync: false,
  tempBytesAtSync: 0,
  rename: false,
  legacyUnlinkPath: undefined as string | undefined,
  readErrorPath: undefined as string | undefined,
  readRace: undefined as ReadRace | undefined,
  legacyAppendAfterRename: undefined as
    | { path: string; text: string }
    | undefined,
}));

const lockObservation = vi.hoisted(() => ({
  path: undefined as string | undefined,
  attempted: undefined as (() => void) | undefined,
}));

vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    default: {
      ...actual,
      async lock(...args: Parameters<typeof actual.lock>) {
        if (String(args[0]) === lockObservation.path) {
          lockObservation.attempted?.();
        }
        return actual.lock(...args);
      },
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (fsFailure.tempSync && String(args[0]).endsWith('.tmp')) {
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                fsFailure.tempBytesAtSync = (await target.stat()).size;
                throw new Error('temp sync failed');
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return handle;
    },
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const race = fsFailure.readRace;
      const filePath = String(args[0]);
      if (filePath === fsFailure.readErrorPath) {
        throw Object.assign(new Error('read failed'), { code: 'EIO' });
      }
      if (
        race !== undefined &&
        filePath === race.jsonPath &&
        !race.jsonIntercepted
      ) {
        race.jsonIntercepted = true;
        race.jsonRead();
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (
        race !== undefined &&
        filePath === race.legacyPath &&
        !race.legacyIntercepted
      ) {
        race.legacyIntercepted = true;
        await race.waitToReadLegacy();
      }
      return actual.readFile(...args);
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      if (fsFailure.rename) {
        throw new Error('rename failed');
      }
      await actual.rename(...args);
      const append = fsFailure.legacyAppendAfterRename;
      if (append !== undefined) {
        fsFailure.legacyAppendAfterRename = undefined;
        await actual.appendFile(append.path, append.text);
      }
    },
    async unlink(...args: Parameters<typeof actual.unlink>) {
      if (String(args[0]) === fsFailure.legacyUnlinkPath) {
        throw new Error('legacy unlink failed');
      }
      return actual.unlink(...args);
    },
  };
});

describe('channel memory', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  let qwenHome: string;

  const target: ChannelMemoryTarget = {
    channelName: 'prod',
    chatId: 'chat-1',
  };

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-channel-memory-'));
    process.env['QWEN_HOME'] = qwenHome;
  });

  afterEach(() => {
    fsFailure.tempSync = false;
    fsFailure.tempBytesAtSync = 0;
    fsFailure.rename = false;
    fsFailure.legacyUnlinkPath = undefined;
    fsFailure.readErrorPath = undefined;
    fsFailure.readRace = undefined;
    fsFailure.legacyAppendAfterRename = undefined;
    lockObservation.path = undefined;
    lockObservation.attempted = undefined;
    vi.restoreAllMocks();
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  function writeLegacy(text: string): string {
    const legacyPath = getLegacyChannelMemoryFilePath(target);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, text);
    return legacyPath;
  }

  function writeJson(raw: string): string {
    const filePath = getChannelMemoryFilePath(target);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, raw);
    return filePath;
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('uses JSON for canonical storage and Markdown for legacy storage', () => {
    const filePath = getChannelMemoryFilePath(target);
    const legacyPath = getLegacyChannelMemoryFilePath(target);

    expect(filePath.startsWith(qwenHome + path.sep)).toBe(true);
    expect(filePath.endsWith(path.join('', CHANNEL_MEMORY_FILE_NAME))).toBe(
      true,
    );
    expect(filePath.endsWith('CHANNEL.json')).toBe(true);
    expect(legacyPath.endsWith('CHANNEL.md')).toBe(true);
  });

  it('keeps channel names and chat/thread identifiers safe', () => {
    const filePath = getChannelMemoryFilePath({
      channelName: '../prod/channel',
      chatId: 'raw-chat-id',
      threadId: 'raw-thread-id',
    });
    const relativePath = path.relative(qwenHome, filePath);

    expect(relativePath.split(path.sep)).not.toContain('..');
    expect(filePath).not.toContain('raw-chat-id');
    expect(filePath).not.toContain('raw-thread-id');
  });

  it('keeps a readable channel-name slug in the path', () => {
    const filePath = getChannelMemoryFilePath({
      channelName: 'team..bot',
      chatId: 'chat-1',
    });
    const relativeSegments = path.relative(qwenHome, filePath).split(path.sep);

    expect(relativeSegments[2]).toMatch(/^team\.\.bot-[a-f0-9]{16}$/u);
  });

  it.each(['.', '..'])(
    'does not use exact %s as the channel directory segment',
    (channelName) => {
      const filePath = getChannelMemoryFilePath({
        channelName,
        chatId: 'chat-1',
      });
      const relativeSegments = path
        .relative(qwenHome, filePath)
        .split(path.sep);

      expect(relativeSegments).not.toContain('.');
      expect(relativeSegments).not.toContain('..');
      expect(relativeSegments[0]).toBe('channels');
      expect(relativeSegments[1]).toBe('memory');
      expect(relativeSegments[2]).toMatch(/^[._]+-[a-f0-9]{16}$/u);
    },
  );

  it('uses different paths for colliding sanitized channel names and threads', () => {
    expect(
      getChannelMemoryFilePath({ channelName: 'ops/alerts', chatId: 'chat-1' }),
    ).not.toBe(
      getChannelMemoryFilePath({ channelName: 'ops alerts', chatId: 'chat-1' }),
    );
    expect(
      getChannelMemoryFilePath({ ...target, threadId: 'thread-1' }),
    ).not.toBe(getChannelMemoryFilePath({ ...target, threadId: 'thread-2' }));
  });

  it('renders JSON entries through the compatibility read API', async () => {
    writeJson(
      serializeChannelMemoryDocument({
        version: 1,
        entries: [
          { id: 'm-111111111111', text: 'Use staging' },
          { id: 'm-222222222222', text: 'Run tests' },
        ],
      }),
    );

    await expect(readChannelMemory(target)).resolves.toBe(
      'Use staging\nRun tests\n',
    );
  });

  it('lists deterministic legacy entries without creating JSON', async () => {
    writeLegacy('Use staging\nUse staging\n Run tests \n');

    const entries = await listChannelMemoryEntries(target);

    expect(entries.map((entry) => entry.text)).toEqual([
      'Use staging',
      ' Run tests ',
    ]);
    expect(entries.map((entry) => entry.id)).toEqual([
      'm-5c1888e97dc2',
      'm-477e65662a6b',
    ]);
    expect(fs.existsSync(getChannelMemoryFilePath(target))).toBe(false);
  });

  it('migrates legacy content on add and cleans up the legacy file after commit', async () => {
    const legacyPath = writeLegacy('Use staging\n');

    const result = await addChannelMemoryEntries(
      target,
      ['Run tests'],
      'alice',
    );

    expect(result.added).toHaveLength(1);
    expect(result.added[0].createdBy).toBe('alice');
    expect(fs.existsSync(getChannelMemoryFilePath(target))).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    await expect(listChannelMemoryEntries(target)).resolves.toMatchObject([
      { text: 'Use staging' },
      { text: 'Run tests' },
    ]);
  });

  it('waits for an old worker lock and migrates its final append', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    let releaseOldWorker = await lockfile.lock(legacyPath, {
      realpath: false,
      stale: 5000,
    });
    const legacyLockAttempted = deferred();
    lockObservation.path = legacyPath;
    lockObservation.attempted = legacyLockAttempted.resolve;

    const migration = addChannelMemoryEntries(target, ['Run tests']);
    try {
      const first = await Promise.race([
        legacyLockAttempted.promise.then(() => 'legacy-lock'),
        migration.then(() => 'migration-completed'),
      ]);
      expect(first).toBe('legacy-lock');

      fs.appendFileSync(legacyPath, 'Old worker append\n');
      await releaseOldWorker();
      releaseOldWorker = async () => {};

      await expect(migration).resolves.toMatchObject({ changed: true });
      await expect(readChannelMemory(target)).resolves.toBe(
        'Use staging\nOld worker append\nRun tests\n',
      );
      expect(fs.existsSync(legacyPath)).toBe(false);
    } finally {
      await releaseOldWorker();
    }
  });

  it('does not delete legacy bytes changed after canonical commit', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    fsFailure.legacyAppendAfterRename = {
      path: legacyPath,
      text: 'Late append\n',
    };

    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).resolves.toMatchObject({ changed: true });

    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(
      'Use staging\nLate append\n',
    );
    expect(fs.existsSync(getChannelMemoryFilePath(target))).toBe(true);
  });

  it('skips normalized duplicate additions and returns their existing IDs', async () => {
    const first = await addChannelMemoryEntries(
      target,
      ['Use staging'],
      'alice',
    );
    const duplicate = await addChannelMemoryEntries(
      target,
      [' use   STAGING '],
      'alice',
    );

    expect(duplicate).toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
      added: [],
      duplicateIds: [first.added[0].id],
    });
  });

  it('keeps append as a compatibility wrapper', async () => {
    await expect(appendChannelMemory(target, 'Use staging')).resolves.toEqual({
      changed: true,
      filePath: getChannelMemoryFilePath(target),
    });
    await expect(appendChannelMemory(target, ' use STAGING ')).resolves.toEqual(
      {
        changed: false,
        filePath: getChannelMemoryFilePath(target),
      },
    );
    await expect(readChannelMemory(target)).resolves.toBe('Use staging\n');
  });

  it('does not create memory for whitespace-only appends', async () => {
    await expect(appendChannelMemory(target, ' \n\t ')).resolves.toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
    });
    await expect(readChannelMemory(target)).resolves.toBe('');
  });

  it('updates only text and updatedAt while preserving identity metadata', async () => {
    const [entry] = (
      await addChannelMemoryEntries(target, ['Use staging'], 'alice')
    ).added;
    await new Promise((resolve) => setTimeout(resolve, 1));

    const result = await updateChannelMemoryEntry(target, {
      id: entry.id,
      text: 'Use production',
      expectedText: 'Use staging',
    });

    expect(result.changed).toBe(true);
    expect(result.entry).toMatchObject({
      id: entry.id,
      text: 'Use production',
      createdAt: entry.createdAt,
      createdBy: 'alice',
    });
    expect(result.entry?.updatedAt).not.toBe(entry.updatedAt);
  });

  it('rejects updates that duplicate another entry after normalization', async () => {
    const [first, second] = (
      await addChannelMemoryEntries(target, ['Use staging', 'Run tests'])
    ).added;

    await expect(
      updateChannelMemoryEntry(target, {
        id: second.id,
        text: ' use   STAGING ',
      }),
    ).rejects.toThrow('Channel memory entry already exists');

    await expect(listChannelMemoryEntries(target)).resolves.toMatchObject([
      { id: first.id, text: 'Use staging' },
      { id: second.id, text: 'Run tests' },
    ]);
  });

  it('returns no change for missing update IDs', async () => {
    await expect(
      updateChannelMemoryEntry(target, {
        id: 'm-111111111111',
        text: 'Use prod',
      }),
    ).resolves.toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
    });
  });

  it('rejects update CAS when the entry was deleted', async () => {
    const [entry] = (await addChannelMemoryEntries(target, ['Use staging']))
      .added;
    await removeChannelMemoryEntries(target, { ids: [entry.id] });

    await expect(
      updateChannelMemoryEntry(target, {
        id: entry.id,
        text: 'Use production',
        expectedText: 'Use staging',
      }),
    ).rejects.toThrow('Channel memory entry changed');
  });

  it('rejects remove CAS when any expected entry was deleted', async () => {
    const [first, second] = (
      await addChannelMemoryEntries(target, ['Use staging', 'Run tests'])
    ).added;
    await removeChannelMemoryEntries(target, { ids: [first.id] });

    await expect(
      removeChannelMemoryEntries(target, {
        ids: [first.id, second.id],
        expectedTextById: {
          [first.id]: first.text,
          [second.id]: second.text,
        },
      }),
    ).rejects.toThrow('Channel memory entry changed');
    await expect(listChannelMemoryEntries(target)).resolves.toEqual([second]);
  });

  it('rejects stale update and remove compare-and-swap requests', async () => {
    const [entry] = (await addChannelMemoryEntries(target, ['Use staging']))
      .added;

    await expect(
      updateChannelMemoryEntry(target, {
        id: entry.id,
        text: 'Use production',
        expectedText: 'stale text',
      }),
    ).rejects.toThrow('Channel memory entry changed');
    await expect(
      removeChannelMemoryEntries(target, {
        ids: [entry.id],
        expectedTextById: { [entry.id]: 'stale text' },
      }),
    ).rejects.toThrow('Channel memory entry changed');
  });

  it('removes requested IDs once and ignores missing IDs', async () => {
    const [entry] = (await addChannelMemoryEntries(target, ['Use staging']))
      .added;

    const result = await removeChannelMemoryEntries(target, {
      ids: [entry.id, entry.id, 'm-111111111111'],
    });

    expect(result.removed).toEqual([entry]);
    expect(result.changed).toBe(true);
    await expect(
      removeChannelMemoryEntries(target, { ids: ['m-111111111111'] }),
    ).resolves.toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
      removed: [],
    });
  });

  it('clears entries while preserving migration metadata', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    await addChannelMemoryEntries(target, ['Run tests']);
    const before = parseChannelMemoryDocument(
      fs.readFileSync(getChannelMemoryFilePath(target), 'utf8'),
    );

    await expect(clearChannelMemory(target)).resolves.toEqual({
      changed: true,
      filePath: getChannelMemoryFilePath(target),
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(
      parseChannelMemoryDocument(
        fs.readFileSync(getChannelMemoryFilePath(target), 'utf8'),
      ),
    ).toEqual({ version: 1, migration: before.migration, entries: [] });
  });

  it('reports no change when clearing sources with no entries', async () => {
    await expect(clearChannelMemory(target)).resolves.toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
    });
    writeLegacy('\n\n');
    await expect(clearChannelMemory(target)).resolves.toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
    });
  });

  it('rejects additions beyond request, entry, and text limits', async () => {
    await expect(
      addChannelMemoryEntries(
        target,
        Array.from({ length: 11 }, () => 'entry'),
      ),
    ).rejects.toThrow();
    await expect(
      addChannelMemoryEntries(target, ['a'.repeat(2_001)]),
    ).rejects.toThrow('Invalid channel memory entry');

    for (let index = 0; index < 50; index++) {
      await addChannelMemoryEntries(
        target,
        Array.from(
          { length: 10 },
          (_, offset) => `entry ${index * 10 + offset}`,
        ),
      );
    }
    await expect(addChannelMemoryEntries(target, ['too many'])).rejects.toThrow(
      'Channel memory exceeds maximum number of entries',
    );
  });

  it('rejects oversized serialized JSON without creating canonical storage', async () => {
    await expect(
      addChannelMemoryEntries(
        target,
        ['entry'],
        'x'.repeat(MAX_CHANNEL_MEMORY_BYTES),
      ),
    ).rejects.toThrow('Channel memory exceeds maximum size');
    expect(fs.existsSync(getChannelMemoryFilePath(target))).toBe(false);
  });

  it('fails closed for malformed JSON and unsupported JSON versions', async () => {
    writeLegacy('Use staging\n');
    writeJson('{');
    await expect(listChannelMemoryEntries(target)).rejects.toThrow(
      'Invalid channel memory document',
    );
    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).rejects.toThrow('Invalid channel memory document');
    expect(
      fs.readFileSync(getLegacyChannelMemoryFilePath(target), 'utf8'),
    ).toBe('Use staging\n');

    writeJson('{"version":2,"entries":[]}');
    await expect(listChannelMemoryEntries(target)).rejects.toThrow(
      'Unsupported channel memory version',
    );
  });

  it('rejects unknown JSON keys without modifying either source', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const legacyBefore = fs.readFileSync(legacyPath);
    const filePath = writeJson(
      JSON.stringify({
        version: 1,
        migration: {
          legacySha256: createHash('sha256').update(legacyBefore).digest('hex'),
        },
        entries: [{ id: 'm-111111111111', text: 'Use staging' }],
        futureMetadata: 'preserve me',
      }),
    );
    const canonicalBefore = fs.readFileSync(filePath);

    const readResult = await readChannelMemory(target).then(
      () => 'fulfilled',
      () => 'rejected',
    );
    const mutationResult = await addChannelMemoryEntries(target, [
      'Run tests',
    ]).then(
      () => 'fulfilled',
      () => 'rejected',
    );

    expect(readResult).toBe('rejected');
    expect(mutationResult).toBe('rejected');
    expect(fs.readFileSync(filePath)).toEqual(canonicalBefore);
    expect(fs.readFileSync(legacyPath)).toEqual(legacyBefore);
  });

  it('rejects invalid UTF-8 JSON without modifying either source', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const legacyBefore = fs.readFileSync(legacyPath);
    const migrationHash = createHash('sha256')
      .update(legacyBefore)
      .digest('hex');
    const filePath = getChannelMemoryFilePath(target);
    fs.writeFileSync(
      filePath,
      Buffer.concat([
        Buffer.from(
          `{"version":1,"migration":{"legacySha256":"${migrationHash}"},"entries":[{"id":"m-111111111111","text":"`,
        ),
        Buffer.from([0xff]),
        Buffer.from('"}]}'),
      ]),
    );
    const canonicalBefore = fs.readFileSync(filePath);

    await expect(readChannelMemory(target)).rejects.toThrow();
    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).rejects.toThrow();

    expect(fs.readFileSync(filePath)).toEqual(canonicalBefore);
    expect(fs.readFileSync(legacyPath)).toEqual(legacyBefore);
  });

  it('rejects invalid UTF-8 legacy bytes without migrating or modifying them', async () => {
    const legacyPath = getLegacyChannelMemoryFilePath(target);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, Buffer.from([0xff]));
    const legacyBefore = fs.readFileSync(legacyPath);

    await expect(readChannelMemory(target)).rejects.toThrow();
    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).rejects.toThrow();

    expect(fs.readFileSync(legacyPath)).toEqual(legacyBefore);
    expect(fs.existsSync(getChannelMemoryFilePath(target))).toBe(false);
  });

  it('rejects non-missing read errors without modifying either source', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const legacy = fs.readFileSync(legacyPath);
    const filePath = writeJson(
      serializeChannelMemoryDocument(parseLegacyChannelMemory(legacy)),
    );
    const canonicalBefore = fs.readFileSync(filePath);
    const legacyBefore = fs.readFileSync(legacyPath);
    fsFailure.readErrorPath = filePath;

    await expect(listChannelMemoryEntries(target)).rejects.toMatchObject({
      code: 'EIO',
      message: 'read failed',
    });
    await expect(readChannelMemory(target)).rejects.toMatchObject({
      code: 'EIO',
      message: 'read failed',
    });
    expect(fs.readFileSync(filePath)).toEqual(canonicalBefore);
    expect(fs.readFileSync(legacyPath)).toEqual(legacyBefore);
  });

  it('accepts matching dual files and cleans up legacy only after a mutation', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const legacy = fs.readFileSync(legacyPath);
    writeJson(serializeChannelMemoryDocument(parseLegacyChannelMemory(legacy)));

    await expect(listChannelMemoryEntries(target)).resolves.toMatchObject([
      { text: 'Use staging' },
    ]);
    expect(fs.existsSync(legacyPath)).toBe(true);
    await addChannelMemoryEntries(target, ['Run tests']);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('re-reads canonical JSON across the first-migration rename race', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const filePath = getChannelMemoryFilePath(target);
    const jsonRead = deferred();
    const releaseLegacyRead = deferred();
    fsFailure.readRace = {
      jsonPath: filePath,
      legacyPath,
      jsonRead: jsonRead.resolve,
      waitToReadLegacy: () => releaseLegacyRead.promise,
      jsonIntercepted: false,
      legacyIntercepted: false,
    };

    const entriesPromise = listChannelMemoryEntries(target);
    await jsonRead.promise;
    await addChannelMemoryEntries(target, ['Run tests']);
    releaseLegacyRead.resolve();

    await expect(entriesPromise).resolves.toMatchObject([
      { text: 'Use staging' },
      { text: 'Run tests' },
    ]);
  });

  it('rejects divergent or unhashed dual files', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const legacy = fs.readFileSync(legacyPath);
    const document = parseLegacyChannelMemory(legacy);
    writeJson(
      serializeChannelMemoryDocument({
        ...document,
        migration: {
          legacySha256: createHash('sha256').update('different').digest('hex'),
        },
      }),
    );
    await expect(listChannelMemoryEntries(target)).rejects.toThrow(
      'Channel memory migration conflict',
    );

    writeJson(serializeChannelMemoryDocument({ version: 1, entries: [] }));
    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).rejects.toThrow('Channel memory migration conflict');
  });

  it('cleans a written temp file and recovers lock and queue after sync failure', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const directory = path.dirname(legacyPath);
    fsFailure.tempSync = true;

    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).rejects.toThrow('temp sync failed');
    expect(fsFailure.tempBytesAtSync).toBeGreaterThan(0);
    expect(
      fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    expect(fs.existsSync(getChannelMemoryFilePath(target))).toBe(false);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('Use staging\n');

    fsFailure.tempSync = false;
    await expect(
      addChannelMemoryEntries(target, ['after failure']),
    ).resolves.toMatchObject({
      changed: true,
    });
    await expect(readChannelMemory(target)).resolves.toBe(
      'Use staging\nafter failure\n',
    );
  });

  it('preserves the previous JSON when atomic rename fails', async () => {
    await addChannelMemoryEntries(target, ['Use staging']);
    const filePath = getChannelMemoryFilePath(target);
    const previous = fs.readFileSync(filePath, 'utf8');
    fsFailure.rename = true;

    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).rejects.toThrow('rename failed');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(previous);
  });

  it('reports a committed migration when legacy cleanup fails and retries later', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    fsFailure.legacyUnlinkPath = legacyPath;

    await expect(
      addChannelMemoryEntries(target, ['Run tests']),
    ).resolves.toMatchObject({
      changed: true,
      added: [{ text: 'Run tests' }],
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
    await expect(readChannelMemory(target)).resolves.toBe(
      'Use staging\nRun tests\n',
    );

    fsFailure.legacyUnlinkPath = undefined;
    await addChannelMemoryEntries(target, ['Review diff']);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('serializes concurrent additions without losing entries', async () => {
    const additions = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        addChannelMemoryEntries(target, [`entry ${index}`]),
      ),
    );
    const entries = await listChannelMemoryEntries(target);

    expect(entries).toHaveLength(20);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(20);
    expect(
      new Set(
        additions.flatMap((result) => result.added.map((entry) => entry.text)),
      ),
    ).toEqual(
      new Set(Array.from({ length: 20 }, (_, index) => `entry ${index}`)),
    );
    expect(() =>
      parseChannelMemoryDocument(
        fs.readFileSync(getChannelMemoryFilePath(target), 'utf8'),
      ),
    ).not.toThrow();
  });

  it('allows only one stale compare-and-swap operation to win', async () => {
    const [entry] = (await addChannelMemoryEntries(target, ['Use staging']))
      .added;
    const results = await Promise.allSettled([
      updateChannelMemoryEntry(target, {
        id: entry.id,
        text: 'Use production',
        expectedText: 'Use staging',
      }),
      removeChannelMemoryEntries(target, {
        ids: [entry.id],
        expectedTextById: { [entry.id]: 'Use staging' },
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('rejects an update CAS when a racing remove is queued first', async () => {
    const [entry] = (await addChannelMemoryEntries(target, ['Use staging']))
      .added;
    const results = await Promise.allSettled([
      removeChannelMemoryEntries(target, {
        ids: [entry.id],
        expectedTextById: { [entry.id]: 'Use staging' },
      }),
      updateChannelMemoryEntry(target, {
        id: entry.id,
        text: 'Use production',
        expectedText: 'Use staging',
      }),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: new Error('Channel memory entry changed'),
    });
  });

  it('serializes clear racing additions and first migration racing another add', async () => {
    writeLegacy('Use staging\n');
    await Promise.all([
      addChannelMemoryEntries(target, ['Run tests']),
      addChannelMemoryEntries(target, ['Review diff']),
    ]);
    await expect(readChannelMemory(target)).resolves.toBe(
      'Use staging\nRun tests\nReview diff\n',
    );
    await Promise.all([
      clearChannelMemory(target),
      ...Array.from({ length: 10 }, (_, index) =>
        addChannelMemoryEntries(target, [`entry ${index}`]),
      ),
    ]);

    const entries = await listChannelMemoryEntries(target);
    expect(entries.map((entry) => entry.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `entry ${index}`),
    );
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(() =>
      parseChannelMemoryDocument(
        fs.readFileSync(getChannelMemoryFilePath(target), 'utf8'),
      ),
    ).not.toThrow();
  });
});
