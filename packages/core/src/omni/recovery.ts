/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { OmniObjectStore } from './storage.js';
import type { OmniUploadCache } from './upload-cache.js';

const debugLogger = createDebugLogger('omni:recovery');

/** Resume window for interrupted downloads (storage design §6.1). */
const PART_RETENTION_MS = 48 * 3600_000;
/** Sampled integrity verification budget per recovery run. */
const SAMPLE_VERIFY_LIMIT = 3;
/** Skip sampled verification for objects above this size — the scan runs
 * inline before the session's first delivery, and hashing multi-GiB
 * videos there would stall the user for the sake of hygiene. */
const SAMPLE_VERIFY_MAX_BYTES = 64 * 1024 * 1024;
/** Grace window for promotion temp files: a .tmp younger than this may
 * belong to a promotion in flight in ANOTHER process — deleting it would
 * fail that process's rename. Older survivors are crash leftovers. */
const TMP_GRACE_MS = 3600_000;

let recoveryOnce: Promise<void> | undefined;

/** Test-only: allow re-running recovery within one process. */
export function resetRecoveryLatchForTests(): void {
  recoveryOnce = undefined;
}

async function sweepDownloads(downloadsDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(downloadsDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - PART_RETENTION_MS;
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    const p = path.join(downloadsDir, name);
    try {
      const st = await fs.lstat(p);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        await fs.rm(p, { force: true });
        debugLogger.debug(`recovery: removed expired download ${name}`);
      }
    } catch {
      // Best-effort sweep.
    }
  }
}

async function sweepTmpFiles(objectsDir: string): Promise<void> {
  let shards: string[];
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return;
  }
  for (const shard of shards) {
    const shardDir = path.join(objectsDir, shard);
    let names: string[];
    try {
      names = await fs.readdir(shardDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('.tmp-')) continue;
      const p = path.join(shardDir, name);
      try {
        // Same-process writers clean up on every soft failure, so an old
        // survivor means a crash — but a YOUNG .tmp may be another
        // process's in-flight promotion; deleting it would fail that
        // rename. Grace window keeps the sweep multi-process safe.
        const st = await fs.lstat(p);
        if (Date.now() - st.mtimeMs < TMP_GRACE_MS) continue;
        await fs.rm(p, { force: true });
        debugLogger.debug(`recovery: removed orphan temp ${shard}/${name}`);
      } catch {
        // Best-effort sweep.
      }
    }
  }
}

async function sampleVerifyObjects(
  objectsDir: string,
  uploadCache: OmniUploadCache | undefined,
  limit: number,
): Promise<void> {
  const candidates: string[] = [];
  let shards: string[];
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return;
  }
  for (const shard of shards) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(objectsDir, shard));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('.')) candidates.push(path.join(shard, name));
    }
  }
  // Day-seeded stride sampling: coverage rotates across runs (a fixed
  // offset would verify the same objects forever). Cheap corruption
  // detection, not an audit.
  const stride = Math.max(1, Math.floor(candidates.length / limit));
  const seed = Math.floor(Date.now() / 86_400_000) % stride;
  const sample = candidates
    .filter((_, i) => i % stride === seed)
    .slice(0, limit);
  for (const rel of sample) {
    const full = path.join(objectsDir, rel);
    const expected = path.basename(rel).split('.')[0]!;
    try {
      const st = await fs.lstat(full);
      if (st.size > SAMPLE_VERIFY_MAX_BYTES) continue;
      const hash = createHash('sha256');
      await pipeline(createReadStream(full), hash);
      if (hash.digest('hex') !== expected) {
        await fs.rm(full, { force: true });
        await uploadCache?.removeBySha256(expected);
        debugLogger.debug(
          `recovery: removed corrupt object ${rel} (hash mismatch)`,
        );
      }
    } catch {
      // Unreadable object: leave it; the read path fails closed anyway.
    }
  }
}

/**
 * One-time-per-process recovery scan (storage design §6.1), run lazily the
 * first time the omni pipeline is touched — zero cost when omni is unused.
 *
 * 1. expired `downloads/*.part` (resume window 48h) are removed;
 * 2. `objects/…/.tmp-*` promotion orphans are removed (crash leftovers);
 * 3. a small sample of objects is hash-verified; corrupt objects are
 *    deleted with their upload-cache entries cascaded.
 *
 * Never throws: recovery is hygiene, not a gate.
 */
export function runStartupRecoveryOnce(
  store: OmniObjectStore,
  uploadCache?: OmniUploadCache,
): Promise<void> {
  recoveryOnce ??= (async () => {
    const root = store.getOmniRootDir();
    await sweepDownloads(path.join(root, 'downloads'));
    await sweepTmpFiles(store.getObjectsDir());
    await sampleVerifyObjects(
      store.getObjectsDir(),
      uploadCache,
      SAMPLE_VERIFY_LIMIT,
    );
  })().catch((err) => {
    debugLogger.debug(
      `recovery scan failed (ignored): ${err instanceof Error ? err.message : err}`,
    );
  });
  return recoveryOnce;
}
