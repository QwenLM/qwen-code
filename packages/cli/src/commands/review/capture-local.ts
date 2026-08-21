/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review capture-local`: capture the working tree's diff — staged,
// unstaged, and untracked — and partition it into review chunks, in one pass.
// The local counterpart of `fetch-pr`.
//
// This used to be a `git diff` command line typed out in the skill prompt, with
// ten flags to pin and a redirect to dodge Shell model-output truncation. Two things
// were wrong with that. The flags drifted from the ones `fetch-pr` pins (they
// now live in `lib/diff-flags.ts`, shared). And the command it told the model to
// run — `git diff HEAD` — cannot see an untracked file, so every brand-new file
// in the working tree went unreviewed and a working tree whose only change was a
// new file reported "no changes to review".

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { repoRelativeOf, REVIEW_TMP_DIR, tmpFile } from './lib/paths.js';
import { safeTarget } from '../../utils/paths.js';
import { planEffortField } from './lib/effort.js';
import type { ReviewEffort } from './parse-args.js';
import { captureLocalDiff, type SkippedFile } from './lib/local-diff.js';
import {
  buildDiffPlan,
  sliceDiffByLines,
  READ_FILE_CHAR_CAP,
} from './lib/diff-plan.js';
import {
  type IncrementalBlock,
  buildPlanReport,
  warnOnReportSize,
  stringifyPlanReport,
  type PlanReport,
} from './lib/report.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import { hasReviewDeadline } from './lib/deadline.js';
import { gitOpt } from './lib/git.js';
import { certifierMatchesRound, roundModelIdFrom } from './lib/round-model.js';
import {
  changedSince,
  movedSince,
  hashWorktreeFiles,
  readLocalCache,
  stateIdOf,
  type LocalCacheCandidate,
} from './lib/local-anchor.js';
import {
  dependentsOfChanged,
  discoverWorkspacePackages,
} from './lib/import-graph.js';

interface CaptureLocalArgs {
  out: string;
  file?: string;
  target: string;
  untracked: boolean;
  effort?: ReviewEffort;
  cache?: string;
}

type CaptureLocalResult = PlanReport & {
  /**
   * The review's target token, as the CLI derived it — the stem every other
   * artifact of this round must carry. Read it; do not recompute it. The
   * plan's own `--out` is the one name the caller may choose freely, because
   * the caller both writes and reads that one.
   */
  target: string;
  /** The review's effort, recorded so the roster reads one value everywhere. */
  effort?: ReviewEffort;
  diffPath: string;
  diffPathAbsolute: string;
  /** Untracked files whose contents are in the diff — `git diff` shows none. */
  untrackedFiles: string[];
  /** Untracked files that were NOT reviewed. Named, never silently dropped. */
  skippedFiles: SkippedFile[];
  /** Present only when `--cache` scoped this capture incrementally. */
  incremental?: IncrementalBlock;
  /** Where this round's content anchor landed — Step 8 promotes it on a clean run. */
  cacheCandidatePath: string;
};

/**
 * Render a repo path for a terminal.
 *
 * A filename is workspace-controlled data, and git permits almost any byte in
 * one — including newlines and ESC. Printed raw, a path can forge a second
 * warning line ("...was NOT reviewed\nIncluded 3 untracked files") or emit an
 * OSC/CSI sequence at the user's terminal. `JSON.stringify` escapes the control
 * characters and quotes the result; the machine-readable report keeps the real
 * bytes.
 */
function display(path: string): string {
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001f\u007f]/;
  return CONTROL.test(path) ? JSON.stringify(path) : path;
}

/**
 * Why the previous round's anchor cannot scope this capture — or null when it
 * can. Every reason is said out loud: an anchor silently ignored looks
 * exactly like an anchor honoured over a full-size diff.
 */
function anchorRefusalReason(
  cache: ReturnType<typeof readLocalCache>,
  /** The identity running THIS round, provider-qualified; empty means none. */
  model: string,
  headSha: string | null,
  target: string,
  /** The path `target` was flattened from, when the review names one. */
  source: string | undefined,
  skippedCount: number,
  treeHeldStill: boolean,
): string | null {
  if (!treeHeldStill) {
    // The hashes this scoping would compare against were computed over a tree
    // that moved while they were being taken — the same uncertainty that
    // withholds the cache candidate. Withholding only the candidate protects
    // the NEXT round and leaves THIS one wrong: a file whose bytes changed
    // during the hash pass hashes equal to the cached round, `changedSince`
    // reports nothing, and its diff section is sliced out of scope — so the
    // round says "nothing to re-review" over a capture no agent read. The
    // guard's own promise is that no round certifies bytes it never
    // reviewed; that promise is this one's too.
    return 'the working tree changed while the capture was being hashed';
  }
  if (skippedCount > 0) {
    // Skipped content is in NO diff and NO hash: with it present, "zero
    // delta" cannot mean "nothing changed", and an incremental round would
    // certify the previous verdict over work the capture explicitly could
    // not read.
    return `the capture SKIPPED ${skippedCount} file(s) whose content cannot be certified`;
  }
  if (!cache) return 'the cache is missing or unreadable';
  if (!certifierMatchesRound(cache.lastModelId, model)) {
    // `display()`: the model id is a string out of the model-written cache
    // file — printed raw, a crafted value forges warning lines or emits
    // terminal escapes. Capped for the same reason.
    // The same-model contract cannot be verified when either side is
    // missing, and an unverifiable contract is a failed one — which is what
    // `certifierMatchesRound` answers for an empty running identity too.
    return `the previous local round was reviewed by ${display(
      (cache.lastModelId ?? 'an unrecorded model').slice(0, 64),
    )}, not ${display(model || 'an unrecorded model')}`;
  }
  if (cache.target !== target) {
    // A cache belonging to another target (a different file-path review)
    // describes a different reviewed scope entirely.
    return `the cache belongs to target ${display(cache.target.slice(0, 64))}, not ${display(target)}`;
  }
  if ((cache.source ?? undefined) !== source) {
    // …and the TOKEN alone cannot answer that question, because
    // `safeTarget` is not injective: `src/foo.ts` and `src_foo.ts` flatten to
    // one token, as do `foo.ts`/`.foo.ts` and `foo..bar`/`foo/bar`. Under
    // matching HEAD and identity the token gate passed each file the other's
    // cache — scoping against a state describing a different file, and
    // erasing that file's anchor and open findings on promotion. The capture
    // records the path it flattened; compare that.
    //
    // A cache from before the field carries none, which reads as a mismatch
    // against a file review and costs one full round — the safe direction.
    return `the cache belongs to source path ${display(
      (cache.source ?? 'an unrecorded path').slice(0, 96),
    )}, not ${display(source ?? 'an unrecorded path')}`;
  }
  if (cache.stateId !== stateIdOf(cache.headSha, cache.files)) {
    // Integrity: a shape-valid cache whose hashes were edited without
    // recomputing stateId is not the state any clean round certified.
    return 'the cache stateId does not match its own files (tampered or corrupted)';
  }
  if (cache.headSha !== headSha) {
    // The captured diff is HEAD-vs-worktree: under a moved HEAD the same
    // worktree bytes describe a different change under review.
    return 'HEAD moved since the last local round';
  }
  return null;
}

function runCaptureLocal(args: CaptureLocalArgs): void {
  const { out, file } = args;
  // DERIVED here when a file review does not name one, rather than recomputed
  // by whoever calls this. `qwen review run` pins the artifact name it polls
  // for from the same repo-relative path put through the same `safeTarget`,
  // and the skill used to tell the orchestrator to apply that recipe BY HAND
  // — character-class replacement, no canonicalisation. The two agreed only
  // where the prose derivation happened to: `ln -s src srclink` then
  // `qwen review run srclink/foo.ts` had the parent poll for
  // `qwen-review-src_foo.ts-composed.json` while every child artifact was
  // named `srclink_foo.ts`, so the poll never matched and a review that had
  // already run — and with --comment, already posted — reported no verdict.
  //
  // One deriver, in code. A caller that passes an explicit `--target` still
  // wins: the plain local review names `local`, and the cache-target gate
  // below compares whatever was used.
  const sourcePath =
    file !== undefined && (args.target === undefined || args.target === 'local')
      ? repoRelativeOf(gitOpt('rev-parse', '--show-toplevel') ?? '.', file).rel
      : undefined;
  const target =
    sourcePath !== undefined ? safeTarget(sourcePath) : args.target;

  const capture = captureLocalDiff({
    file,
    includeUntracked: args.untracked,
  });

  // Two directories, and they are not the same one. The diff always lands in
  // `.qwen/tmp` (its path is ours to choose), but `--out` is the caller's — and
  // `--out reports/plan.json` is a legal request that answering with the temp
  // dir turned into an ENOENT from `writeFileSync`.
  mkdirSync(REVIEW_TMP_DIR, { recursive: true });
  mkdirSync(dirname(resolve(out)), { recursive: true });

  const fullPlan = buildDiffPlan(capture.diff.toString('utf8'));

  // The content anchor for the NEXT round: hash every captured file's current
  // bytes (`hash-object` without `-w` — computes, writes nothing) plus the
  // HEAD this diff was based against. Written on every run, incremental or
  // not, full-capture fallback or not: the candidate records what THIS round
  // reviewed, and Step 8 promotes it to `.qwen/review-cache/` only on a clean
  // high-effort end — the same division of labour as the PR cache.
  const headSha = capture.unbornHead
    ? null
    : gitOpt('-C', capture.repoRoot, 'rev-parse', 'HEAD');
  // A rename section names only its NEW side, so the deleted SOURCE would go
  // unhashed and two captures differing only in which head file git paired as
  // the source would compare as "no changes".
  //
  // LIVE, not defensive. An earlier version of this comment claimed the
  // opposite on the strength of a measurement that did not hold: the pinned
  // flags include `--find-renames` (`lib/diff-flags.ts`), and the capture's
  // own command over a staged `git mv` renders one rename section, not two —
  // `similarity index 100%` for a pure move and `95%` for a move with a small
  // edit. Local plans therefore DO carry `renameFrom`, which is what makes
  // the slice filter below a live fix rather than a spare part.
  const planPaths = [
    ...new Set(
      fullPlan.files.flatMap((f) =>
        f.renameFrom && f.renameFrom !== f.path
          ? [f.path, f.renameFrom]
          : [f.path],
      ),
    ),
  ];
  const hashes = hashWorktreeFiles(capture.repoRoot, planPaths);
  // TOCTOU guard: the diff was snapshotted before the hashes were computed,
  // and an editor save landing in that window makes the candidate certify
  // bytes THIS round never reviewed — the one uncertainty in this module
  // that failed OPEN. Differing bytes withhold the candidate (the plan still
  // reviews the FIRST capture) AND refuse this round's own incremental
  // scoping, which reads the very same hashes — see `anchorRefusalReason`'s
  // first clause. The cost is a full-range review now and no anchor next
  // round.
  //
  // BOTH endpoints are re-read, the diff and the hashes, because the hash
  // pass sits BETWEEN the two diff snapshots and a write that straddles it
  // is invisible to the diffs alone. Capture B0 → autosave writes B1 → the
  // hashes read B1 → undo restores B0 → the re-capture reads B0: the two
  // diffs agree, and the candidate certifies B1's identity for a round that
  // reviewed B0. The earlier note here had this backwards — it called a
  // same-bytes revert harmless and a different-bytes revert the uncatchable
  // one, when a different-bytes revert moves the endpoints and IS caught,
  // and the same-bytes straddle is what poisons the hashes. "No editor does
  // that by accident" is no answer to an autosave racing an undo.
  //
  // Re-hashing is one extra pass over the plan's paths, on the same batched
  // `hash-object` the first pass uses.
  const recapture = captureLocalDiff({
    file,
    includeUntracked: args.untracked,
  });
  const rehashes = hashWorktreeFiles(capture.repoRoot, planPaths);
  const treeHeldStill =
    capture.diff.equals(recapture.diff) &&
    // `movedSince`, not `changedSince`: a path unhashable on both reads did
    // not move between them, and treating it as a move would withhold the
    // candidate on every round holding a pending deletion — the same
    // conflation that made the convergence stop unreachable.
    movedSince(hashes, rehashes).length === 0;
  const candidate: LocalCacheCandidate = {
    v: 1,
    target,
    headSha,
    files: hashes,
    stateId: stateIdOf(headSha, hashes),
    // Recorded HERE, from the identity the runtime published, rather than
    // merged in by Step 8 from `{{model}}`. `{{model}}` interpolates the BARE
    // model id while `roundModelIdFrom` is provider-qualified
    // (`<model>@<digest of authType + baseUrl>`), so two provider
    // configurations exposing one model name wrote — and compared — equal,
    // and each passed the other's gate. That is the identity-channel class
    // the PR flow closed by moving the comparison into the command; a local
    // round is the same contract ("an anchor is honoured only under the model
    // whose clean verdict certified it") and needs the same treatment. An
    // empty string means the runtime published nothing, which the gate reads
    // as a mismatch rather than a pass.
    lastModelId: roundModelIdFrom(process.env),
    // The path the target token was FLATTENED from, when there is one.
    //
    // `safeTarget` is not injective: `src/foo.ts` and `src_foo.ts` both
    // flatten to `src_foo.ts`, as do `foo.ts`/`.foo.ts` and
    // `foo..bar`/`foo/bar`. This PR newly keys the review cache by that
    // token, so the gate below — comparing tokens alone — could not tell two
    // different files apart: a review of `src_foo.ts` accepted `src/foo.ts`'s
    // cache, scoped against a state describing another file, and promoting it
    // erased the first file's anchor and its open findings.
    ...(sourcePath !== undefined ? { source: sourcePath } : {}),
  };
  const cacheCandidatePath = tmpFile(target, 'cache-candidate.json');
  if (treeHeldStill) {
    writeFileSync(cacheCandidatePath, JSON.stringify(candidate, null, 2));
  } else {
    writeStderrLine(
      'The working tree changed while the capture was being hashed — the ' +
        'cache candidate is withheld, so the next round cannot anchor on ' +
        'bytes this round never reviewed. The review itself proceeds on ' +
        'the first capture.',
    );
  }

  // Incremental scoping, when the caller brought the previous round's anchor.
  let diffBytes = capture.diff;
  let plan = fullPlan;
  let incremental: IncrementalBlock | undefined;
  if (args.cache) {
    const cache = readLocalCache(args.cache);
    const refusal = anchorRefusalReason(
      cache,
      roundModelIdFrom(process.env),
      headSha,
      target,
      sourcePath,
      capture.skipped.length,
      treeHeldStill,
    );
    if (refusal !== null) {
      writeStderrLine(
        `Incremental anchor not used — ${refusal}. Running the full local review.`,
      );
    } else {
      // SYMMETRIC difference, via the tested helper: a path the cached round
      // hashed that no longer appears in this capture (an untracked file
      // deleted between rounds) is a change — its importers must re-enter
      // through the widening even though the path itself has no diff
      // section left to review.
      const stateChanged = changedSince(cache!.files, hashes);
      // What actually MOVED, which is not the same list. A path that could
      // not be hashed on either side is in `stateChanged` for ever — that is
      // deliberate, so unreadable state is re-reviewed rather than certified
      // — but keying the "nothing changed" stop on it made that stop
      // unreachable for any change set holding a pending deletion, and told
      // the user "1 changed file(s)" about a byte-identical diff every round.
      // Scope keeps the wider list; the stop and the human-facing count take
      // this one.
      const stateMoved = movedSince(cache!.files, hashes);
      const changedSet = new Set(stateChanged);
      const changed = planPaths.filter((p) => changedSet.has(p));
      // One import hop over the still-clean SOURCE files, read from the LIVE
      // working tree — the same tree the local review runs against.
      const candidates = fullPlan.files
        .filter(
          (f) => f.kind === 'source' && !f.binary && !changedSet.has(f.path),
        )
        .map((f) => f.path);
      const readTree = (rel: string): string | null => {
        try {
          return readFileSync(join(capture.repoRoot, rel), 'utf8');
        } catch {
          return null;
        }
      };
      const interaction = dependentsOfChanged(
        changedSet,
        candidates,
        readTree,
        discoverWorkspacePackages(planPaths, readTree),
      );
      const keep = new Set([...changed, ...interaction.keys()]);
      const fullDiffPath = tmpFile(target, 'diff-full.txt');
      writeFileSync(fullDiffPath, capture.diff);
      diffBytes = sliceDiffByLines(
        capture.diff,
        fullPlan.files
          // Either SIDE of a rename keeps the section. A rename section is
          // labelled with its NEW path, while `changedSince` reports the
          // deleted SOURCE — its recorded identity is UNHASHABLE, which never
          // equals itself, so the source is in `keep` on every round and the
          // target is in none. Matching `f.path` alone cut the whole section:
          // a zero-byte slice, a plan with no chunks, `deltaFiles` naming a
          // path no section carries, and the branch below still printing
          // "Their sections are in scope". The stop sentence cannot fire
          // either (`stateChanged` is non-empty), and the candidate re-records
          // the same state, so every round repeats it — a review cycle spun
          // over an empty diff with no convergence until HEAD moves.
          .filter(
            (f) =>
              keep.has(f.path) ||
              (f.renameFrom !== undefined && keep.has(f.renameFrom)),
          )
          .map((f) => ({ startLine: f.diffStart, endLine: f.diffEnd })),
      );
      plan = buildDiffPlan(diffBytes.toString('utf8'));
      // Under `scope`, exactly as the PR flow writes it — see
      // `IncrementalBlock`. Written flat here once, which rendered no
      // incremental frame on any local round while the diff was sliced
      // regardless, so nothing looked wrong.
      incremental = {
        scope: {
          anchor: cache!.stateId,
          deltaFiles: changed,
          interaction: [...interaction.entries()].map(
            ([path, importsChanged]) => ({ path, importsChanged }),
          ),
          contextFileCount: candidates.filter((p) => !interaction.has(p))
            .length,
          fullDiffPath,
        },
      };
      // Paths that vanished since the cached round have no diff section and
      // no deltaFiles entry — say they existed, or a deletion-only round
      // reads as if nothing drove its scope.
      const removedCount = stateChanged.filter(
        (p) => !planPaths.includes(p),
      ).length;
      writeStderrLine(
        // The stop condition is the SYMMETRIC set: a deleted-since-cache
        // path with no diff section left is still a change, and "no
        // changes" must not be claimed over it.
        stateMoved.length === 0 && stateChanged.length === 0
          ? `No changes since the last local review round (same model, same ` +
              `HEAD, same content) — nothing to re-review.`
          : stateMoved.length === 0
            ? // Nothing MOVED, but the scope is not empty: a path unhashable
              // on both sides stays in it, because "could not capture it
              // twice" is not "unchanged". Saying "nothing to re-review"
              // here would be false twice over — the plan carries chunks,
              // and SKILL.md stops the orchestrator on that exact sentence,
              // so it would stop over live scope.
              `No content changes since the last local review round, but ` +
              `${stateChanged.length} path(s) could not be hashed on either ` +
              `side (a pending deletion, or a name this layer cannot read) ` +
              `— they are re-reviewed every round and never certified. ` +
              `Their sections are in scope.`
            : `Incremental scope since state ${display(
                cache!.stateId.slice(0, 12),
              )}: ` +
              `${changed.length} changed file(s), ${interaction.size} ` +
              `interaction file(s) (one import hop), ` +
              (stateChanged.length > stateMoved.length
                ? `${stateChanged.length - stateMoved.length} unreadable ` +
                  `path(s) re-reviewed every round (never certified), `
                : '') +
              (removedCount > 0
                ? `${removedCount} cached path(s) no longer present ` +
                  `(treated as changes for the widening), `
                : '') +
              `${incremental.scope!.contextFileCount} clean file(s) left out of ` +
              `scope.`,
      );
    }
  }

  const diffPath = tmpFile(target, 'diff.txt');
  // Write the bytes, not the string: a re-encode would rewrite the content of
  // every hunk touching a file git handed us in a non-UTF-8 encoding.
  writeFileSync(diffPath, diffBytes);

  const result: CaptureLocalResult = {
    // The token the CLI derived, so nothing downstream has to re-derive it.
    // `qwen review run` pins the artifact name it waits for from the same
    // canonicalisation; an orchestrator that recomputes the stem by hand gets
    // a different answer wherever a symlink sits below the repo root, and
    // every artifact it names then misses the poll.
    target,
    diffPath,
    diffPathAbsolute: resolve(diffPath),
    // No ref to `git show` a pre-change file out of, so per-file line counts and
    // heaviness are unavailable — same as `plan-diff`. Chunk coverage, which is
    // what the topology needs, is not.
    ...buildPlanReport(plan, null, {
      operatorRoundCap: operatorReviewSettings().reverseAuditRounds,
      hasDeadline: hasReviewDeadline(process.env),
    }),
    untrackedFiles: capture.untracked,
    skippedFiles: capture.skipped,
    ...(incremental ? { incremental } : {}),
    cacheCandidatePath,
    ...planEffortField(args.effort),
  };

  writeFileSync(out, stringifyPlanReport(result), 'utf8');
  writeStdoutLine(`Wrote diff to ${diffPath} and plan to ${out}`);

  if (capture.unbornHead) {
    writeStderrLine(
      'Note: this repo has no commits yet — diffing against the empty tree, ' +
        'so every file reads as new.',
    );
  }
  if (capture.untracked.length > 0) {
    writeStderrLine(
      `Included ${capture.untracked.length} untracked file(s) that no ` +
        `\`git diff\` would show: ${capture.untracked.map(display).join(', ')}`,
    );
  }
  for (const s of capture.skipped) {
    // The reason needs escaping too, and for the same reason the path did: it is
    // built from `Error.message`, and a filesystem or git error quotes the
    // filename back at you (`ENOENT: ... stat '<name>'`). Escaping the path and
    // then printing the error that contains it is a lock on the front door.
    writeStderrLine(
      `WARNING: untracked file ${display(s.path)} was NOT reviewed — ` +
        `${display(s.reason)}. List it under "Not reviewed" in the review output.`,
    );
  }
  if (plan.diffLines === 0 && !incremental) {
    // "Nothing to review" and "nothing was reviewable" are different sentences,
    // and only one of them is a clean tree. An oversized blob or an embedded repo
    // as the *only* change lands here with an empty diff and a non-empty skip
    // list, and calling that clean would hand the review a green verdict over
    // work it explicitly could not read — the whole failure this command exists
    // to end, arriving through the front door.
    //
    // The incremental no-changes case is deliberately NOT this branch: its 0
    // chunks mean "identical to the state the last round reviewed", which the
    // scoping block already said in its own words — "the working tree is
    // clean" would be false, and false in the direction that certifies.
    writeStderrLine(
      capture.skipped.length > 0
        ? `WARNING: 0 chunks — nothing reviewable was captured, but ` +
            `${capture.skipped.length} untracked file(s) were SKIPPED (above). ` +
            `This is not a clean tree: report them under "Not reviewed" and do ` +
            `not certify the working tree as reviewed.`
        : 'WARNING: the working tree is clean — 0 chunks. There is nothing to ' +
            'review; do not run the review agents.',
    );
  }
  writeStderrLine(
    `Diff: ${plan.diffLines} lines (${plan.srcDiffLines} source, ` +
      `${plan.testDiffLines} test, ${plan.docsDiffLines} docs, ` +
      `${plan.generatedDiffLines} generated) -> ${plan.chunks.length} review chunk(s)`,
  );
  warnOnReportSize(out, READ_FILE_CHAR_CAP);
}

export const captureLocalCommand: CommandModule = {
  command: 'capture-local',
  describe:
    'Capture staged + unstaged + untracked changes as one diff and partition it into review chunks',
  builder: (yargs) =>
    yargs
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path for the chunk plan (will be overwritten)',
      })
      .option('file', {
        type: 'string',
        describe:
          'Scope the capture to a single path (a `/review <file-path>` target)',
      })
      .option('target', {
        type: 'string',
        default: 'local',
        describe:
          'Target suffix for the diff file name (`local`, or a filename for a file-path review)',
      })
      .option('untracked', {
        type: 'boolean',
        default: true,
        describe:
          'Include untracked, non-ignored files. On by default: `git diff` cannot see them, so without this a brand-new file goes unreviewed.',
      })
      .option('effort', {
        type: 'string',
        choices: ['low', 'medium', 'high'],
        describe:
          'The review effort. `medium` (balanced) drops the adversarial ' +
          'personas from the required roster; recorded in the plan so ' +
          'check-coverage, agent-prompt --roster and compose-review all read ' +
          'one value. Omit for the full (high) roster.',
      })
      .option('cache', {
        type: 'string',
        describe:
          "The previous local round's review cache " +
          '(`.qwen/review-cache/<target>.json`). When its anchor validates — ' +
          'same model, same HEAD — the capture is scoped to files whose ' +
          'content changed since that round, widened by one import hop; on ' +
          'any refusal it degrades to the full capture and says why.',
      }),
  handler: (argv) => {
    runCaptureLocal(argv as unknown as CaptureLocalArgs);
  },
};
