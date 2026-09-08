/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// One import hop past what the round actually touched.
//
// `narrow-diff.ts` decides which of the PR's own sections an incremental round
// publishes: the ones the delta touched, emitted whole. That is the saving
// incremental review exists for — a round touching 2 files of 40 reviews 2 —
// and it is also, on its own, unsound in one direction.
//
// "Clean" is a verdict about the code as it stood. The previous round cleared
// a caller against the callee it imported THEN; the fix under review moves the
// callee, and a scope holding only the touched files never re-opens the
// caller. The breakage retires silently and permanently, because the next
// clean round re-anchors past it. The caller is unchanged by definition, so no
// delta capture can show it — which is exactly why this cannot be a narrowing
// and has to be a widening.
//
// So every still-clean SOURCE file one import hop from a touched one re-enters
// the scope with its full-range hunks, and the plan records WHY
// (`incremental.scope.interaction[]`), so the chunk brief can point its agent
// at the seam — "do your uses of what changed still hold" — instead of a
// from-scratch re-review that re-reports what the earlier round already ruled
// on.
//
// One hop, dependents only, source files only. The callee-side risk lives in
// the changed file's own chunk (its agent reads callees from the worktree),
// test dependents are `build-test`'s job, and a barrel re-export between
// caller and callee hides the edge — a documented miss that leaves exactly the
// floor incremental review had before widening existed. The specifier scan is
// a regex heuristic on purpose, and its error directions are chosen: a false
// positive reviews a file once more than needed, a false negative never drops
// below the unwidened floor.
//
// Everything here is pure but for one injected reader, so the whole decision
// is unit-testable without a repository.

import type { NarrowSelection } from './narrow-diff.js';
import {
  dependentsOfChanged,
  discoverWorkspacePackages,
  loadTypeScript,
  seamLines,
} from './import-graph.js';
import { classifyHeavy } from './heavy.js';

/** A still-clean file pulled in because it imports a changed one. */
export interface InteractionFile {
  path: string;
  importsChanged: string[];
  /**
   * Present exactly when the fix-audit posture seam-bounded this file
   * (#10104): of its section's `total` hunks, `kept` republish — the ones
   * displaying a line that imports or uses what changed. The rest were
   * cleared by the round that reviewed them and are not re-shown; the brief
   * and the posted body both disclose the reduction through this record.
   */
  seam?: { kept: number; total: number };
}

export interface IncrementalScope {
  /** The anchor this scope was computed against, full sha. */
  anchor: string;
  /** Touched since the anchor, and carrying a section of the PR's own diff. */
  deltaFiles: string[];
  /** Still-clean files the widening pulled in, with the edges that did it. */
  interaction: InteractionFile[];
  /** Clean source files the widening considered and did NOT pull in. */
  contextFileCount: number;
  /**
   * Set exactly when the seam bound was asked for but no TypeScript
   * parser could be resolved at run time (#10136 R18-2): every
   * interaction file republished in full with NO census — byte-identical
   * to the pre-bound widening — and the capture note and the posted body
   * name the oracle's absence instead of reading as "no interaction file
   * needed seam-bounding". TypeScript is a build-time dependency of the
   * CLI and the published package carries no runtime dependencies, so
   * this is the steady state of a global install; the seam bound only
   * ever runs where a parser resolves.
   */
  seamOracle?: 'unavailable';
}

export interface WidenedScope {
  /** Every path to publish: what the delta touched, plus what imports it. */
  paths: Set<string>;
  /** The record the plan carries and the chunk briefs read. */
  scope: IncrementalScope;
  /**
   * Per seam-bounded interaction file, the indices (into its section's
   * `hunks`) to republish — `assembleSections` reads it. An entry exists only
   * where the bound actually dropped something; an empty set is legal and
   * means "header only": the file stays in the published diff (and so in a
   * chunk, and so in a brief) with none of its already-cleared hunks.
   */
  hunkKeep?: Map<string, ReadonlySet<number>>;
}

export interface WidenInput {
  /** Full sha of the anchor, for the report. */
  anchor: string;
  /** What `selectNarrowing` decided — its guards have already passed. */
  selection: NarrowSelection;
  /** Read a repo-relative file from the worktree; null when unreadable. */
  readWorktree: (repoRelPath: string) => string | null;
  /**
   * Bound each interaction file to the hunks near its import seams (#10104)
   * — the fix-audit posture's widening. Off, the widening republishes
   * full-range sections exactly as it always has; the flag is resolved by
   * the capture command from the posture, never by a later reader.
   */
  seamBound?: boolean;
}

/**
 * Widen a narrowing by one import hop.
 *
 * This never declines and never narrows: with nothing to pull in it returns
 * exactly the paths the narrowing selected, so the unwidened round is the
 * floor rather than a separate path that could disagree with it.
 */
export function widenScope(input: WidenInput): WidenedScope {
  const { anchor, selection, readWorktree, seamBound } = input;
  const touched = new Set(selection.touched);

  // Test and docs dependents stay out: re-running tests is `build-test`'s job,
  // and prose does not call functions.
  const candidates = selection.sections
    .filter((f) => f.kind === 'source' && !f.binary && !touched.has(f.path))
    .map((f) => f.path);
  const packages = discoverWorkspacePackages(
    [...touched, ...candidates],
    readWorktree,
  );
  const interaction = dependentsOfChanged(
    touched,
    candidates,
    readWorktree,
    packages,
  );

  // The seam bound (#10104). Under the critical posture an interaction
  // file's full-range republication is what re-entered 89% of a measured
  // long-lived diff every round, and everything it re-found below Critical
  // was deferred anyway. So each interaction file keeps only the hunks that
  // DISPLAY a seam line — an import of a changed file, or a use of a binding
  // such an import introduces — and the record says how many were shed. The
  // file itself always stays in scope (header at minimum), so its chunk
  // agent is still briefed to re-ask the seam question against the worktree.
  // Every doubt state republishes in full: an unreadable source, a section
  // with no hunks, a scan that keeps everything, a FULL-RANGE slice that
  // classifies heavy (#10136), and the oracle's own doubt return — each
  // leaves the file exactly as the unbounded widening published it. The
  // heavy state is a doubt state because heaviness is classified from the
  // PUBLISHED slice: bounding a heavy interaction file would flip it
  // non-heavy, `heavyFiles()` would drop it, and the invariant agents that
  // read it whole from the worktree — the only auditors of hunks a backward
  // base move smuggles into the full-range slice — would never launch on
  // exactly the rounds the bound runs.
  const hunkKeep = new Map<string, ReadonlySet<number>>();
  const seams = new Map<string, { kept: number; total: number }>();
  // The oracle's unavailable state is named, not doubted through (#10136
  // R18-2). `seamLines` answers the doubt shape for every file when no
  // parser resolves, which republishes everything whole correctly — but
  // the plan, the capture's note and the posted body could not then tell
  // "the oracle never ran" from "nothing needed bounding", and the round
  // would certify the narrowed shape while running the full one (a
  // global install resolves no `typescript`: it is a build-time
  // dependency of the CLI and the published package carries no runtime
  // dependencies). Record it instead: every interaction file republishes
  // in full with NO census — the pre-bound behaviour, byte-identical —
  // and `seamOracle` says why.
  const oracleUnavailable =
    seamBound === true && interaction.size > 0 && loadTypeScript() === null;
  if (seamBound === true && interaction.size > 0 && !oracleUnavailable) {
    const byPath = new Map(selection.sections.map((f) => [f.path, f]));
    // The full capture's lines, for the kept slice's own +/- counts — the
    // second heaviness classification below reads them exactly as a
    // re-parse of the emitted hunks would (`assembleSections` emits each
    // kept hunk's diff text verbatim).
    const diffLines = selection.fullText.split('\n');
    for (const path of interaction.keys()) {
      const section = byPath.get(path);
      if (!section || section.hunks.length === 0) continue;
      const source = readWorktree(path);
      if (source === null) continue;
      // Heavy exemption (#10136): classify against the FULL-RANGE section,
      // not the slice the bound would leave — the same counts
      // `buildPlanReport` derives (added+removed, and preLines from the
      // post-image line count), so the plan's `heavy` and the roster's
      // invariant agents agree with what this loop decided to publish.
      const fileLines =
        source === ''
          ? 0
          : source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
      if (
        classifyHeavy({
          preLines: Math.max(
            0,
            fileLines - section.addedLines + section.removedLines,
          ),
          fileLines,
          changedLines: section.addedLines + section.removedLines,
          binary: section.binary,
          kind: section.kind,
        }).heavy
      ) {
        continue;
      }
      const lines = seamLines(path, source, touched, packages);
      // The doubt shape — a read whose bindings cannot be proven collected
      // marks EVERY line (#10136) — is detected before hunk matching:
      // `parseDiff` clamps a pure-deletion hunk at the top of a file
      // (`@@ -1,N +0,0 @@`) to new-side [0,0], no marked line is ever 0,
      // so matching in the doubt state would shed exactly the hunks the
      // doubt state promises to keep. A legitimate scan can never mark
      // more lines than the file has, so the shape is unambiguous; leave
      // the file unbounded with NO seam record, exactly like the
      // unreadable-source doubt state.
      if (lines.length >= fileLines) continue;
      const kept = new Set<number>();
      section.hunks.forEach((h, i) => {
        if (lines.some((ln) => ln >= h.newStart && ln <= h.newEnd)) {
          kept.add(i);
        }
      });
      // The heavy exemption's second direction (#10136 R17-4): the plan
      // classifies heaviness from the PUBLISHED slice — the kept hunks'
      // own +/- counts against the whole-file post-image, by the same
      // identity `buildPlanReport` applies — and the bound is the first
      // partial publisher, so a full-range NON-heavy file can classify
      // heavy once bounded (shedding hunks lowers changedLines while the
      // identity raises preLines; the two move in opposite directions).
      // The classifications must tell one story: a disagreement
      // republishes the file whole with NO census, or the plan's `heavy`
      // would roster three whole-file invariant agents on a file this
      // loop deliberately bounded, in the round shape whose purpose is to
      // stop spending them.
      if (kept.size < section.hunks.length) {
        let keptAdded = 0;
        let keptRemoved = 0;
        section.hunks.forEach((h, i) => {
          if (!kept.has(i)) return;
          for (let ln = h.diffStart; ln <= h.diffEnd; ln++) {
            const ch = diffLines[ln - 1]?.charAt(0);
            if (ch === '+') keptAdded++;
            else if (ch === '-') keptRemoved++;
          }
        });
        const keptHeavy = classifyHeavy({
          preLines: Math.max(0, fileLines - keptAdded + keptRemoved),
          fileLines,
          changedLines: keptAdded + keptRemoved,
          binary: section.binary,
          kind: section.kind,
        }).heavy;
        if (keptHeavy) continue;
      }
      seams.set(path, { kept: kept.size, total: section.hunks.length });
      if (kept.size < section.hunks.length) hunkKeep.set(path, kept);
    }
  }

  const paths = new Set([...touched, ...interaction.keys()]);
  return {
    paths,
    scope: {
      anchor,
      deltaFiles: [...touched].sort(),
      interaction: [...interaction.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, importsChanged]) => ({
          path,
          importsChanged,
          ...(seams.has(path) ? { seam: seams.get(path) } : {}),
        })),
      contextFileCount: candidates.filter((p) => !interaction.has(p)).length,
      ...(oracleUnavailable ? { seamOracle: 'unavailable' as const } : {}),
    },
    ...(hunkKeep.size > 0 ? { hunkKeep } : {}),
  };
}
