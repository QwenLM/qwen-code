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
import {
  blobPairs,
  changedPairs,
  readFileVerdicts,
} from './lib/file-verdicts.js';

export type { IncrementalScope } from './lib/report.js';

/** Exit codes the skill branches on. Named so the prose and the code agree. */
export const RESCOPE_EXIT_FULL_RANGE = 2;
export const RESCOPE_EXIT_NOTHING_NEW = 3;

interface RescopeArgs {
  plan: string;
  anchor: string;
  out?: string;
  maxChunkLines: number;
  cache?: string;
  model?: string;
}

/**
 * The verdict-transfer fallback: which files' `(base, head)` pairs moved
 * since the last clean round, judged from the promoted cache. Returns the
 * delta or the refusal reason — a refusal with an empty string means the
 * caller was never asked to try (`--cache` absent), so the message stays the
 * commit anchor's own.
 */
function verdictsDelta(
  args: RescopeArgs,
  worktreePath: string,
  mergeBaseSha: string,
  fetchedSha: string,
  allPaths: readonly string[],
): { delta: string[]; label: string } | { refusal: string } {
  if (!args.cache) return { refusal: '' };
  if (!args.model) {
    return { refusal: '--cache was given without --model' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.cache, 'utf8'));
  } catch {
    return { refusal: `the cache at ${args.cache} is missing or unreadable` };
  }
  // `JSON.parse('null')` succeeds; dereferencing it does not. A corrupted or
  // truncated promotion must land on the descriptive refusal, never on a
  // TypeError with an exit code the skill has no branch for.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { refusal: `the cache at ${args.cache} is not a JSON object` };
  }
  const cache = parsed as {
    lastModelId?: unknown;
    lastCommitSha?: unknown;
    fileVerdicts?: unknown;
  };
  if (cache.lastModelId !== args.model) {
    // The same-model contract, on the same terms as every other anchor gate.
    return {
      refusal: `the previous round was reviewed by ${
        typeof cache.lastModelId === 'string'
          ? cache.lastModelId
          : 'an unrecorded model'
      }, not ${args.model}`,
    };
  }
  const recorded = readFileVerdicts(cache.fileVerdicts);
  if (recorded === null) {
    return { refusal: 'the cache carries no usable fileVerdicts map' };
  }
  const current = blobPairs(worktreePath, mergeBaseSha, fetchedSha, allPaths);
  if (current === null) {
    return { refusal: 'the current blob pairs could not be listed' };
  }
  return {
    delta: changedPairs(recorded, current, allPaths),
    label:
      typeof cache.lastCommitSha === 'string' && cache.lastCommitSha !== ''
        ? cache.lastCommitSha
        : 'content-verdicts',
  };
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

/** Truncate only sha-shaped anchors: slicing `content-verdicts` to twelve
 *  characters printed `content-verd` in the summary and every brief. */
function displayAnchor(label: string): string {
  return /^[0-9a-f]{40,64}$/i.test(label) ? label.slice(0, 12) : label;
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
  const planFiles = planFilesRaw as Array<{
    path?: unknown;
    kind?: unknown;
    binary?: unknown;
  }>;
  const allPaths = planFiles
    .filter((f): f is { path: string } => !!f && typeof f?.path === 'string')
    .map((f) => f.path);

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
  const anchorUsable =
    anchorFull !== null &&
    gitOpt(
      '-C',
      worktreePath,
      'merge-base',
      '--is-ancestor',
      anchorFull,
      fetchedSha,
    ) !== null;

  // Interdiff names: which files changed since the anchor. `null` means the
  // anchor path is unavailable (rebase, force-push, unknown sha) — see
  // `IncrementalScope.deltaFiles` for why these are NAMES only, never hunks.
  let interdiffNames: string[] | null = null;
  if (anchorUsable) {
    if (anchorFull === fetchedSha) {
      interdiffNames = [];
    } else {
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
      interdiffNames = parseDiff(interdiff.toString('utf8')).files.map(
        (f) => f.path,
      );
    }
  }

  // Content verdicts are consulted on BOTH paths when the caller brought
  // them. On a live anchor they catch what the interdiff cannot see: an
  // upstream-moved merge base changes a file's diff-under-review without a
  // single new commit past the anchor, so "empty interdiff" alone must not
  // certify "nothing new". On a dead anchor they ARE the scope.
  const verdicts = verdictsDelta(
    args,
    worktreePath,
    mergeBaseSha,
    fetchedSha,
    allPaths,
  );

  let deltaFiles: string[];
  let anchorLabel: string;
  if (interdiffNames !== null) {
    const union = new Set(interdiffNames);
    if ('delta' in verdicts) for (const p of verdicts.delta) union.add(p);
    deltaFiles = [...union];
    anchorLabel = anchorFull as string;
    if (deltaFiles.length === 0) {
      fail(
        RESCOPE_EXIT_NOTHING_NEW,
        `rescope: ${args.anchor}..head is an empty diff` +
          ('delta' in verdicts
            ? ` and every (base, head) blob pair matches the last clean round` +
              ` — nothing new to review.`
            : ` — the tree is identical to the last clean round's.` +
              ('refusal' in verdicts && verdicts.refusal
                ? ` (content verdicts were not consulted: ${verdicts.refusal})`
                : '')),
      );
      return;
    }
  } else {
    const why =
      anchorFull === null
        ? `anchor ${args.anchor} is not a commit in this repository ` +
          `(rebased away, or from another history)`
        : `anchor ${args.anchor} is not an ancestor of the fetched head ` +
          `${fetchedSha} (force-push or rebase)`;
    if ('refusal' in verdicts) {
      fail(
        RESCOPE_EXIT_FULL_RANGE,
        `rescope: ${why}${
          verdicts.refusal
            ? `, and content verdicts cannot substitute — ${verdicts.refusal}`
            : ''
        }. Continue with the full-range plan.`,
      );
      return;
    }
    if (verdicts.delta.length === 0) {
      fail(
        RESCOPE_EXIT_NOTHING_NEW,
        `rescope: ${why}, but every file's (base, head) blob pair is ` +
          `identical to the pairs the last clean round certified — the ` +
          `change under review is unchanged despite the rewritten history.`,
      );
      return;
    }
    writeStderrLine(
      `rescope: ${why}; transferring content verdicts instead — ` +
        `${allPaths.length - verdicts.delta.length} of ${allPaths.length} ` +
        `file(s) carry an unchanged (base, head) pair from the last clean round.`,
    );
    deltaFiles = verdicts.delta;
    anchorLabel = verdicts.label;
  }
  const delta = new Set(deltaFiles);
  if (allPaths.every((p) => delta.has(p))) {
    // Nothing transfers; an "incremental" plan covering every file would be
    // a full review wearing the wrong label — let the full-range path own it.
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: every file in the plan changed since the anchor — there is ` +
        `nothing to scope out. Continue with the full-range plan.`,
    );
    return;
  }

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
    anchor: anchorLabel,
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
    `Incremental scope since ${displayAnchor(anchorLabel)}: ` +
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
      .option('cache', {
        type: 'string',
        describe:
          'The promoted review cache (.qwen/review-cache/pr-<n>.json). When ' +
          'the commit anchor is unusable (rebase), its fileVerdicts transfer ' +
          'per-file: files with an unchanged (base, head) blob pair stay out ' +
          'of scope.',
      })
      .option('model', {
        type: 'string',
        describe:
          'The model running this review. Required for --cache to take ' +
          'effect: verdicts transfer only under the model that certified them.',
      })
      .strict(),
  handler: (argv) => runRescope(argv as unknown as RescopeArgs),
};
