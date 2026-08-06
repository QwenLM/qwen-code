/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmniObjectStore } from './storage.js';
import { OmniUploadCache } from './upload-cache.js';
import {
  runStartupRecoveryOnce,
  resetRecoveryLatchForTests,
} from './recovery.js';

let qwenDir: string;
let store: OmniObjectStore;

beforeEach(async () => {
  resetRecoveryLatchForTests();
  qwenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-recovery-'));
  store = new OmniObjectStore(qwenDir);
  await store.ensureLayout();
});

afterEach(async () => {
  vi.useRealTimers();
  resetRecoveryLatchForTests();
  await fs.rm(qwenDir, { recursive: true, force: true });
});

async function putObject(
  content: string,
  dir = qwenDir,
  s = store,
): Promise<{
  sha256: string;
  objectPath: string;
}> {
  const src = path.join(dir, `src-${content.length}.bin`);
  await fs.writeFile(src, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const { objectPath } = await s.putFile(src, sha256, '.mp4');
  return { sha256, objectPath };
}

describe('runStartupRecoveryOnce', () => {
  it('removes expired .part files, keeps recent ones', async () => {
    const downloads = path.join(store.getOmniRootDir(), 'downloads');
    await fs.mkdir(downloads, { recursive: true });
    const oldPart = path.join(downloads, 'old.part');
    const newPart = path.join(downloads, 'new.part');
    await fs.writeFile(oldPart, 'x');
    await fs.writeFile(newPart, 'y');
    const old = new Date(Date.now() - 72 * 3600_000);
    await fs.utimes(oldPart, old, old);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(oldPart)).rejects.toThrow();
    await expect(fs.access(newPart)).resolves.toBeUndefined();
  });

  it('.part cutoff boundary: just older than 48h removed, just younger kept', async () => {
    const downloads = path.join(store.getOmniRootDir(), 'downloads');
    await fs.mkdir(downloads, { recursive: true });
    const justOlder = path.join(downloads, 'just-older.part');
    const justYounger = path.join(downloads, 'just-younger.part');
    await fs.writeFile(justOlder, 'x');
    await fs.writeFile(justYounger, 'y');
    // Straddle the retention cutoff by a minute either side — pins the
    // comparison direction (mtime < cutoff → remove), not the exact value.
    const older = new Date(Date.now() - 48 * 3600_000 - 60_000);
    const younger = new Date(Date.now() - 48 * 3600_000 + 60_000);
    await fs.utimes(justOlder, older, older);
    await fs.utimes(justYounger, younger, younger);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(justOlder)).rejects.toThrow();
    await expect(fs.access(justYounger)).resolves.toBeUndefined();
  });

  it('keeps a DIRECTORY named like a .part (isFile guard)', async () => {
    const downloads = path.join(store.getOmniRootDir(), 'downloads');
    const dirPart = path.join(downloads, 'stale-dir.part');
    await fs.mkdir(dirPart, { recursive: true });
    const old = new Date(Date.now() - 72 * 3600_000);
    await fs.utimes(dirPart, old, old);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(dirPart)).resolves.toBeUndefined();
  });

  it('removes aged promotion .tmp orphans, keeps fresh ones (grace window)', async () => {
    const { objectPath } = await putObject('real-object');
    const shard = path.dirname(objectPath);
    const aged = path.join(shard, '.tmp-deadbeef');
    const fresh = path.join(shard, '.tmp-inflight');
    await fs.writeFile(aged, 'partial');
    await fs.writeFile(fresh, 'partial');
    const old = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(aged, old, old);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(aged)).rejects.toThrow();
    // A young .tmp may be another process's in-flight promotion.
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(objectPath)).resolves.toBeUndefined();
  });

  it('deletes corrupt objects and cascades their cache entries', async () => {
    const { sha256, objectPath } = await putObject('will-corrupt');
    await fs.writeFile(objectPath, 'tampered-bytes'); // break hash==name
    const cache = new OmniUploadCache(store.getOmniRootDir());
    await cache.put(sha256, 'm', 'oss://bucket/dead');

    await runStartupRecoveryOnce(store, cache);

    await expect(fs.access(objectPath)).rejects.toThrow();
    expect(await cache.get(sha256, 'm')).toBeNull();
  });

  it('keeps intact objects and runs only once per process', async () => {
    const { objectPath } = await putObject('intact');
    await runStartupRecoveryOnce(store);
    await expect(fs.access(objectPath)).resolves.toBeUndefined();

    // Second call must be the same latched promise (no re-scan): plant an
    // orphan after the first run — it must survive because the latch holds.
    const orphan = path.join(path.dirname(objectPath), '.tmp-late');
    await fs.writeFile(orphan, 'x');
    await runStartupRecoveryOnce(store);
    await expect(fs.access(orphan)).resolves.toBeUndefined();
  });

  it('latches per omni root: a second store with a different root still sweeps', async () => {
    // Sweep the first root…
    await runStartupRecoveryOnce(store);

    // …then a second store with its OWN root must get its own scan (a
    // process-global latch would silently skip it).
    const qwenDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-recov2-'));
    try {
      const store2 = new OmniObjectStore(qwenDir2);
      await store2.ensureLayout();
      const { objectPath } = await putObject('other-root', qwenDir2, store2);
      const orphan = path.join(path.dirname(objectPath), '.tmp-orphan2');
      await fs.writeFile(orphan, 'x');
      const old = new Date(Date.now() - 2 * 3600_000);
      await fs.utimes(orphan, old, old);

      await runStartupRecoveryOnce(store2);

      await expect(fs.access(orphan)).rejects.toThrow();
    } finally {
      await fs.rm(qwenDir2, { recursive: true, force: true });
    }
  });

  it('verifies exactly `limit` objects per run and rotates coverage across days', async () => {
    // 10 tiny objects, all corrupted: every verified object gets deleted,
    // so deletions == verifications.
    const objects: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { objectPath } = await putObject(`stride-object-${i}`);
      await fs.writeFile(objectPath, `tampered-${i}`);
      objects.push(objectPath);
    }
    const missing = async () => {
      const gone: string[] = [];
      for (const p of objects) {
        try {
          await fs.access(p);
        } catch {
          gone.push(p);
        }
      }
      return gone;
    };

    // Fake only Date: the verifier pipes streams, which need real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    await runStartupRecoveryOnce(store, undefined, { sampleVerifyLimit: 3 });
    const day1Deleted = await missing();
    expect(day1Deleted).toHaveLength(3);

    // Restore the deleted (still-corrupt) objects, advance one day, and
    // reset the latch: the day-seeded stride must pick DIFFERENT objects.
    for (const p of day1Deleted) await fs.writeFile(p, 'tampered-again');
    resetRecoveryLatchForTests();
    vi.setSystemTime(new Date('2025-06-02T12:00:00Z'));
    await runStartupRecoveryOnce(store, undefined, { sampleVerifyLimit: 3 });
    const day2Deleted = await missing();
    expect(day2Deleted).toHaveLength(3);
    for (const p of day2Deleted) {
      expect(day1Deleted).not.toContain(p);
    }
  });

  it('skips verification of objects above the size budget (object AND cache entry survive)', async () => {
    const content = 'corrupt-but-too-big-to-hash';
    const { sha256, objectPath } = await putObject(content);
    await fs.writeFile(objectPath, 'tampered-large-object-bytes');
    const cache = new OmniUploadCache(store.getOmniRootDir());
    await cache.put(sha256, 'm', 'oss://bucket/live');

    await runStartupRecoveryOnce(store, cache, {
      sampleVerifyLimit: 3,
      sampleVerifyMaxBytes: 4, // everything is "too big"
    });

    await expect(fs.access(objectPath)).resolves.toBeUndefined();
    expect(await cache.get(sha256, 'm')).toBe('oss://bucket/live');
  });

  it('never throws — even when getOmniRootDir() itself throws, and the latch is not poisoned', async () => {
    const throwingStore = {
      getOmniRootDir(): string {
        throw new Error('boom');
      },
      getObjectsDir(): string {
        throw new Error('boom');
      },
    } as unknown as OmniObjectStore;

    await expect(
      runStartupRecoveryOnce(throwingStore),
    ).resolves.toBeUndefined();
    // A second call must also resolve (no poisoned/cached rejection).
    await expect(
      runStartupRecoveryOnce(throwingStore),
    ).resolves.toBeUndefined();
    // And a healthy store afterwards still works.
    await expect(runStartupRecoveryOnce(store)).resolves.toBeUndefined();
  });
});
