/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { access, lstat, open, readFile, stat } from 'node:fs/promises';
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
  /** Only meaningful for untracked files: `true` when the file exceeded the
   *  line-counting read cap and `added` is therefore a lower bound. */
  truncated?: boolean;
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
/** Per-file read buffer for line counting. With up to MAX_FILES (=50) files
 *  reading concurrently, the worst-case heap footprint is ~3.2 MB instead of
 *  the ~50 MB a single full-cap allocation per file would cost. */
const UNTRACKED_READ_CHUNK_BYTES = 64 * 1024;
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

  // Pin every git invocation (and on-disk file probe) to the repo root.
  // `git diff` already emits repo-root-relative paths regardless of cwd, but
  // `git ls-files --others` is scoped to cwd — running both from the same
  // root keeps the path keys consistent and ensures untracked files in
  // sibling directories aren't silently dropped when /diff is invoked from
  // a subdirectory of the worktree.
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;

  // Shortstat probe + untracked scan run in parallel — both are needed
  // regardless of which path we take, and shortstat is O(1) memory so it can
  // short-circuit huge generated workspaces before we pay the per-file
  // numstat cost. For untracked we hold the raw stdout rather than the parsed
  // list so the fast path only has to count NUL bytes instead of allocating
  // a full path array.
  const [shortstatOut, untrackedOut] = await Promise.all([
    runGit(['--no-optional-locks', 'diff', 'HEAD', '--shortstat'], gitRoot),
    runGit(
      [
        '--no-optional-locks',
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
      ],
      gitRoot,
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
    gitRoot,
  );
  if (numstatOut == null) return null;

  const { stats, perFileStats } = parseGitNumstat(numstatOut);

  if (untrackedCount > 0) {
    // Count every untracked file in the totals, even if the per-file map is
    // already full. Otherwise `filesCount` under-reports whenever tracked
    // changes already fill the `MAX_FILES` slot.
    stats.filesCount += untrackedCount;
    const untrackedPaths = splitNulDelimited(untrackedOut);
    // Keep line-counting decoupled from per-file rendering. We read up to
    // `MAX_FILES` untracked files for their line counts (bounds worst-case
    // I/O at ~50 MB) and fold all of them into `linesAdded`, even if only
    // `remainingSlots` of them end up as visible rows. That avoids the
    // header silently under-reporting additions when tracked changes have
    // already filled the per-file map.
    const countable = untrackedPaths.slice(0, MAX_FILES);
    const countableStats = await Promise.all(
      countable.map((relPath) =>
        countUntrackedLines(path.join(gitRoot, relPath)),
      ),
    );
    for (const s of countableStats) stats.linesAdded += s.added;

    const remainingSlots = Math.max(0, MAX_FILES - perFileStats.size);
    const visibleCount = Math.min(remainingSlots, countable.length);
    for (let i = 0; i < visibleCount; i++) {
      const relPath = countable[i] ?? '';
      const u = countableStats[i] ?? {
        added: 0,
        isBinary: false,
        truncated: false,
      };
      perFileStats.set(relPath, {
        added: u.added,
        removed: 0,
        isBinary: u.isBinary,
        isUntracked: true,
        truncated: u.truncated,
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
  // Run from the repo root so hunk keys are repo-root-relative regardless of
  // which subdirectory the caller is in.
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return new Map();

  const diffOut = await runGit(
    ['--no-optional-locks', 'diff', 'HEAD'],
    gitRoot,
  );
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
    // The `diff --git a/X b/Y` header is ambiguous for paths that contain
    // ` b/` (e.g. `a b/c.txt` yields `diff --git a/a b/c.txt b/a b/c.txt`).
    // Prefer the unambiguous metadata that follows: `rename to`, `copy to`,
    // or the `+++ b/<path>` / `--- a/<path>` lines. Git appends a trailing
    // TAB to those paths when they contain whitespace — that's our real
    // end-of-path marker.
    const filePath = extractFilePath(lines);
    if (filePath === null) continue;

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
 * Extract the real filename from a `diff --git` file block, avoiding the
 * ambiguity of `diff --git a/X b/Y` when `X` itself contains ` b/`.
 *
 * Preference order:
 *   1. `rename to <path>` / `copy to <path>` — the authoritative new name.
 *   2. `+++ b/<path>` — the new-side path for in-place modifications. When
 *      the file was deleted the line reads `+++ /dev/null`; we then fall back
 *      to `--- a/<path>` for the old name.
 *   3. `--- a/<path>` alone — for the rare case where `+++` is absent.
 *
 * Git appends a TAB after the path on `---` / `+++` / `rename to` lines when
 * the path contains whitespace; `stripTab` cuts at that marker.
 *
 * Returns `null` when the block has no hunks or no recognizable path line
 * (mode-only changes, for example).
 */
function extractFilePath(lines: string[]): string | null {
  let plus: string | null = null;
  let minus: string | null = null;
  let renameTo: string | null = null;
  let copyTo: string | null = null;
  for (const line of lines) {
    if (line.startsWith('@@ ')) break;
    if (line.startsWith('+++ ')) plus = line.slice(4);
    else if (line.startsWith('--- ')) minus = line.slice(4);
    else if (line.startsWith('rename to ')) renameTo = line.slice(10);
    else if (line.startsWith('copy to ')) copyTo = line.slice(8);
  }
  const stripTab = (s: string): string => {
    const t = s.indexOf('\t');
    return t >= 0 ? s.slice(0, t) : s;
  };
  if (renameTo !== null) return stripTab(renameTo);
  if (copyTo !== null) return stripTab(copyTo);
  if (plus !== null) {
    const p = stripTab(plus);
    if (p !== '/dev/null' && p.startsWith('b/')) return p.slice(2);
    // Deleted file — fall back to the old path.
    if (minus !== null) {
      const m = stripTab(minus);
      if (m !== '/dev/null' && m.startsWith('a/')) return m.slice(2);
    }
    return null;
  }
  if (minus !== null) {
    const m = stripTab(minus);
    if (m !== '/dev/null' && m.startsWith('a/')) return m.slice(2);
  }
  return null;
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
  /** `true` when the file was larger than the read cap so `added` is a lower
   *  bound (the caller is expected to surface this so the user knows). */
  truncated: boolean;
}

/**
 * Count lines in an untracked file so the /diff totals include it. Reads up
 * to `UNTRACKED_READ_CAP_BYTES`, bails on NUL in the first `BINARY_SNIFF_BYTES`
 * (git's own heuristic), and swallows read errors into a zero-result so one
 * unreadable file can't block the whole command. `truncated` is set when
 * `fstat(size) > bytesRead`, so the UI can mark partial counts honestly
 * instead of silently under-reporting a 10 MB log as `+20k`.
 *
 * Uses `lstat` before `open` to gate on regular files only — git's
 * `ls-files --others` can list FIFOs (whose `open()` would block forever
 * waiting on a writer) and symlinks (whose target may live outside the
 * worktree). Symlinks and non-regular files render as binary `~` rows.
 */
async function countUntrackedLines(
  absPath: string,
): Promise<UntrackedLineStats> {
  let st;
  try {
    st = await lstat(absPath);
  } catch {
    return { added: 0, isBinary: false, truncated: false };
  }
  if (!st.isFile()) {
    return { added: 0, isBinary: true, truncated: false };
  }
  let fh;
  try {
    fh = await open(absPath, 'r');
  } catch {
    return { added: 0, isBinary: false, truncated: false };
  }
  try {
    // Stream the file in fixed-size chunks instead of allocating one full
    // `UNTRACKED_READ_CAP_BYTES` buffer per call. With up to MAX_FILES
    // line-counts running concurrently the heap footprint stays around
    // `MAX_FILES * UNTRACKED_READ_CHUNK_BYTES` (~3.2 MB) rather than the
    // ~50 MB a one-shot full-cap alloc would have cost on a constrained
    // host. Behavior (line count, binary sniff, truncation flag) is
    // identical to the single-shot path.
    const buf = Buffer.allocUnsafe(UNTRACKED_READ_CHUNK_BYTES);
    let totalRead = 0;
    let lines = 0;
    let lastByte = -1;
    let sniffedBytes = 0;
    while (totalRead < UNTRACKED_READ_CAP_BYTES) {
      const remaining = UNTRACKED_READ_CAP_BYTES - totalRead;
      const toRead = Math.min(buf.length, remaining);
      const { bytesRead } = await fh.read(buf, 0, toRead, totalRead);
      if (bytesRead === 0) break;

      // Binary sniff on the first BINARY_SNIFF_BYTES across cumulative reads.
      // Almost always completes inside the first chunk because chunk size
      // (64 KB) is much larger than the sniff window (8 KB).
      if (sniffedBytes < BINARY_SNIFF_BYTES) {
        const sniffEnd = Math.min(bytesRead, BINARY_SNIFF_BYTES - sniffedBytes);
        for (let i = 0; i < sniffEnd; i++) {
          if (buf[i] === 0) {
            return { added: 0, isBinary: true, truncated: false };
          }
        }
        sniffedBytes += sniffEnd;
      }

      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x0a) lines++;
      }
      lastByte = buf[bytesRead - 1] ?? -1;
      totalRead += bytesRead;
    }

    if (totalRead === 0) {
      return { added: 0, isBinary: false, truncated: false };
    }
    // Truncated only when we hit the cap with more bytes still on disk.
    // A `read()` returning 0 means EOF, so we naturally exit untruncated.
    let truncated = false;
    if (totalRead >= UNTRACKED_READ_CAP_BYTES) {
      const { size } = await fh.stat();
      truncated = size > totalRead;
    }
    // If the portion we read ends mid-line (no trailing `\n`) and the read
    // reached EOF, count that trailing partial line. When the read was cut
    // short by the cap, the "trailing partial" is really a line that
    // continues past the cap; counting it here would double-count once the
    // cap is raised.
    if (!truncated && lastByte !== 0x0a) lines++;
    return { added: lines, isBinary: false, truncated };
  } catch {
    return { added: 0, isBinary: false, truncated: false };
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
