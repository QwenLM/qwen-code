/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaMemoryStore, MEDIA_MEMORY_FILE_NAME } from './store.js';

let root: string;
let store: MediaMemoryStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-memory-store-'));
  store = new MediaMemoryStore(root);
});

afterEach(async () => {
  await fs.chmod(root, 0o700).catch(() => {});
  await fs.chmod(store.filePath, 0o600).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

// chmod-based denial tests are meaningless on Windows and as root.
const canDropPermissions =
  process.platform !== 'win32' &&
  (typeof process.getuid !== 'function' || process.getuid() !== 0);

async function listCorruptBackups(): Promise<string[]> {
  return (await fs.readdir(root)).filter((n) =>
    n.startsWith(`${MEDIA_MEMORY_FILE_NAME}.corrupt-`),
  );
}

describe('MediaMemoryStore', () => {
  it('starts from an empty snapshot when the document does not exist', async () => {
    const counts = await store.read(undefined, (snapshot) => ({
      schemaVersion: snapshot.schemaVersion,
      files: Object.keys(snapshot.files).length,
      versions: Object.keys(snapshot.versions).length,
    }));
    expect(counts).toEqual({ schemaVersion: 1, files: 0, versions: 0 });
    // A pure read never creates the document.
    await expect(fs.stat(store.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('persists a changed snapshot atomically and reloads it', async () => {
    await store.transact(undefined, (snapshot) => {
      snapshot.files['f1'] = {
        fileId: 'f1',
        rootFileId: 'f1',
        fileRef: '/tmp/a.mp4',
        origin: 'user',
        currentVersionId: 'v1',
        createdAt: '2026-08-11T00:00:00.000Z',
      };
      return { result: undefined, changed: true };
    });
    const reloaded = new MediaMemoryStore(root);
    const fileIds = await reloaded.read([], (snapshot) =>
      Object.keys(snapshot.files),
    );
    expect(fileIds).toEqual(['f1']);
    const stat = await fs.stat(store.filePath);
    if (canDropPermissions) {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  // Rename replaces the inode; an in-place write keeps it. Meaningless on
  // Windows, where fs.stat().ino is not a stable identity.
  it.runIf(process.platform !== 'win32')(
    'replaces the document by rename instead of writing over it in place',
    async () => {
      const put = (fileId: string) =>
        store.transact(undefined, (snapshot) => {
          snapshot.files[fileId] = {
            fileId,
            rootFileId: fileId,
            fileRef: `/tmp/${fileId}.mp4`,
            origin: 'user',
            currentVersionId: 'v1',
            createdAt: '2026-08-11T00:00:00.000Z',
          };
          return { result: undefined, changed: true };
        });

      await put('f1');
      const before = await fs.stat(store.filePath);
      await put('f2');
      const after = await fs.stat(store.filePath);

      // An in-place rewrite truncates the live document first, so a
      // concurrent reader (another store instance, another process on the
      // same project) or a crash mid-write leaves half a JSON document —
      // which the load path can only treat as corrupt, condemning the whole
      // graph to a .corrupt backup and re-derivation.
      expect(after.ino).not.toBe(before.ino);
      expect(
        JSON.parse(await fs.readFile(store.filePath, 'utf8')),
      ).toMatchObject({ schemaVersion: 1, files: { f1: {}, f2: {} } });
      // The staging file is committed by the rename, never left behind.
      expect(
        (await fs.readdir(root)).filter((n) => n.endsWith('.tmp')),
      ).toEqual([]);
    },
  );

  it('does not save when the mutator reports no change', async () => {
    await store.transact(undefined, (snapshot) => {
      snapshot.files['ghost'] = {
        fileId: 'ghost',
        rootFileId: 'ghost',
        fileRef: 'x',
        origin: 'user',
        currentVersionId: 'v',
        createdAt: 'now',
      };
      return { result: undefined, changed: false };
    });
    await expect(fs.stat(store.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('backs up a corrupt document and rebuilds empty', async () => {
    await fs.writeFile(store.filePath, 'not json at all');
    const files = await store.read(undefined, (snapshot) =>
      Object.keys(snapshot.files),
    );
    expect(files).toEqual([]);
    expect(await listCorruptBackups()).toHaveLength(1);
  });

  it('treats an unexpected shape (wrong schemaVersion) as corrupt', async () => {
    await fs.writeFile(
      store.filePath,
      JSON.stringify({ schemaVersion: 99, files: {} }),
    );
    const version = await store.read(undefined, (s) => s.schemaVersion);
    expect(version).toBe(1);
    expect(await listCorruptBackups()).toHaveLength(1);
  });

  it('prunes a malformed record value instead of blacking out every read', async () => {
    // Envelope is valid, so the corrupt-backup self-heal never fires: a
    // single non-object value used to surface as raw TypeErrors from every
    // read path, caught into miss/empty — a PERMANENT global recall
    // blackout for the whole project.
    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 1,
        files: { f1: { fileId: 'f1', fileRef: '/a.mkv' }, f2: null },
        versions: { v1: 'not-an-object' },
        executions: {},
        entries: {},
      }),
    );

    const seen = await store.read(undefined, (s) => ({
      files: Object.keys(s.files),
      versions: Object.keys(s.versions),
      // Dereferences values exactly like the real index/lookup paths do —
      // a surviving bad value would throw right here.
      refs: Object.values(s.files).map((f) => f.fileRef),
    }));

    expect(seen).toEqual({ files: ['f1'], versions: [], refs: ['/a.mkv'] });
    // Valid records survive, so the document is NOT condemned.
    expect(await listCorruptBackups()).toHaveLength(0);
  });

  it('keeps at most two corrupt backups', async () => {
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(store.filePath, `broken-${i}`);
      await store.read(undefined, () => undefined);
      // Distinct Date.now() suffixes.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect((await listCorruptBackups()).length).toBeLessThanOrEqual(2);
  });

  it('discards the OLDEST corrupt backups, keeping the newest', async () => {
    // Backups from earlier sessions, oldest first.
    for (const stamp of ['1000000000000', '1000000000001', '1000000000002']) {
      await fs.writeFile(`${store.filePath}.corrupt-${stamp}`, 'old');
    }
    await fs.writeFile(store.filePath, 'not json at all');
    await store.read(undefined, () => undefined);

    // A backup is the only surviving evidence of what went wrong, and the
    // corruption worth investigating is the one that just happened —
    // retaining the oldest two would delete the fresh backup and keep
    // documents from sessions nobody is debugging.
    const stamps = (await listCorruptBackups()).map((name) =>
      name.slice(`${MEDIA_MEMORY_FILE_NAME}.corrupt-`.length),
    );
    expect(stamps).toHaveLength(2);
    expect(stamps.some((s) => Number(s) > 1_700_000_000_000)).toBe(true);
    expect(stamps).toContain('1000000000002');
    expect(stamps).not.toContain('1000000000001');
    expect(stamps).not.toContain('1000000000000');
  });

  it.runIf(canDropPermissions)(
    'returns unreadableResult and never saves when the document exists but cannot be read',
    async () => {
      await store.transact(undefined, (snapshot) => {
        snapshot.entries['e1'] = {
          outputId: 'e1',
          kind: 'policy_result',
          scope: {},
          channels: [],
          coverage: { mode: 'complete', scope: {} },
          parentVersionId: 'v1',
          producedByExecutionId: 'x1',
          createdAt: 'now',
        };
        return { result: undefined, changed: true };
      });
      await fs.chmod(store.filePath, 0o000);
      const result = await store.transact('unreadable', (snapshot) => {
        snapshot.entries = {};
        return { result: 'mutated', changed: true };
      });
      expect(result).toBe('unreadable');
      await fs.chmod(store.filePath, 0o600);
      // The prior graph survived — a transient denial never wipes memory.
      const entryCount = await store.read(
        0,
        (s) => Object.keys(s.entries).length,
      );
      expect(entryCount).toBe(1);
    },
  );

  it.runIf(canDropPermissions)(
    'surfaces save failures to the caller (transact rejects)',
    async () => {
      await fs.chmod(root, 0o500);
      await expect(
        store.transact(undefined, () => ({ result: undefined, changed: true })),
      ).rejects.toThrow();
    },
  );
});
