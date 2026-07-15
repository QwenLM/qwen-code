/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which agents this review is required to launch, derived from the plan.
//
// "Which agents must exist" was, until now, a sentence in a document. The skill
// says Agent 0 runs on every PR review; dogfooded against a real PR, **it was
// never launched**, and nothing in the run could tell — the coverage check asks
// what the agents that *did* run were given, and an agent that does not run leaves
// no transcript to ask. An omission is invisible precisely because it is an
// omission. The only cure is a list of who should have been there, written by
// something other than the thing doing the launching.
//
// The plan is that something. It already knows everything the roster turns on:
// the topology (from `srcDiffLines` / `diffLines`), whether the diff deletes
// anything (so whether the removed-behaviour audit has a job), which files were
// rewritten heavily enough to need whole-file invariant agents, and — from the
// fields the capturing command wrote — whether there is a pull request to check an
// issue against and a local tree to build and grep.
//
// Nothing here is supplied by the caller. A roster the caller could shrink is a
// roster that gets shrunk.

import type { RoleId } from './agent-briefs.js';

/**
 * How this review's diff was captured — which decides what can be asked of it.
 *
 * Inferred from the fields the capturing command wrote, rather than taken as an
 * argument: `fetch-pr` alone creates a worktree, `capture-local` alone reports the
 * untracked files it swept in, and `plan-diff` — the cross-repo lightweight path —
 * writes neither, because it has neither a pull request it can reach locally nor a
 * tree to look at.
 */
export type ReviewMode =
  /** Same-repo PR: a worktree, a PR number, a local tree to build and grep. */
  | 'pr-worktree'
  /** Uncommitted local changes or a single file: a tree, but no PR. */
  | 'local'
  /** Cross-repo lightweight: the diff and nothing else. */
  | 'diff-only';

/** The plan, as far as the roster needs it. */
export interface RosterPlan {
  chunks?: Array<{ id?: unknown }>;
  files?: Array<{
    path?: unknown;
    kind?: unknown;
    heavy?: unknown;
    removedLines?: unknown;
  }>;
  srcDiffLines?: unknown;
  diffLines?: unknown;
  worktreePath?: unknown;
  prNumber?: unknown;
  untrackedFiles?: unknown;
}

/** One agent this review must launch. */
export interface RequiredAgent {
  /** The key `agent-prompt` records its prompt under, and coverage looks up. */
  key: string;
  /** A dimension role, or a Step 3B territory. */
  role: RoleId | 'chunk';
  /** The territory a chunk agent owns. */
  chunk?: number;
  /** The heavy file an invariant agent owns. */
  file?: string;
}

export function reviewMode(plan: RosterPlan): ReviewMode {
  if (typeof plan.worktreePath === 'string' && plan.worktreePath) {
    return 'pr-worktree';
  }
  if (Array.isArray(plan.untrackedFiles)) return 'local';
  return 'diff-only';
}

/**
 * The topology gate, in code.
 *
 * The same two numbers the skill's prose turns on. It is here so the roster and
 * the reader cannot disagree about which fan-out was owed — a disagreement that
 * would show up as a review being told it forgot eleven agents it was never
 * supposed to launch.
 */
export function isTerritoryFanOut(plan: RosterPlan): boolean {
  const src = Number(plan.srcDiffLines ?? 0);
  const total = Number(plan.diffLines ?? 0);
  return !(src <= 500 && total <= 3200);
}

/** Does the diff remove or replace anything? If not, 1b has nothing to audit. */
function hasDeletions(plan: RosterPlan): boolean {
  const files = Array.isArray(plan.files) ? plan.files : [];
  // No `files[]` at all is not "no deletions" — it is "we do not know", and the
  // safe answer to that is to run the audit. An agent with nothing to find costs
  // one return; a removed guard nobody looked for costs whatever it was guarding.
  if (files.length === 0) return true;
  return files.some((f) => Number(f?.removedLines ?? 0) > 0);
}

/** Source files rewritten heavily enough that the diff is the wrong frame. */
function heavyFiles(plan: RosterPlan): string[] {
  const files = Array.isArray(plan.files) ? plan.files : [];
  return files
    .filter((f) => f?.heavy === true && typeof f.path === 'string')
    .map((f) => f.path as string);
}

/**
 * Every agent this plan requires, and the key each one's prompt is recorded under.
 *
 * Maxima are not requirements: Agent 8 is optional by construction ("launch none
 * when no domain stands out — the common case"), so it is not here. Nothing in this
 * list is discretionary. If a role is in it, a review that did not launch it has a
 * dimension nobody reviewed, and must not certify the diff.
 */
export function requiredAgents(plan: RosterPlan): RequiredAgent[] {
  const mode = reviewMode(plan);
  const out: RequiredAgent[] = [];
  const add = (role: RoleId, file?: string) =>
    out.push({ key: file ? `${role}--${file}` : role, role, file });

  // Issue fidelity needs a pull request to fetch, and the PR number is only in the
  // plan when the review resolved one locally. A cross-repo lightweight review does
  // run Agent 0 — it is pure GitHub API — but its plan does not carry the number,
  // so this cannot require it, and says so rather than pretending.
  if (mode === 'pr-worktree' && plan.prNumber !== undefined) add('0');

  if (isTerritoryFanOut(plan)) {
    // Step 3B: one agent per territory, plus the agents no territory can see. A
    // chunk agent owns every dimension *for its own lines*, so 1a and 2–6 do not
    // run as whole-diff agents here — but the test matrix does, because a chunk
    // agent sees either an implementation or its test, rarely both.
    const chunks = Array.isArray(plan.chunks) ? plan.chunks : [];
    for (const c of chunks) {
      if (Number.isSafeInteger(c?.id)) {
        out.push({
          key: `chunk-${c.id}`,
          role: 'chunk',
          chunk: c.id as number,
        });
      }
    }
    add('test-matrix');
  } else {
    // Step 3A: every dimension, each walking the whole diff.
    add('1a');
    add('2');
    add('3');
    add('4');
    add('5');
    add('6a');
    add('6b');
    add('6c');
  }

  // Both topologies. 1b owns the deleted side; 1c owns the cross-file walk and
  // needs a tree to grep.
  if (hasDeletions(plan)) add('1b');
  if (mode !== 'diff-only') {
    add('1c');
    add('7');
  }

  // A largely-rewritten file is not reviewable as a diff: the two ends of an
  // invariant sit two thousand lines apart. Three agents, one checklist slice each
  // — measured, one agent holding all eight checks found one of five defects and
  // the same model split three ways found all five.
  //
  // **Step 3B only.** `heavy` is decided independently of topology (`lib/heavy.ts`):
  // a 300-line source file with ~120 changed lines clears the rewrite-ratio branch
  // while `srcDiffLines` stays under 500 — a Step 3A review. Step 3A launches no
  // invariant agents (its dimension agents each walk the whole diff, so they
  // already see both ends of a file), and the skill's 3A section never mentions
  // them. Requiring them there demanded agents the review was never meant to launch,
  // and `check-coverage` then exit-3'd an otherwise-complete small PR. Gate the loop
  // on the topology that actually runs them.
  if (isTerritoryFanOut(plan)) {
    for (const file of heavyFiles(plan)) {
      add('invariant-a', file);
      add('invariant-b', file);
      add('invariant-c', file);
    }
  }

  return out;
}
