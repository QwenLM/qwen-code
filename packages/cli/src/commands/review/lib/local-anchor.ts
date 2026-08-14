/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The local review-fix loop's anchor: content-addressed per-file state.
//
// A PR round anchors on a commit sha. A local round has none — the reviewed
// state is a dirty working tree, and the local capture path is FORBIDDEN from
// writing to the index, the worktree, or any ref (`local-diff.ts` spells out
// why). So the anchor is content: `git hash-object` — no `-w`, computes and
// writes nothing — over every file the plan covered, plus the HEAD the diff
// was based against. The next round re-hashes the same paths and compares:
// under the same HEAD and the same model, a file whose bytes are identical to
// what the previous clean round reviewed is skipped, one import hop of
// dependents re-enters (same widening, same reasons as `rescope`), and the
// rest is the delta.
//
// HEAD equality is a hard gate, not a convenience. The captured diff is
// HEAD-vs-worktree: if HEAD moved between rounds, the same worktree bytes
// describe a DIFFERENT change under review (a reset exposes commits the last
// round never saw), so content equality alone certifies nothing. A moved HEAD
// degrades to the full capture, with the reason said out loud.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gitOpt } from './git.js';

/** Per-file content ids. `absent` marks a deletion the diff still shows. */
export const ABSENT = 'absent';

export interface LocalCacheCandidate {
  v: 1;
  target: string;
  /** null on an unborn HEAD (repo with no commits). */
  headSha: string | null;
  /** path → blob id (or `absent`), for every file the plan covered. */
  files: Record<string, string>;
  /** Content-addressed id of the whole reviewed state, for display and logs. */
  stateId: string;
}

/**
 * The cache Step 8 writes from a candidate — the candidate's fields plus the
 * model-written ledger (`lastModelId`, `round`, `findings`, …). Only the
 * fields the scoping decision reads are typed; the rest ride as data.
 */
export interface LocalReviewCache extends LocalCacheCandidate {
  lastModelId?: string;
}

/**
 * Hash the current worktree content of `paths`, batched.
 *
 * `git hash-object` computes the blob id git WOULD store — content-addressed,
 * indifferent to mtime, mode bits and the index, which is exactly the identity
 * "the bytes the previous round reviewed" needs. Non-files (deleted, a
 * directory, a dangling symlink) map to `absent`; a file git refuses to hash
 * maps to `absent` too, which reads as "changed" downstream — the direction
 * that reviews rather than skips.
 */
export function hashWorktreeFiles(
  repoRoot: string,
  paths: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const hashable: string[] = [];
  for (const p of paths) {
    try {
      if (statSync(join(repoRoot, p)).isFile()) hashable.push(p);
      else out[p] = ABSENT;
    } catch {
      out[p] = ABSENT;
    }
  }
  const BATCH = 200;
  for (let i = 0; i < hashable.length; i += BATCH) {
    const batch = hashable.slice(i, i + BATCH);
    const res = gitOpt('-C', repoRoot, 'hash-object', '--', ...batch);
    const lines = res === null ? null : res.split('\n');
    if (lines !== null && lines.length === batch.length) {
      batch.forEach((p, j) => (out[p] = lines[j]));
      continue;
    }
    // The batch failed as a unit (one unreadable file fails them all) —
    // re-try one by one so a single pathological file costs itself, not
    // its 199 neighbours.
    for (const p of batch) {
      out[p] = gitOpt('-C', repoRoot, 'hash-object', '--', p) ?? ABSENT;
    }
  }
  return out;
}

/** One id for the whole state: order-independent, HEAD included. */
export function stateIdOf(
  headSha: string | null,
  files: Record<string, string>,
): string {
  const h = createHash('sha256');
  h.update(headSha ?? 'unborn');
  for (const path of Object.keys(files).sort()) {
    // NUL-separated fields: no path or blob id contains one, so adjacent
    // entries cannot collide by concatenation.
    h.update(`\0${path}\0${files[path]}`);
  }
  return h.digest('hex');
}

/**
 * Parse a local review cache, fail-quiet. The file is model-written under
 * Step 8's prose rules, so every field is re-validated: a malformed cache
 * degrades to "no anchor" — a full capture — never to a throw and never to a
 * skip.
 */
export function readLocalCache(path: string): LocalReviewCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const c = raw as {
    v?: unknown;
    target?: unknown;
    headSha?: unknown;
    files?: unknown;
    stateId?: unknown;
    lastModelId?: unknown;
  };
  if (
    !c ||
    c.v !== 1 ||
    typeof c.target !== 'string' ||
    (c.headSha !== null && typeof c.headSha !== 'string') ||
    typeof c.stateId !== 'string' ||
    typeof c.files !== 'object' ||
    c.files === null
  ) {
    return null;
  }
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.files as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    files[k] = v;
  }
  return {
    v: 1,
    target: c.target,
    headSha: c.headSha as string | null,
    files,
    stateId: c.stateId,
    ...(typeof c.lastModelId === 'string'
      ? { lastModelId: c.lastModelId }
      : {}),
  };
}

/**
 * The paths whose content differs between the cached state and now — added,
 * removed, and modified alike. Symmetric difference over the two key sets
 * with value comparison on the intersection.
 */
export function changedSince(
  cached: Record<string, string>,
  current: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [path, hash] of Object.entries(current)) {
    if (cached[path] !== hash) out.push(path);
  }
  for (const path of Object.keys(cached)) {
    if (!(path in current)) out.push(path);
  }
  return out;
}

/**
 * Cut a captured diff down to the file sections named in `keep`, by BYTES.
 *
 * The capture path's contract is bytes end to end: a decode/re-encode rewrites
 * the content of every hunk touching a file git handed over in a non-UTF-8
 * encoding (the header of `capture-local` says so where it writes the file).
 * So the filter works on the buffer: the caller passes the 1-based inclusive
 * LINE ranges `parseDiff` reported per file, and this maps them to byte
 * ranges over the same newline structure `parseDiff` walked.
 */
export function sliceDiffByLines(
  diff: Buffer,
  keep: ReadonlyArray<{ startLine: number; endLine: number }>,
): Buffer {
  // Byte offset of the start of each 1-based line; sentinel = buffer length.
  const starts: number[] = [0];
  for (let i = 0; i < diff.length; i++) {
    if (diff[i] === 0x0a) starts.push(i + 1);
  }
  const offsetOf = (line1: number): number =>
    line1 - 1 < starts.length ? starts[line1 - 1] : diff.length;
  const parts = [...keep]
    .sort((a, b) => a.startLine - b.startLine)
    .map((r) => diff.subarray(offsetOf(r.startLine), offsetOf(r.endLine + 1)));
  return Buffer.concat(parts);
}
