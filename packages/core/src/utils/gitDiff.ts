/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { access, open, readFile, stat } from 'node:fs/promises';
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

const GIT_TIMEOUT_MS = 5000;
/** Maximum files retained in per-file results. Matches issue #2997 "50 files" cap. */
export const MAX_FILES = 50;
/** Per-file diff content cap. Matches issue #2997 "1MB" cap. */
export const MAX_DIFF_SIZE_BYTES = 1_000_000;
/** Per-file diff line cap (GitHub's auto-load threshold). */
export const MAX_LINES_PER_FILE = 400;
/** Skip per-file parsing when the diff touches more than this many files. */
export const MAX_FILES_FOR_DETAILS = 500;
/** How much of an untracked file to read when counting its lines. */
const UNTRACKED_READ_CAP_BYTES = MAX_DIFF_SIZE_BYTES;
/** Scan the first N bytes for NUL to detect binary files (matches git's heuristic). */
const BINARY_SNIFF_BYTES = 8 * 1024;

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

  // Shortstat probe + untracked scan run in parallel — both are needed
  // regardless of which path we take, and shortstat is O(1) memory so it can
  // short-circuit huge generated workspaces before we pay the per-file
  // numstat cost. For untracked we hold the raw stdout rather than the parsed
  // list so the fast path only has to count NUL bytes instead of allocating
  // a full path array.
  const [shortstatOut, untrackedOut] = await Promise.all([
    runGit(['--no-optional-locks', 'diff', 'HEAD', '--shortstat'], cwd),
    runGit(
      [
        '--no-optional-locks',
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
      ],
      cwd,
    ),
  ]);
  const untrackedCount = countNulDelimited(untrackedOut);

  if (shortstatOut != null) {
    const quickStats = parseShortstat(shortstatOut);
    // Base the short-circuit on tracked + untracked so repos with relatively
    // few edits but a flood of untracked files (e.g. large generated
    // workspaces) still take the summary-only path.
    if (
      quickStats &&
      quickStats.filesCount + untrackedCount > MAX_FILES_FOR_DETAILS
    ) {
      return {
        stats: {
          ...quickStats,
          filesCount: quickStats.filesCount + untrackedCount,
        },
        perFileStats: new Map(),
      };
    }
  }

  const numstatOut = await runGit(
    ['--no-optional-locks', 'diff', 'HEAD', '--numstat', '-z'],
    cwd,
  );
  if (numstatOut == null) return null;

  const { stats, perFileStats } = parseGitNumstat(numstatOut);

  if (untrackedCount > 0) {
    // Count every untracked file in the totals, even if the per-file map is
    // already full. Otherwise `filesCount` under-reports whenever tracked
    // changes already fill the `MAX_FILES` slot.
    stats.filesCount += untrackedCount;
    const untrackedPaths = splitNulDelimited(untrackedOut);
    const remainingSlots = Math.max(0, MAX_FILES - perFileStats.size);
    const visiblePaths = untrackedPaths.slice(0, remainingSlots);
    // Count lines in each newly-created file so the header's `+N` reflects
    // the true additions a user would see if they `git add`'d. Reads are
    // capped per-file and binary content is detected so huge log files or
    // blobs don't stall /diff.
    const untrackedStats = await Promise.all(
      visiblePaths.map((relPath) =>
        countUntrackedLines(path.join(cwd, relPath)),
      ),
    );
    for (let i = 0; i < visiblePaths.length; i++) {
      const relPath = visiblePaths[i] ?? '';
      const u = untrackedStats[i] ?? {
        added: 0,
        isBinary: false,
      };
      perFileStats.set(relPath, {
        added: u.added,
        removed: 0,
        isBinary: u.isBinary,
        isUntracked: true,
      });
      stats.linesAdded += u.added;
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
 * Parse `git diff --numstat -z` output.
 *
 * Wire format (stable per `git-diff(1)`):
 * - Non-rename:  `<added>\t<removed>\t<path>\0`
 * - Rename:      `<added>\t<removed>\t\0<oldpath>\0<newpath>\0`
 *
 * Using `-z` (vs the default newline-delimited form) keeps paths byte-accurate:
 * tabs, newlines, and non-ASCII characters all round-trip without git's
 * C-style quoting, so `perFileStats` keys match the real on-disk filenames.
 *
 * Binary files use `-` for both counts. Only the first `MAX_FILES` entries are
 * retained in `perFileStats`; totals account for every entry.
 */
export function parseGitNumstat(stdout: string): GitDiffResult {
  // Drop the trailing empty chunk from the terminating NUL.
  const tokens = stdout.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();

  let added = 0;
  let removed = 0;
  let validFileCount = 0;
  const perFileStats = new Map<string, PerFileStats>();

  // Rename entries span three tokens ({counts}, oldPath, newPath). When we
  // see an empty path in the counts token we stash the counts here and
  // consume the next two tokens as the rename pair.
  let pending: { added: number; removed: number; isBinary: boolean } | null =
    null;
  let renameOld: string | null = null;

  for (const token of tokens) {
    if (pending) {
      if (renameOld === null) {
        renameOld = token;
        continue;
      }
      commitEntry(
        `${renameOld} => ${token}`,
        pending.added,
        pending.removed,
        pending.isBinary,
      );
      pending = null;
      renameOld = null;
      continue;
    }

    // Index-based parse — `split('\t')` is unsafe because `-z` preserves
    // literal tabs inside filenames.
    const firstTab = token.indexOf('\t');
    if (firstTab < 0) continue;
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;
    const addStr = token.slice(0, firstTab);
    const remStr = token.slice(firstTab + 1, secondTab);
    const filePath = token.slice(secondTab + 1);
    const isBinary = addStr === '-' || remStr === '-';
    const fileAdded = isBinary ? 0 : parseInt(addStr, 10) || 0;
    const fileRemoved = isBinary ? 0 : parseInt(remStr, 10) || 0;

    if (filePath === '') {
      // Rename header — wait for oldPath and newPath tokens.
      pending = { added: fileAdded, removed: fileRemoved, isBinary };
      continue;
    }
    commitEntry(filePath, fileAdded, fileRemoved, isBinary);
  }

  function commitEntry(
    filePath: string,
    fileAdded: number,
    fileRemoved: number,
    isBinary: boolean,
  ): void {
    validFileCount++;
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
    // Use UTF-8 byte length (not JS string .length, which counts UTF-16 code
    // units) so the cap matches the documented `MAX_DIFF_SIZE_BYTES` semantic
    // on non-ASCII diffs.
    if (Buffer.byteLength(fileDiff, 'utf8') > MAX_DIFF_SIZE_BYTES) continue;

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
 *
 * The regex is anchored (line start/end with the `m` flag) and uses single
 * literal spaces plus bounded `\d{1,10}` digit runs. This closes CodeQL alert
 * #137: the previous unanchored form with `\s+` and `\d+` in nested optional
 * groups could backtrack polynomially on crafted strings of `0`s.
 */
export function parseShortstat(stdout: string): GitDiffStats | null {
  const match = stdout.match(
    /^ ?(\d{1,10}) files? changed(?:, (\d{1,10}) insertions?\(\+\))?(?:, (\d{1,10}) deletions?\(-\))?$/m,
  );
  if (!match) return null;
  return {
    filesCount: parseInt(match[1] ?? '0', 10),
    linesAdded: parseInt(match[2] ?? '0', 10),
    linesRemoved: parseInt(match[3] ?? '0', 10),
  };
}

function countNulDelimited(stdout: string | null): number {
  if (!stdout) return 0;
  let count = 0;
  for (let i = 0; i < stdout.length; i++) {
    if (stdout.charCodeAt(i) === 0) count++;
  }
  return count;
}

function splitNulDelimited(stdout: string | null): string[] {
  if (!stdout) return [];
  return stdout.split('\0').filter(Boolean);
}

interface UntrackedLineStats {
  added: number;
  isBinary: boolean;
}

/**
 * Count lines in an untracked file so the /diff totals include it. Reads up
 * to `UNTRACKED_READ_CAP_BYTES`, bails on NUL in the first `BINARY_SNIFF_BYTES`
 * (git's own heuristic), and swallows read errors into `{added:0,isBinary:false}`
 * so one unreadable file can't block the whole command.
 */
async function countUntrackedLines(
  absPath: string,
): Promise<UntrackedLineStats> {
  let fh;
  try {
    fh = await open(absPath, 'r');
  } catch {
    return { added: 0, isBinary: false };
  }
  try {
    const buf = Buffer.alloc(UNTRACKED_READ_CAP_BYTES);
    const { bytesRead } = await fh.read(buf, 0, UNTRACKED_READ_CAP_BYTES, 0);
    if (bytesRead === 0) return { added: 0, isBinary: false };
    const sniffEnd = Math.min(BINARY_SNIFF_BYTES, bytesRead);
    for (let i = 0; i < sniffEnd; i++) {
      if (buf[i] === 0) return { added: 0, isBinary: true };
    }
    let lines = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x0a) lines++;
    }
    // If the file does not end in a newline, count the trailing partial line.
    if (buf[bytesRead - 1] !== 0x0a) lines++;
    return { added: lines, isBinary: false };
  } catch {
    return { added: 0, isBinary: false };
  } finally {
    await fh.close().catch(() => {});
  }
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
