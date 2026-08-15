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
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import { fileLineCount, gitOpt, gitRaw } from './lib/git.js';
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
  displayAnchor,
  warnOnReportSize,
  stringifyPlanReport,
} from './lib/report.js';
import {
  dependentsOfChanged,
  discoverWorkspacePackages,
} from './lib/import-graph.js';
import type { IncrementalScope } from './lib/report.js';
import { inertText } from './lib/inert-text.js';
import {
  blobPairs,
  changedPairs,
  readFileVerdicts,
  type FileVerdicts,
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
    return {
      refusal: `the cache at ${inertText(args.cache)} is missing or unreadable`,
    };
  }
  // `JSON.parse('null')` succeeds; dereferencing it does not. A corrupted or
  // truncated promotion must land on the descriptive refusal, never on a
  // TypeError with an exit code the skill has no branch for.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      refusal: `the cache at ${inertText(args.cache)} is not a JSON object`,
    };
  }
  const cache = parsed as {
    lastModelId?: unknown;
    lastCommitSha?: unknown;
    fileVerdicts?: unknown;
  };
  if (cache.lastModelId !== args.model) {
    // The same-model contract, on the same terms as every other anchor gate.
    return {
      refusal: `the previous round was reviewed by ${inertText(
        typeof cache.lastModelId === 'string'
          ? cache.lastModelId
          : 'an unrecorded model',
        64,
      )}, not ${inertText(args.model, 64)}`,
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
      // Shape-checked, not merely non-empty: the label rides into the
      // summary line AND `plan.incremental.anchor`, which every brief
      // renders. A cache-written non-sha string has no business there.
      typeof cache.lastCommitSha === 'string' &&
      /^[0-9a-f]{7,64}$/i.test(cache.lastCommitSha)
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
  diffPathAbsolute?: unknown;
  files?: unknown;
  incremental?: unknown;
  cacheCandidatePath?: unknown;
}

/**
 * After a successful rescope, narrow the fetched cache candidate to what
 * this round can actually certify. `fetch-pr` recorded `(base, head)` pairs
 * for the FULL plan at capture time; a rescoped round reviews only
 * delta ∪ interaction, and promoting the untouched candidate wholesale would
 * certify pairs for files nobody read — most sharply when the merge base
 * moved under a scoped-out file while the verdicts that would have caught it
 * were unavailable (the fresh-environment case). The rewrite keeps: current
 * pairs for every DELTA file (reviewed in full this round), and current
 * pairs for any other file ONLY when the previous cache — under the same model — already
 * certified that exact pair. Everything else is dropped, which downstream
 * reads as "changed" and re-reviews: the safe direction.
 *
 * Never fail-open: the return value is what the caller writes into the plan
 * (`false` strips `cacheCandidatePath`, so Step 8 finds nothing to promote
 * and falls back to the hand-written template), and an unusable candidate
 * file is removed outright. A warning alone was not enough — nothing in
 * Step 8 reads warnings.
 */
function rewriteCandidateForScope(
  plan: FetchedPlan & { cacheCandidatePath?: unknown },
  args: RescopeArgs,
  worktreePath: string,
  mergeBaseSha: string,
  fetchedSha: string,
  allPaths: readonly string[],
  delta: ReadonlySet<string>,
): boolean {
  const candidatePath = plan.cacheCandidatePath;
  if (typeof candidatePath !== 'string' || candidatePath === '') return false;
  let candidate: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(candidatePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('not a JSON object');
    candidate = parsed as Record<string, unknown>;
  } catch (err) {
    writeStderrLine(
      `rescope: could not read the cache candidate to narrow it ` +
        `(${inertText((err as Error).message)}) — it is removed so nothing ` +
        `can promote pairs from it.`,
    );
    dropCandidate(candidatePath);
    return false;
  }
  const current = blobPairs(worktreePath, mergeBaseSha, fetchedSha, allPaths);
  // Recorded pairs carry forward only under the same-model contract that
  // admitted them in the first place.
  let recorded: FileVerdicts | null = null;
  if (args.cache && args.model) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(args.cache, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as { lastModelId?: unknown }).lastModelId === args.model
      ) {
        recorded = readFileVerdicts(
          (parsed as { fileVerdicts?: unknown }).fileVerdicts,
        );
      }
    } catch {
      recorded = null;
    }
  }
  if (current === null) {
    delete candidate['fileVerdicts'];
    writeStderrLine(
      `rescope: current blob pairs could not be listed — the candidate's ` +
        `fileVerdicts are stripped so an unverifiable pair cannot be promoted.`,
    );
  } else {
    const next: FileVerdicts = Object.create(null) as FileVerdicts;
    let carried = 0;
    for (const p of allPaths) {
      if (delta.has(p)) {
        // Reviewed in FULL this round: its pair is certified.
        next[p] = current[p];
      } else if (
        recorded !== null &&
        Object.hasOwn(recorded, p) &&
        recorded[p].base === current[p].base &&
        recorded[p].head === current[p].head
      ) {
        next[p] = current[p];
        carried++;
      }
      // else: omitted — no round certified this pair; absence reads as
      // changed next time, and the file is simply re-reviewed.
    }
    candidate['fileVerdicts'] = next;
    const dropped = allPaths.length - Object.keys(next).length;
    if (dropped > 0 || carried > 0) {
      writeStderrLine(
        `rescope: cache candidate narrowed to this round's scope — ` +
          `${[...delta].filter((p) => allPaths.includes(p)).length} ` +
          `reviewed pair(s) kept, ${carried} carried from the previous ` +
          `clean round, ${dropped} dropped as certified by no one.`,
      );
    }
  }
  try {
    atomicWriteFileSync(candidatePath, JSON.stringify(candidate, null, 2));
  } catch (err) {
    writeStderrLine(
      `rescope: could not rewrite the cache candidate ` +
        `(${inertText((err as Error).message)}) — it is removed so nothing ` +
        `can promote the un-narrowed pairs.`,
    );
    dropCandidate(candidatePath);
    return false;
  }
  return true;
}

/** Remove a candidate nothing may promote from. Best-effort; the caller
 *  additionally strips `cacheCandidatePath` from the plan it writes. */
function dropCandidate(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The plan-side strip below is the load-bearing half.
  }
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
    if ('refusal' in verdicts && verdicts.refusal) {
      // The exit-2/exit-3 branches surface their verdicts state; the success
      // path must too, or a silently-bare interdiff union is
      // indistinguishable from a checked one.
      writeStderrLine(
        `rescope: content verdicts not consulted (${verdicts.refusal}) — ` +
          `scoping by the interdiff alone.`,
      );
    }
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

  // The mislabel gate tests DELTA coverage, deliberately not delta ∪
  // interaction: an interaction file is seam-only scope — its brief forbids
  // a from-scratch re-review — so a plan whose remainder is all interaction
  // still saves real work and is honestly incremental. Only when every plan
  // file is DELTA (owed a full review) is the "incremental" label a lie.
  const scoped = new Set([...delta, ...interaction.keys()]);
  if (allPaths.every((p) => delta.has(p))) {
    fail(
      RESCOPE_EXIT_FULL_RANGE,
      `rescope: every file in the plan changed since the anchor — there is ` +
        `nothing to scope out. Continue with the full-range plan.`,
    );
    return;
  }

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
    anchor: anchorLabel,
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
  // Narrow the fetched candidate BEFORE the plan is written: the plan must
  // carry `cacheCandidatePath` only when a candidate Step 8 may promote
  // actually survives on disk.
  const candidateUsable = rewriteCandidateForScope(
    plan,
    args,
    worktreePath,
    mergeBaseSha,
    fetchedSha,
    allPaths,
    delta,
  );
  const result = {
    ...(plan as Record<string, unknown>),
    diffPath: diffRel,
    diffPathAbsolute: resolve(diffRel),
    // `-C`-pinned like every other git call here: an unpinned `git show`
    // resolves `<ref>:<path>` against the process cwd's repository.
    ...buildPlanReport(diffPlan, (path) =>
      fileLineCount(fetchedSha, path, worktreePath),
    ),
    incremental,
  } as Record<string, unknown>;
  if (!candidateUsable) delete result['cacheCandidatePath'];

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
    `Incremental scope since ${displayAnchor(anchorLabel)}: ` +
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
      .option('cache', {
        type: 'string',
        describe:
          'The promoted review cache (.qwen/review-cache/pr-<n>.json). Its ' +
          'fileVerdicts are consulted on BOTH anchor paths: unioned with the ' +
          'interdiff while the commit anchor lives (a moved merge base ' +
          'changes a diff with zero new commits), and carrying the scope ' +
          'alone when a rebase killed it. Unchanged (base, head) pairs stay ' +
          'out of scope.',
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
