/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Capture the working tree's diff for a local /review — staged, unstaged, AND
// untracked.
//
// Why the third one is not a nicety: `git diff HEAD` reports changes to files
// git already tracks. A file the user created and has not `git add`ed is in
// neither the index nor HEAD, so it appears in **no** `git diff` output at all.
// The review therefore skipped brand-new files entirely — a new payment path, a
// new auth middleware, the whole file invisible — and when the new file was the
// *only* change, /review reported "no changes to review" and stopped.
//
// The fix must not fix it by staging things. `git add -N` would make untracked
// files show up in `git diff HEAD`, and it would do so by **writing to the
// user's index** — the same class of side effect the mandatory-worktree rule
// exists to prevent. Every new file would silently become a tracked, staged
// path in the user's repo because they asked for a code review. So each
// untracked file is diffed against `/dev/null` with `--no-index`, which touches
// nothing, and the sections are concatenated onto the tracked diff. A unified
// diff is a concatenation of per-file sections; the result parses exactly like
// any other.

import { lstatSync, statSync, type Stats } from 'node:fs';
import { join, sep } from 'node:path';
import { repoRelativeOf } from './paths.js';
import { parseDiff, sliceDiffByLines } from './diff-plan.js';
import {
  LITERAL_PATHSPECS,
  NULL_DEVICE,
  PINNED_DIFF_CONFIG,
  PINNED_DIFF_FLAGS,
} from './diff-flags.js';
import {
  git,
  gitRaw,
  gitRawTolerateDiff,
  gitWithInput,
  refExists,
} from './git.js';

/**
 * Untracked files above this size are named but not diffed.
 *
 * An untracked file is whatever the user happened to leave in the tree, and
 * `--exclude-standard` only filters what `.gitignore` covers. A 200 MB core
 * dump, a captured pcap, a vendored tarball that nobody ignored: inlining one
 * into the review diff buys nothing and pushes every real hunk past the chunk
 * planner's budget. They are reported to the caller instead of dropped in
 * silence — a review that quietly skipped a file is the bug this module exists
 * to fix, and re-introducing it one size class up would be a poor trade.
 */
export const MAX_UNTRACKED_BYTES = 1_000_000;

/**
 * Ceilings on the untracked pass as a whole.
 *
 * `MAX_UNTRACKED_BYTES` bounds any one file; nothing bounded the *set*, and each
 * untracked file costs one synchronous `git` spawn. A working tree whose
 * `.gitignore` does not yet cover `node_modules` — `git init` followed by
 * `npm install`, which is a normal Tuesday — offers tens of thousands of
 * untracked files, and the capture would sit there spawning `git` once per file
 * for minutes before the review began. The old bug made `/review` show nothing;
 * an unbounded fix would make it hang, which is not obviously an improvement.
 *
 * A count this far above any real change (500 new files in one review is already
 * extraordinary; `node_modules` is a hundred times that) means the tree's ignore
 * rules are broken, not that the user wrote a lot of code. So the pass is
 * abandoned wholesale rather than reviewing an arbitrary alphabetical prefix of
 * a build directory — and, being checked before the loop, it costs zero spawns.
 * The user is told, loudly, in the one place that can act on it.
 */
export const MAX_UNTRACKED_FILES = 500;
export const MAX_UNTRACKED_TOTAL_BYTES = 10_000_000;

/** An untracked file the capture did not review, and why. Never dropped mutely. */
export interface SkippedFile {
  path: string;
  /** Size in bytes, or null when the file could not be stat-ed at all. */
  bytes: number | null;
  reason: string;
}

export interface LocalDiffCapture {
  /** The captured diff: tracked sections first, then untracked ones. */
  diff: Buffer;
  /** Untracked files whose full contents were added to the diff. */
  untracked: string[];
  /** Untracked files that were NOT reviewed. Report every one of them. */
  skipped: SkippedFile[];
  /** True when HEAD does not exist yet (a repo with no commits). */
  unbornHead: boolean;
  /** The repo root every path in the capture is relative to. */
  repoRoot: string;
}

/**
 * The empty tree, in this repository's object format.
 *
 * `git diff <empty-tree>` is what "everything is new" means to git, and it is
 * what an unborn HEAD needs — `git diff HEAD` in a repo with no commits fails
 * outright ("fatal: bad revision 'HEAD'") rather than treating everything as
 * new. The famous `4b825dc…` is the SHA-**1** empty tree and is simply not an
 * object in a SHA-256 repository, so hardcoding it trades one hard failure for
 * a rarer one. Ask git instead; `hash-object` without `-w` computes and writes
 * nothing.
 */
function emptyTree(repoRoot: string): string {
  // `--stdin` with nothing on it, rather than naming the null device. Git's
  // special-casing of `/dev/null` and `NUL` lives in `diff-no-index.c`'s
  // `get_mode()` — it is on the *diff* code path only. `hash-object` reaches the
  // file through `hash_fd()`, which has no such case, so on Windows it would try
  // to open `NUL` as an ordinary file. An empty stdin needs no device name and
  // no platform branch at all.
  return gitWithInput(Buffer.alloc(0), [
    '-C',
    repoRoot,
    'hash-object',
    '-t',
    'tree',
    '--stdin',
  ]);
}

/**
 * Why git will not be able to diff this entry as a file, or null if it will.
 *
 * `ls-files --others` names three kinds of thing — regular files, symlinks, and
 * directories (it silently ignores FIFOs, sockets and device nodes, so those
 * never arrive here). Directories are the problem, and git's `--no-index`
 * decides what an argument *is* from its **resolved** type:
 *
 * - An **embedded git repository** arrives as `nested/`. Git will not recurse
 *   into another repo, so it hands back the directory itself; `--no-index` then
 *   switches to directory-diff semantics and joins the other operand into it
 *   (`error: Could not access 'nested/null'`).
 * - A **symlink to a directory** arrives as a plain name and resolves the same
 *   way, which is why `lstat` alone cannot judge it and this follows the link
 *   before deciding.
 * - A **symlink to a file** is diffable and must pass: git renders the *link
 *   text* at mode 120000. A **dangling** symlink is diffable for the same reason
 *   — the link text does not depend on the target existing — and it is worth
 *   reviewing precisely *because* it points nowhere, so a failed `stat` here
 *   means "let git have it", not "skip".
 *
 * Anything unforeseen still fails closed: git either errors or produces nothing,
 * and the caller records it as unreviewed rather than as reviewed.
 */
function describeUndiffable(abs: string, st: Stats): string | null {
  if (st.isDirectory()) {
    return (
      'is a directory (an embedded git repository, most likely) — git cannot ' +
      'diff it as a file'
    );
  }
  if (st.isSymbolicLink()) {
    try {
      return statSync(abs).isDirectory()
        ? 'is a symlink to a directory — git cannot diff it as a file'
        : null;
    } catch {
      return null; // Dangling. Git diffs the link text; let it.
    }
  }
  return null;
}

/**
 * Turn a user-supplied `--file` into a pathspec git will read as **this one
 * file**, from the repo root.
 *
 * Two things are wrong with passing it through untouched.
 *
 * It is relative to where the *user* typed it, and every git call below runs
 * with `-C <repoRoot>`. `qwen review capture-local --file src/foo.ts` from
 * `packages/cli` would therefore look for `<repo>/src/foo.ts` — a different
 * file, usually a nonexistent one — and report no changes.
 *
 * And `--` ends option parsing without disabling **pathspec magic**. A filename
 * is not a pathspec: `a[bc].ts` is a *glob*, and asking git to diff it returns
 * `ab.ts` and `ac.ts` as well, so a review scoped to one file silently reviews
 * others. `--literal-pathspecs` (applied at every call site below) turns the
 * whole argument back into a plain name.
 */
function toRepoPathspec(repoRoot: string, file: string): string {
  // `resolve` does not follow symlinks, but `rev-parse --show-toplevel` returns
  // the canonical root — on macOS `/tmp` is a symlink to `/private/tmp`, so a
  // `--file` given under `/tmp` relativises against a root that shares no prefix
  // with it and the containment check below rejects a file that is plainly
  // inside the repo. Canonicalise both sides before comparing. `realpathSync`
  // throws on a path that does not exist yet, which a `--file` may legitimately
  // be (a brand-new untracked file is exactly this feature's subject), so fall
  // back to the non-canonical form rather than failing the review.
  // Canonicalisation and the segment-aware escape check live in
  // `repoRelativeOf` because `qwen review run` pins the artifact name it polls
  // for from the same answer; a second derivation here is how the two spellings
  // drifted before.
  const { rel, abs, escapes } = repoRelativeOf(repoRoot, file);
  if (escapes) {
    throw new Error(
      `--file ${file} resolves to ${abs}, which is outside the repository ` +
        `at ${repoRoot}.`,
    );
  }
  // git speaks forward slashes even on Windows.
  return rel.split(sep).join('/');
}

/**
 * True when git rendered this file as a binary blob rather than as text.
 *
 * `Binary files /dev/null and b/logo.png differ` — that is the entire body. The
 * section parses, and it contains nothing to review.
 */
export function isBinarySection(section: Buffer): boolean {
  // Both halves of the old test were wrong, in opposite directions.
  //
  // It read only the first 4096 bytes, on the theory that a binary section is
  // short. Its *header* is short; the path in that header is not bounded, and a
  // Linux path can run to 4096 bytes on its own. Push git's marker past the
  // window and the file reads as text — which certifies unreadable bytes as
  // reviewed, the exact lie this function was added to stop.
  //
  // And it looked for `GIT binary patch` as a substring anywhere. That is a
  // sentence, and sentences appear in prose: a Markdown file with the line
  // `+GIT binary patch is a format git uses` was classified binary and thrown
  // away. Git writes both markers as whole records at the start of a line, so
  // match them there. The section is bounded by the per-file cap, so scanning it
  // is not the expense the window was avoiding.
  return /^(Binary files .* differ|GIT binary patch)$/m.test(
    section.toString('utf8'),
  );
}

/** Repo-root-relative paths of untracked, non-ignored files. */
function listUntracked(
  repoRoot: string,
  pathspec?: string,
  excludeStandard = true,
): string[] {
  const args = [
    '-C',
    repoRoot,
    LITERAL_PATHSPECS,
    'ls-files',
    '--others',
    // Deliberately named plumbing wins over ignore rules — repos ordinarily
    // ignore `.qwen/` (this repo's own `.gitignore` does), and exclusion
    // applies to an explicitly pathspec-NAMED file too, so with the flag the
    // named file never reached the filter at all and the round reported
    // clean over the one file it was asked about.
    ...(excludeStandard ? ['--exclude-standard'] : []),
    '--full-name',
    '-z',
  ];
  // `--` separates paths from options, so a file named `--cached` cannot be
  // read as a flag. It does not stop git reading the name as a glob; that is
  // what `--literal-pathspecs` above is for.
  if (pathspec) args.push('--', pathspec);
  const out = gitRaw(...args).toString('utf8');
  // `-z` because a filename may legally contain a newline. Splitting on '\n'
  // would turn one such file into two nonexistent ones.
  return out.split('\0').filter((p) => p !== '');
}

/**
 * Diff one untracked file against `/dev/null`.
 *
 * Runs from the repo root with a root-relative path, so the `+++ b/<path>`
 * header git writes matches what `git diff HEAD --no-relative` writes for
 * tracked files. Without that, a capture started from a subdirectory would
 * label tracked files from the repo root and untracked ones from the cwd, and
 * two names for one directory tree is how an anchor stops matching.
 */
function diffUntracked(repoRoot: string, path: string): Buffer {
  return gitRawTolerateDiff(
    '-C',
    repoRoot,
    LITERAL_PATHSPECS,
    ...PINNED_DIFF_CONFIG,
    'diff',
    '--no-index',
    ...PINNED_DIFF_FLAGS,
    '--',
    NULL_DEVICE,
    path,
  );
}

/**
 * Capture staged + unstaged + untracked changes as one unified diff.
 *
 * `file` scopes the capture to a single path (a `/review <file-path>` target).
 * Nothing here writes to the index, the worktree, or any ref.
 */
/**
 * Is this repo-relative path the review's own plumbing?
 *
 * Segment-exact at ANY depth, not anchored to the cwd. The three constants in
 * `paths.ts` are cwd-relative for every invocation, so a round started from
 * `sub/` writes `sub/.qwen/…` — which a filter built from THIS invocation's
 * cwd does not match. A repo that does not ignore `.qwen` then lets the next
 * root-invoked round capture the previous round's cache, reports, and args
 * record as the user's untracked work, and the cache changes every round by
 * construction, so an incremental round could never again report "no
 * changes". Matching the segment wherever it sits closes both directions with
 * no dependence on where either round ran.
 *
 * Segment-exact matters for the same reason `toRepoPathspec` records: a
 * directory named `.qwen-notes` or `tmpfiles` is the user's, not ours.
 */
export function isReviewPlumbing(repoRelPath: string): boolean {
  return /(?:^|\/)\.qwen\/(?:tmp|review-cache|reviews)(?:\/|$)/.test(
    repoRelPath,
  );
}

/**
 * The tracked diff with the review's own plumbing sections removed.
 *
 * Ignore rules never apply to TRACKED files, so a repo that once committed
 * its `.qwen` plumbing gets the cache back in `git diff HEAD` every round —
 * and Step 8 rewrites that cache after every clean round, so the section is
 * there by construction. The round then reviews its own ledger JSON, and
 * `changedSince` can never empty: the incremental loop can never report "no
 * changes". Exactly the pathology the untracked filter beside this exists to
 * prevent, on the half it could not reach.
 *
 * The exemption is a NAMED plumbing pathspec, file- or directory-shaped:
 * `/review .qwen/reviews/saved.md` is a deliberate request for exactly the
 * section this drop exists to remove, so whatever came back stays. A
 * NON-plumbing pathspec still drops: a directory target carries every
 * tracked section beneath it, and "whatever came back is what the user
 * asked for" is only true of file-shaped names — a repo that committed its
 * own plumbing would otherwise review its ledger JSON as user content under
 * a `sub/` target, and its every-round churn would keep `changedSince` from
 * ever emptying. This matches the untracked filter beside this, which drops
 * plumbing descendants of a directory target the same way.
 */
function dropPlumbingSections(diff: Buffer, pathspec?: string): Buffer {
  if (diff.length === 0) return diff;
  if (pathspec !== undefined && isReviewPlumbing(pathspec)) return diff;
  // The cap gate runs BEFORE any decode: an over-cap tracked diff is
  // rejected by the caller whole, never inlined, so parsing it first made
  // the pathological case this gate exists for pay the cost it avoids —
  // and near `gitRaw`'s 512 MiB ceiling an all-ASCII diff decodes past
  // Node's maximum string length, so the decode throws instead of
  // producing the caller's graceful skip record. The one semantic delta,
  // accepted: a diff whose plumbing DROP would have shrunk it under the
  // cap is rejected whole rather than rescued — an 11 MB diff is the cap's
  // pathology whatever it is made of, and the skip record says so.
  if (diff.length > MAX_UNTRACKED_TOTAL_BYTES) return diff;
  const files = parseDiff(diff.toString('utf8')).files;
  if (!files.some((f) => isReviewPlumbing(f.path))) return diff;
  return sliceDiffByLines(
    diff,
    files
      .filter((f) => !isReviewPlumbing(f.path))
      .map((f) => ({ startLine: f.diffStart, endLine: f.diffEnd })),
  );
}

export function captureLocalDiff(opts: {
  file?: string;
  includeUntracked?: boolean;
}): LocalDiffCapture {
  const { file, includeUntracked = true } = opts;
  // The launch directory this resolves from is judged by `lib/git`'s wrappers
  // (see `assertTrustedLaunchDir`), so the `rev-parse` below refuses before it
  // can answer through a rewritten pointer — which matters here because
  // `git diff` is not a safe read through a planted repository: it refreshes
  // the index (running any configured clean filter) and honours
  // `diff.<driver>.command`. No second gate at this call site: a duplicate
  // whose only contribution is a nicer message is one more thing to keep in
  // step with the real one.
  //
  // Everything below runs against the repo *root*, not the process's cwd. A
  // capture started from a subdirectory must still see the whole working tree —
  // and, more subtly, must label its files the same way `git diff --no-relative`
  // does, or the tracked and untracked halves of one diff would name the same
  // directory tree two different ways.
  const repoRoot = git('rev-parse', '--show-toplevel');

  // A repo with no commits has no HEAD to diff against, and `git diff HEAD`
  // there fails outright ("fatal: bad revision 'HEAD'") rather than treating
  // everything as new. Diff against the empty tree instead, which is what
  // "everything is new" means to git.
  const unbornHead = !refExists('HEAD');
  const base = unbornHead ? emptyTree(repoRoot) : 'HEAD';

  // The user typed `--file` relative to *their* directory; every git call here
  // runs with `-C <repoRoot>`. Re-base it, and strip it of pathspec magic.
  const pathspec = file ? toRepoPathspec(repoRoot, file) : undefined;
  // The user NAMED a plumbing path — a file or a directory under
  // `.qwen/tmp|review-cache|reviews` — when reviewing it is the point. Both
  // halves of the capture key on this one predicate so they cannot disagree:
  // the tracked drop keeps its sections, and the untracked filter lists its
  // files even when ignore rules cover them.
  const namedPlumbing = pathspec !== undefined && isReviewPlumbing(pathspec);

  // `git diff HEAD` is what covers the whole tracked scope: a bare `git diff`
  // omits staged changes.
  const trackedArgs = [
    '-C',
    repoRoot,
    LITERAL_PATHSPECS,
    ...PINNED_DIFF_CONFIG,
    'diff',
    ...PINNED_DIFF_FLAGS,
    base,
  ];
  if (pathspec) trackedArgs.push('--', pathspec);
  const trackedDiff = dropPlumbingSections(gitRaw(...trackedArgs), pathspec);

  const untracked: string[] = [];
  const skipped: SkippedFile[] = [];

  // The aggregate budget covered only untracked files; the tracked diff could
  // still grow to `gitRaw`'s 512 MiB buffer and then be concatenated, decoded,
  // and re-split by the planner. A tracked diff over the whole-capture cap is
  // itself the pathology the cap exists for — a generated file committed, a
  // vendored tree staged — so it is reported, not inlined.
  const parts: Buffer[] = [];
  if (trackedDiff.length > MAX_UNTRACKED_TOTAL_BYTES) {
    skipped.push({
      path: 'tracked changes',
      bytes: trackedDiff.length,
      reason:
        `the tracked diff is ${Math.round(trackedDiff.length / 1_000_000)} MB, ` +
        `over the ${Math.round(MAX_UNTRACKED_TOTAL_BYTES / 1_000_000)} MB ` +
        `capture cap — review it in smaller commits`,
    });
  } else {
    parts.push(trackedDiff);
  }

  if (includeUntracked) {
    // The review writes its own plumbing before and after this capture runs:
    // scratch files under `.qwen/tmp` (the args record, the diff, the plan),
    // the persistent incremental cache under `.qwen/review-cache` (rewritten
    // by Step 8 after every clean round), and per-round artifacts under
    // `.qwen/reviews`. In a repo that does not ignore `.qwen`, `ls-files
    // --others` lists all of them as the user's untracked work — and the
    // cache is worse than noise: hashed into its own next-round candidate it
    // changes every round by construction, so an incremental round could
    // never again report "no changes". None of it is ever the change under
    // review; drop it.
    //
    // …unless the user NAMED plumbing. An explicit `--file` under
    // `.qwen/reviews` is a deliberate request to review it — round notes, a
    // saved report — and dropping it here left the round claiming "the
    // working tree is clean, 0 chunks" over the one file it was asked about,
    // with no `Not reviewed` record: mute, which this module's `SkippedFile`
    // contract forbids. A NAMED plumbing path exempts itself and — for a
    // directory-shaped target — its children; everything else under the
    // plumbing directories is still dropped, exactly as the tracked half
    // drops plumbing sections under a non-plumbing directory target.
    const candidates = listUntracked(repoRoot, pathspec, !namedPlumbing).filter(
      (p) => namedPlumbing || !isReviewPlumbing(p),
    );

    if (candidates.length > MAX_UNTRACKED_FILES) {
      // Checked before the loop: the whole point is to spend zero spawns on a
      // tree whose ignore rules are broken.
      skipped.push({
        path: `${candidates.length} untracked files`,
        bytes: null,
        reason:
          `${candidates.length} untracked files exceeds the ` +
          `${MAX_UNTRACKED_FILES}-file cap, so NONE of them were reviewed. ` +
          `A count this size usually means .gitignore does not cover a build ` +
          `or dependency directory. Ignore them, or stage the ones you want ` +
          `reviewed, or re-run with untracked capture off.`,
      });
    } else {
      let budget = MAX_UNTRACKED_TOTAL_BYTES;
      for (const path of candidates) {
        let bytes: number;
        try {
          // `lstat`, not `stat`. Two things turn on it.
          //
          // `ls-files --others` names directory-shaped entries: an embedded git
          // repo comes out as `nested/`, and a symlink to a directory as a plain
          // name. `stat` follows the link and succeeds on both, and git then
          // fails to diff them — quietly, because it fails by exiting 1 with no
          // output, which used to read as "an empty diff". The path was recorded
          // as reviewed and nobody had looked at it: the exact lie this module
          // exists to prevent, and worse than the old bug, which at least never
          // claimed otherwise. A FIFO is worse still — git *blocks* reading it,
          // and the review hangs until the git timeout fires.
          //
          // And a symlink to a 5 MB file is 20 bytes of link text to git, not
          // 5 MB, so `stat`'s size would skip it against the wrong number.
          const abs = join(repoRoot, path);
          const st = lstatSync(abs);
          const kind = describeUndiffable(abs, st);
          if (kind) {
            skipped.push({ path, bytes: null, reason: kind });
            continue;
          }
          bytes = st.size;
        } catch (err) {
          // A path `ls-files` just named can still be unreachable: a build
          // script's scratch file removed underneath us, or a name whose bytes
          // do not survive the round-trip through a JS string on this platform.
          // Skipping it must not take the whole capture down — but it must not
          // be silent either.
          skipped.push({
            path,
            bytes: null,
            reason: `could not be read (${(err as Error).message})`,
          });
          continue;
        }

        if (bytes > MAX_UNTRACKED_BYTES) {
          skipped.push({
            path,
            bytes,
            reason: `${Math.round(bytes / 1000)} kB exceeds the ${Math.round(
              MAX_UNTRACKED_BYTES / 1000,
            )} kB untracked-file cap`,
          });
          continue;
        }
        if (bytes > budget) {
          skipped.push({
            path,
            bytes,
            reason:
              `the untracked capture reached its ` +
              `${Math.round(MAX_UNTRACKED_TOTAL_BYTES / 1_000_000)} MB total cap`,
          });
          continue;
        }

        let section: Buffer;
        try {
          section = diffUntracked(repoRoot, path);
        } catch (err) {
          // Fail closed. Whatever git could not render — a special file that
          // slipped the lstat gate, a permissions wall, a name it will not take
          // — is a file nobody reviewed, and it says so rather than joining
          // `untracked`, which claims the opposite.
          skipped.push({
            path,
            bytes,
            reason: `git could not diff it (${(err as Error).message.trim()})`,
          });
          continue;
        }

        // Charge the budget with what git actually produced, not with what
        // `lstat` said a moment earlier. The size gate above is a cheap way to
        // skip a file without spawning git; it is not a measurement of the diff,
        // and it is not even a measurement of the file — an editor writing the
        // file between the `lstat` and git's read makes it stale. The section in
        // hand is the only number that is true.
        if (section.length > MAX_UNTRACKED_BYTES) {
          skipped.push({
            path,
            bytes: section.length,
            reason:
              `its diff is ${Math.round(section.length / 1000)} kB, over the ` +
              `${Math.round(MAX_UNTRACKED_BYTES / 1000)} kB untracked-file cap ` +
              `(the rendered diff, not the file — unified-diff framing and a ` +
              `file that grew after it was measured both land here)`,
          });
          continue;
        }
        if (section.length > budget) {
          skipped.push({
            path,
            bytes: section.length,
            reason:
              `the untracked capture reached its ` +
              `${Math.round(MAX_UNTRACKED_TOTAL_BYTES / 1_000_000)} MB total cap`,
          });
          continue;
        }

        if (isBinarySection(section)) {
          // Git renders a binary file as the single line `Binary files ... differ`
          // and nothing else. The section is well-formed and parses, but it holds
          // not one byte an agent could read — so recording the path among the
          // files "whose contents are in the diff" is the same lie the directory
          // entries told, just quieter: a small PNG or a `.pyc` would be certified
          // as reviewed by a review that could not see it.
          skipped.push({
            path,
            bytes,
            reason:
              'is a binary file — git emits only a "Binary files differ" ' +
              'marker, so there is nothing for a reviewer to read',
          });
          continue;
        }

        budget -= section.length;
        parts.push(section);
        untracked.push(path);
      }
    }
  }

  return {
    diff: Buffer.concat(parts),
    untracked,
    skipped,
    unbornHead,
    repoRoot,
  };
}
