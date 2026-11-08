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
  getChannelMemoryRevision,
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
  options: undefined as lockfile.LockOptions | undefined,
  simulateCompromise: false,
}));

// Pristine copies; afterEach restores both objects from these.
const FS_FAILURE_DEFAULTS = { ...fsFailure };
const LOCK_OBSERVATION_DEFAULTS = { ...lockObservation };

vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    default: {
      ...actual,
      async lock(...args: Parameters<typeof actual.lock>) {
        if (String(args[0]) === lockObservation.path) {
          lockObservation.options = args[1];
          lockObservation.attempted?.();
          const release = await actual.lock(...args);
          if (lockObservation.simulateCompromise) {
            // A real compromise marks the lock released in the registry
            // before invoking onCompromised, so release() later rejects
            // with ERELEASED. Reproduce that state exactly.
            lockObservation.options?.onCompromised?.(new Error('lock lost'));
            await release();
          }
          return release;
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
    Object.assign(fsFailure, FS_FAILURE_DEFAULTS);
    Object.assign(lockObservation, LOCK_OBSERVATION_DEFAULTS);
    vi.restoreAllMocks();
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  const jsonPath = () => getChannelMemoryFilePath(target);
  const revision = () => getChannelMemoryRevision(target);
  const list = () => listChannelMemoryEntries(target);
  const read = () => readChannelMemory(target);
  const add = (texts: readonly string[], createdBy?: string) =>
    addChannelMemoryEntries(target, texts, createdBy);
  const addEntries = async (...texts: string[]) => (await add(texts)).added;
  const update = (mutation: Parameters<typeof updateChannelMemoryEntry>[1]) =>
    updateChannelMemoryEntry(target, mutation);
  const remove = (mutation: Parameters<typeof removeChannelMemoryEntries>[1]) =>
    removeChannelMemoryEntries(target, mutation);
  const unchanged = () => ({ changed: false, filePath: jsonPath() });
  const ENTRY_CHANGED = 'Channel memory entry changed';
  // Compare-and-swap requests guarded by the entry's expected current text.
  const casUpdate = (id: string, expectedText = 'Use staging') =>
    update({ id, text: 'Use production', expectedText });
  const casRemove = (id: string, expectedText = 'Use staging') =>
    remove({ ids: [id], expectedTextById: { [id]: expectedText } });
  const readDoc = () =>
    parseChannelMemoryDocument(fs.readFileSync(jsonPath(), 'utf8'));
  const expectListed = (...texts: string[]) =>
    expect(list()).resolves.toMatchObject(texts.map((text) => ({ text })));

  function writeLegacy(text: string | Uint8Array): string {
    const legacyPath = getLegacyChannelMemoryFilePath(target);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, text);
    return legacyPath;
  }

  function writeJson(raw: string | Uint8Array): string {
    const filePath = jsonPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, raw);
    return filePath;
  }

  const writeEntries = (...entries: Array<{ id: string; text: string }>) =>
    writeJson(serializeChannelMemoryDocument({ version: 1, entries }));

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function expectCredentialRejection(
    write: () => Promise<unknown>,
  ): Promise<void> {
    let error: unknown;
    try {
      await write();
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error ? error.message : undefined).toBe(
      'Channel memory cannot store detected credentials',
    );
  }

  it('uses JSON for canonical storage and Markdown for legacy storage', () => {
    const filePath = jsonPath();
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

  it('returns a stable opaque revision when channel memory is missing', async () => {
    const first = await revision();
    const second = await revision();

    expect(second).toBe(first);
    expect(first).not.toContain(qwenHome);
    expect(first).not.toContain('CHANNEL.json');
    expect(first).not.toContain('CHANNEL.md');
  });

  it('changes revision when canonical channel memory changes', async () => {
    const missing = await revision();
    writeEntries({ id: 'm-111111111111', text: 'Use staging' });
    const created = await revision();
    writeEntries({ id: 'm-111111111111', text: 'Use production instead' });
    const replaced = await revision();

    expect(created).not.toBe(missing);
    expect(replaced).not.toBe(created);
  });

  it('changes revision after an external atomic replacement', async () => {
    const filePath = writeEntries({
      id: 'm-111111111111',
      text: 'Use staging',
    });
    const before = await revision();
    const replacementPath = path.join(path.dirname(filePath), '.external.tmp');
    fs.writeFileSync(replacementPath, fs.readFileSync(filePath));
    fs.renameSync(replacementPath, filePath);

    expect(await revision()).not.toBe(before);
  });

  it('changes revision after each successful structured mutation', async () => {
    const revisions = [await revision()];
    const [entry] = await addEntries('Use staging');
    revisions.push(await revision());
    await update({ id: entry.id, text: 'Use production' });
    revisions.push(await revision());
    await remove({ ids: [entry.id] });
    revisions.push(await revision());
    await add(['Run tests']);
    revisions.push(await revision());
    await clearChannelMemory(target);
    revisions.push(await revision());

    for (let index = 1; index < revisions.length; index += 1) {
      expect(revisions[index]).not.toBe(revisions[index - 1]);
    }
  });

  it('changes revision when legacy channel memory changes', async () => {
    const missing = await revision();
    const legacyPath = writeLegacy('Use staging\n');
    const created = await revision();
    fs.writeFileSync(legacyPath, 'Use production instead\n');
    const replaced = await revision();
    fs.unlinkSync(legacyPath);
    const removed = await revision();

    expect(created).not.toBe(missing);
    expect(replaced).not.toBe(created);
    expect(removed).toBe(missing);
  });

  it('renders JSON entries through the compatibility read API', async () => {
    writeEntries(
      { id: 'm-111111111111', text: 'Use staging' },
      { id: 'm-222222222222', text: 'Run tests' },
    );

    await expect(read()).resolves.toBe('Use staging\nRun tests\n');
  });

  it('lists deterministic legacy entries without creating JSON', async () => {
    writeLegacy('Use staging\nUse staging\n Run tests \n');

    const entries = await list();

    expect(entries.map((entry) => entry.text)).toEqual([
      'Use staging',
      ' Run tests ',
    ]);
    expect(entries.map((entry) => entry.id)).toEqual([
      'm-5c1888e97dc2',
      'm-477e65662a6b',
    ]);
    expect(fs.existsSync(jsonPath())).toBe(false);
  });

  it('migrates legacy content on add and cleans up the legacy file after commit', async () => {
    const legacyPath = writeLegacy('Use staging\n');

    const result = await add(['Run tests'], 'alice');

    expect(result.added).toHaveLength(1);
    expect(result.added[0].createdBy).toBe('alice');
    expect(fs.existsSync(jsonPath())).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    await expectListed('Use staging', 'Run tests');
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

    const migration = add(['Run tests']);
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
      await expect(read()).resolves.toBe(
        'Use staging\nOld worker append\nRun tests\n',
      );
      expect(fs.existsSync(legacyPath)).toBe(false);
    } finally {
      await releaseOldWorker();
    }
  });

  it('completes mutations when the channel memory lock is compromised', async () => {
    writeEntries();
    lockObservation.path = path.join(
      path.dirname(jsonPath()),
      '.channel-memory.lock',
    );
    lockObservation.simulateCompromise = true;

    await expect(add(['Run tests'])).resolves.toMatchObject({ changed: true });

    expect(lockObservation.options?.onCompromised).toBeTypeOf('function');
    await expect(read()).resolves.toBe('Run tests\n');
  });

  it('does not delete legacy bytes changed after canonical commit', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    fsFailure.legacyAppendAfterRename = {
      path: legacyPath,
      text: 'Late append\n',
    };

    await expect(add(['Run tests'])).resolves.toMatchObject({ changed: true });

    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(
      'Use staging\nLate append\n',
    );
    expect(fs.existsSync(jsonPath())).toBe(true);
  });

  it('skips normalized duplicate additions and returns their existing IDs', async () => {
    const first = await add(['Use staging'], 'alice');
    const duplicate = await add([' use   STAGING '], 'alice');

    expect(duplicate).toEqual({
      ...unchanged(),
      added: [],
      duplicateIds: [first.added[0].id],
    });
  });

  it('rejects credential-bearing batches before creating canonical storage', async () => {
    const credentialText = `ghp_${'a'.repeat(36)}`;

    await expectCredentialRejection(() => add(['Use staging', credentialText]));

    expect(fs.existsSync(jsonPath())).toBe(false);
  });

  it('rejects credential-bearing batches without changing canonical storage', async () => {
    await add(['Use staging']);
    const before = fs.readFileSync(jsonPath());
    const credentialText = `ghp_${'b'.repeat(36)}`;

    await expectCredentialRejection(() => add(['Run tests', credentialText]));

    expect(fs.readFileSync(jsonPath())).toEqual(before);
  });

  it('persists the scanned add snapshot when an input getter changes', async () => {
    const credentialText = `ghp_${'e'.repeat(36)}`;
    const texts = ['Use staging', 'Run tests'];
    let secondTextReads = 0;
    Object.defineProperty(texts, '1', {
      configurable: true,
      enumerable: true,
      get() {
        secondTextReads += 1;
        return secondTextReads === 1 ? 'Run tests' : credentialText;
      },
    });

    await add(texts);

    await expectListed('Use staging', 'Run tests');
    expect(secondTextReads).toBe(1);
  });

  it('keeps append as a compatibility wrapper', async () => {
    await expect(appendChannelMemory(target, 'Use staging')).resolves.toEqual({
      changed: true,
      filePath: jsonPath(),
    });
    await expect(appendChannelMemory(target, ' use STAGING ')).resolves.toEqual(
      unchanged(),
    );
    await expect(read()).resolves.toBe('Use staging\n');
  });

  it('does not create memory for whitespace-only appends', async () => {
    await expect(appendChannelMemory(target, ' \n\t ')).resolves.toEqual(
      unchanged(),
    );
    await expect(read()).resolves.toBe('');
  });

  it('updates only text and updatedAt while preserving identity metadata', async () => {
    const [entry] = (await add(['Use staging'], 'alice')).added;
    await new Promise((resolve) => setTimeout(resolve, 1));

    const result = await casUpdate(entry.id);

    expect(result.changed).toBe(true);
    expect(result.entry).toMatchObject({
      id: entry.id,
      text: 'Use production',
      createdAt: entry.createdAt,
      createdBy: 'alice',
    });
    expect(result.entry?.updatedAt).not.toBe(entry.updatedAt);
  });

  it('rejects credential-bearing replacements without changing the entry', async () => {
    const [entry] = await addEntries('Use staging');
    const before = fs.readFileSync(jsonPath());
    const credentialText = `ghp_${'c'.repeat(36)}`;

    await expectCredentialRejection(() =>
      update({ id: entry.id, text: credentialText }),
    );

    expect(fs.readFileSync(jsonPath())).toEqual(before);
    await expect(list()).resolves.toEqual([entry]);
  });

  it('persists one scanned update snapshot when mutation getters change', async () => {
    const [entry] = await addEntries('Use staging');
    const credentialText = `ghp_${'f'.repeat(36)}`;
    const reads = { id: 0, text: 0, expectedText: 0 };
    const mutation = {
      get id() {
        reads.id += 1;
        return entry.id;
      },
      get text() {
        reads.text += 1;
        return reads.text === 1 ? 'Use production' : credentialText;
      },
      get expectedText() {
        reads.expectedText += 1;
        return 'Use staging';
      },
    };

    await update(mutation);

    await expect(list()).resolves.toMatchObject([
      { id: entry.id, text: 'Use production' },
    ]);
    expect(reads).toEqual({ id: 1, text: 1, expectedText: 1 });
  });

  it('allows manually seeded credential entries to be removed and cleared', async () => {
    const credentialText = `ghp_${'d'.repeat(36)}`;
    const entry = { id: 'm-111111111111', text: credentialText };
    writeEntries(entry);

    await expect(remove({ ids: [entry.id] })).resolves.toMatchObject({
      changed: true,
      removed: [entry],
    });
    await expect(list()).resolves.toEqual([]);

    writeEntries(entry);
    await expect(clearChannelMemory(target)).resolves.toMatchObject({
      changed: true,
    });
    await expect(list()).resolves.toEqual([]);
  });

  it('rejects updates that duplicate another entry after normalization', async () => {
    const [first, second] = await addEntries('Use staging', 'Run tests');

    await expect(
      update({ id: second.id, text: ' use   STAGING ' }),
    ).rejects.toThrow('Channel memory entry already exists');

    await expect(list()).resolves.toMatchObject([
      { id: first.id, text: 'Use staging' },
      { id: second.id, text: 'Run tests' },
    ]);
  });

  it('returns no change for missing update IDs', async () => {
    await expect(
      update({ id: 'm-111111111111', text: 'Use prod' }),
    ).resolves.toEqual(unchanged());
  });

  it('rejects update CAS when the entry was deleted', async () => {
    const [entry] = await addEntries('Use staging');
    await remove({ ids: [entry.id] });

    await expect(casUpdate(entry.id)).rejects.toThrow(ENTRY_CHANGED);
  });

  it('rejects remove CAS when any expected entry was deleted', async () => {
    const [first, second] = await addEntries('Use staging', 'Run tests');
    await remove({ ids: [first.id] });

    await expect(
      remove({
        ids: [first.id, second.id],
        expectedTextById: {
          [first.id]: first.text,
          [second.id]: second.text,
        },
      }),
    ).rejects.toThrow(ENTRY_CHANGED);
    await expect(list()).resolves.toEqual([second]);
  });

  it('rejects stale update and remove compare-and-swap requests', async () => {
    const [entry] = await addEntries('Use staging');

    await expect(casUpdate(entry.id, 'stale text')).rejects.toThrow(
      ENTRY_CHANGED,
    );
    await expect(casRemove(entry.id, 'stale text')).rejects.toThrow(
      ENTRY_CHANGED,
    );
  });

  it('removes requested IDs once and ignores missing IDs', async () => {
    const [entry] = await addEntries('Use staging');

    const result = await remove({
      ids: [entry.id, entry.id, 'm-111111111111'],
    });

    expect(result.removed).toEqual([entry]);
    expect(result.changed).toBe(true);
    await expect(remove({ ids: ['m-111111111111'] })).resolves.toEqual({
      ...unchanged(),
      removed: [],
    });
  });

  it('clears entries while preserving migration metadata', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    await add(['Run tests']);
    const before = readDoc();

    await expect(clearChannelMemory(target)).resolves.toEqual({
      changed: true,
      filePath: jsonPath(),
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(readDoc()).toEqual({
      version: 1,
      migration: before.migration,
      entries: [],
    });
  });

  it('reports no change when clearing sources with no entries', async () => {
    await expect(clearChannelMemory(target)).resolves.toEqual(unchanged());
    writeLegacy('\n\n');
    await expect(clearChannelMemory(target)).resolves.toEqual(unchanged());
  });

  it('rejects additions beyond request, entry, and text limits', async () => {
    await expect(
      add(Array.from({ length: 11 }, () => 'entry')),
    ).rejects.toThrow();
    await expect(add(['a'.repeat(2_001)])).rejects.toThrow(
      'Invalid channel memory entry',
    );

    for (let index = 0; index < 50; index++) {
      await add(
        Array.from(
          { length: 10 },
          (_, offset) => `entry ${index * 10 + offset}`,
        ),
      );
    }
    await expect(add(['too many'])).rejects.toThrow(
      'Channel memory exceeds maximum number of entries',
    );
  });

  it('rejects oversized serialized JSON without creating canonical storage', async () => {
    await expect(
      add(['entry'], 'x'.repeat(MAX_CHANNEL_MEMORY_BYTES)),
    ).rejects.toThrow('Channel memory exceeds maximum size');
    expect(fs.existsSync(jsonPath())).toBe(false);
  });

  it('fails closed for malformed JSON and unsupported JSON versions', async () => {
    writeLegacy('Use staging\n');
    writeJson('{');
    await expect(list()).rejects.toThrow('Invalid channel memory document');
    await expect(add(['Run tests'])).rejects.toThrow(
      'Invalid channel memory document',
    );
    expect(
      fs.readFileSync(getLegacyChannelMemoryFilePath(target), 'utf8'),
    ).toBe('Use staging\n');

    writeJson('{"version":2,"entries":[]}');
    await expect(list()).rejects.toThrow('Unsupported channel memory version');
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
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => 'fulfilled',
        () => 'rejected',
      );

    const readResult = await outcome(read());
    const mutationResult = await outcome(add(['Run tests']));

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
    const filePath = writeJson(
      Buffer.concat([
        Buffer.from(
          `{"version":1,"migration":{"legacySha256":"${migrationHash}"},"entries":[{"id":"m-111111111111","text":"`,
        ),
        Buffer.from([0xff]),
        Buffer.from('"}]}'),
      ]),
    );
    const canonicalBefore = fs.readFileSync(filePath);

    await expect(read()).rejects.toThrow();
    await expect(add(['Run tests'])).rejects.toThrow();

    expect(fs.readFileSync(filePath)).toEqual(canonicalBefore);
    expect(fs.readFileSync(legacyPath)).toEqual(legacyBefore);
  });

  it('rejects invalid UTF-8 legacy bytes without migrating or modifying them', async () => {
    const legacyPath = writeLegacy(Buffer.from([0xff]));
    const legacyBefore = fs.readFileSync(legacyPath);

    await expect(read()).rejects.toThrow();
    await expect(add(['Run tests'])).rejects.toThrow();

    expect(fs.readFileSync(legacyPath)).toEqual(legacyBefore);
    expect(fs.existsSync(jsonPath())).toBe(false);
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

    for (const load of [list, read]) {
      await expect(load()).rejects.toMatchObject({
        code: 'EIO',
        message: 'read failed',
      });
    }
    expect(fs.readFileSync(filePath)).toEqual(canonicalBefore);
    expect(fs.readFileSync(legacyPath)).toEqual(legacyBefore);
  });

  it('accepts matching dual files and cleans up legacy only after a mutation', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const legacy = fs.readFileSync(legacyPath);
    writeJson(serializeChannelMemoryDocument(parseLegacyChannelMemory(legacy)));

    await expectListed('Use staging');
    expect(fs.existsSync(legacyPath)).toBe(true);
    await add(['Run tests']);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('re-reads canonical JSON across the first-migration rename race', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const jsonRead = deferred();
    const releaseLegacyRead = deferred();
    fsFailure.readRace = {
      jsonPath: jsonPath(),
      legacyPath,
      jsonRead: jsonRead.resolve,
      waitToReadLegacy: () => releaseLegacyRead.promise,
      jsonIntercepted: false,
      legacyIntercepted: false,
    };

    const entriesPromise = list();
    await jsonRead.promise;
    await add(['Run tests']);
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
    await expect(list()).rejects.toThrow('Channel memory migration conflict');

    writeEntries();
    await expect(add(['Run tests'])).rejects.toThrow(
      'Channel memory migration conflict',
    );
  });

  it('cleans a written temp file and recovers lock and queue after sync failure', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    const directory = path.dirname(legacyPath);
    fsFailure.tempSync = true;

    await expect(add(['Run tests'])).rejects.toThrow('temp sync failed');
    expect(fsFailure.tempBytesAtSync).toBeGreaterThan(0);
    expect(
      fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    expect(fs.existsSync(jsonPath())).toBe(false);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('Use staging\n');

    fsFailure.tempSync = false;
    await expect(add(['after failure'])).resolves.toMatchObject({
      changed: true,
    });
    await expect(read()).resolves.toBe('Use staging\nafter failure\n');
  });

  it('preserves the previous JSON when atomic rename fails', async () => {
    await add(['Use staging']);
    const previous = fs.readFileSync(jsonPath(), 'utf8');
    fsFailure.rename = true;

    await expect(add(['Run tests'])).rejects.toThrow('rename failed');
    expect(fs.readFileSync(jsonPath(), 'utf8')).toBe(previous);
  });

  it('reports a committed migration when legacy cleanup fails and retries later', async () => {
    const legacyPath = writeLegacy('Use staging\n');
    fsFailure.legacyUnlinkPath = legacyPath;

    await expect(add(['Run tests'])).resolves.toMatchObject({
      changed: true,
      added: [{ text: 'Run tests' }],
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
    await expect(read()).resolves.toBe('Use staging\nRun tests\n');

    fsFailure.legacyUnlinkPath = undefined;
    await add(['Review diff']);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('serializes concurrent additions without losing entries', async () => {
    const texts = Array.from({ length: 20 }, (_, index) => `entry ${index}`);
    const additions = await Promise.all(texts.map((text) => add([text])));
    const entries = await list();

    expect(entries).toHaveLength(20);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(20);
    expect(
      new Set(
        additions.flatMap((result) => result.added.map((entry) => entry.text)),
      ),
    ).toEqual(new Set(texts));
    expect(readDoc).not.toThrow();
  });

  it('allows only one stale compare-and-swap operation to win', async () => {
    const [entry] = await addEntries('Use staging');
    const results = await Promise.allSettled([
      casUpdate(entry.id),
      casRemove(entry.id),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('rejects an update CAS when a racing remove is queued first', async () => {
    const [entry] = await addEntries('Use staging');
    const results = await Promise.allSettled([
      casRemove(entry.id),
      casUpdate(entry.id),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: new Error(ENTRY_CHANGED),
    });
  });

  it('serializes clear racing additions and first migration racing another add', async () => {
    writeLegacy('Use staging\n');
    await Promise.all([add(['Run tests']), add(['Review diff'])]);
    await expect(read()).resolves.toBe('Use staging\nRun tests\nReview diff\n');
    const texts = Array.from({ length: 10 }, (_, index) => `entry ${index}`);
    await Promise.all([
      clearChannelMemory(target),
      ...texts.map((text) => add([text])),
    ]);

    const entries = await list();
    expect(entries.map((entry) => entry.text)).toEqual(texts);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(readDoc).not.toThrow();
  });
});
