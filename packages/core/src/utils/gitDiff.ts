/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
// Namespace import (vs `import { constants }`) so vitest tests that
// `vi.mock('node:fs', ...)` without supplying every named export don't
// blow up in strict-mock mode just because they transitively load this
// file via `@qwen-code/qwen-code-core`. The `constants?.X ?? 0` accesses
// below absorb a missing `constants` field by falling through to plain
// `O_RDONLY` (= 0 on POSIX) — harmless in mock environments where no
// real `open()` ever runs.
import * as nodeFs from 'node:fs';
import { access, lstat, open, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Hunk } from 'diff';
import { findGitRoot } from './gitUtils.js';

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
  /** `true` when the file is removed in the worktree relative to HEAD.
   *  Mutually exclusive with `isUntracked`. Detected via
   *  `git diff HEAD --name-status -z` (status letter `D`); a row like
   *  `0\t10\tfoo.ts` from numstat alone is not enough to distinguish
   *  "deleted" from "heavy edit that drops 10 lines". */
  isDeleted?: boolean;
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
/** Sentinel used when `git diff --shortstat` returns nothing — most often
 *  because there are no tracked changes at all. The fast-path threshold
 *  is then driven entirely by the untracked count. */
const EMPTY_STATS: GitDiffStats = {
  filesCount: 0,
  linesAdded: 0,
  linesRemoved: 0,
};
/** How much of an untracked file to read when counting its lines. */
const UNTRACKED_READ_CAP_BYTES = MAX_DIFF_SIZE_BYTES;
/** Per-file read buffer for line counting. With up to MAX_FILES (=50) files
 *  reading concurrently, the worst-case heap footprint is ~3.2 MB instead of
 *  the ~50 MB a single full-cap allocation per file would cost. */
const UNTRACKED_READ_CHUNK_BYTES = 64 * 1024;
/** Scan the first N bytes for NUL to detect binary files (matches git's heuristic). */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Memoized open flags for line counting. `O_NOFOLLOW` closes the TOCTOU
 *  window between the `lstat` symlink check and `open` — if the path is
 *  replaced with a symlink in that gap, `open` rejects with `ELOOP` instead
 *  of silently dereferencing it. Falls back to plain `O_RDONLY` on platforms
 *  that don't expose the flag (Windows constants omit `O_NOFOLLOW`).
 *
 *  Computed lazily on first call (rather than at module load) so test files
 *  that `vi.mock('node:fs', ...)` without supplying `constants` can still
 *  load this module transitively via `@qwen-code/qwen-code-core` without
 *  vitest's strict-mock proxy throwing on the property access. Tests that
 *  do not actually exercise `countUntrackedLines` never trigger the lookup. */
let untrackedOpenFlagsCache: number | undefined;
function getUntrackedOpenFlags(): number {
  if (untrackedOpenFlagsCache === undefined) {
    untrackedOpenFlagsCache =
      (nodeFs.constants?.O_RDONLY ?? 0) | (nodeFs.constants?.O_NOFOLLOW ?? 0);
  }
  return untrackedOpenFlagsCache;
}

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
  // Walk ancestors once to find the worktree root; reuse the result for the
  // transient-state probe and every git invocation below. `findGitRoot`
  // doubles as the "is this a git repo" check — a non-null return implies a
  // repo. `git diff` already emits repo-root-relative paths regardless of
  // cwd, but `git ls-files --others` is scoped to cwd, so pinning everything
  // to the same root keeps the path keys consistent and ensures untracked
  // files in sibling directories aren't silently dropped when /diff is
  // invoked from a subdirectory of the worktree.
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  if (await isInTransientGitState(gitRoot)) return null;

  // Shortstat probe + untracked scan run in parallel — both are needed
  // regardless of which path we take, and shortstat is O(1) memory so it can
  // short-circuit huge generated workspaces before we pay the per-file
  // numstat cost. For untracked we hold the raw stdout rather than the parsed
  // list so the fast path only has to count NUL bytes instead of allocating
  // a full path array.
  // Every `git diff` invocation passes both `--no-ext-diff` AND
  // `--no-textconv` so the worktree's config can never run user-supplied
  // commands while /diff is only inspecting changes. The two flags cover
  // independent attack surfaces: `--no-ext-diff` blocks `GIT_EXTERNAL_DIFF`
  // and `diff.<name>.command`, while `--no-textconv` blocks the textconv
  // filter that .gitattributes + `diff.<name>.textconv` register (e.g.
  // `pdftotext` to render PDFs). In practice the stats variants
  // (`--shortstat`, `--numstat`, `--name-status`) do not invoke either
  // mechanism, but pinning both flags everywhere is defense-in-depth —
  // git's behavior around these drivers has shifted between versions
  // before.
  const [shortstatOut, untrackedOut] = await Promise.all([
    runGit(
      [
        '--no-optional-locks',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--shortstat',
      ],
      gitRoot,
    ),
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

  // Apply the >500-file fast path on tracked + untracked, treating "no
  // shortstat output" (no tracked changes) and "shortstat unparseable"
  // both as zero tracked stats. Without this fall-through, a workspace
  // with 0 tracked + 501 untracked files would slip past the guardrail:
  // shortstat would be empty, parseShortstat would return null, and the
  // slow path would only line-count the first MAX_FILES untracked
  // entries — leaving `filesCount: 501` paired with a `linesAdded` that
  // missed the other 451 files.
  const quickStats =
    (shortstatOut != null && parseShortstat(shortstatOut)) || EMPTY_STATS;
  if (quickStats.filesCount + untrackedCount > MAX_FILES_FOR_DETAILS) {
    return {
      stats: {
        ...quickStats,
        filesCount: quickStats.filesCount + untrackedCount,
      },
      perFileStats: new Map(),
    };
  }

  // Numstat gives us +/- counts; name-status tells us *why* a row exists
  // (D = deleted, M = modified, R<score> = rename, etc.). We need both
  // because numstat alone can't distinguish a delete (`0\tN\tpath`) from
  // a heavy edit that drops N lines.
  const [numstatOut, nameStatusOut] = await Promise.all([
    runGit(
      [
        '--no-optional-locks',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--numstat',
        '-z',
      ],
      gitRoot,
    ),
    runGit(
      [
        '--no-optional-locks',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--name-status',
        '-z',
      ],
      gitRoot,
    ),
  ]);
  if (numstatOut == null) return null;

  const { stats, perFileStats } = parseGitNumstat(numstatOut);
  const deletedPaths =
    nameStatusOut != null ? parseDeletedFromNameStatus(nameStatusOut) : null;
  if (deletedPaths && deletedPaths.size > 0) {
    for (const [filename, s] of perFileStats) {
      if (deletedPaths.has(filename)) s.isDeleted = true;
    }
  }

  if (untrackedCount > 0) {
    // Count every untracked file in the totals, even if the per-file map is
    // already full. Otherwise `filesCount` under-reports whenever tracked
    // changes already fill the `MAX_FILES` slot.
    stats.filesCount += untrackedCount;
    const untrackedPaths = splitNulDelimited(untrackedOut);
    // Read line counts for *every* untracked path that survived the
    // `>MAX_FILES_FOR_DETAILS` fast-path filter (so up to ~500 files at the
    // outer cap, not just the first MAX_FILES). Otherwise a workspace with
    // 51-500 untracked files would surface in the header as e.g. "60 files
    // changed, +50 lines" — the +50 only covering the first 50 files,
    // bypassing the contributions of the remaining 10. Concurrency is
    // bounded to MAX_FILES so peak heap stays around
    // `MAX_FILES * UNTRACKED_READ_CHUNK_BYTES` (~3.2 MB) regardless of how
    // many untracked files are in the slow-path window.
    const lineStats = await mapWithConcurrency(
      untrackedPaths,
      MAX_FILES,
      (relPath) => countUntrackedLines(path.join(gitRoot, relPath)),
    );
    for (const s of lineStats) stats.linesAdded += s.added;

    // Per-file rendering still caps at MAX_FILES — only the first
    // `remainingSlots` untracked entries become visible rows. The rest are
    // already folded into `linesAdded` above and into `filesCount`, so
    // `hiddenCount` covers them faithfully on the renderer side.
    const remainingSlots = Math.max(0, MAX_FILES - perFileStats.size);
    const visibleCount = Math.min(remainingSlots, untrackedPaths.length);
    for (let i = 0; i < visibleCount; i++) {
      const relPath = untrackedPaths[i] ?? '';
      const u = lineStats[i] ?? {
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
 * Fetch structured hunks for the current working tree vs HEAD. Separate
 * from `fetchGitDiff` so callers that only need stats do not pay the full
 * diff cost.
 *
 * NOTE on memory: this reads the full `git diff HEAD` stdout via `execFile`
 * before applying parser caps (`MAX_FILES`, `MAX_DIFF_SIZE_BYTES`,
 * `MAX_LINES_PER_FILE`). For very large diffs we can buffer up to the
 * `runGit` `maxBuffer` (64 MB) before dropping content. Streaming the
 * parser would let us terminate `git` early at `MAX_FILES`; that's a
 * reasonable follow-up but out of scope for this utility's first cut.
 */
export async function fetchGitDiffHunks(
  cwd: string,
): Promise<Map<string, Hunk[]>> {
  // Walk ancestors once; reuse for the transient-state probe and the diff
  // call. Running from the repo root also keeps hunk keys repo-root-relative
  // regardless of which subdirectory the caller is in.
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return new Map();
  if (await isInTransientGitState(gitRoot)) return new Map();

  // Plain `git diff` honors both `GIT_EXTERNAL_DIFF` / `diff.<name>.command`
  // (blocked by `--no-ext-diff`) AND .gitattributes-driven textconv filters
  // like `diff.<name>.textconv` (blocked by `--no-textconv`) — independent
  // command-execution surfaces, both of which we have to disable on this
  // read-only utility. The stats variants in `fetchGitDiff` already bypass
  // both, but plain diff fires both unless told not to.
  const diffOut = await runGit(
    ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD'],
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
 * Decode a path field from a `diff --git` header — handles both unquoted
 * (`b/foo.txt`) and C-style quoted (`"b/tab\there.txt"`) forms.
 *
 * Git wraps a path in `"..."` and applies C-style escaping (`\t`, `\n`,
 * `\r`, `\"`, `\\`, plus octal `\NNN` for non-ASCII bytes) whenever the
 * raw path contains a character that breaks the simple space-delimited
 * format. `core.quotepath=false` disables ONLY the octal escaping for
 * non-ASCII bytes; control chars and quotes are still escaped, so we
 * must decode them ourselves to preserve the real on-disk filename.
 *
 * Octal escapes are decoded as raw byte values then UTF-8-decoded en
 * masse so multi-byte sequences like `\346\226\207` (文) round-trip
 * correctly even though we never set quotepath=true ourselves.
 */
function unquoteCStylePath(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const inner = s.slice(1, -1);
  // Build raw bytes first so octal `\NNN` sequences (each one byte of a
  // potentially multi-byte UTF-8 character) reassemble correctly. We walk by
  // Unicode code points (not UTF-16 code units), so non-BMP characters such as
  // emoji that may appear inside a quoted path under `core.quotepath=false`
  // round-trip through UTF-8 instead of being split into lone surrogates.
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const c = inner.charCodeAt(i);
    if (c !== 0x5c /* '\' */) {
      const cp = inner.codePointAt(i);
      if (cp === undefined) {
        i++;
        continue;
      }
      const ch = String.fromCodePoint(cp);
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      i++;
      continue;
    }
    switch (next) {
      case 'a':
        bytes.push(0x07);
        i += 2;
        break;
      case 'b':
        bytes.push(0x08);
        i += 2;
        break;
      case 'f':
        bytes.push(0x0c);
        i += 2;
        break;
      case 'v':
        bytes.push(0x0b);
        i += 2;
        break;
      case 't':
        bytes.push(0x09);
        i += 2;
        break;
      case 'n':
        bytes.push(0x0a);
        i += 2;
        break;
      case 'r':
        bytes.push(0x0d);
        i += 2;
        break;
      case '"':
        bytes.push(0x22);
        i += 2;
        break;
      case '\\':
        bytes.push(0x5c);
        i += 2;
        break;
      default:
        if (next >= '0' && next <= '7') {
          let octal = '';
          while (
            octal.length < 3 &&
            i + 1 + octal.length < inner.length &&
            (inner[i + 1 + octal.length] ?? '') >= '0' &&
            (inner[i + 1 + octal.length] ?? '') <= '7'
          ) {
            octal += inner[i + 1 + octal.length];
          }
          bytes.push(parseInt(octal, 8) & 0xff);
          i += 1 + octal.length;
        } else {
          bytes.push(...Buffer.from(next, 'utf8'));
          i += 2;
        }
    }
  }
  return Buffer.from(bytes).toString('utf8');
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
 * Each candidate path goes through `stripTab` (cut at the trailing TAB git
 * appends after whitespace-containing paths) and `unquoteCStylePath`
 * (decode `"..."` C-quoted form for paths whose raw bytes include tabs,
 * newlines, quotes, or non-ASCII characters that core.quotepath does not
 * suppress). Without the unquote step, fetchGitDiffHunks would silently
 * drop hunks for any tracked file whose name contains those characters.
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
  // Strip the TAB-end-of-path marker first, then C-unquote — git emits the
  // TAB AFTER the closing quote on quoted paths.
  const normalize = (s: string): string => unquoteCStylePath(stripTab(s));
  if (renameTo !== null) return normalize(renameTo);
  if (copyTo !== null) return normalize(copyTo);
  if (plus !== null) {
    const p = normalize(plus);
    if (p !== '/dev/null' && p.startsWith('b/')) return p.slice(2);
    // Deleted file — fall back to the old path.
    if (minus !== null) {
      const m = normalize(minus);
      if (m !== '/dev/null' && m.startsWith('a/')) return m.slice(2);
    }
    return null;
  }
  if (minus !== null) {
    const m = normalize(minus);
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

/**
 * Parse `git diff HEAD --name-status -z` output and return the paths whose
 * status is `D` (deleted in the worktree).
 *
 * Wire format with `-z`: `<status>\0<path>\0` per entry, except renames and
 * copies which span three tokens: `R<score>\0<oldpath>\0<newpath>\0` (and
 * `C<score>\0...`). We only care about deletions here, so renames/copies
 * are walked past — neither half of a rename pair is "deleted" in the
 * user-facing sense (the file still exists under the new name).
 */
export function parseDeletedFromNameStatus(stdout: string): Set<string> {
  const tokens = stdout.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();

  const deleted = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i] ?? '';
    i++;
    if (status === '') continue;
    const head = status[0];
    // Rename / copy entries are followed by TWO path tokens.
    if (head === 'R' || head === 'C') {
      i += 2;
      continue;
    }
    const path = tokens[i] ?? '';
    i++;
    if (head === 'D' && path !== '') deleted.add(path);
  }
  return deleted;
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
    // File raced out from under ls-files (deleted, permission revoked, etc.).
    // Surface it as a binary row to be consistent with the open-failure /
    // non-regular-file branches below — `+0 (new)` would lie about it being
    // an empty text file when we genuinely have no signal.
    return { added: 0, isBinary: true, truncated: false };
  }
  if (!st.isFile()) {
    return { added: 0, isBinary: true, truncated: false };
  }
  let fh;
  try {
    fh = await open(absPath, getUntrackedOpenFlags());
  } catch {
    // ELOOP from O_NOFOLLOW (path raced into a symlink between lstat and
    // open) and any other open error all collapse to a binary row so the
    // file appears once in the listing without contributing line counts.
    return { added: 0, isBinary: true, truncated: false };
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
    // Mid-read failure (EIO, fh.stat throwing, etc.). Discard the partial
    // count and surface as binary — same opaque marker as every other
    // "we couldn't read this" branch in this function.
    return { added: 0, isBinary: true, truncated: false };
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
  return resolveGitDirFromRoot(gitRoot);
}

/**
 * Same contract as `resolveGitDir`, but skips the ancestor walk when the
 * caller has already resolved the worktree root. Used by `fetchGitDiff` /
 * `fetchGitDiffHunks` so they walk ancestors at most once per invocation.
 */
async function resolveGitDirFromRoot(gitRoot: string): Promise<string | null> {
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

async function isInTransientGitState(gitRoot: string): Promise<boolean> {
  const gitDir = await resolveGitDirFromRoot(gitRoot);
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

/**
 * Run an async mapper over `items` with at most `limit` operations in
 * flight at once. Used for untracked-file line counting so a workspace with
 * a few hundred untracked files doesn't open 500 file descriptors in
 * parallel — peak heap stays at `limit * UNTRACKED_READ_CHUNK_BYTES`
 * regardless of `items.length`.
 *
 * Order-preserving: `results[i]` corresponds to `items[i]`. Failures
 * propagate as thrown errors (`countUntrackedLines` already swallows its
 * own I/O errors, so callers here see no rejections in practice).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effective = Math.max(1, limit);
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += effective) {
    const slice = items.slice(i, i + effective);
    const batch = await Promise.all(slice.map((item) => fn(item)));
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = batch[j] as R;
    }
  }
  return results;
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
