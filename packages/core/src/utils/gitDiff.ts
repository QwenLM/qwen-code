/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Hunk } from 'diff';
import { findGitRoot, isGitRepository } from './gitUtils.js';

/** Re-export so consumers don't need to depend on `diff` directly. */
export type GitDiffHunk = Hunk;

const execFileAsync = promisify(execFile);

export interface GitDiffStats {
  filesCount: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface PerFileStats {
  added: number;
  removed: number;
  isBinary: boolean;
  isUntracked?: boolean;
}

export interface GitDiffResult {
  stats: GitDiffStats;
  perFileStats: Map<string, PerFileStats>;
}

export interface NumstatResult {
  stats: GitDiffStats;
  perFileStats: Map<string, PerFileStats>;
}

const GIT_TIMEOUT_MS = 5000;
/** Maximum files retained in per-file results. Matches issue #2997 "50 files" cap. */
export const MAX_FILES = 50;
/** Per-file diff content cap. Matches issue #2997 "1MB" cap. */
export const MAX_DIFF_SIZE_BYTES = 1_000_000;
/** Per-file diff line cap (GitHub's auto-load threshold). */
export const MAX_LINES_PER_FILE = 400;
/** Skip per-file parsing when the diff touches more than this many files. */
export const MAX_FILES_FOR_DETAILS = 500;

/**
 * Fetch numstat-based git diff stats (files changed, lines added/removed) and
 * per-file summaries comparing the working tree to HEAD. Structured hunks are
 * available separately via `fetchGitDiffHunks`.
 *
 * Returns `null` when not inside a git repo, when git itself fails, or when
 * the working tree is in a transient state (merge, rebase, cherry-pick,
 * revert) — those states carry incoming changes that weren't intentionally
 * made by the user.
 */
export async function fetchGitDiff(cwd: string): Promise<GitDiffResult | null> {
  if (!isGitRepository(cwd)) return null;
  if (await isInTransientGitState(cwd)) return null;

  // Quick probe first — O(1) memory regardless of diff size. Lets us bail out
  // of huge diffs (e.g. generated workspaces) before paying for per-file work.
  const shortstatOut = await runGit(
    ['--no-optional-locks', 'diff', 'HEAD', '--shortstat'],
    cwd,
  );
  // Fetch untracked filenames up front so both the shortstat fast path and
  // the numstat slow path report the same `filesCount` surface.
  const untrackedPaths = (await fetchUntrackedPaths(cwd)) ?? [];

  if (shortstatOut != null) {
    const quickStats = parseShortstat(shortstatOut);
    if (quickStats && quickStats.filesCount > MAX_FILES_FOR_DETAILS) {
      return {
        stats: {
          ...quickStats,
          filesCount: quickStats.filesCount + untrackedPaths.length,
        },
        perFileStats: new Map(),
      };
    }
  }

  const numstatOut = await runGit(
    ['--no-optional-locks', 'diff', 'HEAD', '--numstat'],
    cwd,
  );
  if (numstatOut == null) return null;

  const { stats, perFileStats } = parseGitNumstat(numstatOut);

  if (untrackedPaths.length > 0) {
    // Count every untracked file in the totals, even if the per-file map is
    // already full. Otherwise `filesCount` under-reports whenever tracked
    // changes already fill the `MAX_FILES` slot.
    stats.filesCount += untrackedPaths.length;
    const remainingSlots = MAX_FILES - perFileStats.size;
    for (const filePath of untrackedPaths.slice(
      0,
      Math.max(0, remainingSlots),
    )) {
      perFileStats.set(filePath, {
        added: 0,
        removed: 0,
        isBinary: false,
        isUntracked: true,
      });
    }
  }

  return { stats, perFileStats };
}

/**
 * Fetch structured hunks for the current working tree vs HEAD. Separate from
 * `fetchGitDiff` so callers that only need stats do not pay the full diff cost.
 */
export async function fetchGitDiffHunks(
  cwd: string,
): Promise<Map<string, Hunk[]>> {
  if (!isGitRepository(cwd)) return new Map();
  if (await isInTransientGitState(cwd)) return new Map();

  const diffOut = await runGit(['--no-optional-locks', 'diff', 'HEAD'], cwd);
  if (diffOut == null) return new Map();
  return parseGitDiff(diffOut);
}

/**
 * Parse `git diff --numstat` output.
 * Format per line: `<added>\t<removed>\t<filename>`. Binary files use `-` for
 * counts. Only the first `MAX_FILES` entries are kept in `perFileStats`, but
 * total stats account for every line.
 */
export function parseGitNumstat(stdout: string): NumstatResult {
  const lines = stdout.split('\n').filter(Boolean);
  let added = 0;
  let removed = 0;
  let validFileCount = 0;
  const perFileStats = new Map<string, PerFileStats>();

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    validFileCount++;
    const addStr = parts[0];
    const remStr = parts[1];
    const filePath = parts.slice(2).join('\t');
    const isBinary = addStr === '-' || remStr === '-';
    const fileAdded = isBinary ? 0 : parseInt(addStr ?? '0', 10) || 0;
    const fileRemoved = isBinary ? 0 : parseInt(remStr ?? '0', 10) || 0;

    added += fileAdded;
    removed += fileRemoved;

    if (perFileStats.size < MAX_FILES) {
      perFileStats.set(filePath, {
        added: fileAdded,
        removed: fileRemoved,
        isBinary,
      });
    }
  }

  return {
    stats: {
      filesCount: validFileCount,
      linesAdded: added,
      linesRemoved: removed,
    },
    perFileStats,
  };
}

/**
 * Parse unified diff output into per-file hunks.
 *
 * Limits applied:
 * - Stop once `MAX_FILES` files have been collected.
 * - Skip files whose raw diff exceeds `MAX_DIFF_SIZE_BYTES`.
 * - Truncate per-file content at `MAX_LINES_PER_FILE` lines.
 */
export function parseGitDiff(stdout: string): Map<string, Hunk[]> {
  const result = new Map<string, Hunk[]>();
  if (!stdout.trim()) return result;

  const fileDiffs = stdout.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    if (result.size >= MAX_FILES) break;
    if (fileDiff.length > MAX_DIFF_SIZE_BYTES) continue;

    const lines = fileDiff.split('\n');
    const headerMatch = lines[0]?.match(/^a\/(.+?) b\/(.+)$/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2] ?? headerMatch[1] ?? '';

    const fileHunks: Hunk[] = [];
    let currentHunk: Hunk | null = null;
    let lineCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
      );
      if (hunkMatch) {
        if (currentHunk) fileHunks.push(currentHunk);
        currentHunk = {
          oldStart: parseInt(hunkMatch[1] ?? '0', 10),
          oldLines: parseInt(hunkMatch[2] ?? '1', 10),
          newStart: parseInt(hunkMatch[3] ?? '0', 10),
          newLines: parseInt(hunkMatch[4] ?? '1', 10),
          lines: [],
        };
        continue;
      }

      // Pre-hunk metadata is only skipped before the first `@@` header. Once
      // inside a hunk, a line like `---foo` is a removed source line whose
      // content happens to start with `---`, and must not be dropped.
      if (!currentHunk) {
        continue;
      }

      if (
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith(' ')
      ) {
        if (lineCount >= MAX_LINES_PER_FILE) break;
        // Force a flat string copy to break V8 sliced-string references so the
        // whole raw diff can be GC'd once parsing finishes.
        currentHunk.lines.push('' + line);
        lineCount++;
      }
    }

    if (currentHunk) fileHunks.push(currentHunk);
    if (fileHunks.length > 0) result.set(filePath, fileHunks);
  }

  return result;
}

/**
 * Parse `git diff --shortstat` output, e.g.
 * ` 3 files changed, 42 insertions(+), 7 deletions(-)`.
 */
export function parseShortstat(stdout: string): GitDiffStats | null {
  const match = stdout.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  );
  if (!match) return null;
  return {
    filesCount: parseInt(match[1] ?? '0', 10),
    linesAdded: parseInt(match[2] ?? '0', 10),
    linesRemoved: parseInt(match[3] ?? '0', 10),
  };
}

/**
 * Resolve the real git directory for a working tree, following `.git` file
 * indirection used by linked worktrees (`git worktree add`) and submodules.
 * Returns `null` when the location is not inside a git repo.
 */
export async function resolveGitDir(cwd: string): Promise<string | null> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  const dotGit = path.join(gitRoot, '.git');
  try {
    const s = await stat(dotGit);
    if (s.isDirectory()) return dotGit;
    if (!s.isFile()) return null;
    const content = await readFile(dotGit, 'utf8');
    const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match || !match[1]) return null;
    const raw = match[1];
    return path.isAbsolute(raw) ? raw : path.resolve(gitRoot, raw);
  } catch {
    return null;
  }
}

async function isInTransientGitState(cwd: string): Promise<boolean> {
  const gitDir = await resolveGitDir(cwd);
  if (!gitDir) return false;

  // Rebase-in-progress is signalled by a directory, not a ref file. Both
  // rebase-apply (git-am backed) and rebase-merge (interactive / `-m`) forms
  // are covered. REBASE_HEAD alone misses the common case.
  const transientPaths = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
  ];

  const results = await Promise.all(
    transientPaths.map((name) =>
      access(path.join(gitDir, name))
        .then(() => true)
        .catch(() => false),
    ),
  );
  return results.some(Boolean);
}

async function fetchUntrackedPaths(cwd: string): Promise<string[] | null> {
  const stdout = await runGit(
    ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'],
    cwd,
  );
  if (!stdout || !stdout.trim()) return null;
  return stdout.trim().split('\n').filter(Boolean);
}

async function runGit(args: string[], cwd: string): Promise<string | null> {
  // `core.quotepath=false` keeps non-ASCII filenames as UTF-8 in git's output
  // instead of octal-escaping them (`\346\226\207.txt`), which would otherwise
  // end up as literal keys in `perFileStats`.
  const fullArgs = ['-c', 'core.quotepath=false', ...args];
  try {
    const { stdout } = await execFileAsync('git', fullArgs, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return null;
  }
}
