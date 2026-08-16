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
// Exit 3 means "nothing new to review": the interdiff is empty (the anchor's
// tree and the head's are identical, the same outcome as the same-SHA
// shortcut), or every file it named turned out to be restored to its
// merge-base state and so carries no section of the PR's own diff. Only
// exit 0 rewrites the plan, atomically.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import { fileLineCount, gitOpt, gitRaw } from './lib/git.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import { hasReviewDeadline } from './lib/deadline.js';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from './lib/diff-flags.js';
import {
  buildDiffPlan,
  parseDiff,
  sliceDiffByLines,
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
  diffPathAbsolute?: unknown;
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
    const parsed: unknown = JSON.parse(readFileSync(args.plan, 'utf8'));
    // `JSON.parse('null')` succeeds; dereferencing it does not. A truncated
    // or clobbered plan must land on the refusal, not on a TypeError with an
    // exit code the skill has no branch for.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('the plan is not a JSON object');
    }
    plan = parsed as FetchedPlan;
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
  const planFiles = planFilesRaw as Array<{
    path?: unknown;
    kind?: unknown;
    binary?: unknown;
  }>;
  const allPaths = planFiles
    .filter((f): f is { path: string } => !!f && typeof f?.path === 'string')
    .map((f) => f.path);
  if (allPaths.length === 0) {
    // A NON-EMPTY files[] whose entries carry no usable path is the same
    // truncated-plan shape as an empty one — and worse downstream, where
    // "zero files compared" must never read as "nothing changed".
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      "rescope: the plan's `files[]` has no entry with a usable path — " +
        'cannot widen safely. Continue with the full-range plan.',
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

  // The composite is a BYTE-SLICE of the fetched full-range diff, not a
  // pathspec-scoped re-capture. Two invariants ride on that: every hunk is
  // byte-identical to a hunk of the PR's own diff (comment anchoring can
  // never produce a line GitHub refuses), and RENAME sections stay paired —
  // a pathspec-scoped `git diff` cannot see the rename source, un-pairs the
  // rename, and renders the file as a whole-file add whose hunks exist
  // nowhere in the original diff.
  const origDiffPath =
    typeof plan.diffPathAbsolute === 'string'
      ? plan.diffPathAbsolute
      : typeof plan.diffPath === 'string'
        ? resolve(plan.diffPath)
        : null;
  let origDiff: Buffer;
  try {
    if (origDiffPath === null) throw new Error('the plan names no diff file');
    origDiff = readFileSync(origDiffPath);
  } catch (err) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: cannot read the fetched diff (${(err as Error).message}). ` +
        `Continue with the full-range plan.`,
    );
    return;
  }
  const scoped = new Set([...delta, ...interaction.keys()]);
  const sections = parseDiff(origDiff.toString('utf8')).files.filter((f) =>
    scoped.has(f.path),
  );
  const composite = sliceDiffByLines(
    origDiff,
    sections.map((f) => ({ startLine: f.diffStart, endLine: f.diffEnd })),
  );
  // Reconcile the reported delta with what the composite actually holds: a
  // file restored to its merge-base state is in the interdiff but has no
  // hunks here, and a plan naming delta files with zero hunks sends agents
  // hunting for scope that does not exist. (The WIDENING above still used
  // the full changed set — a restoration still moves its importers' seams.)
  const sectionPaths = new Set(sections.map((f) => f.path));
  const unmatched = deltaFiles.filter((p) => !sectionPaths.has(p));
  // A delta file with no section of the PR's own diff is one of two things,
  // and only one of them is safe to drop. A RESTORATION (the fix round put
  // the file back to its merge-base content) genuinely has nothing left to
  // review. A LINEAGE MISMATCH does not: a file renamed before the anchor
  // and deleted in the fix round is `new.ts` in the interdiff but `old.ts`
  // in the PR diff (parseDiff labels a deletion with its left-side path),
  // so the section carrying its unreviewed hunks is scoped out under a name
  // nothing matched. Distinguishing them is one cheap probe per unmatched
  // file: identical blobs on both sides of the PR range means restored.
  const restored = (p: string): boolean => {
    const at = (ref: string) =>
      gitOpt('-C', worktreePath, 'rev-parse', `${ref}:${p}`);
    const b = at(mergeBaseSha);
    const h = at(fetchedSha);
    // Absent on BOTH sides is deliberately NOT droppable. Two shapes produce
    // it and this layer cannot tell them apart: a file the PR added and this
    // round deleted (net-zero — safe to drop), and a file renamed before the
    // anchor and deleted now, whose unreviewed deletion hunks sit in the PR
    // diff under its pre-rename name (dropping it loses them). Refusing
    // costs a full review on the first shape; dropping loses scope on the
    // second, so the refusal wins.
    return b !== null && h !== null && b === h;
  };
  const lineageLost = unmatched.filter((p) => !restored(p));
  if (lineageLost.length > 0) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: ${lineageLost.length} file(s) changed since ${args.anchor} ` +
        `carry no section of the PR's own diff under that name ` +
        `(${lineageLost.slice(0, 3).join(', ')}${lineageLost.length > 3 ? ', …' : ''}) ` +
        `— a rename or lineage change the scoped slice cannot follow. ` +
        `Continue with the full-range plan.`,
    );
    return;
  }
  if (sections.length === 0) {
    // Changed since the anchor, but present in no section of the PR's own
    // diff — every delta file was restored to its merge-base state. There
    // is nothing of the PR left to re-review.
    fail(
      RESCOPE_EXIT_NOTHING_NEW,
      `rescope: the files changed since ${args.anchor} carry no section of ` +
        `the PR's own diff (restored to the merge-base state) — nothing new ` +
        `to review.`,
    );
    return;
  }
  const deltaReported = deltaFiles.filter((p) => sectionPaths.has(p));
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
    deltaFiles: deltaReported,
    interaction: [...interaction.entries()].map(([path, importsChanged]) => ({
      path,
      importsChanged,
    })),
    contextFileCount: candidates.filter((p) => !interaction.has(p)).length,
    // Absolute: the field's whole job is to let a later step reach the
    // superseded diff, and that step need not share this command's cwd.
    fullDiffPath: origDiffPath,
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
    // `-C`-pinned like every other git call here: an unpinned `git show`
    // resolves `<ref>:<path>` against the process cwd's repository.
    ...buildPlanReport(
      diffPlan,
      (path) => fileLineCount(fetchedSha, path, worktreePath),
      {
        operatorRoundCap: operatorReviewSettings().reverseAuditRounds,
        hasDeadline: hasReviewDeadline(process.env),
      },
    ),
    incremental,
  };

  const out = args.out ?? args.plan;
  try {
    mkdirSync(REVIEW_TMP_DIR, { recursive: true });
    atomicWriteFileSync(diffRel, composite);
    mkdirSync(dirname(resolve(out)), { recursive: true });
    atomicWriteFileSync(out, stringifyPlanReport(result));
  } catch (err) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: could not write the rescoped plan (${(err as Error).message}). ` +
        `Continue with the full-range plan.`,
    );
    return;
  }
  writeStdoutLine(`Wrote incremental plan to ${out}`);
  writeStderrLine(
    `Incremental scope since ${anchorFull.slice(0, 12)}: ` +
      `${deltaReported.length} changed file(s), ${interaction.size} ` +
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
