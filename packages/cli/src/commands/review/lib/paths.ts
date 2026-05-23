/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Centralised path constants and helpers for the `qwen review` subcommands.
// All paths are anchored at the main project root — not `process.cwd()` —
// because the gated subcommands (`pr-context`, `presubmit`,
// `deterministic --pr`, `load-rules --pr`, `autofix-gate`) are expected to
// honour the canonical fetch-pr report at `<project>/.qwen/tmp/...` even
// when they're invoked from inside the PR worktree (cwd != project root).
// Resolution order:
//   1. `QWEN_PROJECT_DIR` env var (set by hookRunner.ts for skill hooks).
//   2. `git rev-parse --git-common-dir` — yields `<main>/.git` even from
//      inside a `git worktree`, so the parent dir is the main project root
//      regardless of which worktree the subcommand was launched from.
//   3. `process.cwd()` — fallback for non-git invocations.
// Use `path.join` rather than string concatenation so Windows backslashes
// are produced when needed.

import { execSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

let _gitFailureWarned = false;

function findProjectRoot(): string {
  const envRoot = process.env['QWEN_PROJECT_DIR'];
  if (envRoot && isAbsolute(envRoot)) {
    return envRoot;
  }
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf8',
      // Capture stderr (was 'ignore') so a `safe.directory` rejection or
      // similar non-trivial git failure surfaces in the warning below.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (commonDir) {
      const abs = isAbsolute(commonDir) ? commonDir : resolve(commonDir);
      // `--git-common-dir` returns the path of the shared `.git` directory
      // (the main repo's `.git` for any linked worktree). The main project
      // root is its parent, which "owns" the `.qwen/tmp/` markers the
      // gated subcommands read.
      return dirname(abs);
    }
  } catch (err) {
    // Warn once per process so a non-trivial git failure
    // (`safe.directory` rejection on a sudo-mediated checkout, corrupt
    // `.git`, permission errors, …) is observable rather than silently
    // collapsing to a cwd-anchored canonical path that downstream
    // subcommands will look for at a different cwd. Stays at `warn`
    // because the `process.cwd()` fallback is still a reasonable answer
    // when the caller happens to be at the project root.
    if (!_gitFailureWarned) {
      _gitFailureWarned = true;
      const stderr = (err as { stderr?: Buffer | string }).stderr;
      const tail = stderr ? `: ${stderr.toString().trim()}` : '';
      process.stderr.write(
        `Warning: \`git rev-parse --git-common-dir\` failed; falling back to process.cwd() for projectRoot()${tail}\n`,
      );
    }
  }
  return process.cwd();
}

let _cachedRoot: string | undefined;

/**
 * Absolute path of the main project root. Cached after first resolution
 * because a single review subcommand invocation calls this 5–10 times
 * transitively (via `fetchReportPath`, `worktreePath`, `tmpFile`, …) and
 * the `git rev-parse --git-common-dir` subprocess is the dominant cost.
 * Tests that `process.chdir(...)` between assertions must call
 * `_resetProjectRootCache()` to invalidate.
 */
export function projectRoot(): string {
  if (_cachedRoot === undefined) {
    _cachedRoot = findProjectRoot();
  }
  return _cachedRoot;
}

/** @internal Test-only — clears the cache so the next `projectRoot()` call re-resolves. */
export function _resetProjectRootCache(): void {
  _cachedRoot = undefined;
  _gitFailureWarned = false;
}

/**
 * Resolve a path against the main project root. Convenience wrapper around
 * `resolve(projectRoot(), p)` so the 5+ gated-subcommand callsites
 * (deterministic / fetch-pr / pr-context / presubmit / load-rules / cleanup)
 * can share one identical anchoring helper and one JSDoc comment instead of
 * repeating the rationale at each site.
 */
export function anchoredPath(p: string): string {
  return resolve(projectRoot(), p);
}

export const REVIEW_TMP_DIR = join('.qwen', 'tmp');
export const REVIEWS_DIR = join('.qwen', 'reviews');
export const REVIEW_CACHE_DIR = join('.qwen', 'review-cache');

/** Worktree path for a given PR review session — absolute, project-anchored. */
export function worktreePath(prNumber: string | number): string {
  return join(projectRoot(), REVIEW_TMP_DIR, `review-pr-${prNumber}`);
}

/** Local branch ref name for a fetched PR head. */
export function reviewBranch(prNumber: string | number): string {
  return `qwen-review/pr-${prNumber}`;
}

/**
 * Per-target side-file path (review JSON, PR context, presubmit report) —
 * absolute, project-anchored.
 *
 * Files live under `<project>/.qwen/tmp/` rather than the OS temp dir so
 * the path is stable across platforms (macOS's `os.tmpdir()` returns
 * `/var/folders/...`, not `/tmp` — using the project-local dir avoids that
 * mismatch entirely) and so they're scoped to the project rather than the
 * user's whole machine.
 */
export function tmpFile(target: string, suffix: string): string {
  return join(projectRoot(), REVIEW_TMP_DIR, `qwen-review-${target}-${suffix}`);
}

/** Filename prefix used by `tmpFile`; useful for cleanup globbing. */
export function tmpPrefix(target: string): string {
  return `qwen-review-${target}-`;
}
