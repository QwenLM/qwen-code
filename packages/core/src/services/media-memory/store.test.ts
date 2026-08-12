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
