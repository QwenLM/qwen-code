/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which of a PR's diff belongs to an incremental round — decided as a SLICE of
// the PR's own full-range diff, never as a re-capture of `anchor..head`.
//
// `fetch-pr --since` already rules whether an anchor may scope a round at all
// (ancestry, merge-base clamp, base trust). This module answers the next
// question: given a valid anchor, WHICH files does the round review, and what
// bytes does it hand the agents. Two properties fall out of doing it by slicing
// that a re-capture cannot give:
//
//   1. Every hunk is byte-identical to a hunk of the PR's own diff. Comment
//      anchoring can therefore never produce a line GitHub refuses — and an
//      inline comment 422 is all-or-nothing, taking every other finding in the
//      Create Review call with it. A re-captured `anchor..head` carries hunks
//      the PR's diff does not contain whenever the fix round reverted lines
//      back to base content ("undo per feedback"), which is an ordinary thing
//      for a fix round to do.
//   2. A file with no hunks in `anchor..head` can still be IN scope. That is
//      what makes the one-hop widening possible at all: an importer of a
//      changed file is unchanged by definition, so a delta capture cannot show
//      it, yet round 1 cleared it against the callee's OLD shape and
//      (importer@head × callee@head) is a pairing no round has seen.
//
// Everything here is pure but for two injected readers, so the whole decision
// is unit-testable without a repository.

import { parseDiff, sliceDiffByLines } from './diff-plan.js';
import {
  dependentsOfChanged,
  discoverWorkspacePackages,
} from './import-graph.js';

/** A still-clean file pulled in because it imports a changed one. */
export interface InteractionFile {
  path: string;
  importsChanged: string[];
}

export interface IncrementalScope {
  /** The anchor this scope was computed against, full sha. */
  anchor: string;
  /**
   * Changed since the anchor AND carrying hunks of the PR's own diff. A file
   * restored to its merge-base state is changed since the anchor but has
   * nothing left to review, so it is not here — a plan naming delta files
   * with zero hunks sends agents hunting for scope that does not exist.
   */
  deltaFiles: string[];
  /** Still-clean files the widening pulled in, with the edges that did it. */
  interaction: InteractionFile[];
  /** Clean source files the widening considered and did NOT pull in. */
  contextFileCount: number;
  /**
   * Files changed since the anchor whose content is byte-identical to the
   * merge base's — the fix round undid them. Counted, not reviewed: they own
   * no hunks, but they still moved their importers' seams, so the widening
   * used them.
   */
  restoredFileCount: number;
}

export type ScopeRuling =
  | { kind: 'scoped'; diff: Buffer; scope: IncrementalScope }
  /** Nothing of the PR's diff is in scope — the round has nothing to review. */
  | { kind: 'nothing-new'; detail: string }
  /** The slice cannot be trusted to hold everything owed a review. */
  | { kind: 'refuse'; reason: 'lineage-unfollowable'; detail: string };

export interface ScopeInput {
  /** Full sha of the anchor, for the report. */
  anchor: string;
  /** The PR's own full-range diff — merge-base..head — as captured bytes. */
  fullDiff: Buffer;
  /** Paths changed in `anchor..head`, as `parseDiff` labels them. */
  deltaFiles: readonly string[];
  /**
   * Is this path's tree entry at the head identical to the merge base's?
   *
   * The whole ENTRY, mode included: a fix round that reverts the content and
   * keeps `chmod +x` — or swaps a file for a symlink with the same text — is
   * not a restoration, and its mode-only section IS in the PR's diff. A blob
   * -only comparison read those as restored and scoped them out, which put a
   * change nobody reviewed past the next round's anchor.
   *
   * Absent on BOTH sides must answer `false`, not `true`: this layer cannot
   * tell a net-zero add-then-delete (safe to drop) from a file renamed before
   * the anchor and deleted now, whose unreviewed deletion hunks sit in the PR
   * diff under its pre-rename name (dropping it loses them).
   */
  restored: (path: string) => boolean;
  /** Read a repo-relative file from the worktree; null when unreadable. */
  readWorktree: (repoRelPath: string) => string | null;
}

/**
 * Decide an incremental round's scope, or decline to.
 *
 * Declining is always toward MORE review: `refuse` sends the round to the full
 * range, and `nothing-new` only ever fires when the slice provably holds
 * nothing. There is no path here that narrows scope on an uncertainty.
 */
export function computeIncrementalScope(input: ScopeInput): ScopeRuling {
  const { anchor, fullDiff, deltaFiles, restored, readWorktree } = input;
  const sections = parseDiff(fullDiff.toString('utf8')).files;

  // The restoration probe runs BEFORE the widening, not after it. A delta
  // file the fix round restored to its merge-base state has no PR-diff
  // section — nothing left to review in it — but it is also, by definition, a
  // file whose CURRENT content is the base content, so if it imports a file
  // that IS still changing, that seam is exactly what the widening exists to
  // catch. Judged after the fact it fell between both classes: excluded from
  // the delta readers for having no section, and excluded from the widening
  // candidates for being in the delta. It is a CANDIDATE.
  const restoredDelta = new Set(deltaFiles.filter(restored));
  // Two sets, because a restored file plays both parts. As a CHANGE it still
  // pulls its importers in: round 1 cleared them against the pre-revert
  // callee, and (importer@head × callee@base) is a pairing no round has seen.
  // As a FILE it has nothing left to review.
  const delta = new Set(deltaFiles);
  const deltaLive = new Set(deltaFiles.filter((p) => !restoredDelta.has(p)));

  // One import hop over the PR's still-clean SOURCE files. Test and docs
  // dependents stay out: re-running tests is `build-test`'s job, and prose
  // does not call functions.
  const candidates = sections
    .filter((f) => f.kind === 'source' && !f.binary && !deltaLive.has(f.path))
    .map((f) => f.path);
  const packages = discoverWorkspacePackages(
    [...deltaFiles, ...candidates],
    readWorktree,
  );
  const interaction = dependentsOfChanged(
    delta,
    candidates,
    readWorktree,
    packages,
  );
  // A restored file is inside `delta`, so the pass above skips it as a
  // candidate by construction (`dependentsOfChanged` never scans a file that
  // is itself changed). It still needs one: its own imports of files that are
  // STILL changing are live seams no other reader covers. Keyed on
  // `deltaLive`, because a restored file importing another restored file has
  // no moving side to check.
  for (const [path, edges] of dependentsOfChanged(
    deltaLive,
    [...restoredDelta],
    readWorktree,
    packages,
  )) {
    if (!interaction.has(path)) interaction.set(path, edges);
  }

  const scoped = new Set([...deltaLive, ...interaction.keys()]);
  const kept = sections.filter((f) => scoped.has(f.path));
  const keptPaths = new Set(kept.map((f) => f.path));

  // Every LIVE delta file must carry a section of the PR's own diff. One that
  // does not is a lineage break — a file renamed before the anchor and
  // deleted now is `new.ts` in the delta but `old.ts` on the PR diff's
  // deletion section (a deletion is labelled with its left-side path), so the
  // section holding its unreviewed hunks is scoped out under a name nothing
  // matched. Restored files are already out of `deltaLive`.
  const lineageLost = [...deltaLive].filter((p) => !keptPaths.has(p));
  if (lineageLost.length > 0) {
    return {
      kind: 'refuse',
      reason: 'lineage-unfollowable',
      detail:
        `${lineageLost.length} file(s) changed since ${anchor} carry no ` +
        `section of the PR's own diff under that name ` +
        `(${lineageLost.slice(0, 3).join(', ')}` +
        `${lineageLost.length > 3 ? ', …' : ''}) — a rename or lineage ` +
        `change the scoped slice cannot follow.`,
    };
  }
  if (kept.length === 0) {
    return {
      kind: 'nothing-new',
      detail:
        `the files changed since ${anchor} carry no section of the PR's own ` +
        `diff (restored to the merge-base state), and nothing imports them.`,
    };
  }

  return {
    kind: 'scoped',
    diff: sliceDiffByLines(
      fullDiff,
      kept.map((f) => ({ startLine: f.diffStart, endLine: f.diffEnd })),
    ),
    scope: {
      anchor,
      deltaFiles: [...deltaLive].filter((p) => keptPaths.has(p)),
      // SECTIONLESS entries first, and the order is load-bearing.
      //
      // An interaction file that carries a section of the PR's diff is named
      // twice: here, and in the chunk brief of whichever chunk holds that
      // section, uncapped. One that carries NONE — a restored file pulled in
      // by the second pass, whose own content is base content — belongs to no
      // chunk, so this capped list is the ONLY surface that briefs its seam.
      // Appended last, as insertion order had them, they were the first
      // elided into `(+N more)` on any round with more than `SCOPE_LIST_CAP`
      // entries: the seam went unbriefed while `scope.interaction` recorded
      // it as covered, which is coverage claimed and not delivered.
      //
      // So the cap now bites the redundantly-named entries first. It still
      // bites — a round with more sectionless entries than the cap elides
      // some — but that is the honest degradation, not the silent one.
      interaction: [...interaction.entries()]
        .sort(
          ([a], [b]) =>
            Number(keptPaths.has(a)) - Number(keptPaths.has(b)) ||
            a.localeCompare(b),
        )
        .map(([path, importsChanged]) => ({
          path,
          importsChanged,
        })),
      contextFileCount: candidates.filter((p) => !interaction.has(p)).length,
      restoredFileCount: restoredDelta.size,
    },
  };
}
