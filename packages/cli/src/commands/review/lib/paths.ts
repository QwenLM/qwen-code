/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Centralised path constants and helpers for the `qwen review` subcommands.
// All paths are relative to the project root (the current working directory
// when the command is invoked). Use `path.join` rather than string
// concatenation so Windows backslashes are produced when needed.

import { join } from 'node:path';

export const REVIEW_TMP_DIR = join('.qwen', 'tmp');
export const REVIEWS_DIR = join('.qwen', 'reviews');
export const REVIEW_CACHE_DIR = join('.qwen', 'review-cache');

/** Worktree path for a given PR review session. */
export function worktreePath(prNumber: string | number): string {
  return join(REVIEW_TMP_DIR, `review-pr-${prNumber}`);
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
