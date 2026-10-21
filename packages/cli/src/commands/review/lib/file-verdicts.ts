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

import { renderingAttributes, UNHASHABLE } from './local-anchor.js';
import { gitRaw } from './git.js';
import { LITERAL_PATHSPECS } from './diff-flags.js';

/** A file absent on one side: created by the PR, or deleted by it. */
export const NO_BLOB = 'absent';

/**
 * Stands in for a rendering the attribute probe could not report.
 *
 * The COMPARISON gives it its meaning, exactly as `local-anchor` does for
 * `UNHASHABLE`: a plain constant is equal to itself, so recording one and
 * leaving `changedPairs` to compare strings would keep the fail-open it is
 * here to close — two rounds whose probes both failed would read as
 * unchanged. `changedPairs` treats it as changed on either side.
 */
const UNANSWERED_ATTRS = 'unanswered';

export interface BlobPair {
  base: string;
  head: string;
  /**
   * The EFFECTIVE rendering attributes git reports for this path, when it has
   * any.
   *
   * The two blobs answer "did the content move"; this answers "would git
   * render it the same way", which the blobs cannot: an untracked
   * `.gitattributes` in the reviewer's checkout governs `git diff` while
   * recording `absent/absent` in both trees. Optional, so a record written
   * before this field reads as changed once and is re-recorded.
   */
  attrs?: string;
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
    // Decoding is where a byte-faithful listing can still betray us: an
    // invalid UTF-8 byte in a filename decodes to U+FFFD, and a SIBLING
    // literally named with U+FFFD then shares the decoded key. The verdict
    // recorded under that key would be the sibling's pair on both sides, so
    // an edited file compares unchanged and its clean verdict transfers.
    // The whole lookup goes unusable rather than resolving the wrong file —
    // the caller degrades to the full-range review, which is the direction
    // every other failure here takes.
    const text = raw.toString('utf8');
    if (text.includes('\uFFFD')) return null;
    const seen = new Set<string>();
    for (const record of text.split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      // Two records decoding to one key is the same aliasing by another
      // route (a repo can hold both spellings).
      if (seen.has(path)) return null;
      seen.add(path);
      if (meta.length >= 3 && Object.hasOwn(out, path)) {
        out[path] = `${meta[0]} ${meta[2]}`;
      }
    }
  }
  return out;
}

/**
 * The recorded pairs for `paths` across a base and a head.
 *
 * The `.gitattributes` that GOVERN those paths are recorded too, whether or
 * not the round touched them. They decide how a blob is rendered — `binary`,
 * `-diff`, `text` — and a round reviews the rendering, so a pair identity
 * that cannot see them lets a clean verdict transfer over a diff nobody read.
 * The consumer (`changedPairs`) rules on them; it can only rule on what the
 * producer wrote, which is why they are added HERE and not left to a caller
 * to remember. They carry `NO_BLOB` on a side where they do not exist, like
 * any other path.
 */
export function blobPairs(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  paths: readonly string[],
): FileVerdicts | null {
  const all = [...new Set([...paths, ...governingAttributePaths(paths)])];
  const base = blobsAt(repoRoot, baseSha, all);
  const head = blobsAt(repoRoot, headSha, all);
  if (base === null || head === null) return null;
  const out = nullProtoMap<BlobPair>();
  for (const p of all) out[p] = { base: base[p], head: head[p] };
  // …and the EFFECTIVE rendering, asked of git rather than inferred from the
  // tree. The attribute-file blobs above see only what the two trees carry: a
  // `.gitattributes` that is UNTRACKED in the reviewer's checkout records
  // `absent/absent` on both sides and stays inert for ever, while `git diff`
  // renders under it — so round 1 could read `Binary files … differ`, round 2
  // (same trees, file since deleted) full hunks, with the pairs byte-identical
  // and the clean verdict transferred over hunks no round ever read.
  //
  // `check-attr` is the authority: it answers under every source git honours,
  // in git's own precedence, including the worktree copy this record cannot
  // see, `.git/info/attributes`, and the config-side diff drivers. The answer
  // is folded per path as a THIRD component, so a rendering change moves the
  // record even when both blobs stand still. It is machine-local by nature,
  // which is the safe direction: another checkout reads it as changed and
  // re-reviews.
  const attrs = renderingAttributes(
    repoRoot,
    paths.filter((p) => out[p] !== undefined),
  );
  for (const p of paths) {
    if (out[p] === undefined) continue;
    // A path the probe could not answer for gets a never-equal sentinel, not
    // an ABSENT component. `renderingAttributes` answers `{}` from a blanket
    // catch when the probe itself fails, and skipping those paths recorded
    // nothing — so two rounds whose probes both failed compared
    // `undefined === undefined`, and a clean verdict transferred over a
    // rendering neither round ever certified. Failing closed costs a
    // re-review; failing open costs the review.
    out[p].attrs = attrs[p] ?? UNANSWERED_ATTRS;
  }
  return out;
}

/**
 * Every `.gitattributes` that could apply to `paths`: the repository root's,
 * and one in each ancestor directory of each path.
 *
 * Derived from the path strings rather than probed on disk — a file that does
 * not exist records `NO_BLOB` on both sides and is inert, which costs one
 * `ls-tree` entry and needs no filesystem walk. Git also reads
 * `.git/info/attributes` and the user's global file; neither is in the tree,
 * so neither travels with the PR, and a round cannot be made to disagree with
 * itself through them.
 */
function governingAttributePaths(paths: readonly string[]): string[] {
  const out = new Set<string>([GITATTRIBUTES]);
  for (const p of paths) {
    const parts = p.split('/');
    // The last element is the filename, so stop before it.
    for (let i = 1; i < parts.length; i++) {
      out.add(`${parts.slice(0, i).join('/')}/${GITATTRIBUTES}`);
    }
  }
  return [...out];
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
    const p = pair as { base?: unknown; head?: unknown; attrs?: unknown };
    if (!p || typeof p.base !== 'string' || typeof p.head !== 'string') {
      return null;
    }
    // …and the third component. Dropping it here made the whole thing inert
    // in the opposite direction: a round-tripped record arrived with no
    // `attrs` while a freshly computed pair carries the probe's answer, so
    // `changedPairs` saw a difference on every attrs-bearing file every
    // round and no verdict ever transferred. A record written before the
    // field legitimately has none, which reads as changed once.
    out[path] = {
      base: p.base,
      head: p.head,
      ...(typeof p.attrs === 'string' ? { attrs: p.attrs } : {}),
    };
  }
  return out;
}

/** Every `.gitattributes` path either side recorded, in one set. */
function attributePaths(...sides: FileVerdicts[]): string[] {
  const out = new Set<string>();
  for (const side of sides) {
    for (const p of Object.keys(side)) {
      if (p === GITATTRIBUTES || p.endsWith(`/${GITATTRIBUTES}`)) out.add(p);
    }
  }
  return [...out];
}

/**
 * Did any `.gitattributes` this record covers move between the two states?
 *
 * Only files the record CARRIES are visible here — `blobPairs` is given the
 * plan's file list — so an attributes file outside it cannot be ruled on. The
 * producer is what has to include them; this is the consumer's half, and it
 * fails safe on what it can see.
 */
function attributesMoved(
  recorded: FileVerdicts,
  current: FileVerdicts,
): boolean {
  return attributePaths(recorded, current).some((p) => {
    const rec = Object.hasOwn(recorded, p) ? recorded[p] : undefined;
    const cur = Object.hasOwn(current, p) ? current[p] : undefined;
    // Present on one side only is a move: added, deleted, or newly in scope.
    if (!rec || !cur) return true;
    return rec.base !== cur.base || rec.head !== cur.head;
  });
}

const GITATTRIBUTES = '.gitattributes';

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
  // `.gitattributes` decides how a blob is RENDERED, and a round reviews the
  // rendering, not the blob. `binary`, `-diff` and `text` all change what
  // `git diff` emits for byte-identical content — one history shows
  // "Binary files … differ" where the other shows hunks — and those files are
  // in the tree, so a PR can change them. A pair identity built from
  // `<mode> <oid>` cannot see it, and the verdict would transfer over a diff
  // no round ever read, in either direction: hunks appearing where none were
  // reviewed, or content vanishing behind a binary marker.
  //
  // Ruled here rather than folded into each pair, because the attributes are
  // not per-file state: one `.gitattributes` governs a subtree, and the set
  // that applies to a path is itself a function of the tree. Any move in any
  // of them retires every transferable verdict for this round — coarse, and
  // the fail-safe direction: a full review costs tokens, a transferred
  // verdict over an unread rendering costs the review.
  if (attributesMoved(recorded, current)) return [...paths];
  return paths.filter((p) => {
    const rec = Object.hasOwn(recorded, p) ? recorded[p] : undefined;
    const cur = Object.hasOwn(current, p) ? current[p] : undefined;
    if (!rec || !cur) return true;
    if (rec.base === NO_BLOB || cur.base === NO_BLOB) return true;
    // The rendering is the third component, and comparing only the blobs
    // would leave the field inert: an untracked `.gitattributes` moves
    // `attrs` while both blobs stand still, which is the whole reason it is
    // recorded. A record written before the field has none on the recorded
    // side, so it reads as changed once and is re-recorded — the safe
    // direction.
    //
    // `UNHASHABLE` is the probe's OWN never-equal answer — a `diff` attribute
    // spelled `set`/`unset`, an undecodable driver name, a `diff.unspecified`
    // driver configured — recorded verbatim by `blobPairs`, and a plain
    // constant like the sentinel above: `local-anchor`'s standard is that it
    // never equals, not even itself, so it is refused here the same way.
    if (
      rec.attrs === UNANSWERED_ATTRS ||
      cur.attrs === UNANSWERED_ATTRS ||
      rec.attrs === UNHASHABLE ||
      cur.attrs === UNHASHABLE ||
      rec.attrs !== cur.attrs
    ) {
      return true;
    }
    return rec.base !== cur.base || rec.head !== cur.head;
  });
}
