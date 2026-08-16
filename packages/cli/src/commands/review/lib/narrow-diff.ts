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
// The two captures' NEW-side line numbers are comparable because both end at
// the same head commit. That is the only cross-capture fact this needs, and it
// is the one fact that was never in doubt.

import { parseDiff } from './diff-plan.js';

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
 * `fullBytes` is `base..head` — exactly what GitHub renders. `deltaText` is
 * `anchor..head`, read for its post-image ranges and nothing else: not one of
 * its bytes reaches the result.
 *
 * Returns null when there is nothing to narrow to — the caller keeps the full
 * range, which is always safe because it is the review the round would have
 * done anyway. Null covers three cases deliberately treated alike: a capture
 * that did not parse, a delta touching no path the PR's diff carries, and a
 * delta whose ranges miss every hunk of it. The last is the "undo per feedback"
 * round, where the commits since the anchor put lines back the way the base
 * had them: the PR's diff no longer shows that region at all, so there is
 * genuinely nothing there to re-review, and the round falls back rather than
 * scoping to hunks nobody can comment on.
 */
export function narrowToDelta(
  fullBytes: Buffer,
  deltaText: string,
): Buffer | null {
  // Bytes in, bytes out. The selection below runs on decoded text, because
  // that is what `parseDiff` reads — so a capture that does not round-trip
  // through UTF-8 cannot be reassembled faithfully: re-encoding would write
  // bytes git never produced and give `diffSha256` a value naming a file
  // nobody captured. Checked exactly, by round-trip, rather than by hunting
  // for U+FFFD. Such a round keeps the full range, which is the original
  // bytes untouched.
  const fullText = fullBytes.toString('utf8');
  if (!Buffer.from(fullText, 'utf8').equals(fullBytes)) return null;
  if (fullText.trim() === '' || deltaText.trim() === '') return null;
  const full = parseDiff(fullText);
  const delta = parseDiff(deltaText);
  if (full.files.length === 0 || delta.files.length === 0) return null;

  /** path -> the post-image ranges the delta touched. */
  const touched = new Map<string, Array<[number, number]>>();
  for (const f of delta.files) {
    const ranges = touched.get(f.path) ?? [];
    // A section with no hunks — a mode change, a pure rename, a binary
    // replacement — touches the path without naming a range. It still counts
    // as "this path changed since the anchor", so it enters as a range that
    // overlaps nothing and the path-level check below carries it.
    for (const h of f.hunks) ranges.push([h.newStart, h.newEnd]);
    touched.set(f.path, ranges);
  }

  // 1-based line numbers throughout, matching `parseDiff`'s own coordinates.
  const lines = fullText.split('\n');
  const slice = (from: number, to: number) => lines.slice(from - 1, to);

  const out: string[] = [];
  for (const file of full.files) {
    const ranges = touched.get(file.path);
    if (ranges === undefined) continue;

    // The section header: everything from the start of the section up to its
    // first hunk. A hunkless section has no hunks to select, so the header IS
    // the section, and it is emitted whole when the delta touched that path.
    const firstHunk = file.hunks[0];
    const headerEnd =
      firstHunk === undefined ? file.diffEnd : firstHunk.diffStart - 1;
    const selected = file.hunks.filter((h) =>
      ranges.some((r) => overlaps([h.newStart, h.newEnd], r)),
    );
    if (firstHunk !== undefined && selected.length === 0) continue;

    out.push(...slice(file.diffStart, headerEnd));
    for (const h of selected) out.push(...slice(h.diffStart, h.diffEnd));
  }

  if (out.length === 0) return null;
  // Safe to encode: the round-trip check above proved this text's bytes are
  // exactly the ones git emitted, and every line here came from it.
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}
