/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Centralised path constants and helpers for the `qwen review` subcommands.
// Review artifacts are relative to the project root; user-private runtime
// preferences resolve under Storage's project directory. Use `path.join`
// rather than string concatenation so Windows backslashes are produced.

import { existsSync, realpathSync, statSync } from 'node:fs';

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import { safeTarget } from '../../../utils/paths.js';
import { inertText } from './inert-text.js';

/**
 * Classify a `--out` target BEFORE the command fetches anything: an empty /
 * whitespace-only path, or a path that resolves to an existing directory, is
 * a usage error. A directory target otherwise survives to `writeFileSync`,
 * dies EISDIR there — AFTER the fetches — and exit-codes as a runtime
 * failure instead of the repairable-invocation class the caller keys on.
 */
export function assertWritableOutPath(out: string): void {
  if (out.trim() === '') {
    throw new TypeError('--out must name a file path');
  }
  // A trailing separator is the POSIX spelling of "this is a directory" —
  // `resolve` normalizes it away, so check the RAW value: otherwise a
  // not-yet-existing `--out /tmp/diffs/` slips past and gets written as a
  // FILE after the fetches (every POSIX peer refuses that argument).
  if (/[/\\]$/.test(out.trim())) {
    throw new TypeError(`--out names a directory, not a file: ${out}`);
  }
  const resolved = resolve(out);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    throw new TypeError(`--out names a directory, not a file: ${out}`);
  }
}

export const REVIEW_TMP_DIR = join('.qwen', 'tmp');
export const REVIEWS_DIR = join('.qwen', 'reviews');
export const REVIEW_CACHE_DIR = join('.qwen', 'review-cache');

/**
 * Filename prefix for review-worktree lease files under `REVIEW_TMP_DIR`.
 * Lives here, not in `review-worktree-lease.ts`, because the review
 * workflow's cleanup sweep deletes leases by glob — the sweep pattern and
 * the lease writer must share one definition (the cleanup spec pins both).
 */
export const LEASE_PREFIX = 'qwen-review-lease-';

/**
 * Where the skill tees `qwen review parse-args`'s verdict (SKILL Step 0). A fixed,
 * conventional name so a capture command can read back the effort the parser
 * already resolved without the orchestrator threading the `--effort` value through
 * by hand — see `resolveEffort`.
 */
export const PARSE_ARGS_REPORT = join(
  REVIEW_TMP_DIR,
  'qwen-review-parse-args.json',
);

/** User-private path for the last effort explicitly typed in this project. */
export function lastReviewEffortPath(
  projectRoot: string,
  sessionProjectDir?: string,
): string {
  const owner = sessionProjectDir?.trim()
    ? resolve(sessionProjectDir)
    : new Storage(projectRoot).getProjectDir();
  return join(owner, 'review-last-effort');
}

/** Worktree path for a given PR review session. */
export function worktreePath(prNumber: string | number): string {
  return join(REVIEW_TMP_DIR, `review-pr-${prNumber}`);
}

/**
 * The disposable worktree the test-efficacy probe runs in — a sibling of the
 * shared review worktree, discarded wholesale when the probe finishes (#6832).
 *
 * This returns an ABSOLUTE path. The probe drives `git worktree add`/
 * `remove` with the shared worktree as cwd, so a relative path would resolve
 * against that worktree, not the repo root, and land the probe tree nested
 * inside the tree it is meant to sit beside. Both call sites — the probe and
 * `cleanup.ts`'s stale-tree sweep — go through here so the `-probe` suffix and
 * this normalisation stay in one place; renaming the suffix in one file used to
 * silently stop the other from sweeping.
 */
export function probeWorktreePath(worktree: string): string {
  return `${resolve(worktree)}-probe`;
}

/**
 * The merge-base tree an A/B probe compares against — a second sibling of the
 * review worktree, holding the code as it stood *before* the PR.
 *
 * Absolute for the same reason as `probeWorktreePath`: `git worktree add` runs
 * with the review worktree as cwd, so a relative path would land the base tree
 * nested inside the tree it is meant to sit beside. Kept here beside its sibling
 * so `base-tree` and `cleanup.ts`'s sweep cannot drift apart on the suffix —
 * the failure mode that made the probe tree's helper shared in the first place.
 */
export function baseWorktreePath(worktree: string): string {
  return `${resolve(worktree)}-base`;
}

/**
 * The infix that marks a verifier's private scratch worktree. Private to this
 * module and reached through the two functions below, so the creator
 * (`scratch-tree`) and the sweeper (`cleanup.ts`, which can only match on the
 * prefix — the label half is per-agent and unknown to it) cannot drift apart on
 * it, the way the `-probe` suffix once did.
 */
const SCRATCH_INFIX = '-scratch-';

/**
 * A Step 4 verifier's own throwaway worktree — the tree its probes run in
 * (#9207).
 *
 * The review worktree is READ by concurrent agents for the whole run: the
 * pipelined loop launches round k's verifiers alongside round k+1's reverse
 * auditors, all pinned to that one tree by `working_dir`. A verifier that
 * writes a probe file there, or applies the one-line fix its flip-check needs,
 * is mutating a tree other agents are reading mid-review — measured live, an
 * auditor read a probe's mutant plus a leftover probe test and nearly filed a
 * Critical against residue no commit contains. Restoring afterwards does not
 * close it; the exposure is the window *during* the probe.
 *
 * So each verifier gets its own, and the LABEL is what keeps them apart: shards
 * of one round run concurrently too, and a shared scratch tree would just move
 * the same race one level down (shard B's probe editing the file shard A is
 * measuring). Callers pass their record key, which is already unique per role,
 * round and findings digest.
 *
 * Absolute, and for the same reason as {@link probeWorktreePath}: `git worktree
 * add` runs with the review worktree as cwd, so a relative path would land the
 * scratch tree *inside* the tree it is meant to sit beside — the one place it
 * must never be, since that is the tree it exists to keep clean.
 */
export function scratchWorktreePath(worktree: string, label: string): string {
  const safe = scratchLabel(label);
  // A label that flattens to nothing would name the tree after the PREFIX
  // itself — one tree for every agent whose label happened to be unusable, and
  // a path `cleanup`'s prefix sweep matches as a whole family. Refusing is the
  // fail-closed direction: the caller (`scratch-tree`) turns this into an
  // `available: false` the verifier can act on.
  if (!safe) {
    throw new TypeError(
      `scratch label ${JSON.stringify(label)} keeps no path-safe character ` +
        '(A-Za-z0-9._-); a tree cannot be named for it',
    );
  }
  return `${resolve(worktree)}${SCRATCH_INFIX}${safe}`;
}

/**
 * The `<worktree>-scratch-` prefix every scratch tree of one review shares, so
 * `cleanup` can sweep a family whose members it cannot name.
 */
export function scratchWorktreePrefix(worktree: string): string {
  return `${resolve(worktree)}${SCRATCH_INFIX}`;
}

/**
 * A scratch label reduced to one safe path component.
 *
 * The label reaching this is a record key (`verify--round-2--<digest>`), but it
 * arrives over a CLI flag, so it is treated as untrusted: a `../` in it would
 * put the tree — and the `git worktree add` that creates it, and the sweep that
 * later deletes it — somewhere else entirely. Same flattening as
 * {@link safeTarget}, plus a length cap: the suffix rides on a path that is
 * already deep, and a 200-character label is how a `git worktree add` starts
 * failing with ENAMETOOLONG on the platforms with the shortest limits.
 *
 * Exported because the label makes one more journey the path does not:
 * `agent-prompt` writes it into a shell command inside the verifier's brief.
 * Sanitising there with this same function keeps the label shell-inert (no
 * quoting to get right, no metacharacter to reach a shell) AND keeps the brief
 * honest — the flag it shows is exactly the label the tree will be named for.
 *
 * Returns the empty string when nothing survives, and deliberately does NOT
 * substitute a default: `???` and `!!!` are two different labels that flatten
 * to nothing, and a shared default would put two shards in one tree — the race
 * the label exists to prevent, reached through the sanitiser.
 */
export function scratchLabel(label: string): string {
  return (
    label
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/\.\.+/g, '_')
      // Leading `.`/`_` would make a hidden directory; a leading `-` is worse
      // than cosmetic — the label is welded into `scratch-tree --label <it>`,
      // and yargs reads `-rm` as flags, so the command dies before it can
      // report while the brief still shows a label.
      .replace(/^[._-]+/, '')
      .slice(0, 64)
  );
}

/** Local branch ref name for a fetched PR head. */
export function reviewBranch(prNumber: string | number): string {
  return `qwen-review/pr-${prNumber}`;
}

/**
 * Per-target side-file path (review JSON, PR context, presubmit report).
 *
 * Files live under `.qwen/tmp/` rather than the OS temp dir so the path is
 * stable across platforms (macOS's `os.tmpdir()` returns `/var/folders/...`,
 * not `/tmp` — using the project-local dir avoids that mismatch entirely)
 * and so they're scoped to the project rather than the user's whole machine.
 */
export function tmpFile(target: string, suffix: string): string {
  return join(REVIEW_TMP_DIR, `qwen-review-${safeTarget(target)}-${suffix}`);
}

/** Filename prefix used by `tmpFile`; useful for cleanup globbing. */
export function tmpPrefix(target: string): string {
  return `qwen-review-${safeTarget(target)}-`;
}

/**
 * A PR-controlled path, flattened for display inside a brief, a prompt, or a
 * terminal line. The brief is the file the agent is told is the whole of its
 * instructions — a git path can legally contain newlines, and a newline inside
 * an interpolated path would let PR content open its own Markdown line there.
 * Functional arguments (the `read_file` path) are JSON-quoted instead, which
 * both survives the newline and remains the parseable single-line form the
 * transcripts checks read.
 *
 * Lives here, not in `agent-prompt.ts`, because residue paths reach two more
 * sinks the same way: `scratch-tree`'s verifier-facing note and the
 * orchestrator's stderr warning. Both render paths that git reports verbatim
 * (the residue probe reads the NUL format precisely so names arrive intact),
 * so both need the same flattening — a control sequence in a filename must not
 * reach a terminal from any of the three.
 */
export function inertPath(p: string): string {
  // `\p{Cc}` covers every control character (newlines, tabs, ESC — a terminal
  // control sequence in a filename must not reach a terminal either); `\p{Cf}`
  // covers the INVISIBLE ones that survive it — bidi overrides and isolates
  // (U+202A-202E, U+2066-2069) can reverse the rendering of the rest of the
  // line, and zero-width joiners and the BOM hide characters inside a path a
  // reader is being asked to judge; `\p{Zl}`/`\p{Zp}` are the line and
  // paragraph separators, which open a new line in the Markdown the same way a
  // newline does. U+2500 is the roster separator glyph, and the backtick would
  // close the Markdown code span these paths are rendered inside, letting the
  // tail of a filename run as markup in the file the agent treats as
  // authoritative.
  return p.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u2500`]+/gu, ' ');
}

/**
 * `realpathSync(p)`, or the same answer for a path whose leaf does not exist
 * yet: resolve the deepest ancestor that does, then re-append what was walked
 * past. A path with no existing ancestor at all (an unreachable mount, a
 * hostile chain) comes back untouched — the caller's containment check still
 * rules on it, and refusing to name it at all would fail reviews that work.
 */
function canonicalise(abs: string): string {
  const walked: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return walked.length === 0 ? real : join(real, ...walked.reverse());
    } catch {
      const parent = resolve(cur, '..');
      // `resolve('/', '..')` is `/`: the root is its own parent, so this is
      // the termination condition, not a step.
      if (parent === cur) return abs;
      // Strip only THIS platform's separators: `\` is a legal POSIX
      // filename byte (this PR's own `notes\` fixtures insist on it), and
      // the two-class strip corrupted a leaf like `\link` into `link` on
      // the walk-up — the capture then diffed a different name and the real
      // file dropped mutely (R23: dangling `\link` at the repo root is the
      // end-to-end shape, since only a realpath FAILURE reaches this walk).
      walked.push(
        cur.slice(parent.length).replace(sep === '/' ? /^\/+/ : /^[\\/]+/, ''),
      );
      cur = parent;
    }
  }
}

/**
 * Where a user-supplied path sits relative to the repository root — the ONE
 * answer both the parent's artifact pin and the child's capture must read.
 *
 * `qwen review run <file>` pins the artifact name it polls for from this, and
 * `capture-local --file` scopes the diff from it. When the two spell the same
 * file differently the parent polls a name no child ever writes: the review
 * runs, posts, and then reports "no composed verdict was produced". They drifted
 * once already, and the two corners below are why one call site cannot be
 * trusted to re-derive it.
 *
 * `resolve` does not follow symlinks while `rev-parse --show-toplevel` returns
 * the CANONICAL root — on macOS `/tmp` is a symlink to `/private/tmp`, so a
 * path typed under `/tmp` relativises against a root sharing no prefix with it
 * and comes back as a `..` walk out of a repository it is plainly inside.
 * `realpathSync` throws on a path not on disk yet, which a reviewed file may
 * legitimately be (a brand-new untracked file is exactly that feature's
 * subject) — so the canonicalisation resolves the nearest ancestor that DOES
 * exist and re-appends the rest, which is what makes the symlinked prefix and
 * the not-yet-created file hold at the same time rather than one at a time.
 *
 * And `rel.startsWith('..')` is not the containment check it looks like: a
 * file called `..foo.ts` at the repository root relativises to `..foo.ts` and
 * would be read as having escaped. What escapes is `..` itself, a path whose
 * FIRST SEGMENT is `..`, or an absolute one (no relative spelling exists).
 */
export function repoRelativeOf(
  repoRoot: string,
  file: string,
  from: string = process.cwd(),
): { rel: string; abs: string; escapes: boolean } {
  const abs = canonicalise(resolve(from, file));
  const rel = relative(repoRoot, abs);
  // `rel === ''` is the repository ROOT, which is inside the repository — the
  // one place the old test called an escape. `classifyRunTarget` accepts a
  // directory target explicitly ("a tab-completed `src/` classifies as a file
  // target"), so the root is a reachable one, and treating it as an escape
  // split the two sides that must agree: the parent fell back to pinning the
  // typed spelling while the child derived `safeTarget('') === 'target'`, so
  // the poll never matched and a review that had run — and with `--comment`
  // already posted — reported no verdict. `--file <root>` also threw the
  // self-contradictory "resolves to <root>, which is outside the repository
  // at <root>". As a pathspec `.` scopes the diff to the whole tree, which is
  // what naming the root asks for.
  const escapes = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
  // Git spells every path with forward slashes on every platform, and `rel`
  // flows VERBATIM into git pathspecs, the candidate's recorded `source`,
  // and `cachePathFor`'s digest — where node's win32 `relative()` answers
  // backslashes, one file got two different cache filenames across
  // platforms and the win32 lane failed every assertion spelling the posix
  // form (R21-1). Normalized HERE, after the escape check computed against
  // the platform separator, so both consumers of `rel` see one spelling.
  return { rel: sep === '/' ? rel : rel.split(sep).join('/'), abs, escapes };
}

/**
 * Refuse a write whose PARENT CHAIN is redirected.
 *
 * `noFollow` protects the final path element only, and the threat these
 * commands police — a contributor branch committing a symlink at a
 * deterministic in-repo path — is satisfied one layer up just as well: plant
 * `.qwen/tmp` or `.qwen/review-cache` itself as a link (gitignore does not
 * stop `git add -f`), and `mkdirSync(…, {recursive:true})` succeeds through
 * it while the atomic tmp+rename lands the file in the attacker's directory,
 * over whatever of that name lives there. Comparing the resolved parent
 * against its lexical form catches a link ANYWHERE in the chain, which is
 * what the final-element guard cannot do.
 *
 * Shared, because the three writers that need it are the three that write a
 * deterministic in-repo path — the promoted cache and both candidate files —
 * and the one that had it while the others did not is how a candidate whose
 * path the plan then advertised became an attacker-chosen file.
 */
export function assertUnredirectedParent(
  target: string,
  what: string,
  command: string,
): void {
  const parent = resolve(dirname(target));
  let real: string;
  try {
    real = realpathSync(parent);
  } catch (err) {
    throw new Error(
      `${command}: cannot resolve the ${what} directory ${inertText(parent)}: ` +
        inertText((err as Error).message),
    );
  }
  if (real !== parent) {
    throw new Error(
      `${command}: the ${what} directory ${inertText(parent)} resolves to ` +
        `${inertText(real)} — a symlink in the path would redirect this ` +
        `write outside the tree it names. Refusing.`,
    );
  }
}
