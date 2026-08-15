/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Content-addressed per-file verdicts: the PR flow's rebase survival.
//
// The commit anchor dies with its history: one rebase, and `rescope` refuses
// the sha (correctly — the range would review the wrong code) and the whole
// incremental saving degrades to a full review. But "what the previous round
// reviewed" was never really a commit; it was, per file, a PAIR of tree
// entries — the base side and the head side, whose difference is exactly the
// diff the round read. Tree entries are content-addressed and indifferent to
// history: after a rebase that changed nothing about a file's diff, its
// `(base, head)` pair is byte-for-byte the pair the clean round certified,
// and the verdict transfers. A file whose pair moved — its own change
// amended, or the merge-base slid under it — re-enters the scope in full.
//
// The identity is `<mode> <oid>`, not the oid alone: an exec-bit flip or a
// file↔symlink typechange is its own lines in `git diff`, so identical
// content under a different mode is NOT an identical change.
//
// The pairs are recorded at capture time by `fetch-pr` (they describe what
// this round is about to review) and promoted into the review cache only by
// Step 8's clean-high-effort gate, exactly like the local flow's content
// candidate. They deliberately do NOT ride the posted-review marker: a
// hundred-file map does not fit a footnote (`LEDGER_MAX_BYTES`), so a fresh
// environment keeps the commit anchor and only the machine that reviewed
// keeps rebase survival — the same graceful degradation the cache has always
// had.

import { gitRaw } from './git.js';
import { LITERAL_PATHSPECS } from './diff-flags.js';

/** A file absent on one side: created by the PR, or deleted by it. */
export const NO_BLOB = 'absent';

export interface BlobPair {
  base: string;
  head: string;
}

export type FileVerdicts = Record<string, BlobPair>;

/** A verdicts map that keys arbitrary file paths safely — `__proto__`
 *  included: on a plain object that assignment is a silent no-op. */
function nullProtoMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Tree-entry identities (`<mode> <oid>`) of `paths` at `ref`, batched — one
 * `ls-tree` per 200 paths. Paths absent at the ref map to `NO_BLOB`.
 *
 * `repoRoot` pins the git cwd: pathspecs resolve against it, and from a
 * subdirectory an unmatched pathspec exits 0 with EMPTY output — every path
 * would read `NO_BLOB` at every ref, pairs would compare stable, and the
 * fallback would silently convert into a skip.
 *
 * The listing is read as BYTES (`gitRaw`), not through the CRLF-normalising
 * text helpers: `-z` exists precisely to keep paths byte-faithful. (Even a
 * mangled lookup would only ever fail SAFE now — an unmatched path stays
 * `NO_BLOB`, and `changedPairs` never transfers an absent-base pair — but a
 * byte-faithful read keeps the identity, so a CRLF filename costs nothing
 * instead of a permanent re-review.)
 *
 * A ref that cannot be listed at all returns null: the caller must treat the
 * whole lookup as unusable rather than reading "everything absent".
 */
export function blobsAt(
  repoRoot: string,
  ref: string,
  paths: readonly string[],
): Record<string, string> | null {
  const out = nullProtoMap<string>();
  for (const p of paths) out[p] = NO_BLOB;
  const BATCH = 200;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    let raw: Buffer;
    try {
      raw = gitRaw(
        '-C',
        repoRoot,
        LITERAL_PATHSPECS,
        'ls-tree',
        '-r',
        '-z',
        ref,
        '--',
        ...batch,
      );
    } catch {
      return null;
    }
    // `<mode> <type> <oid>\t<path>` records, NUL-terminated. `-z` also turns
    // off the C-style quoting that would otherwise mangle non-ASCII paths.
    for (const record of raw.toString('utf8').split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (meta.length >= 3 && Object.hasOwn(out, path)) {
        out[path] = `${meta[0]} ${meta[2]}`;
      }
    }
  }
  return out;
}

/** The recorded pairs for `paths` across a base and a head. */
export function blobPairs(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  paths: readonly string[],
): FileVerdicts | null {
  const base = blobsAt(repoRoot, baseSha, paths);
  const head = blobsAt(repoRoot, headSha, paths);
  if (base === null || head === null) return null;
  const out = nullProtoMap<BlobPair>();
  for (const p of paths) out[p] = { base: base[p], head: head[p] };
  return out;
}

/**
 * Validate a `fileVerdicts` map read from the (model-promoted) cache.
 * Malformed → null, and the caller degrades to the full review — the same
 * untrusted-boundary posture as every other cache read.
 */
export function readFileVerdicts(raw: unknown): FileVerdicts | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const out = nullProtoMap<BlobPair>();
  for (const [path, pair] of Object.entries(raw as Record<string, unknown>)) {
    const p = pair as { base?: unknown; head?: unknown };
    if (!p || typeof p.base !== 'string' || typeof p.head !== 'string') {
      return null;
    }
    out[path] = { base: p.base, head: p.head };
  }
  return out;
}

/**
 * The paths whose pair moved — plus every path the record never saw, which
 * has no verdict to transfer. `paths` is the CURRENT plan's file list: a file
 * the record knows but the current diff no longer touches simply has nothing
 * to review, so it contributes nothing here.
 *
 * A pair whose BASE side is `NO_BLOB` never transfers, identical or not.
 * Such a pair says "this path did not exist at the merge base" — which is
 * also what a pure RENAME records for its destination, with the rename
 * source never consulted. After a keep-both restructure (the old path
 * restored, the new path a plain copy of the same content) the pair is
 * byte-identical while the file's true diff became an all-new addition no
 * round ever read. Added files re-enter every round; their incremental
 * saving is the one this identity cannot carry soundly.
 */
export function changedPairs(
  recorded: FileVerdicts,
  current: FileVerdicts,
  paths: readonly string[],
): string[] {
  return paths.filter((p) => {
    const rec = Object.hasOwn(recorded, p) ? recorded[p] : undefined;
    const cur = Object.hasOwn(current, p) ? current[p] : undefined;
    if (!rec || !cur) return true;
    if (rec.base === NO_BLOB || cur.base === NO_BLOB) return true;
    return rec.base !== cur.base || rec.head !== cur.head;
  });
}
