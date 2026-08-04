/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  resetRecoveryLatchForTests();
  await fs.rm(qwenDir, { recursive: true, force: true });
});

async function putObject(content: string): Promise<{
  sha256: string;
  objectPath: string;
}> {
  const src = path.join(qwenDir, `src-${content.length}.bin`);
  await fs.writeFile(src, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const { objectPath } = await store.putFile(src, sha256, '.mp4');
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
});
