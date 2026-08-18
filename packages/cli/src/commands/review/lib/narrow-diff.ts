/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Narrow a PR's own diff to the part that changed since an anchor.
//
// This replaces a containment ORACLE. The previous design captured
// `anchor..head` separately, published it as the review scope, and then tried
// to prove after the fact that every hunk in it also appeared in the PR's own
// `base..head` diff — because a comment anchored on a line GitHub's PR diff
// does not display answers 422 and takes the whole all-or-nothing Create
// Review call with it.
//
// That proof was a hand-written match over two rendered unified diffs, and its
// acceptance surface was unbounded: six review rounds each closed the reported
// entrances and the next round found new ones — count-less headers, deletion
// junctions, lossy UTF-8 decodes, cross-hunk double-spends, content matched
// without position. Every one was the same shape: something the delta carried
// that the PR's diff did not display, arriving through a gap in the match.
//
// So the scope is not checked against the PR's diff any more; it is BUILT from
// it. The delta is read only to learn which post-image line ranges changed
// since the anchor, and the published text is assembled out of the full
// capture's own hunks. Every line the review sees is therefore a line GitHub
// displays, by construction rather than by proof, and the whole family of
// defects — along with the two refusal reasons that existed to report it —
// cannot recur.
//
// The one judgment left — which of the full capture's hunks the delta's
// ranges corroborate — fails closed the same way. A delta hunk no full hunk
// corroborates (overlaps its new-side range AND shares a changed line with,
// keyed by new-side junction) is a netted-out undo OR a Myers misplacement,
// and two alignment-dependent
// rendered diffs cannot tell those apart, so its section is emitted whole:
// over-inclusion re-reviews lines GitHub displays, while a dropped change
// would be certified unreviewed by the ledger.
//
// The two captures' NEW-side line numbers are comparable because both end at
// the same head commit. That is the only cross-capture fact this needs, and it
// is the one fact that was never in doubt.

import { parseDiff, type DiffHunk } from './diff-plan.js';

/** Do two inclusive ranges share a line? */
function overlaps(
  [aStart, aEnd]: [number, number],
  [bStart, bEnd]: [number, number],
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * The PR's own hunks that overlap what changed since the anchor.
 *
 * `fullBytes` is `base..head` — exactly what GitHub renders. `deltaBytes` is
 * `anchor..head`, read for its post-image ranges and nothing else: not one of
 * its bytes reaches the result.
 *
 * Returns null when there is nothing to narrow to — the caller keeps the full
 * range, which is always safe because it is the review the round would have
 * done anyway. Null covers, deliberately treated alike: a capture on EITHER
 * side that did not decode, a delta carrying a path the full capture does not
 * carry at all — the canonical "undo per feedback" round lands here when the
 * undone file no longer appears in `base..head` — and a rename the full
 * capture keys differently (git's rename detection resolved differently
 * across the two ranges, so the change would drop from the scope under the
 * key mismatch). A delta whose ranges miss the full capture's hunks does NOT
 * land here: a missed hunk might be a netted-out undo, but it might equally
 * be a change the two captures position disjointly, so the join fails closed
 * for it — the section is emitted whole, never dropped.
 */
export function narrowToDelta(
  fullBytes: Buffer,
  deltaBytes: Buffer,
): Buffer | null {
  // Bytes in, bytes out. The selection below runs on decoded text, because
  // that is what `parseDiff` reads — so a capture that does not survive UTF-8
  // cannot be reassembled faithfully: re-encoding would write bytes git never
  // produced and give `diffSha256` a value naming a file nobody captured. A
  // fatal decode rejects exactly those bytes, without materializing a
  // re-encoded full-size copy just to compare, and it runs on BOTH captures:
  // a lossily pre-decoded delta folds an invalid path byte onto U+FFFD, which
  // can collide with a legitimate U+FFFD path the full capture carries and
  // select hunks of a file that never changed since the anchor. Such a round
  // keeps the full range, which is the original bytes untouched.
  const decode = (bytes: Buffer): string | null => {
    try {
      return new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      return null;
    }
  };
  const fullText = decode(fullBytes);
  const deltaText = decode(deltaBytes);
  if (fullText === null || deltaText === null) return null;
  if (fullText.trim() === '' || deltaText.trim() === '') return null;
  const full = parseDiff(fullText);
  const delta = parseDiff(deltaText);
  if (full.files.length === 0 || delta.files.length === 0) return null;

  /** path -> the post-image ranges the delta touched. */
  const touched = new Map<string, Array<[number, number]>>();
  /** path -> the delta's hunks, read by the position-divergence guard. */
  const deltaHunks = new Map<string, DiffHunk[]>();
  const deltaLines = deltaText.split('\n');
  for (const f of delta.files) {
    const ranges = touched.get(f.path) ?? [];
    const hunks = deltaHunks.get(f.path) ?? [];
    // A section with no hunks — a mode change, a pure rename, a binary
    // replacement — touches the path without naming a range. It enters as an
    // EMPTY range list, which the emission loop reads as "the change lives in
    // the full section's header; emit the section whole".
    for (const h of f.hunks) {
      ranges.push([h.newStart, h.newEnd]);
      hunks.push(h);
    }
    touched.set(f.path, ranges);
    deltaHunks.set(f.path, hunks);
  }

  // The two captures can key the same change differently whenever git's
  // rename detection resolves differently across the two ranges —
  // `base..head` is a two-tree diff with no intermediate tree. Either shape
  // of divergence is a change the PR's diff displays that would silently drop
  // from the published scope, so refuse to narrow instead: the round keeps
  // the full range, which still displays it.
  //
  // Shape one: a delta path the full capture does not carry at all.
  const fullPaths = new Set(full.files.map((f) => f.path));
  for (const p of touched.keys()) {
    if (!fullPaths.has(p)) return null;
  }
  // Shape two: a rename the full capture does not key as the SAME rename.
  // The path guard cannot see it — the delta keys the rename under the NEW
  // path, which the full capture also carries (as a plain addition), while
  // the rename's deletion half sits under the OLD path, keyed only in the
  // full capture.
  const fullRenames = new Map<string, string>();
  for (const f of full.files) {
    if (f.renameFrom !== undefined) fullRenames.set(f.path, f.renameFrom);
  }
  for (const f of delta.files) {
    if (
      f.renameFrom !== undefined &&
      fullRenames.get(f.path) !== f.renameFrom
    ) {
      return null;
    }
  }

  // 1-based line numbers throughout, matching `parseDiff`'s own coordinates.
  const lines = fullText.split('\n');

  /**
   * A hunk's changed lines keyed by new-side junction — the `+`/`-` record
   * joined to the new-side position it sits at. Both captures end at the
   * same head commit, so a change both display sits at the same junction in
   * both; a bystander that merely carries identical TEXT at a different
   * junction does not corroborate. The walk advances the new-side cursor on
   * ` `/`+` lines and not on `-`, the same cursor `parseDiff` keeps.
   */
  const changedLineKeys = (textLines: string[], h: DiffHunk): string[] => {
    const out: string[] = [];
    let newLine = h.newStart;
    for (let n = h.diffStart + 1; n <= h.diffEnd; n++) {
      const l = textLines[n - 1];
      if (l.startsWith('+')) {
        out.push(`${newLine}:${l}`);
        newLine++;
      } else if (l.startsWith('-')) {
        out.push(`${newLine}:${l}`);
      } else if (l === '' || l.startsWith(' ')) {
        newLine++;
      }
    }
    return out;
  };

  /** [from, to] line ranges of the full capture the output carries, in order. */
  const selected: Array<[number, number]> = [];
  for (const file of full.files) {
    const ranges = touched.get(file.path);
    if (ranges === undefined) continue;

    if (ranges.length === 0) {
      // Hunk-less delta touch (mode change, pure rename, binary replacement):
      // the change lives in the full section's header, so emit the section
      // whole.
      selected.push([file.diffStart, file.diffEnd]);
      continue;
    }

    // Position divergence: Myers aligns a change inside a run of identical
    // lines against whatever surrounds it, and the two captures' old sides
    // differ — so the SAME post-anchor change can sit at disjoint head-side
    // ranges in the two captures, and the divergent delta hunk can even
    // overlap an unrelated bystander hunk. The range join sees neither
    // shape: it drops the full hunk displaying the change, and can publish
    // the bystander instead. A delta hunk is corroborated only by a full
    // hunk that BOTH overlaps its new-side range — so the join carries that
    // full hunk — AND shares one of its changed lines at the same new-side
    // junction — so the carried hunk displays the same change, and a
    // bystander carrying identical text at a different junction cannot stand
    // in for it. A hunk no full hunk corroborates might be a
    // netted-out undo, but it might equally be a misplacement the join is
    // about to drop, and the captures cannot tell the two apart — telling
    // them was the old oracle's shape, a heuristic proof over two
    // alignment-dependent rendered diffs. Fail closed instead: emit the
    // section whole. Every line of it is displayed — over-inclusion is the
    // chosen semantics — and a dropped change here is certified unreviewed
    // by the ledger.
    if (
      (deltaHunks.get(file.path) ?? []).some((dh) => {
        const dhChanged = new Set(changedLineKeys(deltaLines, dh));
        return !file.hunks.some(
          (fh) =>
            overlaps([fh.newStart, fh.newEnd], [dh.newStart, dh.newEnd]) &&
            changedLineKeys(lines, fh).some((k) => dhChanged.has(k)),
        );
      })
    ) {
      selected.push([file.diffStart, file.diffEnd]);
      continue;
    }

    // The section header: everything from the start of the section up to its
    // first hunk. A hunkless full section has no hunks to select, so the
    // header IS the section, and it is emitted whole when the delta touched
    // that path.
    const firstHunk = file.hunks[0];
    const matching = file.hunks.filter((h) =>
      ranges.some((r) => overlaps([h.newStart, h.newEnd], r)),
    );

    const headerEnd =
      firstHunk === undefined ? file.diffEnd : firstHunk.diffStart - 1;
    selected.push([file.diffStart, headerEnd]);
    for (const h of matching) selected.push([h.diffStart, h.diffEnd]);
  }

  if (selected.length === 0) return null;
  // Assemble without spreading the ranges into a single `push`: a selected
  // hunk can exceed the argument-count ceiling (~125k lines), and this path
  // exists for exactly the large long-lived PRs that carry such hunks. Safe
  // to encode: every line here came from text that decoded cleanly above.
  const parts = selected.map(([from, to]) =>
    lines.slice(from - 1, to).join('\n'),
  );
  return Buffer.from(parts.join('\n') + '\n', 'utf8');
}
