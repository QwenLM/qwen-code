/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Centralised path constants and helpers for the `qwen review` subcommands.
// Review artifacts are relative to the project root; user-private runtime
// preferences resolve under Storage's project directory. Use `path.join`
// rather than string concatenation so Windows backslashes are produced.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { sanitizeFilenameComponent, Storage } from '@qwen-code/qwen-code-core';
import { safeTarget } from '../../../utils/paths.js';

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
 * Where a generated review fan-out script has to live.
 *
 * Not a choice: `Workflow({scriptPath})` loads through
 * `readWorkflowFileSecurely`, which realpaths the file and accepts only the
 * two saved-workflow directories and the generated-scripts root,
 * `Storage.getGeneratedWorkflowsDir()` = `<projectDir>/workflows/generated`.
 * The saved directories are out: every `.js` in them is also a `/<name>`
 * slash command, and a review's fan-out has no business in the user's
 * command namespace. The generated root is reached through the same env the
 * harness exports for the transcript readers — `QWEN_CODE_PROJECT_DIR` is
 * `storage.getProjectDir()` of the session that will dispatch the script —
 * so the writer and the loader compute the same directory by construction.
 * Nested one level per session, so a session's scripts can be swept as a
 * unit and two sessions reviewing in one project never share a file.
 */
export const GENERATED_WORKFLOWS_SUBDIR = join('workflows', 'generated');

/** Subdirectory of the generated root that review scripts live under. */
export const REVIEW_WORKFLOWS_SUBDIR = 'review';

/** Filename prefix for generated fan-out scripts. */
export const REVIEW_WORKFLOW_PREFIX = 'qwen-review-';

/**
 * Why a generated script has nowhere to go. Never conflated with a bad plan:
 * the env contract is the harness's, not the caller's.
 */
export class GeneratedWorkflowDirUnavailableError extends Error {}

function projectDirFromEnv(env: NodeJS.ProcessEnv): string {
  const projectDir = env['QWEN_CODE_PROJECT_DIR']?.trim();
  if (!projectDir) {
    throw new GeneratedWorkflowDirUnavailableError(
      'the CLI did not export QWEN_CODE_PROJECT_DIR, so there is no directory ' +
        'the Workflow tool would load a generated script from. Run this ' +
        'command from inside a qwen session.',
    );
  }
  return projectDir;
}

/**
 * The per-session directory name. The sanitized prefix keeps the directory
 * readable and swept by the same rules as the harness's transcript dirs,
 * but sanitizing is lossy — `sess.1` and `sess_1` both flatten to
 * `sess_1` — so the digest of the RAW id is what keeps two concurrent
 * sessions apart: without it they would select the same script target for
 * the same plan, and the later atomic rename would dispatch one session's
 * roster, rules, and worktree pin to the other.
 */
function reviewSessionDirName(session: string): string {
  const digest = createHash('sha256').update(session).digest('hex').slice(0, 8);
  return `${sanitizeFilenameComponent(session)}-${digest}`;
}

/**
 * The directory this session's generated review scripts live in:
 * `$QWEN_CODE_PROJECT_DIR/workflows/generated/review/<session>`.
 *
 * Read from the environment, never from an argument, for the same reason the
 * transcript readers do: a path the model can choose is a path the model can
 * point somewhere the loader will refuse. The session component is sanitized
 * exactly as the harness sanitizes its transcript directory, so a session id
 * carrying a dot lands in a directory that exists.
 */
export function reviewWorkflowsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const session = env['QWEN_CODE_SESSION_ID']?.trim();
  return join(
    projectDirFromEnv(env),
    GENERATED_WORKFLOWS_SUBDIR,
    REVIEW_WORKFLOWS_SUBDIR,
    session ? reviewSessionDirName(session) : 'no-session',
  );
}

/**
 * The writer half of the loader's canonical-containment policy.
 * `readWorkflowFileSecurely` realpaths the script and refuses one outside
 * the trusted roots — and refuses a symlinked root outright — so a writer
 * that follows a link writes the script (embedding every review prompt)
 * where the loader will not read it, outside the root it was meant to stay
 * inside. Refuses a symlinked directory from the generated root down to the
 * session dir, creates the session dir, then proves the canonical session
 * dir stays under the canonical root. Call BEFORE building briefs or prompt
 * records: delivery evidence for a script that then has nowhere safe to go
 * would read to the coverage gate as a launched fan-out.
 */
export function ensureWritableReviewWorkflowsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const projectDir = projectDirFromEnv(env);
  const dir = reviewWorkflowsDir(env);
  const root = join(projectDir, GENERATED_WORKFLOWS_SUBDIR);
  for (const component of [root, join(root, REVIEW_WORKFLOWS_SUBDIR), dir]) {
    let isLink = false;
    try {
      isLink = lstatSync(component).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      break; // absent — the mkdir below creates it as a real directory
    }
    if (isLink) {
      throw new Error(
        `refusing to write a generated review script through the symlinked ` +
          `directory '${component}' — it would land outside the ` +
          'generated-workflows root the Workflow loader trusts.',
      );
    }
  }
  mkdirSync(dir, { recursive: true });
  const realDir = realpathSync(dir);
  const realRoot = realpathSync(root);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new Error(
      `refusing to write a generated review script: the canonical session ` +
        `directory '${realDir}' escapes the canonical generated-workflows ` +
        `root '${realRoot}'.`,
    );
  }
  return dir;
}

/**
 * The generated fan-out script for one plan.
 *
 * Named by a digest of the plan path so two reviews running in one session
 * do not overwrite each other's script, and so re-running `emit-workflow`
 * for the same review replaces its own file rather than accumulating.
 */
export function reviewWorkflowScriptPath(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = resolve(planPath);
  // Canonicalize an EXISTING plan before hashing: macOS spells the same
  // file `/var/...` and `/private/var/...`, and the loader canonicalizes
  // with realpath too — hashing the raw spelling would name one plan two
  // scripts (and break the identity a relative vs absolute path must keep).
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch {
    // Not on disk — nothing to canonicalize; the read fails on its own terms.
  }
  const digest = createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 10);
  return join(reviewWorkflowsDir(env), `${REVIEW_WORKFLOW_PREFIX}${digest}.js`);
}

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
