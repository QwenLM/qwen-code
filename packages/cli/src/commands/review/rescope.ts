/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review rescope`: shrink a fetched PR plan to the incremental range
// since a previous clean round's anchor, widened by one import hop.
//
// Incremental review existed only as prose: Step 1 told the orchestrator to
// "compute `git diff <lastCommitSha>..HEAD` and use it as the review scope",
// and the mechanics were left to improvisation. The improvised route — re-run
// `plan-diff` over a hand-captured interdiff — silently degrades the plan: a
// `plan-diff` plan has no `worktreePath`, no `prNumber`/`ownerRepo` unless
// re-supplied, no per-file line counts and so no `heavy` classification, which
// drops Agent 0, the modeled-system lens and every invariant agent from the
// roster with nothing to say so. This command produces the incremental plan
// the right way round: same builders as `fetch-pr`, identity fields carried
// over, post-image line counts from the fetched head.
//
// It also WIDENS the range. The previous round's "clean" was certified against
// the code as it stood then; the fix under review now can change a contract an
// unchanged file depends on. Every still-clean source file that imports a
// changed file re-enters the scope with its full-range diff, and the plan
// records why (`incremental.interaction[]`), so its chunk brief can direct the
// agent at the seam instead of a from-scratch re-review.
//
// Failure is directional ON PURPOSE. Exit 2 means "could not scope" — the
// caller falls back to the FULL diff, never to a skip: the plan file is left
// untouched, so the fetched full-range plan simply remains the plan of record.
// Exit 3 means "the interdiff is empty" — the anchor state and the head state
// are identical trees, the same outcome as the same-SHA shortcut. Only exit 0
// rewrites the plan, atomically.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import { fileLineCount, gitOpt, gitRaw } from './lib/git.js';
import {
  LITERAL_PATHSPECS,
  PINNED_DIFF_CONFIG,
  PINNED_DIFF_FLAGS,
} from './lib/diff-flags.js';
import {
  buildDiffPlan,
  parseDiff,
  DEFAULT_MAX_CHUNK_LINES,
  READ_FILE_CHAR_CAP,
} from './lib/diff-plan.js';
import {
  buildPlanReport,
  warnOnReportSize,
  stringifyPlanReport,
} from './lib/report.js';
import {
  dependentsOfChanged,
  discoverWorkspacePackages,
} from './lib/import-graph.js';
import type { IncrementalScope } from './lib/report.js';

export type { IncrementalScope } from './lib/report.js';

/** Exit codes the skill branches on. Named so the prose and the code agree. */
export const RESCOPE_EXIT_FULL_RANGE = 2;
export const RESCOPE_EXIT_NOTHING_NEW = 3;

interface RescopeArgs {
  plan: string;
  anchor: string;
  out?: string;
  maxChunkLines: number;
}

/** The fields rescope reads off the fetched plan. Parsed off disk — guard everything. */
interface FetchedPlan {
  prNumber?: unknown;
  worktreePath?: unknown;
  fetchedSha?: unknown;
  mergeBaseSha?: unknown;
  diffPath?: unknown;
  files?: unknown;
  incremental?: unknown;
}

function fail(code: number, message: string): void {
  writeStderrLine(message);
  process.exitCode = code;
}

function runRescope(args: RescopeArgs): void {
  let plan: FetchedPlan;
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8')) as FetchedPlan;
  } catch (err) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: cannot read plan ${args.plan}: ${(err as Error).message}. ` +
        `Continue with the full-range plan.`,
    );
    return;
  }

  const worktreePath =
    typeof plan.worktreePath === 'string' ? plan.worktreePath : null;
  const fetchedSha =
    typeof plan.fetchedSha === 'string' ? plan.fetchedSha : null;
  const mergeBaseSha =
    typeof plan.mergeBaseSha === 'string' ? plan.mergeBaseSha : null;
  if (!worktreePath || !fetchedSha || !mergeBaseSha) {
    // Local and lightweight plans have no worktree and no fetched range —
    // there is nothing to scope an anchor against.
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      'rescope: the plan carries no worktreePath/fetchedSha/mergeBaseSha — ' +
        'incremental rescoping serves the fetched-PR flow only. ' +
        'Continue with the full-range plan.',
    );
    return;
  }
  if (typeof plan.incremental === 'object' && plan.incremental !== null) {
    // A second rescope of an already-rescoped plan would derive candidates
    // from the already-shrunk file list (files widened out in round N can
    // never re-enter) and repoint `fullDiffPath` at the incremental diff it
    // is about to overwrite. The plan of record for a rescope is always a
    // fresh fetch.
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      'rescope: the plan is already rescoped — re-run fetch-pr to restore ' +
        'the full-range plan first. Continue with the full-range review.',
    );
    return;
  }
  // `plan.files` is the candidate universe for the widening AND the proof the
  // fetch captured anything at all. Normalising a malformed list to [] would
  // silently drop every interaction candidate and still exit 0 — a truncated
  // plan must keep the safe full review instead.
  const planFilesRaw = plan.files;
  if (!Array.isArray(planFilesRaw) || planFilesRaw.length === 0) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      'rescope: the plan carries no usable `files[]` (missing, malformed, or ' +
        'empty) — cannot widen safely. Continue with the full-range plan.',
    );
    return;
  }

  // Anchor validation is re-done HERE, not trusted from the caller: a sha that
  // is not in this history would hand `git diff` a range that reviews the
  // wrong code, which is the one failure mode this feature must never have.
  // Every git call is pinned to the plan's worktree with `-C`: pathspecs
  // resolve against git's cwd, and from a subdirectory an unmatched pathspec
  // exits 0 with EMPTY output — hunks silently vanish instead of failing.
  const anchorFull = gitOpt(
    '-C',
    worktreePath,
    'rev-parse',
    `${args.anchor}^{commit}`,
  );
  if (anchorFull === null) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: anchor ${args.anchor} is not a commit in this repository ` +
        `(rebased away, or from another history). Continue with the ` +
        `full-range plan.`,
    );
    return;
  }
  if (anchorFull === fetchedSha) {
    fail(
      RESCOPE_EXIT_NOTHING_NEW,
      `rescope: anchor ${args.anchor} IS the fetched head — no new commits ` +
        `since the last clean round.`,
    );
    return;
  }
  if (
    gitOpt(
      '-C',
      worktreePath,
      'merge-base',
      '--is-ancestor',
      anchorFull,
      fetchedSha,
    ) === null
  ) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: anchor ${args.anchor} is not an ancestor of the fetched head ` +
        `${fetchedSha} (force-push or rebase). Continue with the full-range ` +
        `plan.`,
    );
    return;
  }

  // The interdiff decides only WHICH files changed since the anchor — see
  // `IncrementalScope.deltaFiles` for why their hunks are captured full-range
  // instead of from this diff.
  let interdiff: Buffer;
  try {
    interdiff = gitRaw(
      '-C',
      worktreePath,
      ...PINNED_DIFF_CONFIG,
      'diff',
      ...PINNED_DIFF_FLAGS,
      `${anchorFull}..${fetchedSha}`,
    );
  } catch (err) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: could not capture ${args.anchor}..head: ` +
        `${(err as Error).message}. Continue with the full-range plan.`,
    );
    return;
  }
  const deltaFiles = parseDiff(interdiff.toString('utf8')).files.map(
    (f) => f.path,
  );
  if (deltaFiles.length === 0) {
    fail(
      RESCOPE_EXIT_NOTHING_NEW,
      `rescope: ${args.anchor}..head is an empty diff — the tree is ` +
        `identical to the last clean round's.`,
    );
    return;
  }
  const delta = new Set(deltaFiles);

  // One import hop over the plan's still-clean SOURCE files. Test and docs
  // dependents stay out: re-running tests is `build-test`'s job, and prose
  // does not call functions. Reads come from the worktree — the post-change
  // state is the state whose interactions are in question.
  const planFiles = planFilesRaw as Array<{
    path?: unknown;
    kind?: unknown;
    binary?: unknown;
  }>;
  const candidates = planFiles
    .filter(
      (f): f is { path: string; kind: string; binary?: boolean } =>
        !!f &&
        typeof f.path === 'string' &&
        f.kind === 'source' &&
        f.binary !== true &&
        !delta.has(f.path),
    )
    .map((f) => f.path);
  const readWorktree = (rel: string): string | null => {
    try {
      return readFileSync(join(worktreePath, rel), 'utf8');
    } catch {
      return null;
    }
  };
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

  // ONE capture, full-range, scoped to delta ∪ interaction: every hunk in
  // the composite is a hunk of the PR's own diff, so downstream comment
  // anchoring can never produce a line GitHub refuses.
  let composite: Buffer;
  try {
    composite = gitRaw(
      '-C',
      worktreePath,
      LITERAL_PATHSPECS,
      ...PINNED_DIFF_CONFIG,
      'diff',
      ...PINNED_DIFF_FLAGS,
      `${mergeBaseSha}..${fetchedSha}`,
      '--',
      ...deltaFiles,
      ...interaction.keys(),
    );
  } catch (err) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: could not capture the scoped files' diff: ` +
        `${(err as Error).message}. Continue with the full-range plan.`,
    );
    return;
  }
  let diffPlan;
  try {
    diffPlan = buildDiffPlan(composite.toString('utf8'), args.maxChunkLines);
  } catch (err) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: could not partition the incremental diff ` +
        `(${(err as Error).message}). Continue with the full-range plan.`,
    );
    return;
  }

  const target =
    typeof plan.prNumber === 'string' || typeof plan.prNumber === 'number'
      ? `pr-${plan.prNumber}`
      : 'rescope';
  const diffRel = tmpFile(target, 'diff-incremental.txt');
  const incremental: IncrementalScope = {
    anchor: anchorFull,
    deltaFiles,
    interaction: [...interaction.entries()].map(([path, importsChanged]) => ({
      path,
      importsChanged,
    })),
    contextFileCount: candidates.filter((p) => !interaction.has(p)).length,
    fullDiffPath: typeof plan.diffPath === 'string' ? plan.diffPath : null,
  };

  // The rescoped plan is the fetched plan with its diff swapped: identity and
  // provenance fields ride through the spread untouched (worktreePath,
  // prNumber, ownerRepo, shas, repositoryContext when repo-context already
  // ran, effort), while everything the diff determines — chunks, files,
  // topology counts, budget — is recomputed from the incremental diff by the
  // SAME builders `fetch-pr` used, post-image line counts included, so the
  // heaviness classification and the roster it drives cannot drift from what
  // a full-range plan of this diff would have said.
  const result = {
    ...(plan as Record<string, unknown>),
    diffPath: diffRel,
    diffPathAbsolute: resolve(diffRel),
    ...buildPlanReport(diffPlan, (path) => fileLineCount(fetchedSha, path)),
    incremental,
  };

  mkdirSync(REVIEW_TMP_DIR, { recursive: true });
  atomicWriteFileSync(diffRel, composite);
  const out = args.out ?? args.plan;
  atomicWriteFileSync(out, stringifyPlanReport(result));
  writeStdoutLine(`Wrote incremental plan to ${out}`);
  writeStderrLine(
    `Incremental scope since ${anchorFull.slice(0, 12)}: ` +
      `${deltaFiles.length} changed file(s), ${interaction.size} ` +
      `interaction file(s) (one import hop), ` +
      `${incremental.contextFileCount} clean file(s) left out of scope; ` +
      `${diffPlan.diffLines} diff line(s) -> ${diffPlan.chunks.length} chunk(s).`,
  );
  warnOnReportSize(out, READ_FILE_CHAR_CAP);
}

export const rescopeCommand: CommandModule = {
  command: 'rescope',
  describe:
    'Rescope a fetched PR plan to the incremental diff since a previous ' +
    'clean round, widened by one import hop',
  builder: (y) =>
    y
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'The fetch-pr plan report to rescope',
      })
      .option('anchor', {
        type: 'string',
        demandOption: true,
        describe: "The previous clean round's reviewed head sha",
      })
      .option('out', {
        type: 'string',
        describe: 'Where to write the rescoped plan (default: in place)',
      })
      .option('max-chunk-lines', {
        type: 'number',
        default: DEFAULT_MAX_CHUNK_LINES,
        describe: 'Target chunk size in diff lines',
      })
      .strict(),
  handler: (argv) => runRescope(argv as unknown as RescopeArgs),
};
