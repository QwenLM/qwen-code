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
import type { OmniDegradationCache } from './policy/degradation-cache.js';

const debugLogger = createDebugLogger('omni:recovery');

/** How long crash-orphaned `downloads/*.part` files are retained before
 * the sweep removes them. Nothing ever resumes a .part — staging names
 * are random per attempt and there is no Range/resume logic — so this is
 * purely a debugging window for inspecting what an interrupted download
 * left behind (storage design §6.1). */
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
/** Grace window for staging entries, for the same multi-process reason:
 * a second CLI process starting while another is mid-transcode must not
 * delete the live invocation's work directory out from under its tool.
 * One hour comfortably exceeds the 10-minute default policy-tool timeout
 * (a directory's mtime is set at creation), so anything older is a crash
 * leftover, not an in-flight run. Exported so config validation can cap
 * `policyTools.<tool>.runtime.timeoutMs` below it — a timeout the sweep
 * could outrun would let a live invocation's staging be deleted. */
export const STAGING_GRACE_MS = 3600_000;
/** Default retention for quarantined invocations (storage design §7). */
const QUARANTINE_RETENTION_DAYS = 7;
/** Default size budget for the quarantine area (storage design §7). */
const QUARANTINE_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** Tunables for {@link runStartupRecoveryOnce}; production callers use
 * the defaults, tests inject small values. */
export interface StartupRecoveryOptions {
  sampleVerifyLimit?: number;
  sampleVerifyMaxBytes?: number;
  /** Quarantined invocations older than this are removed. */
  quarantineRetentionDays?: number;
  /** Above this total size, quarantined invocations are removed
   * oldest-first until the area fits. */
  quarantineMaxBytes?: number;
  /** When set, corrupt-object deletion also cascades into the
   * degradation cache (both as source and as derivative), keeping
   * `policy-cache.json` free of entries that can never be served
   * again. */
  degradationCache?: OmniDegradationCache;
}

/** One latch per omni root: distinct stores in one process (multi-project
 * setups, tests) each get their own scan instead of the first root's scan
 * suppressing all others. */
const recoveryOnce = new Map<string, Promise<void>>();

/** Test-only: allow re-running recovery within one process. */
export function resetRecoveryLatchForTests(): void {
  recoveryOnce.clear();
}

/**
 * True only for a REAL directory (lstat, so a symlink to a directory is
 * rejected). Recovery deletes files under the paths it traverses, so every
 * directory it descends into — downloads/, the objects root, and each
 * shard — must be a genuine directory inside the omni root: a symlinked
 * intermediate directory would redirect readdir+rm at arbitrary paths
 * outside `.qwen/omni`. The store's own symlink guard (putFile) runs later
 * and does not protect this pre-delivery scan.
 */
async function isRealDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function sweepDownloads(downloadsDir: string): Promise<void> {
  if (!(await isRealDirectory(downloadsDir))) return;
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

/**
 * Delete crash-orphaned entries under `staging/`. Staging entries belong
 * to policy invocations that never committed (a successful commit deletes
 * its own staging directory first), so anything past the grace window is
 * garbage (storage design §6.1). Entries YOUNGER than the grace window
 * are kept: they may be a concurrent process's live invocation, and its
 * own commit/quarantine path cleans them up. The staging root itself must
 * be a real directory — a symlinked root would redirect the recursive
 * deletes outside the omni root.
 */
async function sweepStaging(stagingDir: string): Promise<void> {
  if (!(await isRealDirectory(stagingDir))) return;
  let names: string[];
  try {
    names = await fs.readdir(stagingDir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(stagingDir, name);
    try {
      const st = await fs.lstat(p);
      // A young REAL entry may belong to an in-flight invocation in
      // another process; symlinks are never live invocations (staging
      // dirs are created with mkdir) and are removed regardless of age
      // (rm on a symlink removes the link itself without following it,
      // so no containment check is needed per entry).
      if (!st.isSymbolicLink() && Date.now() - st.mtimeMs < STAGING_GRACE_MS) {
        continue;
      }
      await fs.rm(p, { recursive: true, force: true });
      debugLogger.debug(`recovery: removed uncommitted staging ${name}`);
    } catch {
      // Best-effort sweep.
    }
  }
}

/** Recursively sum the sizes of regular files under a REAL directory,
 * never following symlinks (neither directory nor file entries). */
async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return total;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fs.lstat(p);
      if (st.isFile()) {
        total += st.size;
      } else if (st.isDirectory()) {
        total += await directorySizeBytes(p);
      }
    } catch {
      // Unreadable entry contributes nothing.
    }
  }
  return total;
}

/**
 * Enforce the quarantine retention window and size budget (storage design
 * §4.4/§6.1): entries older than `retentionMs` are removed; if the
 * remainder still exceeds `maxBytes`, the oldest entries are removed
 * first until the area fits. Only REAL directories are treated as
 * quarantine entries — symlinks are never traversed, sized, or deleted.
 */
async function sweepQuarantine(
  quarantineDir: string,
  retentionMs: number,
  maxBytes: number,
): Promise<void> {
  if (!(await isRealDirectory(quarantineDir))) return;
  let names: string[];
  try {
    names = await fs.readdir(quarantineDir);
  } catch {
    return;
  }
  const entries: Array<{ name: string; mtimeMs: number; sizeBytes: number }> =
    [];
  const cutoff = Date.now() - retentionMs;
  for (const name of names) {
    const p = path.join(quarantineDir, name);
    if (!(await isRealDirectory(p))) continue;
    try {
      const st = await fs.lstat(p);
      if (st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true });
        debugLogger.debug(`recovery: removed expired quarantine ${name}`);
        continue;
      }
      entries.push({
        name,
        mtimeMs: st.mtimeMs,
        sizeBytes: await directorySizeBytes(p),
      });
    } catch {
      // Best-effort sweep.
    }
  }
  let total = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  if (total <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    try {
      await fs.rm(path.join(quarantineDir, entry.name), {
        recursive: true,
        force: true,
      });
      total -= entry.sizeBytes;
      debugLogger.debug(
        `recovery: removed quarantine ${entry.name} (over size budget)`,
      );
    } catch {
      // Best-effort sweep.
    }
  }
}

async function sweepTmpFiles(objectsDir: string): Promise<void> {
  if (!(await isRealDirectory(objectsDir))) return;
  let shards: string[];
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return;
  }
  for (const shard of shards) {
    const shardDir = path.join(objectsDir, shard);
    if (!(await isRealDirectory(shardDir))) continue;
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
  degradationCache: OmniDegradationCache | undefined,
  limit: number,
  maxBytes: number,
): Promise<void> {
  const candidates: string[] = [];
  if (!(await isRealDirectory(objectsDir))) return;
  let shards: string[];
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return;
  }
  for (const shard of shards) {
    // Symlinked shard = redirection outside the store; skip it entirely so
    // its "candidates" (external files!) never enter the sample pool.
    if (!(await isRealDirectory(path.join(objectsDir, shard)))) continue;
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
  if (candidates.length === 0 || limit <= 0) return;
  // Day-seeded stride sampling over a SORTED candidate list (readdir order
  // is filesystem-dependent): pick (seed + k*stride) % N so coverage
  // rotates across days and wraps — a filter+slice would leave a
  // permanent blind spot at the tail. Cheap corruption detection, not an
  // audit.
  candidates.sort();
  const n = candidates.length;
  const stride = Math.max(1, Math.floor(n / limit));
  const seed = Math.floor(Date.now() / 86_400_000) % n;
  const picked = new Set<number>();
  for (let k = 0; k < limit && picked.size < n; k++) {
    picked.add((seed + k * stride) % n);
  }
  for (const i of picked) {
    const rel = candidates[i]!;
    const full = path.join(objectsDir, rel);
    const expected = path.basename(rel).split('.')[0]!;
    try {
      const st = await fs.lstat(full);
      // Only regular files are store objects: a symlinked candidate would
      // make the hash read — and the mismatch-delete below act on — a file
      // outside the omni root. (rm on the symlink itself would only unlink
      // the link, but the hash must not read external content either.)
      if (!st.isFile()) continue;
      if (st.size > maxBytes) continue;
      const hash = createHash('sha256');
      await pipeline(createReadStream(full), hash);
      if (hash.digest('hex') !== expected) {
        await fs.rm(full, { force: true });
        await uploadCache?.removeBySha256(expected);
        // The corrupt object may have been a policy SOURCE (its cached
        // derivatives can never be re-verified against it) or a policy
        // DERIVATIVE (entries pointing at it can never be served) —
        // cascade both directions so policy-cache.json does not
        // accumulate orphans.
        await degradationCache?.removeByOriginalSha256(expected);
        await degradationCache?.removeByDegradedSha256(expected);
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
 * One-time-per-process-per-root recovery scan (storage design §6.1), run
 * lazily the first time the omni pipeline is touched — zero cost when
 * omni is unused.
 *
 * 1. staging entries older than the multi-process grace window are
 *    deleted — they belong to policy invocations that never committed;
 *    younger entries may be another process's live run (storage design
 *    §6.1);
 * 2. crash-orphaned `downloads/*.part` older than the 48h debugging
 *    retention window are removed;
 * 3. `quarantine/` is trimmed to its retention window and size budget
 *    (oldest-first once over budget);
 * 4. `objects/…/.tmp-*` promotion orphans are removed (crash leftovers);
 * 5. a small sample of objects is hash-verified; corrupt objects are
 *    deleted with their upload-cache and degradation-cache entries
 *    cascaded.
 *
 * Never throws: recovery is hygiene, not a gate. That covers the latch
 * key lookup too — a store whose getOmniRootDir() throws yields a
 * resolved promise and does not poison the latch for later calls.
 */
export function runStartupRecoveryOnce(
  store: OmniObjectStore,
  uploadCache?: OmniUploadCache,
  options?: StartupRecoveryOptions,
): Promise<void> {
  let root: string;
  try {
    root = store.getOmniRootDir();
  } catch (err) {
    debugLogger.debug(
      `recovery scan failed (ignored): ${err instanceof Error ? err.message : err}`,
    );
    return Promise.resolve();
  }
  let scan = recoveryOnce.get(root);
  if (!scan) {
    scan = (async () => {
      // The per-directory guards below lstat only the FINAL path component
      // of each directory they enter — every intermediate component is
      // still followed. Verify the shared prefix chain up front: a symlink
      // planted at the omni root itself, or at the `objects/` level above
      // `objects/sha256`, would otherwise redirect every sweep outside the
      // managed tree. (An absent directory fails the check too, which is
      // fine — there is nothing to sweep beneath it.)
      if (!(await isRealDirectory(root))) return;
      await sweepStaging(path.join(root, 'staging'));
      await sweepDownloads(path.join(root, 'downloads'));
      await sweepQuarantine(
        path.join(root, 'quarantine'),
        (options?.quarantineRetentionDays ?? QUARANTINE_RETENTION_DAYS) *
          86_400_000,
        options?.quarantineMaxBytes ?? QUARANTINE_MAX_BYTES,
      );
      if (!(await isRealDirectory(path.join(root, 'objects')))) return;
      await sweepTmpFiles(store.getObjectsDir());
      await sampleVerifyObjects(
        store.getObjectsDir(),
        uploadCache,
        options?.degradationCache,
        options?.sampleVerifyLimit ?? SAMPLE_VERIFY_LIMIT,
        options?.sampleVerifyMaxBytes ?? SAMPLE_VERIFY_MAX_BYTES,
      );
    })().catch((err) => {
      debugLogger.debug(
        `recovery scan failed (ignored): ${err instanceof Error ? err.message : err}`,
      );
    });
    recoveryOnce.set(root, scan);
  }
  return scan;
}
