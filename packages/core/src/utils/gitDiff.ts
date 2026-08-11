/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isUtf8 } from 'node:buffer';
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
import {
  structuredPatch,
  type Hunk,
  type ParsedDiff,
  type PatchOptions,
} from 'diff';
import { findGitRoot, readFirstLineNoFollow } from './gitUtils.js';

/** Re-export so consumers don't need to depend on `diff` directly. */
export type GitDiffHunk = Hunk;

/**
 * A single file's diff hunks plus whether the per-file caps
 * (`MAX_DIFF_SIZE_BYTES` / `MAX_LINES_PER_FILE`) actually cut content — so the
 * viewer can label the diff as incomplete instead of silently under-reporting.
 */
export interface GitDiffFileHunks {
  hunks: Hunk[];
  truncated: boolean;
}

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
  /** `true` when the file is removed relative to the comparison base.
   *  Mutually exclusive with `isUntracked`. Detected via
   *  `git diff --name-status -z` (status letter `D`); a row like
   *  `0\t10\tfoo.ts` from numstat alone is not enough to distinguish
   *  "deleted" from "heavy edit that drops 10 lines". */
  isDeleted?: boolean;
  /** `true` when the line counts are lower bounds: the file exceeded the
   *  `MAX_DIFF_SIZE_BYTES` read/comparison cap (untracked line counting and
   *  branch-mode collision diffs both cap at that budget). */
  truncated?: boolean;
  /** For a rename detected by `git diff --numstat -z`, the pre-rename path.
   *  The map key (and wire `path`) is the current post-rename path so the
   *  single-file endpoint can address it; this carries the old path for display. */
  oldPath?: string;
}

export interface GitDiffResult {
  stats: GitDiffStats;
  perFileStats: Map<string, PerFileStats>;
}

export type GitDiffMode =
  | 'uncommitted'
  | 'unstaged'
  | 'staged'
  | 'commit'
  | 'branch';

export interface GitDiffOptions {
  mode: GitDiffMode;
  ref?: string;
}

interface GitDiffComparison {
  args: string[];
  includeUntracked: boolean;
  untrackedBaseRef?: string;
  /** True when the comparison reads the worktree or index, which transient
   *  states (merge, rebase, cherry-pick, revert) fill with changes the user
   *  didn't intentionally make. Commit-vs-commit comparisons read immutable
   *  objects only and stay available through those states. */
  transientSensitive: boolean;
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
/** Wall-clock budget for one in-process collision diff. jsdiff's Myers walk
 *  is quadratic in the edit distance: two fully dissimilar near-cap inputs
 *  otherwise block the daemon's event loop for minutes. On timeout
 *  `structuredPatch` returns `undefined`, which the caller treats like the
 *  throwing path (one opaque row). */
const COLLISION_PATCH_TIMEOUT_MS = 500;
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
 * per-file summaries for the selected comparison. Omitting options compares
 * the working tree to HEAD. Structured hunks are available separately via
 * `fetchGitDiffHunks`.
 *
 * Returns `null` when not inside a git repo, when git itself fails, or when
 * a worktree/index-targeting comparison runs while the working tree is in a
 * transient state (merge, rebase, cherry-pick, revert) — those states carry
 * incoming changes that weren't intentionally made by the user. Commit mode
 * compares two immutable commits and stays available through those states.
 */
export async function fetchGitDiff(
  cwd: string,
  options?: GitDiffOptions,
): Promise<GitDiffResult | null> {
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
  const comparison = await resolveGitDiffComparison(gitRoot, options);
  if (!comparison) return null;
  if (comparison.transientSensitive && (await isInTransientGitState(gitRoot)))
    return null;

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
  const [shortstatOut, untrackedOut, ignoredUntrackedOut] = await Promise.all([
    runGit(
      [
        '--no-optional-locks',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        ...comparison.args,
        '--shortstat',
      ],
      gitRoot,
    ),
    comparison.includeUntracked
      ? runGit(
          [
            '--no-optional-locks',
            'ls-files',
            '-z',
            '--others',
            '--exclude-standard',
          ],
          gitRoot,
        )
      : Promise.resolve(null),
    // Branch-mode collision classification needs the ignore-INCLUSIVE
    // listing: a baseline-tracked path that was untracked-and-ignored (the
    // common `git rm --cached` + .gitignore recipe) is absent from the
    // exclude-standard list and would survive as the exact phantom deletion
    // the classification exists to remove. All-added rows below stay
    // exclude-standard-driven — an ignored file is not an addition.
    comparison.untrackedBaseRef
      ? runGit(['--no-optional-locks', 'ls-files', '-z', '--others'], gitRoot)
      : Promise.resolve(null),
  ]);
  const rawUntrackedPaths = comparison.includeUntracked
    ? splitNulDelimited(untrackedOut)
    : [];
  const classifiablePaths = comparison.untrackedBaseRef
    ? splitNulDelimited(ignoredUntrackedOut)
    : [];

  // Branch mode compares the worktree against the baseline tree, but
  // `git diff <baseline>` proxies the worktree through the index: a path the
  // baseline tracks that the worktree holds untracked surfaces there as a
  // phantom deletion. Classify the untracked paths against the baseline
  // per-path (bounded by the untracked list, unlike a whole-tree `ls-tree -r`
  // listing, which on a large baseline can overflow runGit's maxBuffer or the
  // git timeout before the diff even starts) so colliding paths can be diffed
  // as base-blob-vs-worktree below while everything else stays all-added.
  // Past the fast-path threshold the classification is skipped — the
  // aggregate totals are shortstat-driven there anyway. The gate keys on the
  // SAME exclude-standard count the fast-path gate below uses: the
  // ignore-inclusive list can exceed the threshold (one ignored build
  // directory suffices) while the detail path still runs, and skipping
  // classification there would defeat the collision re-accounting.
  const quickStats =
    (shortstatOut != null && parseShortstat(shortstatOut)) || EMPTY_STATS;
  let filteredUntrackedPaths: string[] | null = null;
  let collisionPaths: string[] = [];
  let trackedAtBase: Map<string, string> | null = null;
  if (
    comparison.untrackedBaseRef &&
    classifiablePaths.length > 0 &&
    quickStats.filesCount + rawUntrackedPaths.length <= MAX_FILES_FOR_DETAILS
  ) {
    trackedAtBase = await classifyPathsTrackedAtBase(
      gitRoot,
      comparison.untrackedBaseRef,
      classifiablePaths,
    );
    if (trackedAtBase === null) return null;
    const tracked = trackedAtBase;
    filteredUntrackedPaths = rawUntrackedPaths.filter(
      (filePath) => !tracked.has(filePath),
    );
    collisionPaths = classifiablePaths.filter((filePath) =>
      tracked.has(filePath),
    );
  }
  // Without classification (non-branch modes, or branch mode past the
  // fast-path threshold) every untracked path counts as an addition. A
  // branch-mode collision then appears in the aggregate totals twice (once
  // via shortstat's phantom deletion); accepted on that rare knife-edge to
  // keep the >500-file guardrail O(1).
  const untrackedCount =
    filteredUntrackedPaths !== null
      ? filteredUntrackedPaths.length
      : rawUntrackedPaths.length;

  // Apply the >500-file fast path on tracked + untracked, treating "no
  // shortstat output" (no tracked changes) and "shortstat unparseable"
  // both as zero tracked stats. Without this fall-through, a workspace
  // with 0 tracked + 501 untracked files would slip past the guardrail:
  // shortstat would be empty, parseShortstat would return null, and the
  // slow path would only line-count the first MAX_FILES untracked
  // entries — leaving `filesCount: 501` paired with a `linesAdded` that
  // missed the other 451 files.
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
        ...comparison.args,
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
        ...comparison.args,
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

  if (collisionPaths.length > 0 && comparison.untrackedBaseRef) {
    await applyBaselineCollisions(
      gitRoot,
      comparison.untrackedBaseRef,
      collisionPaths,
      trackedAtBase ?? new Map(),
      numstatOut,
      stats,
      perFileStats,
    );
  }

  if (untrackedCount > 0) {
    // Count every untracked file in the totals, even if the per-file map is
    // already full. Otherwise `filesCount` under-reports whenever tracked
    // changes already fill the `MAX_FILES` slot.
    stats.filesCount += untrackedCount;
    const untrackedPaths = filteredUntrackedPaths ?? rawUntrackedPaths;
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
 * Fetch structured hunks for one file in the selected comparison. Omitting
 * options compares the working tree to HEAD. Cheaper than `fetchGitDiffHunks`,
 * which diffs the whole tree — this is for on-demand rendering in the viewer.
 *
 * `filePath` may be a repo-root-relative path or an absolute path inside the
 * repo (the daemon passes the workspace-sandboxed absolute path). Relative
 * inputs reject absolute prefixes, drive letters, and `..` traversal; absolute
 * inputs are rejected when they fall outside the git root. Both forms are
 * normalized to a git-root-relative path before any git call, so the path can
 * never escape the repository.
 *
 * Comparisons that target the working tree synthesize untracked files as a
 * single all-added hunk, so the viewer can show new files like any other
 * addition. `truncated` is set whenever the per-file caps cut content on either
 * path (parser cap for tracked diffs, byte/line caps for synthesized untracked
 * ones). Returns `null` for non-repos, worktree/index comparisons during
 * transient states, paths outside the repo, binary or unreadable untracked
 * files, and tracked files with no changes.
 */
export async function fetchGitDiffHunksForFile(
  cwd: string,
  filePath: string,
  oldPath?: string,
  options?: GitDiffOptions,
): Promise<GitDiffFileHunks | null> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  const relPath = toRepoRelativePath(gitRoot, filePath);
  if (relPath === null) return null;
  const comparison = await resolveGitDiffComparison(gitRoot, options);
  if (!comparison) return null;
  if (comparison.transientSensitive && (await isInTransientGitState(gitRoot)))
    return null;

  // For a rename, include the pre-rename path with rename detection so git
  // diffs old→new content instead of reporting the new path as fully added
  // (a single-path pathspec defeats rename detection).
  const oldRelPath =
    oldPath != null ? toRepoRelativePath(gitRoot, oldPath) : null;
  const diffArgs = [
    '--no-optional-locks',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
  ];
  if (oldRelPath != null) diffArgs.push('-M');
  diffArgs.push(...comparison.args, '--');
  // `:(literal)` keeps pathspec magic in user-selected filenames (e.g. a real
  // file named `foo:(glob)bar.txt`) from being reinterpreted by git.
  if (oldRelPath != null) diffArgs.push(`:(literal)${oldRelPath}`);
  diffArgs.push(`:(literal)${relPath}`);
  const diffOut = await runGit(diffArgs, gitRoot);
  if (diffOut == null) return null;
  const truncatedPaths = new Set<string>();
  const parsed = parseGitDiff(diffOut, truncatedPaths);
  // A single-file diff yields at most one entry; return its hunks regardless of
  // the exact header key (which may carry rename / C-style-quote formatting).
  if (parsed.size > 0) {
    // Branch mode proxies the worktree through the index, so a path the
    // baseline tracks that the worktree holds untracked arrives here as a
    // phantom deletion. The real worktree-vs-baseline comparison is the base
    // blob against the on-disk content.
    if (comparison.untrackedBaseRef) {
      // A git failure (`null`) must not fold into "not untracked": falling
      // through would return the phantom full-deletion hunks for a file that
      // exists on disk. Fail closed instead.
      const isUntracked = await isUntrackedWorktreePath(gitRoot, relPath, true);
      if (isUntracked === null) return null;
      if (isUntracked) {
        return await branchModeUntrackedHunks(
          gitRoot,
          comparison.untrackedBaseRef,
          relPath,
        );
      }
    }
    const [key, hunks] = parsed.entries().next().value as [string, Hunk[]];
    return { hunks: hunks ?? [], truncated: truncatedPaths.has(key) };
  }

  // No tracked diff: synthesize an all-added hunk only for a genuinely
  // untracked (and not ignored) file, matching the `--exclude-standard` listing
  // that drives the diff file list. A tracked-but-unchanged or ignored file
  // yields nothing here and returns null.
  if (!comparison.includeUntracked) return null;
  if (comparison.untrackedBaseRef) {
    // A collision path (tracked at the baseline, untracked in the worktree)
    // reaches here when its phantom-deletion diff carries no hunks: an empty
    // baseline blob, or a tracked diff the parser skipped over the size cap.
    // The list still advertises the row, so compare the base blob against the
    // worktree content instead of returning nothing. `branchModeUntrackedHunks`
    // falls back to the plain all-added synthesis when the baseline does not
    // track the path.
    if (await isUntrackedWorktreePath(gitRoot, relPath, true)) {
      return branchModeUntrackedHunks(
        gitRoot,
        comparison.untrackedBaseRef,
        relPath,
      );
    }
    return null;
  }
  if (await isUntrackedWorktreePath(gitRoot, relPath)) {
    return synthesizeUntrackedHunk(gitRoot, relPath);
  }
  return null;
}

async function resolveGitDiffComparison(
  gitRoot: string,
  options?: GitDiffOptions,
): Promise<GitDiffComparison | null> {
  const mode = options?.mode ?? 'uncommitted';
  if (mode === 'unstaged')
    return { args: [], includeUntracked: true, transientSensitive: true };
  if (mode === 'staged') {
    return {
      args: ['--cached'],
      includeUntracked: false,
      transientSensitive: true,
    };
  }
  if (mode === 'uncommitted') {
    return { args: ['HEAD'], includeUntracked: true, transientSensitive: true };
  }
  if (!options?.ref) return null;

  const target = await resolveCommitRef(gitRoot, options.ref);
  if (!target) return null;
  if (mode === 'branch') {
    return {
      args: [target],
      includeUntracked: true,
      untrackedBaseRef: target,
      transientSensitive: true,
    };
  }
  // Runtime guard for callers that parse untyped input (daemon query
  // strings): without a default rejection an unknown mode with a resolvable
  // ref would fall through into the commit comparison below.
  if (mode !== 'commit') return null;

  const parent = await resolveCommitRef(gitRoot, `${target}^1`);
  if (parent)
    return {
      args: [parent, target],
      includeUntracked: false,
      transientSensitive: false,
    };
  const commitObject = await runGit(['cat-file', 'commit', target], gitRoot);
  if (commitObject == null) return null;
  const headerEnd = commitObject.indexOf('\n\n');
  const headers = commitObject.slice(
    0,
    headerEnd === -1 ? commitObject.length : headerEnd,
  );
  if (/^parent [0-9a-f]{40,64}$/im.test(headers)) return null;
  const emptyTree = (
    await runGit(['hash-object', '-t', 'tree', '--stdin'], gitRoot, '')
  )?.trim();
  return emptyTree && /^[0-9a-f]{40,64}$/i.test(emptyTree)
    ? {
        args: [emptyTree, target],
        includeUntracked: false,
        transientSensitive: false,
      }
    : null;
}

async function resolveCommitRef(
  gitRoot: string,
  ref: string,
): Promise<string | null> {
  const resolved = (
    await runGit(
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      gitRoot,
    )
  )?.trim();
  return resolved && /^[0-9a-f]{40,64}$/i.test(resolved) ? resolved : null;
}

/**
 * Normalize a caller-supplied path (relative or absolute) to a git-root-relative
 * path, or `null` when it escapes the repo. Relative inputs reject absolute
 * prefixes, drive letters, and `..` segments; absolute inputs are mapped through
 * `path.relative` and rejected when the result climbs out of the root.
 */
function toRepoRelativePath(gitRoot: string, filePath: string): string | null {
  if (!path.isAbsolute(filePath)) {
    if (filePath.length === 0) return null;
    if (filePath.startsWith('/') || filePath.startsWith('\\')) return null;
    if (/^[A-Za-z]:/.test(filePath)) return null;
    if (filePath.split(/[\\/]/).some((segment) => segment === '..'))
      return null;
    return filePath;
  }
  const rel = path.relative(gitRoot, filePath);
  // Reject only a real climb-out (`..` or `../…`), not a literal `..foo`
  // filename at the root, which a bare `startsWith('..')` would over-reject.
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  )
    return null;
  return rel;
}

/** Drop a trailing incomplete UTF-8 sequence (at most 3 bytes) left when a
 *  byte-capped read cuts a multi-byte character, returning the last offset
 *  that ends on a character boundary. Content ending on a complete sequence
 *  is returned unchanged; an invalid lead byte is left for the validator. */
function trimPartialUtf8Sequence(buf: Buffer, end: number): number {
  for (let back = 1; back <= 3 && back <= end; back++) {
    const byte = buf[end - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const leadLength =
      byte < 0x80
        ? 1
        : byte >= 0xc0 && byte < 0xe0
          ? 2
          : byte >= 0xe0 && byte < 0xf0
            ? 3
            : byte >= 0xf0 && byte < 0xf8
              ? 4
              : 0;
    if (leadLength === 0) return end;
    return back >= leadLength ? end : end - back;
  }
  return end;
}

/**
 * Read an untracked worktree file as text under the line-counting safeguards:
 * regular files only (`ls-files --others` can list FIFOs whose open() blocks
 * forever waiting on a writer), `O_NOFOLLOW`, the `MAX_DIFF_SIZE_BYTES` read
 * cap, and the NUL sniff that rejects binary content (the same 8 KB window git
 * uses). `truncated` reports when the byte cap cut content. With `strict`,
 * invalid UTF-8 is rejected instead of lossily decoded to U+FFFD — the
 * collision comparison needs byte-faithful text so two byte-distinct files
 * cannot decode to identical strings and drop the row.
 */
async function readWorktreeTextFile(
  gitRoot: string,
  filePath: string,
  strict = false,
): Promise<{ text: string; truncated: boolean } | null> {
  const absPath = path.join(gitRoot, filePath);
  try {
    const lst = await lstat(absPath);
    if (!lst.isFile()) return null;
  } catch {
    return null;
  }
  let fh;
  try {
    fh = await open(absPath, getUntrackedOpenFlags());
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const cap = Math.min(st.size, MAX_DIFF_SIZE_BYTES);
    const buf = Buffer.allocUnsafe(cap);
    let offset = 0;
    while (offset < cap) {
      const { bytesRead } = await fh.read(buf, offset, cap - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const sniffEnd = Math.min(offset, BINARY_SNIFF_BYTES);
    for (let i = 0; i < sniffEnd; i++) {
      if (buf[i] === 0) return null;
    }
    // A byte-capped read can cut a multi-byte UTF-8 sequence in half; the
    // trailing partial bytes would fail strict validation (and decode to a
    // stray U+FFFD otherwise), so drop them before validating and decoding.
    const end =
      st.size > MAX_DIFF_SIZE_BYTES
        ? trimPartialUtf8Sequence(buf, offset)
        : offset;
    if (strict && !isUtf8(buf.subarray(0, end))) return null;
    return {
      text: buf.toString('utf8', 0, end),
      truncated: st.size > MAX_DIFF_SIZE_BYTES,
    };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Build a single all-added hunk from an untracked file's content, capped by
 * `MAX_DIFF_SIZE_BYTES` / `MAX_LINES_PER_FILE` — `truncated` reports when
 * either cap actually cut content, so the caller can say so instead of
 * presenting a silently incomplete file. Binary or unreadable files return
 * `null` so the caller surfaces them without an inline diff.
 */
async function synthesizeUntrackedHunk(
  gitRoot: string,
  filePath: string,
): Promise<GitDiffFileHunks | null> {
  const read = await readWorktreeTextFile(gitRoot, filePath);
  if (read === null) return null;
  const lines = read.text.split('\n');
  // Drop the trailing empty element produced by a final newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const capped = lines.slice(0, MAX_LINES_PER_FILE);
  const truncated = read.truncated || lines.length > capped.length;
  if (capped.length === 0) return { hunks: [], truncated };
  return {
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: capped.length,
        lines: capped.map((line) => '+' + line),
      },
    ],
    truncated,
  };
}

/** `ls-tree -z` token format: `<mode> <type> <sha>\t<path>`. Only blob
 *  entries are trackable file content — a directory entry at the same path
 *  must NOT classify a worktree file as baseline-tracked. Records the entry
 *  mode per path so collision re-accounting can detect pure mode changes. */
function collectBlobEntries(
  lsTreeOut: string,
  into: Map<string, string>,
): void {
  for (const token of lsTreeOut.split('\0')) {
    if (!token) continue;
    const tab = token.indexOf('\t');
    if (tab < 0) continue;
    const header = token.slice(0, tab);
    const space = header.indexOf(' ');
    if (space < 0 || header.slice(space + 1).split(' ')[0] !== 'blob') continue;
    into.set(token.slice(tab + 1), header.slice(0, space));
  }
}

/**
 * Which of `paths` exist as blobs in `baseRef`'s tree — via batched per-path
 * `ls-tree` queries instead of a whole-tree `ls-tree -r` listing, which on a
 * large baseline can overflow `runGit`'s maxBuffer or the git timeout before
 * the diff even starts. Pathspecs carry the `:(literal)` magic so glob
 * characters in filenames match exactly. Returns `null` when git fails.
 */
async function classifyPathsTrackedAtBase(
  gitRoot: string,
  baseRef: string,
  paths: string[],
): Promise<Map<string, string> | null> {
  const tracked = new Map<string, string>();
  // Chunk by argv byte volume, not path count alone: with long paths
  // enabled, Windows' CreateProcessW caps the command line at 32,767
  // characters, and one over-size chunk would fail the whole branch-mode
  // classification (and with it the diff) closed.
  const CHUNK_ARGV_BYTES = 30_000;
  for (let i = 0; i < paths.length; ) {
    const chunk: string[] = [];
    let argvBytes = 0;
    while (i < paths.length) {
      // The `:(literal)` magic prefix plus the path bytes.
      const argBytes = Buffer.byteLength(paths[i] ?? '', 'utf8') + 10;
      if (chunk.length > 0 && argvBytes + argBytes > CHUNK_ARGV_BYTES) break;
      chunk.push(paths[i] ?? '');
      argvBytes += argBytes;
      i++;
    }
    const out = await runGit(
      [
        '--no-optional-locks',
        'ls-tree',
        '-z',
        baseRef,
        '--',
        ...chunk.map((filePath) => `:(literal)${filePath}`),
      ],
      gitRoot,
    );
    if (out == null) return null;
    collectBlobEntries(out, tracked);
  }
  return tracked;
}

/** Single-path variant of {@link classifyPathsTrackedAtBase}. */
async function isBlobTrackedAtBase(
  gitRoot: string,
  baseRef: string,
  relPath: string,
): Promise<boolean | null> {
  const out = await runGit(
    [
      '--no-optional-locks',
      'ls-tree',
      '-z',
      baseRef,
      '--',
      `:(literal)${relPath}`,
    ],
    gitRoot,
  );
  if (out == null) return null;
  const tracked = new Map<string, string>();
  collectBlobEntries(out, tracked);
  return tracked.has(relPath);
}

/** Whether git lists the path as an untracked worktree file. Ignored paths
 *  are excluded unless `includeIgnored` is set: branch-mode reroutes pass it
 *  because a baseline-tracked path can be untracked AND ignored (the
 *  `git rm --cached` + .gitignore recipe) and still collide. Returns `null`
 *  when git itself fails — callers must not fold that into `false`. */
async function isUntrackedWorktreePath(
  gitRoot: string,
  relPath: string,
  includeIgnored = false,
): Promise<boolean | null> {
  const out = await runGit(
    [
      '--no-optional-locks',
      'ls-files',
      '-z',
      '--others',
      ...(includeIgnored ? [] : ['--exclude-standard']),
      '--',
      `:(literal)${relPath}`,
    ],
    gitRoot,
  );
  if (out == null) return null;
  // An exact-entry match, not "any match under the pathspec": a pathspec also
  // matches every descendant path (an untracked `a/x` would otherwise make
  // `a` test true and reroute a real deletion of the file `a`), and the
  // `:(literal)` magic keeps glob metacharacters in the name from matching
  // sibling files.
  return splitNulDelimited(out).includes(relPath);
}

/** Cut patch hunks at `MAX_LINES_PER_FILE` content lines, mirroring
 *  `parseGitDiff`'s truncation for tracked diffs. */
function capPatchHunks(hunks: Hunk[]): {
  hunks: Hunk[];
  truncated: boolean;
} {
  let budget = MAX_LINES_PER_FILE;
  let truncated = false;
  const capped: Hunk[] = [];
  for (const hunk of hunks) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    if (hunk.lines.length <= budget) {
      capped.push(hunk);
      budget -= hunk.lines.length;
      continue;
    }
    truncated = true;
    capped.push({ ...hunk, lines: hunk.lines.slice(0, budget) });
    budget = 0;
  }
  return { hunks: capped, truncated };
}

interface BaseWorktreeDiff {
  added: number;
  removed: number;
  hunks: Hunk[];
  truncated: boolean;
}

/**
 * Diff the baseline blob against the worktree copy of an untracked path — the
 * true comparison behind branch mode's phantom deletions. Returns `null` when
 * either side is binary or unreadable, or the blob read fails.
 */
async function diffBaseBlobAgainstWorktree(
  gitRoot: string,
  baseRef: string,
  relPath: string,
): Promise<BaseWorktreeDiff | null> {
  // The object spec starts with the resolved hex sha, so it can never be
  // parsed as an option regardless of the path's characters. Read raw bytes:
  // decoding through `toString('utf8')` replaces invalid byte sequences with
  // U+FFFD, which could make two distinct blobs compare as identical text.
  const baseRaw = await runGitBuffer(
    ['--no-optional-locks', 'cat-file', 'blob', `${baseRef}:${relPath}`],
    gitRoot,
  );
  if (baseRaw === null) return null;
  // Byte-accurate NUL sniff (git's own 8 KB heuristic). Measuring the window
  // in UTF-16 code units would scan strictly more than 8 KB of bytes for
  // multi-byte content and mislabel real text blobs as binary.
  if (baseRaw.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  // Cap the baseline side in BYTES, mirroring `readWorktreeTextFile` on the
  // worktree side, BEFORE validating: bytes past the cap are never decoded,
  // and validating them would classify a valid capped prefix with an invalid
  // trailer as binary while the worktree side only validates its capped
  // prefix. Slicing a decoded string would count UTF-16 code units (up to
  // ~3x the byte budget for CJK content) and truncate the two sides of the
  // same diff asymmetrically — identical large files could then compare as
  // changed because their prefixes differ. The cap can split a multi-byte
  // sequence, so drop the trailing partial bytes first (the worktree side
  // trims the same way).
  const baseTruncated = baseRaw.length > MAX_DIFF_SIZE_BYTES;
  const baseBytes = baseTruncated
    ? baseRaw.subarray(0, trimPartialUtf8Sequence(baseRaw, MAX_DIFF_SIZE_BYTES))
    : baseRaw;
  // Strict UTF-8 validation — invalid text is treated as binary instead of
  // being lossily decoded (see the baseRaw read above).
  if (!isUtf8(baseBytes)) return null;
  const worktree = await readWorktreeTextFile(gitRoot, relPath, true);
  if (worktree === null) return null;
  const baseText = baseBytes.toString('utf8');
  // @types/diff does not declare the runtime-supported `timeout` option yet.
  const patchOptions: PatchOptions & { timeout: number } = {
    context: 3,
    timeout: COLLISION_PATCH_TIMEOUT_MS,
  };
  let patch: ParsedDiff | undefined;
  try {
    patch = structuredPatch(
      relPath,
      relPath,
      baseText,
      worktree.text,
      '',
      '',
      patchOptions,
    );
  } catch {
    return null;
  }
  // With `timeout`, an aborted diff yields `undefined` instead of throwing.
  if (!patch) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  const { hunks, truncated } = capPatchHunks(patch.hunks);
  return {
    added,
    removed,
    hunks,
    truncated: truncated || worktree.truncated || baseTruncated,
  };
}

/**
 * Hunks for a path that is untracked in the worktree under branch mode: the
 * baseline blob vs the worktree content when the baseline tracks the path (a
 * modified row), or the usual all-added synthesis otherwise.
 */
async function branchModeUntrackedHunks(
  gitRoot: string,
  baseRef: string,
  relPath: string,
): Promise<GitDiffFileHunks | null> {
  const trackedAtBase = await isBlobTrackedAtBase(gitRoot, baseRef, relPath);
  if (trackedAtBase === null) return null;
  if (!trackedAtBase) {
    // All-added synthesis is for visible new files: an ignored path the
    // baseline does not track appears in no comparison row, so it must not
    // grow hunks here even though the ignore-inclusive reroute can reach it.
    if (!(await isUntrackedWorktreePath(gitRoot, relPath))) return null;
    return synthesizeUntrackedHunk(gitRoot, relPath);
  }
  const row = await diffBaseBlobAgainstWorktree(gitRoot, baseRef, relPath);
  if (row === null) return null;
  return { hunks: row.hunks, truncated: row.truncated };
}

/**
 * Re-account paths the baseline branch tracks but the worktree holds
 * untracked. `git diff <baseline>` proxies the worktree through the index and
 * reports such paths as phantom deletions (numstat `0\tN` rows, status `D`);
 * the real worktree-vs-baseline state is the baseline blob diffed against the
 * on-disk file. Subtract each phantom row and re-add the path once with the
 * true added/removed counts (or a binary marker when either side is
 * unreadable), keeping the single-row-per-path accounting.
 */
async function applyBaselineCollisions(
  gitRoot: string,
  baseRef: string,
  collisionPaths: string[],
  baseModes: ReadonlyMap<string, string>,
  numstatOut: string,
  stats: GitDiffStats,
  perFileStats: Map<string, PerFileStats>,
): Promise<void> {
  const collisionSet = new Set(collisionPaths);
  // A collision path entangled with a rename is the rename's OLD path — the
  // source was renamed away and recreated as an untracked file. That copy is
  // a separate change on a separate path, so it is re-accounted below beside
  // the rename row instead of being suppressed (suppressing it dropped the
  // file from the list AND the totals). A rename's NEW path can never be a
  // collision (rename targets are index entries, never untracked); guard it
  // anyway so an unexpected row shape cannot count one path twice.
  const renameEntangled = new Set<string>();
  const phantom = new Map<string, { added: number; removed: number }>();
  forEachNumstatEntry(numstatOut, (entry) => {
    if (entry.oldPath) {
      if (collisionSet.has(entry.path)) {
        renameEntangled.add(entry.path);
      }
      return;
    }
    if (collisionSet.has(entry.path)) {
      phantom.set(entry.path, { added: entry.added, removed: entry.removed });
    }
  });

  for (const relPath of collisionPaths) {
    if (renameEntangled.has(relPath)) continue;
    const stale = phantom.get(relPath);
    if (stale) {
      stats.filesCount -= 1;
      stats.linesAdded -= stale.added;
      stats.linesRemoved -= stale.removed;
    }
    perFileStats.delete(relPath);
    const row = await diffBaseBlobAgainstWorktree(gitRoot, baseRef, relPath);
    if (row === null) {
      // Binary or unreadable on either side: keep one opaque row.
      stats.filesCount += 1;
      if (perFileStats.size < MAX_FILES) {
        perFileStats.set(relPath, { added: 0, removed: 0, isBinary: true });
      }
      continue;
    }
    // Identical content: the file is unchanged against the baseline, so the
    // phantom row is dropped without a replacement — but only when the
    // comparison covered the whole file (`row.truncated` means "no diff
    // within the compared prefix", not "identical") and the file type/mode
    // also matches. Git reports a pure mode flip (executable bit, symlink →
    // regular file) as a 0/0 row; dropping it would hide the metadata change.
    if (
      row.added === 0 &&
      row.removed === 0 &&
      !row.truncated &&
      (await worktreeModeMatchesBase(gitRoot, relPath, baseModes.get(relPath)))
    ) {
      continue;
    }
    stats.filesCount += 1;
    stats.linesAdded += row.added;
    stats.linesRemoved += row.removed;
    if (perFileStats.size < MAX_FILES) {
      perFileStats.set(relPath, {
        added: row.added,
        removed: row.removed,
        isBinary: false,
        truncated: row.truncated,
      });
    }
  }
}

/**
 * Whether the worktree file's type/mode matches the baseline blob's mode.
 * Git tracks only the executable bit for regular files; a baseline symlink
 * (mode 120000) never matches a regular worktree file. Returns `false` —
 * keeping the row — when either side cannot be determined.
 */
async function worktreeModeMatchesBase(
  gitRoot: string,
  relPath: string,
  baseMode: string | undefined,
): Promise<boolean> {
  if (baseMode !== '100644' && baseMode !== '100755') return false;
  try {
    const st = await lstat(path.join(gitRoot, relPath));
    if (!st.isFile()) return false;
    // Git canonicalizes modes from the owner-exec bit only (0o100); group or
    // other exec bits never reach a tracked mode.
    return (st.mode & 0o100 ? '100755' : '100644') === baseMode;
  } catch {
    return false;
  }
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
interface NumstatEntry {
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
  isBinary: boolean;
}

function forEachNumstatEntry(
  stdout: string,
  visit: (entry: NumstatEntry) => void,
): void {
  const tokens = stdout.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();

  let pending: Omit<NumstatEntry, 'path' | 'oldPath'> | null = null;
  let renameOld: string | null = null;

  for (const token of tokens) {
    if (pending) {
      if (renameOld === null) {
        renameOld = token;
        continue;
      }
      visit({ ...pending, path: token, oldPath: renameOld });
      pending = null;
      renameOld = null;
      continue;
    }

    const firstTab = token.indexOf('\t');
    if (firstTab < 0) continue;
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;
    const addStr = token.slice(0, firstTab);
    const remStr = token.slice(firstTab + 1, secondTab);
    const path = token.slice(secondTab + 1);
    const isBinary = addStr === '-' || remStr === '-';
    const added = isBinary ? 0 : parseInt(addStr, 10) || 0;
    const removed = isBinary ? 0 : parseInt(remStr, 10) || 0;

    if (path === '') {
      pending = { added, removed, isBinary };
      continue;
    }
    visit({ path, added, removed, isBinary });
  }
}

export function parseGitNumstat(stdout: string): GitDiffResult {
  let added = 0;
  let removed = 0;
  let validFileCount = 0;
  const perFileStats = new Map<string, PerFileStats>();

  forEachNumstatEntry(stdout, (entry) => {
    commitEntry(
      entry.path,
      entry.added,
      entry.removed,
      entry.isBinary,
      entry.oldPath,
    );
  });

  function commitEntry(
    filePath: string,
    fileAdded: number,
    fileRemoved: number,
    isBinary: boolean,
    oldPath?: string,
  ): void {
    validFileCount++;
    added += fileAdded;
    removed += fileRemoved;
    if (perFileStats.size < MAX_FILES) {
      perFileStats.set(filePath, {
        added: fileAdded,
        removed: fileRemoved,
        isBinary,
        ...(oldPath ? { oldPath } : {}),
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
 * - Truncate per-file content at `MAX_LINES_PER_FILE` lines; when
 *   `truncatedPaths` is provided, every file that actually lost lines to that
 *   cap is recorded there so callers can surface the truncation instead of
 *   presenting a silently incomplete diff.
 */
export function parseGitDiff(
  stdout: string,
  truncatedPaths?: Set<string>,
): Map<string, Hunk[]> {
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
        if (lineCount >= MAX_LINES_PER_FILE) {
          // A content line exists beyond the cap, so this file's hunks are
          // genuinely incomplete (an exactly-at-cap diff never reaches here).
          truncatedPaths?.add(filePath);
          break;
        }
        // Force a flat string copy to break V8 sliced-string references so the
        // whole raw diff can be GC'd once parsing finishes.
        currentHunk.lines.push('' + line);
        lineCount++;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — metadata the viewer renders as a
        // marker. Keep it so a trailing-newline-only edit isn't shown as
        // identical removed/added lines. Not counted against the content cap.
        currentHunk.lines.push('' + line);
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
export function unquoteCStylePath(s: string): string {
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
 * Parse `git diff --name-status -z` output and return the paths whose status is
 * `D` (deleted relative to the comparison base).
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

async function runGit(
  args: string[],
  cwd: string,
  input?: string,
): Promise<string | null> {
  // `core.quotepath=false` keeps non-ASCII filenames as UTF-8 in git's output
  // instead of octal-escaping them (`\346\226\207.txt`), which would otherwise
  // end up as literal keys in `perFileStats`.
  const fullArgs = ['-c', 'core.quotepath=false', ...args];
  return await new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        'git',
        fullArgs,
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
      return;
    }
    if (input !== undefined) {
      // A child that rejects (or exits) without draining stdin turns the
      // write into an unhandled stdin 'error' event (EPIPE) and crashes the
      // process; the failure itself is still reported through the exit code.
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
  });
}

/** Raw-byte variant for content that must not be lossily UTF-8 decoded. */
async function runGitBuffer(
  args: string[],
  cwd: string,
): Promise<Buffer | null> {
  const fullArgs = ['-c', 'core.quotepath=false', ...args];
  return await new Promise((resolve) => {
    try {
      execFile(
        'git',
        fullArgs,
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'buffer',
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
      return;
    }
  });
}

/** An in-progress git operation that the status indicator should surface. */
export type GitOperation =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect';

/**
 * Working-tree summary for the status line / Web Shell git chip: branch,
 * detached-HEAD flag, upstream ahead/behind, staged / unstaged / untracked /
 * conflicted file counts, stash count, and any in-progress operation. A single
 * `git status --porcelain=v1 --branch -z` call drives everything except stash
 * and the operation (read directly from the git dir to avoid extra
 * subprocesses).
 *
 * Unlike `fetchGitDiff`, this does NOT bail on a transient state — a
 * merge / rebase / cherry-pick / revert in progress is exactly what the
 * indicator should show (reported via `operation`). `git status` still
 * produces valid output during these states.
 *
 * Returns `null` only when not inside a git repo or when git itself fails.
 */
export interface GitWorkingTreeStatus {
  /** Branch name, or `null` when detached / unborn / unreadable. */
  branch: string | null;
  /** `true` for a detached HEAD (branch holds no name). */
  detached: boolean;
  /** `true` when the branch tracks an upstream. */
  hasUpstream: boolean;
  /** Commits ahead of upstream (0 without an upstream). */
  ahead: number;
  /** Commits behind upstream (0 without an upstream). */
  behind: number;
  /** Files with a staged change (porcelain X column). */
  staged: number;
  /** Files with an unstaged change (porcelain Y column). */
  unstaged: number;
  /** Untracked files (`??`). */
  untracked: number;
  /** Unmerged (conflicted) entries. */
  conflicted: number;
  /** Stash entries (lines in `logs/refs/stash`). */
  stashCount: number;
  /** In-progress operation, if any. */
  operation?: GitOperation;
}

export async function getGitWorkingTreeStatus(
  cwd: string,
): Promise<GitWorkingTreeStatus | null> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;

  const stdout = await runGit(
    ['--no-optional-locks', 'status', '--porcelain=v1', '--branch', '-z'],
    gitRoot,
  );
  if (stdout == null) return null;

  // `-z` NUL-terminates each entry; the `--branch` header is always first.
  const tokens = stdout.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
  const head = tokens.shift() ?? '';
  const branch = parseStatusBranchLine(head);
  const counts = parseStatusEntries(tokens);
  const [stashCount, operation] = await Promise.all([
    countStashEntries(gitRoot),
    detectGitOperation(gitRoot),
  ]);

  return {
    ...branch,
    ...counts,
    stashCount,
    ...(operation ? { operation } : {}),
  };
}

interface StatusBranchLine {
  branch: string | null;
  detached: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}

const NO_BRANCH: StatusBranchLine = {
  branch: null,
  detached: false,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
};

/**
 * Parse the `## ...` header from `git status --branch`. Forms handled:
 * `## branch...upstream [ahead N, behind M]`, `## branch`, `## HEAD (no
 * branch)` (detached), and `## No commits yet on branch` / `## Initial commit
 * on branch` (unborn).
 */
export function parseStatusBranchLine(line: string): StatusBranchLine {
  if (!line.startsWith('## ')) return { ...NO_BRANCH };
  let desc = line.slice(3);

  if (desc.startsWith('HEAD (no branch)')) {
    return { ...NO_BRANCH, detached: true };
  }
  const unborn = desc.match(/^(?:No commits yet|Initial commit) on (.+)$/);
  if (unborn) {
    return { ...NO_BRANCH, branch: unborn[1] ?? null };
  }

  let ahead = 0;
  let behind = 0;
  const bracket = desc.match(/ \[([^\]]*)\]$/);
  if (bracket) {
    const inner = bracket[1] ?? '';
    const aheadMatch = inner.match(/ahead (\d+)/);
    const behindMatch = inner.match(/behind (\d+)/);
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    behind = behindMatch ? Number(behindMatch[1]) : 0;
    desc = desc.slice(0, bracket.index).trimEnd();
  }

  const hasUpstream = desc.includes('...');
  // Split at the last `...` (the branch/upstream separator). Git forbids `..`
  // in ref names so a branch can't itself contain `...`, but lastIndexOf is the
  // robust split point regardless.
  const sepIndex = desc.lastIndexOf('...');
  const branch = sepIndex >= 0 ? desc.slice(0, sepIndex) : desc;
  return {
    branch: branch || null,
    detached: false,
    hasUpstream,
    ahead,
    behind,
  };
}

interface StatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

/**
 * git's unmerged determination: any `U` in either column, or both-deleted /
 * both-added. These are counted separately (a conflict is neither a plain
 * staged nor unstaged change) and not double-counted into staged/unstaged.
 */
function isUnmergedEntry(x: string, y: string): boolean {
  if (x === 'U' || y === 'U') return true;
  if (x === 'D' && y === 'D') return true;
  if (x === 'A' && y === 'A') return true;
  return false;
}

/**
 * Count staged / unstaged / untracked / conflicted entries from `git status
 * --porcelain=v1 -z` tokens (the branch header is already removed). Each entry
 * is `XY <path>`; a rename/copy carries a second NUL-separated path that is
 * skipped.
 */
export function parseStatusEntries(tokens: string[]): StatusCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? '';
    // A real entry has two status chars then a space; anything else (a rename's
    // second path, a stray token) is not an entry header.
    if (tok.length < 3 || tok[2] !== ' ') continue;
    const x = tok[0];
    const y = tok[1];
    if (x === '?' && y === '?') {
      untracked++;
      continue;
    }
    if (x === '!' && y === '!') continue; // ignored; not emitted without --ignored
    if (isUnmergedEntry(x, y)) {
      conflicted++;
      continue;
    }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ' && y !== '?') unstaged++;
    // Rename/copy entries carry a second NUL-separated path; skip it.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
  }
  return { staged, unstaged, untracked, conflicted };
}

/**
 * Detect an in-progress operation by probing the git dir for the marker files
 * git writes during merge / rebase / cherry-pick / revert / bisect. Order
 * matters: rebase markers are checked first so a rebase isn't misreported.
 */
async function detectGitOperation(
  gitRoot: string,
): Promise<GitOperation | undefined> {
  const gitDir = await resolveGitDirFromRoot(gitRoot);
  if (!gitDir) return undefined;
  const checks: Array<[string, GitOperation]> = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ];
  for (const [name, op] of checks) {
    try {
      await access(path.join(gitDir, name));
      return op;
    } catch {
      // Marker absent; try the next.
    }
  }
  return undefined;
}

/**
 * Resolve the git dir shared by every worktree of a repository.
 *
 * For a linked worktree (`git worktree add`) `resolveGitDirFromRoot` returns
 * the per-worktree dir `.git/worktrees/<name>`, which is correct for the
 * per-worktree state the callers above probe — HEAD, the index, and the
 * MERGE_HEAD / rebase-* / BISECT_LOG markers all live there. Refs and their
 * reflogs do not: they live in the common dir, which git records in a
 * `commondir` file next to those markers. Falls back to `gitDir` itself,
 * which is the right answer for a main worktree (no `commondir` file).
 */
async function resolveCommonGitDir(gitDir: string): Promise<string> {
  // Read it the way gitDirect.ts already reads this same file: O_NOFOLLOW
  // refuses a symlink and O_NONBLOCK never blocks on a FIFO. A plain readFile
  // on a crafted `commondir` named pipe would hang forever and pin a libuv
  // thread-pool slot, and `getGitWorkingTreeStatus` polls unattended, so it has
  // to survive a hostile repository -- the same hazard countStashEntries below
  // guards against for the reflog it reads.
  const raw = (
    await readFirstLineNoFollow(path.join(gitDir, 'commondir'))
  )?.trim();
  if (!raw) return gitDir;
  return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
}

/** Stash count = lines in `<commonDir>/logs/refs/stash` (0 when absent). */
async function countStashEntries(gitRoot: string): Promise<number> {
  const gitDir = await resolveGitDirFromRoot(gitRoot);
  if (!gitDir) return 0;
  // The stash is a single ref shared by the whole repository, so it must be
  // read from the common dir. Reading it from the per-worktree dir reported 0
  // stashes inside every linked worktree, whatever `git stash list` said.
  const commonDir = await resolveCommonGitDir(gitDir);
  const stashLog = path.join(commonDir, 'logs', 'refs', 'stash');
  // lstat before read: a symlink-to-FIFO would block readFile forever (the
  // same hazard the untracked-file readers guard against). Only count a
  // regular file.
  try {
    const st = await lstat(stashLog);
    if (!st.isFile()) return 0;
  } catch {
    return 0;
  }
  try {
    const content = await readFile(stashLog, 'utf8');
    return content.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Git log
// ---------------------------------------------------------------------------

/** Maximum entries per `fetchGitLog` page. */
export const MAX_LOG_LIMIT = 200;
/** Default page size for `fetchGitLog`. */
export const DEFAULT_LOG_LIMIT = 50;

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** Unix timestamp in seconds. */
  authorDate: number;
  subject: string;
  /** `%D` output, e.g. `"HEAD -> main, origin/main, v1.2.0"`. */
  refs: string;
  /** Parent SHAs (length > 1 ⇒ merge commit). */
  parents: string[];
}

export interface GitLogResult {
  entries: GitLogEntry[];
  hasMore: boolean;
}

export interface GitCommitFileStat {
  path: string;
  added: number;
  removed: number;
  isBinary: boolean;
}

export interface GitCommitDetail {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  subject: string;
  body: string;
  refs: string;
  parents: string[];
  files: GitCommitFileStat[];
  filesCount: number;
  linesAdded: number;
  linesRemoved: number;
  hiddenCount: number;
}

const LOG_FORMAT = '%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%D%x00%P';
const LOG_DETAIL_FORMAT =
  '%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%D%x00%P%x00%b';

function parseLogFields(parts: string[]): GitLogEntry | null {
  if (parts.length !== 8) return null;
  return {
    sha: parts[0],
    shortSha: parts[1],
    authorName: parts[2],
    authorEmail: parts[3],
    authorDate: parseInt(parts[4], 10) || 0,
    subject: parts[5],
    refs: parts[6],
    parents: parts[7] ? parts[7].split(' ').filter(Boolean) : [],
  };
}

/**
 * Fetch a page of commit log entries (newest first).
 *
 * Returns `null` when not inside a git repo or when git fails. An empty
 * repo (no commits) returns `{ entries: [], hasMore: false }`.
 */
export async function fetchGitLog(
  cwd: string,
  options?: { limit?: number; skip?: number; range?: string },
): Promise<GitLogResult | null> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;

  const limit = Math.min(
    Math.max(options?.limit ?? DEFAULT_LOG_LIMIT, 1),
    MAX_LOG_LIMIT,
  );
  const skip = Math.max(options?.skip ?? 0, 0);

  const stdout = await runGit(
    [
      '--no-optional-locks',
      'log',
      '-z',
      `--format=${LOG_FORMAT}`,
      '-n',
      String(limit + 1),
      ...(skip > 0 ? ['--skip', String(skip)] : []),
      ...(options?.range &&
      !options.range.startsWith('-') &&
      !options.range.startsWith('..') &&
      /^[A-Za-z0-9_./~^-]+$/.test(options.range)
        ? [options.range, '--']
        : []),
    ],
    gitRoot,
  );
  if (stdout === null) {
    // git log fails on an empty repo (no commits yet). Distinguish that from
    // a real failure by probing HEAD: if HEAD doesn't resolve either, the
    // repo simply has no commits.
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], gitRoot);
    return head === null ? { entries: [], hasMore: false } : null;
  }

  const fields = stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const recordCount = Math.floor(fields.length / 8);
  const hasMore = recordCount > limit;
  const pageCount = hasMore ? limit : recordCount;

  const entries: GitLogEntry[] = [];
  for (let i = 0; i < pageCount; i++) {
    const entry = parseLogFields(fields.slice(i * 8, i * 8 + 8));
    if (entry) entries.push(entry);
  }
  return { entries, hasMore };
}

/**
 * Fetch full detail for a single commit: metadata (including body) plus
 * per-file numstat.
 *
 * Returns `null` when not inside a git repo, the sha is invalid / not found,
 * or git fails.
 */
export async function fetchGitCommitDetail(
  cwd: string,
  sha: string,
): Promise<GitCommitDetail | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;

  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;

  const metaRaw = await runGit(
    [
      '--no-optional-locks',
      'log',
      '-1',
      '-z',
      `--format=${LOG_DETAIL_FORMAT}`,
      sha,
    ],
    gitRoot,
  );
  if (metaRaw === null) return null;

  const parts = metaRaw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length !== 9) return null;

  const parents = parts[7] ? parts[7].split(' ').filter(Boolean) : [];

  // Per-file stats via diff-tree. `--root` handles the initial commit (no
  // parent). For merge commits, plain diff-tree outputs nothing; diff against
  // the first parent to show what the merge introduced.
  const diffTreeArgs =
    parents.length > 1
      ? [
          '--no-optional-locks',
          'diff-tree',
          '--no-commit-id',
          '--numstat',
          // Detect renames so `git mv` counts as one file (by its new path),
          // matching the main `git diff` path — diff-tree is plumbing and does
          // NOT honour diff.renames, so without -M a rename splits into a
          // delete + add pair. The three-token `-z` rename sequence it then
          // emits is handled by the pending-rename state machine below.
          '-M',
          '-r',
          '-z',
          `${sha}^1`,
          sha,
        ]
      : [
          '--no-optional-locks',
          'diff-tree',
          '--no-commit-id',
          '--numstat',
          // Detect renames so `git mv` counts as one file (by its new path),
          // matching the main `git diff` path — diff-tree is plumbing and does
          // NOT honour diff.renames, so without -M a rename splits into a
          // delete + add pair. The three-token `-z` rename sequence it then
          // emits is handled by the pending-rename state machine below.
          '-M',
          '-r',
          '-z',
          '--root',
          sha,
        ];
  const numstatRaw = await runGit(diffTreeArgs, gitRoot);

  const files: GitCommitFileStat[] = [];
  let filesCount = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  if (numstatRaw) {
    forEachNumstatEntry(numstatRaw, (entry) => {
      filesCount++;
      linesAdded += entry.added;
      linesRemoved += entry.removed;
      if (files.length < MAX_FILES) {
        files.push({
          path: entry.path,
          added: entry.added,
          removed: entry.removed,
          isBinary: entry.isBinary,
        });
      }
    });
  }

  return {
    sha: parts[0],
    shortSha: parts[1],
    authorName: parts[2],
    authorEmail: parts[3],
    authorDate: parseInt(parts[4], 10) || 0,
    subject: parts[5],
    refs: parts[6],
    parents,
    body: parts[8].replace(/\n$/, ''),
    files,
    filesCount,
    linesAdded,
    linesRemoved,
    hiddenCount: Math.max(filesCount - files.length, 0),
  };
}
