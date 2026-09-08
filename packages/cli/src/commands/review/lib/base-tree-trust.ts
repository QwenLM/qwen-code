/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The base-tree reuse fence's trust artifacts, persisted OUTSIDE the sandbox's
// read-write mount — beside the worktree leases, the existing "nothing mounts
// it" precedent (`REVIEW_LEASE_DIR` in lib/paths.ts).
//
// Everything the fence used to key on lives inside `.qwen/tmp`, the one
// directory reviewed code can still write: the markers are files in the base
// tree, and the run epoch was the plan's mtime, which reviewed code can stat
// and write into a forged stamp — after which the pipeline certified an
// attacker-shaped tree as the A/B base. So the stamp's second line is now a
// random per-run secret that never enters the mount: the first host process
// of a run creates it (atomically, `flag: 'wx'`), its sibling shards adopt
// it, and a mount-local writer can neither read it to forge a stamp nor
// write it to refresh one. The file is keyed by the plan's path and an
// identity the mount cannot roll back (`runKeyMs` — `ctimeMs` cannot be
// set from userland, so a backdated mtime cannot re-key this run to an
// earlier run's file), so a re-captured plan — a new run — gets a new
// secret, and an earlier run's tree fails the fence exactly as a forged
// one does.
//
// The same file records, per built tree, the untracked path set the build
// legitimately left (`node_modules/`, `dist/`) — recorded host-side because
// the marker itself is attacker-writable and vouches for nothing on its own.
// At reuse, the tree's current untracked set must be a subset of the recorded
// one; anything more is a plant dropped while reviewed code held the mount,
// and the tree is rebuilt, sweeping it.

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { REVIEW_LEASE_DIR } from './paths.js';

/** What a successful build legitimately left behind, recorded host-side. */
export interface BuiltTreeRecord {
  baseSha: string;
  /** The tree's untracked AND ignored paths, as `git status` collapses them. */
  untracked: string[];
}

interface TrustFile {
  nonce: string;
  trees?: Record<string, BuiltTreeRecord>;
}

/**
 * The run identity the trust file is keyed by — NOT the plan's mtime alone.
 * The plan lives inside the directory the sandbox mounts read-write, and an
 * mtime is one `utimensat` call away from any value the reviewed code
 * chooses: backdated to an earlier run's exact nanosecond stamp, it would
 * re-key this run to that run's trust file, adopting its nonce and passing
 * its fence. `ctimeMs` cannot be set from userland — every touch, a
 * backdating `utimensat` included, sets it to now — and on Windows, where
 * `ctimeMs` is the creation time, a backdated mtime still sits at or below
 * it. The max of the two is the earliest time the file can claim.
 */
function runKeyMs(planPath: string): number {
  try {
    const stat = statSync(planPath);
    return Math.max(stat.mtimeMs, stat.ctimeMs);
  } catch {
    // No plan, no identity — and no trust file: the caller reports the
    // command unavailable rather than fencing on a shared key.
    return -Infinity;
  }
}

/**
 * The one file holding a run's base-tree trust state, named by a digest of
 * the plan's path and its tamper-resistant identity (see `runKeyMs`) — the
 * run identity the rest of the pipeline already keys on, so same-run shards
 * share the file and a re-captured plan starts a fresh one.
 */
export function baseTreeTrustPath(worktree: string, planPath: string): string {
  // The worktree is `<root>/.qwen/tmp/<name>` by construction (paths.ts's
  // `worktreePath`), so two directories up is `<root>/.qwen`. Derived
  // lexically, never through git: the worktree's own pointer lives inside
  // the mount, and asking git for the root would let a planted pointer
  // choose where the run's secret is written — and who can read it back.
  const qwenDir = dirname(dirname(resolve(worktree)));
  const key = createHash('sha256')
    .update(resolve(planPath))
    .update('\0')
    .update(String(runKeyMs(planPath)))
    .digest('hex')
    .slice(0, 16);
  return join(qwenDir, basename(REVIEW_LEASE_DIR), 'base-tree', `${key}.json`);
}

function readTrust(trustPath: string): TrustFile | null {
  try {
    const value = JSON.parse(readFileSync(trustPath, 'utf8')) as TrustFile;
    if (typeof value.nonce !== 'string' || value.nonce === '') return null;
    return value;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * This run's stamp secret: created on first ask, adopted on every later one,
 * so every shard of the run stamps — and accepts — the same nonce.
 */
export function runNonce(trustPath: string): string {
  mkdirSync(dirname(trustPath), { recursive: true });
  const fresh = randomBytes(16).toString('hex');
  try {
    // `flag: 'wx'`, the lease's atomic-create shape: two shards asking
    // together must not both "create" and then stamp different secrets.
    writeFileSync(trustPath, `${JSON.stringify({ nonce: fresh })}\n`, {
      flag: 'wx',
    });
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Lost the create race, or the file predates this process: adopt it. A
  // read can land between the winner's open and its write, so retry briefly
  // before calling the file torn.
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = readTrust(trustPath);
    if (existing) return existing.nonce;
    sleepSync(25);
  }
  // A crashed writer left a torn file. Healing it is what the lease's
  // same-session rewrite does, for the same reason: an unreadable file is
  // already read as no secret by every reader, and leaving it wedges the
  // run's shards on a nonce none of them can adopt.
  writeFileSync(trustPath, `${JSON.stringify({ nonce: fresh })}\n`);
  return fresh;
}

/**
 * Record, host-side, the untracked path set a successful build left — the
 * baseline the reuse fence's subset check compares against. Called with the
 * build lock held, so the read-modify-write cannot race a sibling builder;
 * the rename makes the update atomic against lock-free readers on the reuse
 * fast path.
 */
export function recordBuiltTree(
  trustPath: string,
  tree: string,
  baseSha: string,
  untracked: string[],
): void {
  const trust = readTrust(trustPath);
  // No readable file, no record: rewriting from scratch could clobber the
  // nonce a concurrent shard is stamping with. The reuse fence treats a
  // missing record as a fence failure and rebuilds, which re-records.
  if (!trust) return;
  const trees = { ...trust.trees, [tree]: { baseSha, untracked } };
  const tmp = `${trustPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...trust, trees })}\n`);
  renameSync(tmp, trustPath);
}

/** What {@link recordBuiltTree} stored for a tree, or null. */
export function builtTreeRecord(
  trustPath: string,
  tree: string,
): BuiltTreeRecord | null {
  return readTrust(trustPath)?.trees?.[tree] ?? null;
}
