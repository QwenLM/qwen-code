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

import { parseDiff } from './diff-plan.js';

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
  const selection = selectNarrowing(fullBytes, deltaBytes);
  return selection === null
    ? null
    : assembleSections(selection, selection.touched);
}

/** A parsed section of the full capture, as `parseDiff` reads it. */
type FullSection = ReturnType<typeof parseDiff>['files'][number];

/**
 * What the narrowing decided, before it assembles anything.
 *
 * Exposed because the scope is not always exactly what the delta touched: the
 * one-hop widening adds still-clean files that import a touched one, and it
 * needs the same guards to have passed and the same sections to assemble out
 * of. Keeping one selection means the widening cannot re-derive a set the
 * refusals above already ruled out.
 */
export interface NarrowSelection {
  /** The full capture's sections, in the order it rendered them. */
  readonly sections: readonly FullSection[];
  /** The full capture, decoded — the text every emitted line comes from. */
  readonly fullText: string;
  /** Paths the delta touched. Every one is carried by the full capture. */
  readonly touched: ReadonlySet<string>;
}

/** The guard-and-select half of `narrowToDelta`. Null for the same reasons. */
export function selectNarrowing(
  fullBytes: Buffer,
  deltaBytes: Buffer,
): NarrowSelection | null {
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

  /**
   * Every path the delta touched.
   *
   * A set, not ranges. Narrowing is per FILE now, so the only question a path
   * has to answer is whether the round touched it at all — which also makes a
   * hunk-less section (a mode change, a pure rename, a binary replacement)
   * ordinary rather than a special case: it touches the path, so its section
   * is emitted, exactly like any other.
   */
  const touched = new Set(delta.files.map((f) => f.path));

  // The two captures can key the same change differently whenever git's
  // rename detection resolves differently across the two ranges —
  // `base..head` is a two-tree diff with no intermediate tree. Either shape
  // of divergence is a change the PR's diff displays that would silently drop
  // from the published scope, so refuse to narrow instead: the round keeps
  // the full range, which still displays it.
  //
  // Shape one: a delta path the full capture does not carry at all.
  const fullPaths = new Set(full.files.map((f) => f.path));
  for (const p of touched) {
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

  // Whole SECTIONS, not selected hunks.
  //
  // The two captures are independent Myers alignments over overlapping
  // content, so the hunk a change lands in is not stable between them: a run
  // of identical lines — blank runs, repeated imports, regenerated tables —
  // lets the same edit be attributed to the run's front in one capture and
  // its back in the other. Four rounds of review each closed the reported
  // position-divergence entrance and the next round found another, because
  // matching hunks across two alignments is a heuristic over arbitrary
  // content, exactly like the containment oracle this file replaced. The
  // failure was worse than the oracle's, too: a dropped hunk left the round
  // reporting `effective: true`, and the ledger then certified head as the
  // next anchor, so the change was never reviewed by any round.
  //
  // What IS stable is which FILE a change belongs to — file identity, which
  // the path and rename guards above already fail closed on. So the unit of
  // narrowing is the file: a section the delta touched is emitted whole, and
  // a section it did not touch is dropped. Nothing the delta performed can
  // fall out of a section that is emitted entire, and every emitted line is
  // still a line the PR's own diff displays.
  //
  // The cost is real and bounded: within a touched file the round reviews all
  // of that file's PR hunks, not only the ones that moved since the anchor.
  // The saving incremental review exists for is the untouched files — a round
  // touching 2 of 40 reviews 2 — and that is untouched by this.
  return { sections: full.files, fullText, touched };
}

/**
 * The named sections of the full capture, in the capture's own order.
 *
 * Null when `paths` selects nothing — the same "nothing to narrow to" the
 * caller turns into a full-range round.
 */
export function assembleSections(
  selection: NarrowSelection,
  paths: ReadonlySet<string>,
): Buffer | null {
  // 1-based line numbers throughout, matching `parseDiff`'s own coordinates.
  const lines = selection.fullText.split('\n');
  const selected: Array<[number, number]> = [];
  for (const file of selection.sections) {
    if (!paths.has(file.path)) continue;
    selected.push([file.diffStart, file.diffEnd]);
  }

  if (selected.length === 0) return null;
  // Assemble without spreading the ranges into a single `push`: a section can
  // exceed the argument-count ceiling (~125k lines), and this path exists for
  // exactly the large long-lived PRs that carry such sections. Safe to
  // encode: every line here came from text that decoded cleanly above.
  const parts = selected.map(([from, to]) =>
    lines.slice(from - 1, to).join('\n'),
  );
  return Buffer.from(parts.join('\n') + '\n', 'utf8');
}
