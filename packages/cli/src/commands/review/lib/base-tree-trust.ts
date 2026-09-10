/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The base-tree reuse fence's trust state, persisted OUTSIDE the sandbox's
// read-write mount — beside the worktree leases, the existing "nothing mounts
// it" precedent (`REVIEW_LEASE_DIR` in lib/paths.ts).
//
// Every fence decision comes from this file ALONE. The markers inside the
// base tree (`.qwen-review-base-ok`, `.qwen-review-base-failed`) are notes for
// a human looking at the tree, never evidence: the tree is a child of the
// directory the sandbox mounts read-write, so anything stored in it is the
// reviewed code's to forge — a certifying marker can be stamped, and a
// settling one planted to suppress the A/B lane for the whole round while the
// report reads as infrastructure. (That was the nonce-in-marker design's
// hole: the nonce sat in cleartext on line 2, readable from the mount it was
// meant to authenticate against.) What this file records per tree is what a
// mount cannot supply: the base commit the run pinned, whether the build
// succeeded or failed, and the untracked inventory the build legitimately
// left — path, size and ctime per file, so an in-place rewrite of a recorded
// file (`dist/cli.js` is exactly what a host-side A/B executes) is as visible
// as an added one.
//
// One file per plan path, ROTATED IN PLACE on a new run's first ask: the run
// identity lives INSIDE the file, and a caller whose identity disagrees
// replaces the whole file — fresh nonce, records dropped — instead of landing
// on a sibling file keyed to an earlier run's timestamps. With one file there
// is no earlier generation left to adopt, so pinning the plan's timestamps
// (forward or back) cannot hand a later run a state file shaped while the
// reviewed code held the mount; the pin only rotates, and rotation certifies
// nothing.

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { LEASE_PREFIX, REVIEW_LEASE_DIR, REVIEW_TMP_DIR } from './paths.js';

/** What one legitimately-left file looked like at record time. */
export interface BuiltTreeStat {
  size: number;
  /**
   * The tamper signal: `ctimeMs` cannot be set from userland — every write,
   * chmod and rename sets it to now, `utimensat` included — so an in-place
   * rewrite of a recorded path shows here even at the same size (which is
   * all mtime would catch: a forged mtime is one syscall). On Windows ctime
   * is the creation time and an in-place rewrite keeps it — the lane where
   * containment cannot exist, where this fence is silent by design anyway.
   */
  ctimeMs: number;
}

/** What a build of one tree left behind, recorded host-side. */
export interface BuiltTreeRecord {
  baseSha: string;
  /**
   * 'failed' is a settled answer: the fence re-serves it without re-paying
   * the build. Recorded host-side because the in-tree failed marker is one
   * planted line away from suppressing the A/B lane for the whole round.
   */
  state: 'ok' | 'failed';
  /**
   * The tree's untracked AND ignored files at record time, listed
   * individually (never collapsed to a directory) and EXCLUDING the two
   * marker files — the markers are informational notes anyone may hold a
   * copy of, so their presence or content must move no fence decision.
   */
  untracked: Record<string, BuiltTreeStat>;
}

interface TrustFile {
  /** The run identity this file was minted for — see `runIdentityMs`. */
  identity: number;
  /**
   * The merge base this run builds and certifies, pinned at establishment.
   * The plan lives inside the mount, so a mid-run rewrite of its
   * `mergeBaseSha` is how reviewed code would choose the base the A/B
   * measures against; the pin makes the FIRST-read sha the only one this
   * run acts on, and a later disagreement a decline rather than a rebuild
   * at the new value.
   */
  baseSha: string;
  /** Per-generation marker, for debugging; certifies nothing on its own. */
  nonce: string;
  trees?: Record<string, BuiltTreeRecord>;
}

/**
 * How far the stored identity may sit from the current one and still count
 * as the same run — representation noise only, the same tolerance the run
 * ledger gives the plan mtime (`PLAN_MTIME_TOLERANCE_MS` in run-ledger.ts):
 * an epoch-preserving enrichment restores the mtime through `utimesSync`,
 * which costs a unit in the last place on some filesystems, and an exact
 * compare would rotate on the pipeline's own write.
 */
const IDENTITY_TOLERANCE_MS = 1;

function sameIdentity(a: number, b: number): boolean {
  // The exact-equality arm covers the non-finite "no identity" value, whose
  // difference from itself is NaN.
  return a === b || Math.abs(a - b) <= IDENTITY_TOLERANCE_MS;
}

/**
 * The host-side directory the trust file keys under, derived LEXICALLY from
 * the worktree — never through git, because the worktree's own pointer lives
 * inside the mount and asking git for the root would let a planted pointer
 * choose where the run's state is written. Validated, not just derived: the
 * walk assumes the pipeline's `<root>/.qwen/tmp/<name>` geometry, and a
 * worktree outside that shape (a hand-passed `--worktree /tmp/wt`) must be
 * refused here, before anything creates directories two levels up from it.
 */
function trustRootFor(worktree: string): string {
  // Nested geometry (a review launched from inside another review's
  // worktree): the inner review's own `.qwen` sits inside the OUTER
  // review's read-write mount, and a trust file written there is readable
  // AND writable by the outer reviewed code — the record the fence reads
  // must sit outside every layer, beside the outermost enclosing
  // repository's lease directory, exactly where `leaseDirectory` puts it.
  // Lexical, never through git, and never resolved through the filesystem:
  // a planted pointer or link would choose where the run's state is
  // written.
  const resolved = resolve(worktree);
  const marker = `${sep}${REVIEW_TMP_DIR}${sep}`;
  const at = resolved.indexOf(marker);
  if (at >= 0) {
    // The FIRST occurrence is the outermost layer; two levels up from it is
    // the outermost repository root, and its `.qwen` is the answer — the
    // same path `leaseDirectory` computes for this geometry.
    const outermostTmp = resolved.slice(0, at + marker.length - 1);
    return resolve(outermostTmp, '..', '..', '.qwen');
  }
  const tmpDir = dirname(resolved);
  const qwenDir = dirname(tmpDir);
  if (
    basename(tmpDir) !== 'tmp' ||
    basename(qwenDir) !== '.qwen' ||
    dirname(qwenDir) === qwenDir
  ) {
    throw new Error(
      `cannot place the base-tree trust artifact for ${worktree}: the ` +
        'worktree is not shaped like <root>/.qwen/tmp/<name>, so there is ' +
        'no host-side review directory to key it under',
    );
  }
  return qwenDir;
}

/**
 * The one file holding a run's base-tree trust state, named by a digest of
 * the plan's path alone — the run identity is INSIDE the file (see the
 * module doc), so a re-captured plan rotates the content, not the name, and
 * there is never an earlier run's sibling file left to adopt.
 */
export function baseTreeTrustPath(worktree: string, planPath: string): string {
  const key = createHash('sha256')
    .update(resolve(planPath))
    .digest('hex')
    .slice(0, 16);
  return join(
    trustRootFor(worktree),
    basename(REVIEW_LEASE_DIR),
    'base-tree',
    `${key}.json`,
  );
}

/**
 * The run identity the trust file rotates on.
 *
 * The worktree lease's mtime when this run holds one: `fetch-pr` acquires
 * the lease on every capture (a same-session re-fetch rewrites it), and the
 * lease lives beside the trust root — outside the mount, where reviewed code
 * cannot touch it — so a mid-run `utimes` or `chmod` of the plan rotates
 * nothing, and a plan timestamp pinned forward pins nothing either. The
 * lease is matched on its recorded worktree so a stale lease for a
 * different tree never keys this run.
 *
 * Without a lease — a hand-driven `base-tree` call, outside the pipeline's
 * geometry — the plan's own mtime is the identity, the same signal the run
 * ledger keys on: a re-capture moves it (new run), an epoch-preserving
 * enrichment restores it within tolerance (same run), a backdate rotates
 * (destroy, never adopt). What the fallback cannot tell apart is a mid-run
 * `utimes` from a re-capture; base-tree.ts's decline arms are what keep that
 * rotation from destroying a live tree. Its residual: a forward pin applied
 * before the run's first ask and re-applied after a re-capture holds the
 * identity fixed across the two runs — the adoption that lands is then gated
 * by the per-file size+ctime inventory check on every reuse, the arm the pin
 * cannot reach.
 */
export function runIdentityMs(worktree: string, planPath: string): number {
  try {
    const target = /^review-(pr-\d+)$/.exec(basename(resolve(worktree)))?.[1];
    if (target) {
      const leaseFile = join(
        trustRootFor(worktree),
        basename(REVIEW_LEASE_DIR),
        `${LEASE_PREFIX}${target}.json`,
      );
      const lease = JSON.parse(readFileSync(leaseFile, 'utf8')) as {
        sessionId?: unknown;
        promptId?: unknown;
        worktreePath?: unknown;
      };
      if (
        typeof lease.sessionId === 'string' &&
        typeof lease.promptId === 'string' &&
        lease.worktreePath === resolve(worktree)
      ) {
        return statSync(leaseFile).mtimeMs;
      }
    }
  } catch {
    // No lease, an unreadable one, or one not for this tree: the plan's own
    // mtime is the fallback identity.
  }
  try {
    return statSync(planPath).mtimeMs;
  } catch {
    // No plan, no identity — and no trust state: the caller reports the
    // command unavailable rather than fencing on a shared key.
    return -Infinity;
  }
}

function readTrust(trustPath: string): TrustFile | null {
  try {
    const value = JSON.parse(readFileSync(trustPath, 'utf8')) as TrustFile;
    if (
      typeof value.nonce !== 'string' ||
      value.nonce === '' ||
      typeof value.identity !== 'number' ||
      typeof value.baseSha !== 'string'
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** tmp-then-rename, so lock-free readers on the reuse path never see a half file. */
function atomicWrite(trustPath: string, value: TrustFile): void {
  const tmp = `${trustPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    renameSync(tmp, trustPath);
  } catch (err) {
    // The tmp file matches no sweep's glob: take it with us — and the
    // removal must not mask the original failure.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Litter, not a verdict.
    }
    throw err;
  }
}

/** How this call found the trust file — the fence's same-run evidence. */
export type TrustEstablishment =
  /** No file was there: this ask minted it, so this run has no history. */
  | 'created'
  /** Another identity's file was there and was replaced: this run has no history. */
  | 'rotated'
  /** An unreadable file was there and was replaced: history may have been lost. */
  | 'healed'
  /** A file minted for THIS identity was there: earlier shards of this run wrote it. */
  | 'adopted';

export interface TrustState {
  nonce: string;
  established: TrustEstablishment;
  /**
   * The pinned base disagrees with the plan the caller just read — the
   * mid-run-rewrite shape the pin exists to refuse. The caller declines;
   * re-pinning would certify whatever sha the mount named after the fact.
   */
  conflict: boolean;
}

/**
 * Establish this run's trust state: created on first ask, adopted on every
 * same-run later one, rotated in place when the identity moved on. The
 * `wx`-then-adopt shape is what lets two shards asking together agree on one
 * file; rotation DROPS the records, because they certify nothing past the
 * run that wrote them.
 */
export function establishTrust(
  trustPath: string,
  identityMs: number,
  baseSha: string,
): TrustState {
  mkdirSync(dirname(trustPath), { recursive: true });
  const mint = (): TrustFile => ({
    identity: identityMs,
    baseSha,
    nonce: randomBytes(16).toString('hex'),
  });
  const minted = mint();
  try {
    writeFileSync(trustPath, `${JSON.stringify(minted)}\n`, { flag: 'wx' });
    return { nonce: minted.nonce, established: 'created', conflict: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Lost the create race, or the file predates this process: read it. A read
  // can land between the winner's open and its write, so retry briefly
  // before calling the file torn.
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = readTrust(trustPath);
    if (existing) {
      if (sameIdentity(existing.identity, identityMs)) {
        return {
          nonce: existing.nonce,
          established: 'adopted',
          conflict: existing.baseSha !== baseSha,
        };
      }
      const rotated = mint();
      atomicWrite(trustPath, rotated);
      return { nonce: rotated.nonce, established: 'rotated', conflict: false };
    }
    sleepSync(25);
  }
  // A crashed writer left a torn file. Healing it is what the lease's
  // same-session rewrite does, for the same reason: an unreadable file is
  // already read as no state by every reader, and leaving it wedges the
  // run's shards on a file none of them can adopt. The 'healed' marker lets
  // the fence tell "this run's bookkeeping tore" from "this run never ran".
  const healed = mint();
  atomicWrite(trustPath, healed);
  return { nonce: healed.nonce, established: 'healed', conflict: false };
}

/**
 * Record, host-side, what a finished build left — the baseline the reuse
 * fence compares against. Called with the build lock held, so the
 * read-modify-write cannot race a sibling builder; the rename keeps the
 * update atomic against lock-free readers on the reuse fast path.
 */
export function recordBuiltTree(
  trustPath: string,
  identityMs: number,
  tree: string,
  record: BuiltTreeRecord,
): void {
  const trust = readTrust(trustPath);
  // No readable file, no record: rewriting from scratch could clobber state
  // a concurrent shard just established. And no record under an identity or
  // base this process did not establish with: the build took minutes, and a
  // rotation or re-pin in that window means the file now belongs to a
  // generation this build is not part of. The reuse fence treats a missing
  // record as a decline, never as a certification.
  if (
    !trust ||
    !sameIdentity(trust.identity, identityMs) ||
    trust.baseSha !== record.baseSha
  ) {
    return;
  }
  atomicWrite(trustPath, {
    ...trust,
    trees: { ...trust.trees, [tree]: record },
  });
}

/** What {@link recordBuiltTree} stored for a tree, or null. */
export function builtTreeRecord(
  trustPath: string,
  tree: string,
): BuiltTreeRecord | null {
  return readTrust(trustPath)?.trees?.[tree] ?? null;
}
