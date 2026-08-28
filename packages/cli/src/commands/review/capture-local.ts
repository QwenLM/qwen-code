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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  repoRelativeOf,
  REVIEW_CACHE_DIR,
  REVIEW_TMP_DIR,
  tmpFile,
} from './lib/paths.js';
import { safeTarget } from '../../utils/paths.js';
import { planEffortField } from './lib/effort.js';
import { EFFORT_OPTION, type ReviewEffort } from './parse-args.js';
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
  invisibleTrackedPaths,
  movedSince,
  hashWorktreeFiles,
  isPathProvablyAbsent,
  readLocalCache,
  revisionIdentities,
  stateIdOf,
  UNHASHABLE,
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
  /**
   * The written candidate's own `stateId`, for Step 8 to CHECK before
   * promoting. The candidate path is stable per target and local/file
   * reviews take no lease, so a concurrent same-target run overwrites the
   * file mid-round — indistinguishable by path, mtime or shape. A candidate
   * whose stateId no longer matches this field is another run's: treat it
   * exactly like a withheld candidate and say so (R17-4). Absent when the
   * candidate was withheld.
   */
  cacheCandidateStateId?: string;
  /**
   * Where this target's review cache lives — resolved here, not predicted.
   *
   * Every ledger read and the Step 8 write name `<target>.json`, and
   * `target` does not exist until this command derives it from `--file`.
   */
  cachePath: string;
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
 * Cached paths that dropped out of THIS capture while still on disk — and
 * that the base HEAD does not certify.
 *
 * A path the cached round hashed that this one no longer sees is normally a
 * deletion, which the symmetric difference rightly treats as a change. But
 * "still on disk and out of the capture" is not a deletion — it is a capture
 * that stopped SEEING the path: an ignore rule added between rounds is the
 * live case (`ls-files --others --exclude-standard` stops enumerating it),
 * and the flag clause in `anchorRefusalReason` cannot see it because no flag
 * changed. Such a path reads as "vanished", the slice keeps zero sections,
 * and the scope-emptied stop fires over bytes no round captured — decided,
 * and repeated every round, because a stop never advances the cache.
 *
 * The discriminator is the base HEAD, asked of BYTES, not of names: a
 * TRACKED path left the diff because its bytes now equal the tree the diff
 * is taken against, and only that equality certifies it — the designed
 * discarded-change shape the scope-emptied stop decides. Naming the path in
 * HEAD's tree is not the same fact: under
 * `git update-index --assume-unchanged` (and `--skip-worktree`) git hides
 * the edited tracked file from `git diff HEAD` while `ls-tree HEAD` still
 * names it, so a name check certified a divergence no round ever read. A
 * path whose worktree bytes do not byte-compare equal to its HEAD identity
 * — or that either side cannot hash — is refused, at the cost of a full
 * round.
 */
/**
 * Whether a FILE review's subject is a directory — the one shape that must
 * not enter the anchor's hashed population (see the call site). Only a
 * confirmed directory answers true: an unmeasurable path keeps the
 * pre-existing behaviour rather than silently dropping the subject's
 * coverage, the opposite lean from the ENOENT-only rules elsewhere because
 * the risk here is a poisoned anchor, not a false certification.
 */
function isDirectorySubject(repoRoot: string, rel: string): boolean {
  try {
    return lstatSync(join(repoRoot, rel)).isDirectory();
  } catch {
    return false;
  }
}

function vanishedStillOnDisk(
  repoRoot: string,
  headSha: string | null,
  cachedFiles: Record<string, string>,
  currentHashes: Record<string, string>,
): string[] {
  const onDisk: string[] = [];
  for (const p of Object.keys(cachedFiles)) {
    if (Object.hasOwn(currentHashes, p)) continue;
    if (isPathProvablyAbsent(repoRoot, p)) continue;
    onDisk.push(p);
  }
  if (onDisk.length === 0) return [];
  // Both identities in the one format this module compares
  // (`revisionIdentities` mirrors the worktree hasher exactly). An unborn
  // HEAD has no tree and answers nothing: no certification, so everything
  // still on disk refuses — over-review is the affordable direction, same
  // as a failed listing.
  const worktree = hashWorktreeFiles(repoRoot, onDisk);
  const head = revisionIdentities(repoRoot, headSha, onDisk);
  // `core.fileMode=false` makes git itself ignore the EXEC bit — the stored
  // tree keeps one mode while the worktree lstat reports another and
  // `git diff HEAD` stays empty. Certifying by the FULL identity then
  // refused every such path (and the stop suppression beside it withheld
  // every stop) over a divergence git does not recognise: fold 100755 into
  // 100644 and compare.
  //
  // The flag is read `--type=bool`, never raw: `--get` echoes the STORED
  // spelling and git accepts `off`/`no`/`0`/`FALSE`, every one of which
  // failed a `!== 'false'` test and silently disabled the fold (R20-1 — the
  // same misreading R18-2 fixed for `core.sparseCheckout`). Only an
  // EXPLICIT false folds: the knob defaults to true, and an unset one must
  // not erase a real exec divergence from the comparison.
  //
  // DISCLOSED, not folded: `core.symlinks=false` erases the file↔symlink
  // TYPE the same way — git materializes a tracked symlink as a regular
  // file, so the worktree side reads `100644:<oid>:<attrs>` against HEAD's
  // `120000:<oid>` and the designed discarded-change shape never certifies
  // (R20-5). A mode fold does NOT close it: the two spellings also differ
  // in whether they carry rendering attributes at all, so folding the mode
  // leaves them unequal, and equalizing the attributes would mean dropping
  // the rendering dimension for that path — trading a bounded over-review
  // for a certification this layer cannot make. The cost is that such a
  // path is re-reviewed every round on repos with the knob off; the
  // direction is the affordable one, as everywhere else here.
  const foldsExec =
    gitOpt(
      '-C',
      repoRoot,
      'config',
      '--type=bool',
      '--get',
      'core.fileMode',
    ) === 'false';
  const identity = (id: string | undefined): string | undefined =>
    foldsExec && id !== undefined && id.startsWith('100755:')
      ? `100644:${id.slice('100755:'.length)}`
      : id;
  // A path unhashable on the WORKTREE side refuses — unmeasurable is
  // uncertifiable. Submodule gitlinks are no longer that shape: both sides
  // answer `160000:<oid>` for a readable, content-clean submodule (see
  // `gitlinkIdentity` / `revisionIdentities`), so a restored pointer
  // certifies through the ordinary equality below, and a dirty or
  // unreadable one stays UNHASHABLE and refuses — the R20-3/R22-1 pair,
  // closed by making the identity real instead of special-casing the
  // placeholder.
  return onDisk.filter(
    (path) =>
      identity(worktree[path]) !== identity(head[path]) ||
      worktree[path] === UNHASHABLE,
  );
}

/**
 * Why a decided stop is withheld when tracked paths carry a visibility bit —
 * or when the bits themselves could not be enumerated.
 */
function invisibleStopRefusal(invisible: string[] | null): string {
  return invisible === null
    ? 'The tracked-file visibility bits could not be enumerated ' +
        '(`git ls-files -v` failed) — a stop is a DECIDED outcome, and a ' +
        'tree the capture cannot measure cannot be decided. Re-run the review.'
    : `${invisible.length} tracked path(s) carry an --assume-unchanged or ` +
        `--skip-worktree bit (e.g. ${display(
          invisible[0].slice(0, 96),
        )}) — \`git diff\` is blind to any edit on them, so no decided stop ` +
        `can be made: the bytes it would certify were read by no round. Clear ` +
        `the bit(s) (\`git update-index --no-assume-unchanged\` / ` +
        `\`--no-skip-worktree\`) and re-run the review.`;
}

/**
 * Why a decided stop is withheld when the round ran with `--no-untracked` —
 * shared by the two incremental stops; the clean-tree stop's exclusion has
 * its own shape-specific sentence. The anchor gate admits no round NARROWER
 * than the cache, so the cached round ran narrow too: neither ever
 * enumerated untracked files, and a brand-new one is invisible to both.
 */
function untrackedStopRefusal(): string {
  return (
    'The incremental scope kept nothing to review, but untracked files ' +
    'were not enumerated (--no-untracked) — not by this round and not by ' +
    'the round the cache records — so a brand-new file is invisible to ' +
    'both, and this is NOT a decided nothing-to-review: report the ' +
    'untracked scope under "Not reviewed" and end the round without the ' +
    'stop.'
  );
}

/**
 * Why the cache candidate is withheld when tracked paths carry a visibility
 * bit — or when the bits themselves could not be enumerated.
 */
function invisibleCandidateRefusal(invisible: string[] | null): string {
  return invisible === null
    ? 'The tracked-file visibility bits could not be enumerated ' +
        '(`git ls-files -v` failed) — the cache candidate is withheld: an ' +
        'anchor recorded over a tree the capture cannot measure would let ' +
        'a later round certify bytes no round ever read. Re-run the review.'
    : `${invisible.length} tracked path(s) carry an --assume-unchanged or ` +
        `--skip-worktree bit (e.g. ${display(
          invisible[0].slice(0, 96),
        )}) — \`hash-object\` reads the worktree bytes through the bit ` +
        `while \`git diff\` cannot see them, so the cache candidate is ` +
        `withheld: promoted, it would anchor a later round on bytes this ` +
        `round never reviewed. Clear the bit(s) ` +
        `(\`git update-index --no-assume-unchanged\` / ` +
        `\`--no-skip-worktree\`) and re-run the review.`;
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
  /** Did THIS capture include untracked files? */
  untracked: boolean,
  /**
   * Cached paths still on disk but gone from this capture and not certified
   * by the base HEAD — see `vanishedStillOnDisk`.
   */
  vanishedStillPresent: readonly string[],
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
      (cache.lastModelId || 'an unrecorded model').slice(0, 64),
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
  if (cache.untracked === true && !untracked) {
    // Narrower than the round that wrote it: this capture cannot see the
    // untracked files that one hashed, so their absence from it is scope, not
    // change. Refusing costs a full round; honouring it certifies bytes
    // nobody read.
    return 'this round excludes untracked files the cached round reviewed';
  }
  if (cache.stateId !== stateIdOf(cache.headSha, cache.files)) {
    // Integrity: a shape-valid cache whose hashes were edited without
    // recomputing stateId is not the state any clean round certified.
    return 'the cache stateId does not match its own files (tampered or corrupted)';
  }
  if (Object.keys(cache.files).length === 0) {
    // A no-diff round promotes an empty files map, and an empty map
    // certifies nothing: `changedSince` over two empty maps answers
    // "unchanged" under ANY tree state the capture cannot see — an
    // `--assume-unchanged` edit is the live case — so the unchanged stop
    // would decide over bytes no round ever read. An anchor with no
    // identities is not an anchor; the full capture costs one round.
    return 'the cache recorded no file identities, so it cannot certify this round';
  }
  if (cache.headSha !== headSha) {
    // The captured diff is HEAD-vs-worktree: under a moved HEAD the same
    // worktree bytes describe a different change under review.
    return 'HEAD moved since the last local round';
  }
  if (vanishedStillPresent.length > 0) {
    // Visibility narrowed without any flag moving — an ignore rule added
    // between rounds is the live case. The path's absence from this capture
    // is scope, not a deletion, and honouring the anchor would stop decided
    // over bytes no round captured.
    return `${
      vanishedStillPresent.length
    } cached path(s) dropped out of this capture while still on disk (e.g. ${display(
      vanishedStillPresent[0].slice(0, 96),
    )})`;
  }
  return null;
}

/**
 * The cache file `--cache` names: the path itself, or — when it names a
 * directory — the same spelling `cachePathFor` writes (`<dir>/<target>.json`
 * for the whole tree, `<dir>/file-<target>-<digest>.json` for a file
 * review). Null when a directory holds no cache for this target, which
 * every caller already treats as "no anchor".
 */
function resolveCachePath(
  given: string,
  target: string,
  source: string | undefined,
): string | null {
  let isDir = false;
  try {
    isDir = statSync(given).isDirectory();
  } catch {
    // Missing is not a directory; `readLocalCache` reports it as unreadable.
    return given;
  }
  if (!isDir) return given;
  // The SAME spelling `cachePathFor` writes. A resolver and a writer that
  // disagree leave the round reporting "the cache is missing or unreadable"
  // over a cache sitting right there — and for a file review they DID, since
  // the namespace split moved the write and left this probe on the old name.
  const candidate = join(given, basename(cachePathFor(target, source)));
  return existsSync(candidate) ? candidate : null;
}

/**
 * Where a target's review cache lives.
 *
 * The whole-tree round keeps `local.json`. A FILE review gets its own
 * namespace and a digest of the source path, because the flattened token
 * alone does not discriminate the subject and the ledger layer has no other
 * key: `safeTarget` is not injective (`src/foo.ts` and `src_foo.ts` flatten
 * to one token, so two file reviews shared one cache and erased each other's
 * findings), and the token space reserves nothing (a root file literally
 * named `local` produced the whole-tree key byte for byte, and one named
 * `pr-<n>` produced PR <n>'s).
 *
 * The anchor gate's `source` check is the second layer, not the first: it can
 * only refuse a cache the round already opened, which leaves the LEDGER —
 * read and written by the orchestrator, not by the gate — sharing the file.
 *
 * Safe to change the spelling of because nothing predicts it any more: the
 * plan publishes this path and every reader takes it from there. A cache
 * under the old name is simply not found, which costs one full round.
 */
function cachePathFor(target: string, source: string | undefined): string {
  if (source === undefined) return join(REVIEW_CACHE_DIR, `${target}.json`);
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 8);
  return join(REVIEW_CACHE_DIR, `file-${target}-${digest}.json`);
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
  // One deriver, in code, and it runs for EVERY `--file` capture — including
  // one an explicit `--target` rides along on. That combination used to skip
  // the derivation: `sourcePath` stayed undefined, so the cache fell out of
  // the digest namespace, the candidate recorded no `source`, and the gate's
  // source clause degraded to `undefined === undefined` and passed —
  // re-creating the cross-subject cache sharing both exist to close, while
  // the explicit token named artifacts the parent's derived poll never
  // matches anyway. An explicit `--target` names plain (non-file) rounds
  // only; the cache-target gate below compares whatever was used.
  const sourcePath =
    file !== undefined
      ? repoRelativeOf(gitOpt('rev-parse', '--show-toplevel') ?? '.', file).rel
      : undefined;
  const target =
    sourcePath !== undefined ? safeTarget(sourcePath) : args.target;

  // Visibility-bit sample 0 — BEFORE the first capture. The oracle rides the
  // same both-endpoints discipline as the diffs and hashes below: sampled
  // only after the loop, a bit set through every diff pass and cleared just
  // before the one query read clean while the captured diffs were blind to
  // the edit it hid — the candidate then certified bytes no pass ever
  // showed. Bracketing narrows that to a set-AND-cleared toggle inside one
  // inter-sample gap, the same honest-tightening the capture loop claims
  // for itself.
  const invisibleSamples: Array<string[] | null> = [
    invisibleTrackedPaths(gitOpt('rev-parse', '--show-toplevel') ?? '.'),
  ];
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
    ...new Set([
      ...fullPlan.files.flatMap((f) =>
        f.renameFrom && f.renameFrom !== f.path
          ? [f.path, f.renameFrom]
          : [f.path],
      ),
      // A FILE review's subject enters the anchor even with NO diff section.
      // Without it the no-diff shape promotes an empty files map, and an
      // `--assume-unchanged` edit on the subject then hides from
      // `git diff HEAD` while `hash-object` reads through the bit — hashing
      // the subject keeps the next round's comparison honest instead of
      // certifying "unchanged since last round" over bytes nobody read.
      //
      // …but a DIRECTORY subject is not hashable, and `qwen review <dir>`
      // is a supported entrance. Recorded, it lands in every candidate as
      // UNHASHABLE — which never equals itself — so `changedSince` reports
      // the directory every round, `stateChanged` is never empty, and the
      // `unchanged-since-last-round` stop is unreachable for that target
      // for ever (R20-2), while the round prints "could not be hashed on
      // either side" about the user's own subject. Its FILES are already
      // in `fullPlan.files`; the directory itself carries no bytes to
      // certify. Only a confirmed directory is skipped: an lstat that
      // fails leaves the subject in, which is the pre-existing coverage.
      ...(sourcePath !== undefined &&
      !isDirectorySubject(capture.repoRoot, sourcePath)
        ? [sourcePath]
        : []),
    ]),
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
  // THREE consecutive states, not two, and the two kinds interleaved.
  //
  // Pairwise agreement never tied a capture to the hashes recorded beside
  // it: sampling B0 H0 B1 H1 and asking only "B0 == B1" and "H0 == H1"
  // passes for three phase-aligned writes — X→Y before the hash pass, Y→X
  // before the re-capture, X→Y after it. Both checks hold, `treeHeldStill`
  // is true, and the candidate certifies Y's identity for a round that
  // reviewed X. Promoted, the next round compares cache Y against tree Y,
  // finds no delta and says "No changes" over bytes no round ever read —
  // the exact promise this guard exists to keep.
  //
  // Interleaved sampling does not make that impossible; nothing short of
  // holding the tree still can, and this module cannot. It raises the price
  // from three timed writes to five, and every write has to land in a
  // window bounded by the neighbouring sample of the OTHER kind. The
  // honest description is a tightened sample, not a proof — and every
  // failure of it withholds the candidate, so the cost of being wrong is a
  // full round, never a false certification.
  //
  // The extra pass is one more `git diff` and one more batched
  // `hash-object` over paths already read twice.
  const captures = [capture.diff];
  const skippedPasses = [capture.skipped];
  const hashPasses = [hashes];
  for (let i = 0; i < 2; i++) {
    const re = captureLocalDiff({ file, includeUntracked: args.untracked });
    captures.push(re.diff);
    // The re-captures' SKIPPED lists ride the comparison too: a file that
    // enters the tree inside the window and lands in a skip class (over the
    // cap, binary, an embedded repo, the budget) is in no capture's diff
    // BYTES, so the byte comparison alone reads "held still" while two of
    // the three captures explicitly skipped content — and every stop gate
    // reads only capture 0's skipped list (R21-2). Skip-set movement is
    // tree movement.
    skippedPasses.push(re.skipped);
    hashPasses.push(hashWorktreeFiles(capture.repoRoot, planPaths));
    // Visibility-bit samples 1 and 2 — interleaved with the re-captures for
    // the same reason the hashes are: see sample 0 above.
    invisibleSamples.push(invisibleTrackedPaths(capture.repoRoot));
  }
  const skipSet = (list: readonly SkippedFile[]): string =>
    JSON.stringify(list.map((f) => f.path).sort());
  const treeHeldStill =
    captures.every((d) => d.equals(captures[0])) &&
    skippedPasses.every((l) => skipSet(l) === skipSet(skippedPasses[0])) &&
    // `movedSince`, not `changedSince`: a path unhashable on both reads did
    // not move between them, and treating it as a move would withhold the
    // candidate on every round holding a pending deletion — the same
    // conflation that made the convergence stop unreachable.
    hashPasses.every((h) => movedSince(hashPasses[0], h).length === 0);
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
    // What this round could SEE. A later round that sees less cannot certify
    // this one's state: with `--no-untracked` (or a `.gitignore` entry added
    // between rounds) the untracked block never runs and records no `skipped`
    // entries, so a cached untracked path reads as VANISHED rather than
    // out-of-scope — the slice keeps nothing and the round stops decided over
    // bytes it never captured. The stop does not advance the cache, so every
    // later narrow round repeats it.
    untracked: args.untracked !== false,
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
  // The visibility-bit oracle — every stop is a claim that nothing in the
  // tree needs review, and the candidate records the identity of the tree
  // this round reviewed; `git diff` is blind to the marked paths, so the
  // three stops AND the candidate write are conditioned on the enumeration
  // coming back clean AT EVERY SAMPLE POINT: the three bracketing samples
  // taken alongside the captures above, plus a final one here after the
  // loop. A bit visible at ANY of them withholds (the union is reported),
  // and a single failed enumeration withholds everything — the same
  // fail-closed lean as one unhashable path.
  let invisibleBits: string[] | null | undefined;
  const invisibleTracked = (): string[] | null => {
    if (invisibleBits === undefined) {
      invisibleBits = invisibleTrackedPaths(capture.repoRoot);
    }
    if (invisibleBits === null || invisibleSamples.some((v) => v === null)) {
      return null;
    }
    return [
      ...new Set([
        ...invisibleSamples.flatMap((v) => v ?? []),
        ...invisibleBits,
      ]),
    ];
  };
  const invisibleCertified = (): boolean => {
    const inv = invisibleTracked();
    return inv !== null && inv.length === 0;
  };
  const cacheCandidatePath = tmpFile(target, 'cache-candidate.json');
  // Read the cache BEFORE the candidate write: the dropped-out-while-on-disk
  // set gates that write (below), and computing it after let a refused
  // anchor's round write a candidate that silently OMITTED the dropped path
  // — Step 8 promoted the omission, and two rounds later a scope-emptied
  // stop certified bytes no round read (R23). Empty when no `--cache`
  // scoped this round; the scoping branch below reuses these values.
  const cachePathEarly =
    args.cache !== undefined
      ? resolveCachePath(args.cache, target, sourcePath)
      : null;
  const cacheEarly =
    cachePathEarly === null ? null : readLocalCache(cachePathEarly);
  const vanishedPresent: readonly string[] =
    cacheEarly === null
      ? []
      : vanishedStillOnDisk(
          capture.repoRoot,
          headSha,
          cacheEarly.files,
          hashes,
        );
  // The same uncertainty that withholds a decided stop withholds the
  // candidate: `hash-object` reads the worktree bytes THROUGH a set
  // assume-unchanged/skip-worktree bit while `git diff` cannot see them, so
  // the hashes above record the identity of bytes this round's diff never
  // showed. Promoted, the unread bytes become anchor state — and when the
  // bit is cleared between rounds keeping the bytes, every comparison finds
  // no change, every visibility gate reads clean, and the unchanged-since
  // stop certifies them: a loop deciding "nothing to re-review" over bytes
  // no round ever read. A cached path dropped out while still on disk is
  // the same uncertainty from the other side: this capture cannot SEE the
  // path, so the candidate would record its absence as reviewed state.
  const invisible = invisibleTracked();
  const candidateWritten =
    treeHeldStill &&
    invisible !== null &&
    invisible.length === 0 &&
    vanishedPresent.length === 0;
  if (candidateWritten) {
    writeFileSync(cacheCandidatePath, JSON.stringify(candidate, null, 2));
  } else {
    // The path is stable per target, so an earlier round's candidate still
    // sits under the `cacheCandidatePath` this plan publishes, and Step 8
    // would promote that stale anchor merged with this round's ledger.
    // Absent IS the withheld state — fail quiet.
    try {
      unlinkSync(cacheCandidatePath);
    } catch {
      // nothing to remove
    }
    if (!treeHeldStill) {
      writeStderrLine(
        'The working tree changed while the capture was being hashed — the ' +
          'cache candidate is withheld, so the next round cannot anchor on ' +
          'bytes this round never reviewed. The review itself proceeds on ' +
          'the first capture.',
      );
    } else if (invisible === null || invisible.length > 0) {
      writeStderrLine(invisibleCandidateRefusal(invisible));
    } else {
      writeStderrLine(
        `The cache candidate is withheld: ${vanishedPresent.length} cached ` +
          `path(s) dropped out of this capture while still on disk, so the ` +
          `candidate would record their absence as reviewed state. The ` +
          `review itself proceeds in full.`,
      );
    }
  }

  // Incremental scoping, when the caller brought the previous round's anchor.
  let diffBytes = capture.diff;
  let plan = fullPlan;
  let incremental: IncrementalBlock | undefined;
  /**
   * Machine-readable: this round has nothing to review, and that is a
   * DECIDED outcome rather than a failure.
   *
   * Both stops used to exist only as a stderr sentence the orchestrator
   * matched on, so the parent (`qwen review run`) could not tell them from a
   * round that fell over: it polls for a composed verdict, finds none, and
   * exits 1 with "Review did not complete". A user who committed without
   * fixing a blocker gets that on every later round, over a round whose own
   * output rendered the blocker as still standing.
   */
  let nothingToReview: { reason: string } | undefined;
  // Cached paths this capture dropped while still on disk and diverging
  // from HEAD — see `vanishedStillOnDisk`. Empty when no `--cache` scoped
  // this round. Read by the anchor refusal AND the stop gates below.
  if (args.cache !== undefined) {
    // A DIRECTORY resolves to this command's own target, because the caller
    // cannot name the file.
    //
    // The cache is `<dir>/<target>.json`, and `target` exists only after the
    // derivation above — the whole point of which is that a hand-applied
    // recipe disagreed with it. Step 1 has to decide whether a cache exists
    // BEFORE running this command, so it was left predicting the name: for
    // `ln -s src srclink` then a review of `srclink/foo.ts`, the typed
    // spelling flattens to `srclink_foo.ts` while this command canonicalises
    // to `src_foo.ts`. The prediction misses, `--cache` is never passed, and
    // the round silently loses both incremental scoping and the findings
    // ledger — in exactly the spelling classes the canonicalisation exists
    // to handle, with no refusal line printed anywhere.
    //
    // Passing the directory ends the guessing: one deriver, and a caller
    // that knows only where caches live. A file path still works unchanged.
    const cache = cacheEarly;
    const refusal = anchorRefusalReason(
      cache,
      roundModelIdFrom(process.env),
      headSha,
      target,
      sourcePath,
      capture.skipped.length,
      treeHeldStill,
      args.untracked !== false,
      vanishedPresent,
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
      const removedFromSlice = stateChanged.filter(
        (p) => !planPaths.includes(p),
      );
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
          // The scope-emptied split key — see IncrementalScope. Computed
          // here, not re-derived by the orchestrator: file PRESENCE cannot
          // answer it (a discarded change leaves the file present with the
          // cited bytes gone), and no other published channel names these
          // paths at all.
          ...(removedFromSlice.length > 0
            ? { supersededPaths: removedFromSlice }
            : {}),
        },
      };
      // Paths that vanished since the cached round have no diff section and
      // no deltaFiles entry — say they existed, or a deletion-only round
      // reads as if nothing drove its scope.
      const removedCount = removedFromSlice.length;
      // The stop condition is the SYMMETRIC set: a deleted-since-cache
      // path with no diff section left is still a change, and "no
      // changes" must not be claimed over it.
      if (
        stateMoved.length === 0 &&
        stateChanged.length === 0 &&
        // …and NOT a file review, the exclusion BOTH sibling stops carry: a
        // cached round-2 file review of a tracked-unmodified subject passed
        // every anchor clause and stopped decided here, while the identical
        // tree without a cache routes to the whole-file review SKILL.md
        // owes a file target — the cache-vs-no-cache disagreement the
        // scope-emptied exclusion was added to kill, one stop over (R23).
        // The file shape gets its own sentence below instead of falling
        // into the unhashable-paths diagnosis beside it.
        args.file === undefined
      ) {
        const invisible = invisibleTracked();
        if (invisible !== null && invisible.length === 0) {
          if (args.untracked !== false) {
            nothingToReview = { reason: 'unchanged-since-last-round' };
            writeStderrLine(
              `No changes since the last local review round (same model, ` +
                `same HEAD, same content) — nothing to re-review.`,
            );
          } else {
            // …but "same content" was only proven over tracked paths: the
            // gate admits no narrower round than the cache, so the cached
            // round ran `--no-untracked` too — neither enumerated untracked
            // files, and a brand-new one is invisible to both. The same
            // exclusion the clean-tree stop carries, out loud.
            writeStderrLine(untrackedStopRefusal());
          }
        } else {
          // …but "unchanged" was only proven over what `git diff` can see:
          // a marked path's edit leaves every comparison above standing
          // still. The same uncertainty that refuses an anchor withholds a
          // stop — the round decides nothing and says why.
          writeStderrLine(invisibleStopRefusal(invisible));
        }
      } else if (
        stateMoved.length === 0 &&
        stateChanged.length === 0 &&
        args.file !== undefined
      ) {
        // The excluded file shape, said honestly: nothing changed since the
        // cached round, and a file target takes the whole-file review
        // instead of a decided stop — cache and no-cache agree.
        writeStderrLine(
          `No content changes since the last local review round for this ` +
            `file target — a file review never stops decided here; the ` +
            `whole-file review reads the current state.`,
        );
      } else if (stateMoved.length === 0) {
        // Nothing MOVED, but the scope is not empty: a path unhashable
        // on both sides stays in it, because "could not capture it
        // twice" is not "unchanged". Saying "nothing to re-review"
        // here would be false twice over — the plan carries chunks,
        // and SKILL.md stops the orchestrator on that exact sentence,
        // so it would stop over live scope.
        writeStderrLine(
          `No content changes since the last local review round, but ` +
            `${stateChanged.length} path(s) could not be hashed on either ` +
            `side (a pending deletion, or a name this layer cannot read) ` +
            `— they are re-reviewed every round and never certified. ` +
            `Their sections are in scope.`,
        );
      } else {
        writeStderrLine(
          `Incremental scope since state ${display(
            cache!.stateId.slice(0, 12),
          )}: ` +
            `${changed.length} changed file(s), ${interaction.size} ` +
            `interaction file(s) (one import hop), ` +
            (stateChanged.length > stateMoved.length
              ? `${stateChanged.length - stateMoved.length} unreadable ` +
                `path(s) re-reviewed every round (never certified), `
              : '') +
            (removedCount > 0
              ? `${removedCount} cached path(s) whose recorded change is ` +
                `gone from this capture (deleted, or discarded — named in ` +
                `the plan's supersededPaths), `
              : '') +
            `${incremental.scope!.contextFileCount} clean file(s) left out of ` +
            `scope.`,
        );
      }
    }
  }

  // Decided BEFORE the report is written, because the branch that prints the
  // clean-tree warning runs after it. Only the genuinely clean shape counts:
  // a capture that SKIPPED files reviewed nothing AND could not read what it
  // skipped, so that round owes a "Not reviewed" section and must never read
  // as complete.
  if (
    plan.diffLines === 0 &&
    !incremental &&
    capture.skipped.length === 0 &&
    // …and NOT a file review. A tracked, unmodified file has an empty diff
    // and is not a decided round: SKILL.md's no-diff branch owes it a
    // whole-file review ("read the file and review its current state"). Left
    // in, this turned that case from "Review did not complete" — which it was
    // before the stop existed — into a PASSING gate over a file nobody read.
    args.file === undefined &&
    // …and the guard has to agree. `treeHeldStill` false means a write landed
    // inside the capture window — the exact race the three-pass sampling
    // exists to catch — so capture 0's empty diff describes a tree that no
    // longer exists. Without this the round printed both "the working tree
    // changed while the capture was being hashed" AND "the working tree is
    // clean", stopped on the second, and recorded the just-written change as
    // reviewed-and-clean. Same discipline as the skipped-content gate beside
    // it: a stop is a DECIDED outcome, and neither unread nor moved content
    // can be decided.
    treeHeldStill &&
    // …and the anchor refusal did not just prove a path diverges while
    // INVISIBLE to the capture — an `--assume-unchanged` edit is the live
    // case: `git diff HEAD` honours the bit, so an empty diff proves
    // nothing about that path, and the blocker date below reads hidden
    // edits through it. The same uncertainty that refused the anchor
    // withholds the stop, or the round decides clean over bytes no round
    // ever read.
    vanishedPresent.length === 0 &&
    // …and nothing tracked is INVISIBLE to the diff the cleanness claim is
    // about: a path carrying an assume-unchanged/skip-worktree bit hides
    // any edit from the empty diff this stop certifies, so "nothing staged,
    // nothing unstaged, nothing untracked" proves nothing while one is
    // set. The bits are enumerated, not the edits — one ANYWHERE withholds
    // the stop, because the capture cannot tell which marked path diverges.
    invisibleCertified()
  ) {
    if (args.untracked !== false) {
      nothingToReview = { reason: 'clean-tree' };
    } else {
      // The stop's claim is "nothing staged, nothing unstaged, nothing
      // untracked", and under `--no-untracked` the third clause was never
      // checked: the untracked enumeration does not run and records no
      // `skipped` entries, so a tracked-clean tree with pending untracked
      // work passed every conjunct above. SKILL.md's own recovery from an
      // oversized-untracked skip is "re-run with `--no-untracked`", which
      // lands exactly here — deciding clean over the very content the first
      // run could not read. The ANCHOR gate has carried this exclusion
      // since the candidate recorded `untracked`; the stop follows it, out
      // loud like every other withheld stop.
      writeStderrLine(
        'The tracked tree is clean, but untracked files were not ' +
          'enumerated (--no-untracked), so this is NOT a decided clean ' +
          'tree: report the untracked scope under "Not reviewed" and end ' +
          'the round without a clean verdict.',
      );
    }
  }

  // …and the third decided shape, which the two above miss because both are
  // gated on `!incremental`. A cached path that VANISHED (deleted, or the
  // change discarded with `git checkout --`) is a change by design, so
  // `stateChanged` is non-empty and the unchanged-since stop cannot fire —
  // but it carries no section, the widening pulls nothing in, and the slice
  // keeps zero. The plan then had `chunks: []` with an `incremental` block
  // and no field at all: neither SKILL stop fired, `agent-prompt --roster`
  // threw "the plan has no `chunks[]`" on the first diff-reading role, and
  // the parent reported "Review did not complete" over a decided round.
  if (
    // …and only when no MORE SPECIFIC stop already fired. The
    // unchanged-since-last-round round also keeps zero sections, and it has a
    // reason of its own that SKILL.md branches on separately; overwriting it
    // here sent that round down the wrong branch.
    nothingToReview === undefined &&
    incremental !== undefined &&
    plan.chunks.length === 0 &&
    capture.skipped.length === 0 &&
    treeHeldStill &&
    // …and NOT a file review, the same exclusion both sibling stops carry.
    // A file review whose anchored change was discarded has nothing in the
    // slice, but SKILL.md owes it a whole-file review exactly as it does for
    // the no-cache case — and without this the two disagreed on identical
    // trees: with a cache the round completed decided, without one it routed
    // to the whole-file review.
    args.file === undefined
  ) {
    // …and the visibility bits are clean, the same gate both sibling stops
    // carry: the empty slice proves only what `git diff` can see. Withheld,
    // the refusal is said out loud like the unchanged stop's own.
    const invisible = invisibleTracked();
    if (invisible !== null && invisible.length === 0) {
      if (args.untracked !== false) {
        nothingToReview = { reason: 'scope-emptied' };
      } else {
        // The emptied scope proves only the TRACKED content returned to the
        // cached state — neither round enumerated untracked files (the gate
        // admits no narrower round than the cache). The same exclusion both
        // sibling stops carry, out loud.
        writeStderrLine(untrackedStopRefusal());
      }
    } else {
      writeStderrLine(invisibleStopRefusal(invisible));
    }
  }

  // Published at a name the PARENT can predict, beside the plan rather than
  // inside it. `qwen review run` has to find this without knowing `--out`:
  // that path is the orchestrator's to choose (SKILL.md says so, and it must,
  // because the CLI-derived `<target>` token does not exist yet at Step 1),
  // so a parent polling `qwen-review-<target>-plan.json` found nothing for
  // every file review and reported "Review did not complete" over a decided
  // round. This name is derived from the same `target` the parent derives.
  if (nothingToReview) {
    writeFileSync(
      tmpFile(target, 'stop.json'),
      `${JSON.stringify(
        {
          ...nothingToReview,
          // The parent's stamp, echoed back. This file decides `completed`,
          // while its NAME is the flattened target token — not injective, so
          // a concurrent review whose path flattens alike writes the same
          // path and would decide the other run's completion. Absent when the
          // capture was not launched by `qwen review run`, which is exactly
          // when no parent is reading.
          ...(process.env['QWEN_REVIEW_RUN_ID']
            ? { runId: process.env['QWEN_REVIEW_RUN_ID'] }
            : {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
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
    ...(nothingToReview ? { nothingToReview } : {}),
    // Where this target's cache lives, resolved by the deriver rather than
    // predicted by the reader. Every ledger read and the Step 8 write name
    // `<target>.json`, and `target` does not exist until this command derives
    // it — `safeTarget` is not hand-reproducible in the cases that matter
    // (past 64 characters it suffixes a digest, and symlink canonicalisation
    // diverges from any hand recipe). A round-2 medium review of
    // `srclink/foo.ts` predicted `srclink_foo.ts.json`, found nothing, and
    // ruled on zero ledger entries over a Critical that still stood.
    cachePath: cachePathFor(target, sourcePath),
    cacheCandidatePath,
    ...(candidateWritten ? { cacheCandidateStateId: candidate.stateId } : {}),
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
        : file !== undefined
          ? // The same exclusion the field gate above applies: an empty diff
            // is not a decided round for a FILE target. The capture was
            // pathspec-scoped, so 0 chunks says nothing about the tree — and
            // SKILL's no-diff branch owes a whole-file review for exactly
            // this shape. The field channel got the exclusion; this prose
            // channel — which the orchestrator also reads — did not, and a
            // round that stopped on it left the user-named file unread.
            '0 chunks — no diff was captured for the file the review named. ' +
            'This is NOT a decided stop: the no-diff branch owes it a ' +
            'whole-file review — read the file and review its current ' +
            'state; do not report nothing-to-review.'
          : treeHeldStill &&
              vanishedPresent.length === 0 &&
              invisibleCertified()
            ? // The prose channel carries the field gate's untracked
              // exclusion too — the orchestrator reads BOTH, and a prose
              // "clean" beside a withheld field re-opens the contradiction
              // the moved-tree branch below closed.
              args.untracked !== false
              ? 'WARNING: the working tree is clean — 0 chunks. There is nothing ' +
                'to review; do not run the review agents.'
              : '0 chunks — the tracked tree is clean, but untracked files ' +
                'were not enumerated (--no-untracked). This is NOT a decided ' +
                'clean tree: report the untracked scope under "Not ' +
                'reviewed" and end the round without a clean verdict.'
            : vanishedPresent.length > 0
              ? // …and NOT when the anchor refusal just proved a path
                // diverges while invisible to `git diff` — the field gate
                // above withheld the stop, so the prose must not claim clean
                // either. Same discipline as the moved-tree branch beside it.
                'WARNING: 0 chunks, but a cached path dropped out of this ' +
                'capture while still on disk and diverges from HEAD (above): ' +
                'this is NOT a clean tree — the divergence is invisible to ' +
                '`git diff`. Re-run the review rather than reporting ' +
                'nothing to review.'
              : !treeHeldStill
                ? // …and NOT when the guard just proved the tree moved. The
                  // machine-readable stop is gated on `treeHeldStill`; this
                  // sentence was not, so the round printed "the working tree
                  // changed while the capture was being hashed" and "the working
                  // tree is clean" back to back and the orchestrator — which reads
                  // prose here — stopped on the second. The same contradiction the
                  // field-level gate closed, one layer up.
                  'WARNING: 0 chunks, but the working tree changed while the ' +
                  'capture was being hashed (above): this is NOT a clean tree. ' +
                  'Re-run the review rather than reporting nothing to review.'
                : // The shape that remains: the tree held still and no cached
                  // path diverges, but tracked paths carry a visibility bit
                  // (or the bits could not be enumerated), and the field gate
                  // above withheld the stop over it.
                  (() => {
                    const inv = invisibleTracked();
                    return inv === null
                      ? 'WARNING: 0 chunks, but the tracked-file visibility ' +
                          'bits could not be enumerated (`git ls-files -v` ' +
                          'failed): this is NOT a clean tree. Re-run the ' +
                          'review rather than reporting nothing to review.'
                      : `WARNING: 0 chunks, but ${inv.length} tracked ` +
                          'path(s) carry an --assume-unchanged/--skip-worktree ' +
                          `bit (e.g. ${display(inv[0].slice(0, 96))}): ` +
                          '`git diff` is blind to any edit on them, so this ' +
                          'is NOT a clean tree. Clear the bit(s) and re-run ' +
                          'the review rather than reporting nothing to review.';
                  })(),
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
          'Target suffix for the artifact names. Defaults to `local`; a `--file` review derives it from the file path and ignores this.',
      })
      .option('untracked', {
        type: 'boolean',
        default: true,
        describe:
          'Include untracked, non-ignored files. On by default: `git diff` cannot see them, so without this a brand-new file goes unreviewed.',
      })
      .option('effort', EFFORT_OPTION)
      .option('cache', {
        type: 'string',
        describe:
          "The previous local round's review cache — the file, or the " +
          'DIRECTORY holding it (`.qwen/review-cache`), in which case this ' +
          "command resolves this target's cache file — the same spelling " +
          'the plan publishes as `cachePath` — from the target IT derives. ' +
          'Prefer the directory for a file review: the target is ' +
          "this command's to compute, and a caller that predicts the name " +
          'gets it wrong for any non-canonical spelling. When the anchor ' +
          'validates — same identity, same HEAD — the capture is scoped to ' +
          'files whose content changed since that round, widened by one ' +
          'import hop; on any refusal it degrades to the full capture and ' +
          'says why.',
      }),
  handler: (argv) => {
    runCaptureLocal(argv as unknown as CaptureLocalArgs);
  },
};
