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

import type { RepositoryContextRoleId, RoleId } from './agent-briefs.js';
import { repositoryContextOf } from './repository-context.js';
import { pathTool } from '../script-lint.js';
// The topology gate lives in `budget.ts` — it is a size ruling, and the round
// cap needs the same one. Re-exported here because this file was its home and
// the roster is where a reader looks for "which fan-out was owed".
export { isTerritoryFanOut } from './budget.js';
import { isTerritoryFanOut } from './budget.js';

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
  ownerRepo?: unknown;
  chunks?: Array<{ id?: unknown }>;
  files?: Array<{
    path?: unknown;
    kind?: unknown;
    heavy?: unknown;
    addedLines?: unknown;
    removedLines?: unknown;
    /** Lines in the post-change file; 0 for a true deletion (see report.ts). */
    fileLines?: unknown;
  }>;
  srcDiffLines?: unknown;
  diffLines?: unknown;
  worktreePath?: unknown;
  prNumber?: unknown;
  untrackedFiles?: unknown;
  /**
   * The wrapper-vocabulary signal the capturing command computed from the diff
   * (diff-plan.ts). Gates Agent 1e; the gate fails safe (see `hasWrapperTypes`).
   */
  wrapperSignal?: unknown;
  /**
   * The review's effort, as the capturing command recorded it (`--effort`).
   * `'medium'` is the balanced tier and drops the adversarial personas
   * (6a/6b/6c) and the language-pitfall and wrapper/proxy specialists (1d/1e);
   * anything else — including absent — keeps the full roster. It lives in the plan, not in
   * a caller argument, on purpose: the roster this file computes must not be
   * shrinkable by whoever calls `requiredAgents`, or the shrink is what gets
   * called. `check-coverage`, `agent-prompt --roster` and `compose-review`'s
   * recomputation then all read the same value and cannot disagree.
   */
  effort?: unknown;
  repositoryContext?: unknown;
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

/** Does the diff remove or replace anything? If not, 1b has nothing to audit. */
function hasDeletions(plan: RosterPlan): boolean {
  const files = Array.isArray(plan.files) ? plan.files : [];
  // No `files[]` at all is not "no deletions" — it is "we do not know", and the
  // safe answer to that is to run the audit. An agent with nothing to find costs
  // one return; a removed guard nobody looked for costs whatever it was guarding.
  if (files.length === 0) return true;
  return files.some((f) => Number(f?.removedLines ?? 0) > 0);
}

/**
 * Does the diff signal a wrapping type — the gate for Agent 1e.
 *
 * Only an EXPLICIT `wrapperSignal: false` answers no. The signal is a cheap
 * vocabulary heuristic computed at capture time (diff-plan.ts) with imperfect
 * recall, and since this change also removes the wrapper-routing clause from
 * Agent 1a, a miss here would leave the class owned by nobody — so everything
 * but the one value a current capture command writes is "run the check": an
 * absent field (a plan an older CLI wrote — the version skew this skill has
 * already measured once), `true`, or junk. Same asymmetry as `hasDeletions`:
 * an agent with nothing to find costs one return; a wrapper that re-enters
 * itself costs whatever it wraps.
 */
function hasWrapperTypes(plan: RosterPlan): boolean {
  return plan.wrapperSignal !== false;
}

/** A PR number the plan actually resolved: a positive integer, as a number or the
 *  string `fetch-pr` writes. `null`, `0`, `''` and non-numeric junk are 'no PR'. */
export function isPositivePrNumber(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  if (typeof value === 'string')
    return /^\d+$/.test(value) && Number(value) > 0;
  return false;
}

/**
 * Does the diff touch a file a linter owns by path — a shell script, a workflow,
 * a Dockerfile? Detected by path alone (`pathTool`), the same detector the command
 * uses, because here only the plan's file paths are in hand, not the files. A
 * shebang-only extensionless script does not trip this — the roster cannot read it.
 *
 * `compose-review`'s deterministic script-lint gate reads this to decide whether a
 * script-lint report was OWED — a diff that carries such a file but produced no
 * report fails closed to unreviewed. It is the one predicate both the orchestrator's
 * `qwen review script-lint` step and the gate that checks its output share, so they
 * cannot disagree about what counts as an executable script.
 */
export function hasExecutableScript(plan: RosterPlan): boolean {
  const files = Array.isArray(plan.files) ? plan.files : [];
  // `fileLines` distinguishes a TRUE deletion (0, no post-image, exempt) from a
  // surviving file (>0, still owed) ONLY in pr-worktree, where the report resolves
  // real post-image line counts. In local/diff-only NO post-image is available and
  // the report builder writes `fileLines: 0` for EVERY file — there 0 means
  // "unknown", not "deleted", so keying on it would read a surviving `deploy.sh` as
  // deleted and let a missing script-lint report pass uncapped. Trust it only where
  // it is real; elsewhere fail safe and owe any path-detected script.
  const trustsFileLines = reviewMode(plan) === 'pr-worktree';
  return files.some((f) => {
    if (typeof f?.path !== 'string' || pathTool(f.path) === null) return false;
    if (!trustsFileLines) return true;
    return Number(f.fileLines ?? 1) > 0;
  });
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
  // A positive PR number, not merely `!== undefined`: a plan carrying
  // `prNumber: null`, `0` or `''` is 'no PR resolved', and requiring Agent 0 for
  // it would block a review over an issue agent that had nothing to fetch.
  // `fetch-pr` writes the number as a STRING (`"6766"`), so accept a numeric
  // string as well as a number — checking `typeof === 'number'` alone would drop
  // Agent 0 from every real PR review.
  // Any mode, not just pr-worktree: a lightweight cross-repo plan now carries
  // the PR identity too (plan-diff --pr/--repo, passed only when pr-context
  // succeeded), and a review that fetched the PR's context owes the
  // issue-fidelity pass regardless of whether it has a worktree. Both halves of
  // the identity, because the brief builder needs both — requiring an agent
  // nobody could build would wedge the run.
  if (isPositivePrNumber(plan.prNumber) && typeof plan.ownerRepo === 'string') {
    add('0');
  }

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
    // Code quality is three checklist slices, not one agent (see agent-briefs).
    // All three are required at every effort: the split exists because a single
    // agent holding the whole list finishes one item, so dropping two slices at
    // medium would not save a lens — it would restore the failure the split fixed.
    add('3a');
    add('3b');
    add('3c');
    add('4');
    add('5');
    // The three adversarial personas are a high-effort dimension. A `medium`
    // (balanced) review deliberately skips them, so they must not be *required*
    // either — otherwise `check-coverage` flags them missing and exits 3, and a
    // medium review of every small (3A) diff halts before Step 4. Only high
    // requires them. The effort is read from the plan the capturing command
    // wrote, never from a caller argument (see `RosterPlan.effort`).
    if (plan.effort !== 'medium') {
      add('6a');
      add('6b');
      add('6c');
      // The two checks promoted out of Agent 1a's line-by-line brief (#9788):
      // a checklist pattern-match and a structural routing expectation are
      // different attention modes from the walk, and folded into it they were
      // diluted by its rhythm. 1d always runs at high; 1e runs when the diff
      // signals a wrapping type — fail-safe, see `hasWrapperTypes`.
      add('1d');
      if (hasWrapperTypes(plan)) add('1e');
    }
  }

  // Both topologies. 1b owns the deleted side; 1c owns the cross-file walk and
  // needs a tree to grep.
  if (hasDeletions(plan)) add('1b');
  if (mode !== 'diff-only') {
    add('1c');
    add('7');
    // The executable-script lint is NOT an agent: the orchestrator runs
    // `qwen review script-lint` deterministically and `compose-review` reads its
    // report as the sole authority (see hasExecutableScript). There is no role to
    // require here — the gate enforces itself from the report, model out of the loop.
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
  // A heavy INTERACTION file keeps its invariant agents, even though its
  // chunk agent is briefed for the seam only.
  //
  // Skipping them was tempting and wrong. The premise was that an interaction
  // file's full-range slice is code the previous round already cleared — true
  // only while the MERGE BASE holds still between rounds, and nothing
  // enforces that. The anchor gate validates `--since` against head history;
  // neither the round cache nor the posted ledger carries a base identity, so
  // a BACKWARD base move — the author retargets the PR to an older base, an
  // ordinary GitHub operation — is accepted. `newBase..anchor` then carries
  // hunks no round has read, they arrive inside a heavy interaction file's
  // full-range slice, and these three agents are the only ones that would
  // have walked them. A clean verdict re-anchors past them for good.
  //
  // So the skip is off until the anchor can prove base continuity. It costs
  // three agents on a rare shape — heavy, unchanged since the anchor, and
  // importing something that moved — and it buys back the one direction this
  // whole design refuses to lose in.
  if (isTerritoryFanOut(plan)) {
    for (const file of heavyFiles(plan)) {
      add('invariant-a', file);
      add('invariant-b', file);
      add('invariant-c', file);
    }
  }

  const repositoryContext = repositoryContextOf(plan);
  for (const role of repositoryContext?.requiredAgents ?? []) {
    if (!contextRoleRunsInThisReview(role, plan, mode)) continue;
    if (!out.some((agent) => agent.role === role && agent.file === undefined)) {
      add(role);
    }
  }

  return out;
}

/**
 * A repository context may REQUIRE an agent this review's policy already runs;
 * it may not override the policy. The effort gate, the topology split, and the
 * mode are cost and capability decisions the roster owns — a manifest naming a
 * role they exclude would otherwise silently inflate a medium review with the
 * adversarial personas, re-add whole-diff walkers to a chunked 3B fan-out, or
 * demand a tree-grepping tracer from a review that has no tree.
 */
function contextRoleRunsInThisReview(
  role: RepositoryContextRoleId,
  plan: RosterPlan,
  mode: ReviewMode,
): boolean {
  const fanOut = isTerritoryFanOut(plan);
  switch (role) {
    case '6a':
    case '6b':
    case '6c':
      return !fanOut && plan.effort !== 'medium';
    case 'test-matrix':
      return fanOut;
    case '1c':
      return mode !== 'diff-only';
    case '1b':
      // Both topologies run the removed-behavior audit; whether it has work is
      // the diff's business (hasDeletions), not the policy's.
      return true;
    default:
      // Whole-diff dimension walkers exist only in Step 3A; a 3B chunk agent
      // already owns every dimension for its own lines.
      return !fanOut;
  }
}
