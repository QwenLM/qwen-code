/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Centralised path constants and helpers for the `qwen review` subcommands.
// All paths are relative to the project root (the current working directory
// when the command is invoked). Use `path.join` rather than string
// concatenation so Windows backslashes are produced when needed.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

/** Worktree path for a given PR review session. */
export function worktreePath(prNumber: string | number): string {
  return join(REVIEW_TMP_DIR, `review-pr-${prNumber}`);
}

/**
 * The disposable worktree the test-efficacy probe runs in — a sibling of the
 * shared review worktree, discarded wholesale when the probe finishes (#6832).
 *
 * The one exception to this file's "paths are relative to the project root"
 * rule: this returns an ABSOLUTE path. The probe drives `git worktree add`/
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
  return label
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 64);
}

/** Local branch ref name for a fetched PR head. */
export function reviewBranch(prNumber: string | number): string {
  return `qwen-review/pr-${prNumber}`;
}

/**
 * A `target` reduced to a single safe filename component.
 *
 * `target` is a file-path review's own path — `src/foo.ts` — or a PR/local
 * label. Interpolated raw, `src/foo.ts` becomes `qwen-review-src/foo.ts-diff.txt`,
 * a nested path whose parent nobody created (ENOENT), and a crafted `../../evil`
 * escapes `.qwen/tmp` and lets `writeFileSync` land anywhere. Flatten every
 * separator and dot-segment to a single component so the file always sits
 * directly in the temp dir.
 */
function safeTarget(target: string): string {
  const flat = target
    .replace(/[^A-Za-z0-9._-]/g, '_') // separators and anything odd → underscore
    .replace(/\.\.+/g, '_'); // no run of dots survives as a traversal token
  return flat.replace(/^[._]+/, '') || 'target';
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
