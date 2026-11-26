/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorktreeService — comprehensive git worktree management for the CLI.
 *
 * Provides creation, cleanup, validation, fast-resume, domain-filtered copy,
 * post-creation setup, and stale-ephemeral cleanup.
 *
 * Worktrees are stored at `<projectRoot>/<CONFIG_DIR>/worktrees/<slug>/` with
 * branch `worktree-<slug>`. Nested slugs (`user/feature`) are flattened to
 * `user+feature` to avoid directory/file conflicts in git refs and the
 * filesystem.
 */

import { internalGitArgs } from '../utils/gitCommandPolicy.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ignore from 'ignore';
import {
  BRAND_NAME,
  BRAND_TEMP_PATH_SLUG,
  BRAND_WORKTREE_BASE_FILE,
} from '../config/brand.js';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { CONFIG_DIR } from '../utils/paths.js';
import { runLogger } from '../utils/runLogger.js';
import { FatalConfigError } from '../utils/errors.js';
import {
  createGitCommandEnv,
  readGitHead,
  resolveGitRepositoryLayout,
} from '../utils/gitUtils.js';
import { HookEventName } from '../hooks/types.js';
import type { AggregatedHookResult } from '../hooks/hookAggregator.js';
import { setCwd, setOriginalCwd } from '../utils/Shell.js';
import {
  isUnownedGitWorktree,
  isWorktreeOwnedBySession,
  readWorktreeOwnerState,
} from './worktree-owner-state.js';
import { withWorktreeReservation } from './worktree/creationReservation.js';
import type {
  WorktreeCallbacks,
  WorktreeChangeSummary,
  WorktreeCleanupRequest,
  WorktreeCleanupResult,
  WorktreeCreateOptions,
  WorktreeCreateResult,
  WorktreeInfo,
  WorktreeMaterialization,
  WorktreeRemoveHookResult,
  WorktreeRemoveHookStatus,
  WorktreeSettings,
} from './worktree/contracts.js';
import {
  getWorktreePath,
  parsePRReference,
  validateWorktreeSlug,
  worktreeBranchName,
  worktreePathFor,
  worktreesDir,
} from './worktree/naming.js';

export type {
  WorktreeBaseRef,
  WorktreeCallbacks,
  WorktreeChangeSummary,
  WorktreeCleanupFailureReason,
  WorktreeCleanupRequest,
  WorktreeCleanupResult,
  WorktreeCreateOptions,
  WorktreeCreateResult,
  WorktreeCreationSettings,
  WorktreeInfo,
  WorktreeMaterialization,
  WorktreeRemoveHookResult,
  WorktreeRemoveHookStatus,
} from './worktree/contracts.js';
export {
  MAX_WORKTREE_SLUG_LENGTH,
  flattenSlug,
  getWorktreePath,
  parsePRReference,
  validateWorktreeSlug,
  worktreeBranchName,
  worktreesDir,
} from './worktree/naming.js';
export { normalizeWorktreeCreationSettings } from './worktree/settings.js';

// ---------------------------------------------------------------------------
// execFile helper
// ---------------------------------------------------------------------------

function execFile(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    maxBuffer?: number;
    timeout?: number;
    killSignal?: NodeJS.Signals;
  },
): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }> {
  return new Promise((resolve) => {
    const { cwd, ...options } = opts;
    const childArgs =
      cmd === 'git'
        ? [
            ...internalGitArgs(),
            ...(args[0] !== '-C' ? ['-C', cwd, ...args] : args),
          ]
        : args;
    const childOptions =
      cmd === 'git'
        ? {
            ...options,
            env: createGitCommandEnv(options.env ?? process.env),
          }
        : opts;
    execFileCb(cmd, childArgs, childOptions, (err, stdout, stderr) => {
      let code = 0;
      if (err) {
        // ExecException.code is the numeric exit code when the process ran.
        // ErrnoException.code is a string (e.g. 'ENOENT') when spawn fails.
        // Check type to handle both correctly.
        const rawCode = (err as { code?: string | number }).code;
        code = typeof rawCode === 'number' ? rawCode : 1;
      }
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code,
        ...(err?.killed ? { killed: true } : {}),
      });
    });
  });
}

/** Like execFile but never throws — returns exit code + output. */
async function execFileNoThrow(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    stdin?: 'ignore';
    maxBuffer?: number;
    timeout?: number;
    killSignal?: NodeJS.Signals;
  },
): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }> {
  try {
    return await execFile(cmd, args, opts);
  } catch {
    return { stdout: '', stderr: '', code: 1 };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Ephemeral worktree slug patterns — agent, workflow, and bridge worktrees
 * that may leak on crash/kill. Only these are swept by stale cleanup.
 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,
  /^agent-[a-zA-Z0-9._-]+-[0-9a-f]{7,16}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  /^wf-\d+$/,
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/,
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
];

// Env vars to prevent git/SSH credential prompts (which hang the CLI).
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
};
const WORKTREE_BASE_FETCH_TIMEOUT_MS = 5000;
const WORKTREE_REVIEW_FETCH_TIMEOUT_MS = 120000;
const WORKTREE_HEAD_FALLBACK_TIMEOUT_MS = 2000;
const WORKTREE_FETCH_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const WORKTREE_INCLUDE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Reject anything that is not a plain repository-relative path.
 *
 * Absolute paths, empty segments, `.` and `..` are refused so a configured
 * value can never point outside the repository or the new worktree. A trailing
 * separator is accepted because writing a directory as `pkg-a/` is idiomatic in
 * both gitignore and sparse-checkout syntax.
 */
function isUnsafeRelativePath(candidate: string): boolean {
  const withoutTrailingSeparator = stripTrailingSeparators(candidate);
  if (!withoutTrailingSeparator || path.isAbsolute(withoutTrailingSeparator)) {
    return true;
  }
  return withoutTrailingSeparator
    .split(/[\\/]+/)
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

function stripTrailingSeparators(candidate: string): string {
  return candidate.replace(/[\\/]+$/, '');
}

/**
 * Validate configured sparse-checkout paths.
 *
 * Unlike `symlinkDirectories`, a bad entry here is fatal: silently checking out
 * the whole tree would quietly ignore the requested layout.
 */
function normalizeSparsePaths(sparsePaths: string[] | undefined): string[] {
  if (!sparsePaths || sparsePaths.length === 0) return [];

  const normalized: string[] = [];
  for (const candidate of sparsePaths) {
    const trimmed = stripTrailingSeparators(candidate.trim());
    if (isUnsafeRelativePath(trimmed)) {
      throw new Error(
        `Invalid worktree sparsePaths entry ${JSON.stringify(candidate)}: ` +
          'expected a repository-relative path without ".", "..", or empty segments.',
      );
    }
    // Normalize separators so Windows-style input still forms a valid pattern.
    normalized.push(trimmed.split(/[\\/]+/).join('/'));
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Git worktree 操作会修改仓库级元数据。同一进程中，同一 commonDir 共用队列，
// 不同仓库保持并行。
// ---------------------------------------------------------------------------

const repositoryWorktreeOperationTails = new Map<string, Promise<void>>();

/** 同一仓库的 Git worktree 元数据操作串行，不同仓库可以并行。 */
async function acquireRepositoryWorktreeLock(
  repositoryRoot: string,
): Promise<() => void> {
  const layout = await resolveGitRepositoryLayout(repositoryRoot);
  const repositoryKey = path
    .resolve(layout?.commonDir ?? repositoryRoot)
    .normalize('NFC');
  const previous =
    repositoryWorktreeOperationTails.get(repositoryKey) ?? Promise.resolve();
  let resolveCurrent: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = previous.then(() => current);
  repositoryWorktreeOperationTails.set(repositoryKey, tail);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    resolveCurrent!();
    if (repositoryWorktreeOperationTails.get(repositoryKey) === tail) {
      repositoryWorktreeOperationTails.delete(repositoryKey);
    }
  };
}

// ---------------------------------------------------------------------------
// Fast-resume: read HEAD SHA from the .git pointer file
// ---------------------------------------------------------------------------

/**
 * Read the HEAD commit SHA from a worktree's .git pointer file.
 * Returns null if the worktree doesn't exist or HEAD cannot be resolved.
 *
 * Linked worktree branch refs live in the repository's common Git directory,
 * not in the worktree-specific Git directory. Repository layout, loose refs
 * and packed refs are read directly. Repositories using another ref backend
 * fall back to a bounded `git -C` call; this path is part of an explicit
 * worktree operation and does not run during ordinary startup.
 */
export async function readWorktreeHeadSha(
  worktreePath: string,
): Promise<string | null> {
  return (await readWorktreeHeadState(worktreePath))?.commit ?? null;
}

/** 一次读取同时提供分支与 commit，已有 checkout 不能从目录名反推分支。 */
async function readWorktreeHeadState(
  worktreePath: string,
): Promise<{ commit: string; branch?: string } | null> {
  const layout = await resolveGitRepositoryLayout(worktreePath);
  if (!layout?.isWorktree) return null;
  const head = await readGitHead(layout);
  if (head?.commit) return { commit: head.commit, branch: head.branch };

  const fallback = await execFileNoThrow(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    {
      cwd: worktreePath,
      env: {
        ...process.env,
        ...GIT_NO_PROMPT_ENV,
        GIT_OPTIONAL_LOCKS: '0',
      },
      timeout: WORKTREE_HEAD_FALLBACK_TIMEOUT_MS,
    },
  );
  if (fallback.code !== 0 || !fallback.stdout.trim()) return null;
  return {
    commit: fallback.stdout.trim(),
    branch: head ? head.branch : await readCurrentGitBranch(worktreePath),
  };
}

// ---------------------------------------------------------------------------
// .worktreeinclude file copying
// ---------------------------------------------------------------------------

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function patternMayMatchInsideAnyDirectory(pattern: string): boolean {
  if (pattern.startsWith('!')) return false;

  const withoutTrailingSlash = pattern.endsWith('/')
    ? pattern.slice(0, -1)
    : pattern;
  const anchored = withoutTrailingSlash.startsWith('/');
  const normalized = anchored
    ? withoutTrailingSlash.slice(1)
    : withoutTrailingSlash;
  const firstSlash = normalized.indexOf('/');
  if (firstSlash === -1) return !anchored;

  const firstGlob = normalized.search(/[*?[]/);
  return normalized.startsWith('**/') || (firstGlob >= 0 && firstGlob < firstSlash);
}

/**
 * Reject destinations whose nearest existing parent resolves outside the
 * worktree, or whose final path is itself a symlink.
 */
async function destinationEscapesWorktree(
  destinationPath: string,
  canonicalWorktreeRoot: string,
): Promise<boolean> {
  let parentPath = path.dirname(destinationPath);

  for (;;) {
    try {
      const canonicalParent = await fs.realpath(parentPath);
      if (!isInsidePath(canonicalWorktreeRoot, canonicalParent)) return true;
      break;
    } catch (error) {
      // A non-directory ancestor cannot redirect the write outside the
      // worktree: the later mkdir/copy simply fails. Report it as safe so the
      // caller keeps its own diagnostic instead of blaming a symlink.
      if (isErrnoCode(error, 'ENOTDIR')) return false;
      if (!isErrnoCode(error, 'ENOENT')) return true;

      try {
        // Existing paths which cannot be resolved are commonly broken or
        // cyclic symlinks. Treat them as unsafe.
        await fs.lstat(parentPath);
        return true;
      } catch (lstatError) {
        if (isErrnoCode(lstatError, 'ENOTDIR')) return false;
        if (!isErrnoCode(lstatError, 'ENOENT')) return true;
      }

      const nextParent = path.dirname(parentPath);
      if (nextParent === parentPath) return true;
      parentPath = nextParent;
    }
  }

  try {
    return (await fs.lstat(destinationPath)).isSymbolicLink();
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return false;
    }
    return true;
  }
}

async function pathContainsSymlink(
  root: string,
  relativePath: string,
): Promise<boolean> {
  let current = root;
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return false;
      return true;
    }
  }
  return false;
}

/**
 * Copy gitignored files specified in `.worktreeinclude` from base repo to worktree.
 *
 * Only copies files that are BOTH matched by `.worktreeinclude` patterns
 * and gitignored. Uses `git ls-files --others --ignored --exclude-standard --directory`
 * to list gitignored entries efficiently.
 */
export async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  let includeContent: string;
  try {
    includeContent = await readFile(
      path.join(repoRoot, '.worktreeinclude'),
      'utf-8',
    );
  } catch {
    return [];
  }

  const patterns = includeContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (patterns.length === 0) {
    return [];
  }

  const matcher = ignore().add(includeContent);

  // List gitignored entries with --directory to collapse fully-ignored dirs
  const gitignored = await execFileNoThrow(
    'git',
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ],
    { cwd: repoRoot, maxBuffer: WORKTREE_INCLUDE_MAX_BUFFER_BYTES },
  );
  if (gitignored.code !== 0) {
    runLogger.warn(
      `Skipping .worktreeinclude copy: failed to enumerate ignored files: ${gitignored.stderr.trim() || `git exited with ${gitignored.code}`}`,
    );
    return [];
  }
  if (gitignored.stdout.length === 0) {
    return [];
  }

  const entries = gitignored.stdout.split('\0').filter(Boolean);

  const collapsedDirs = entries.filter((e) => e.endsWith('/'));
  const files = new Set(
    entries.filter((entry) => !entry.endsWith('/') && matcher.ignores(entry)),
  );

  // Expand collapsed dirs where a pattern targets a path inside them
  const expandAllCollapsedDirs = patterns.some(
    patternMayMatchInsideAnyDirectory,
  );
  const dirsToExpand = collapsedDirs.filter((dir) =>
    expandAllCollapsedDirs ||
    patterns.some((p) => {
      const normalized = p.startsWith('/') ? p.slice(1) : p;
      if (normalized.startsWith(dir)) return true;
      const globIdx = normalized.search(/[*?[]/);
      return globIdx > 0 && dir.startsWith(normalized.slice(0, globIdx));
    }) ||
    matcher.ignores(dir),
  );

  if (dirsToExpand.length > 0) {
    // Always scope the expansion to the collapsed directories. Everything else
    // was already listed by the first pass, so an unscoped enumeration would
    // walk the whole repository (e.g. every file under node_modules) for the
    // same result.
    const expanded = await execFileNoThrow(
      'git',
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ...dirsToExpand,
      ],
      { cwd: repoRoot, maxBuffer: WORKTREE_INCLUDE_MAX_BUFFER_BYTES },
    );
    if (expanded.code !== 0) {
      runLogger.warn(
        `Could not expand ignored directories for .worktreeinclude, so files inside them were not copied: ${
          expanded.stderr.trim() || `git exited with ${expanded.code}`
        }`,
      );
    } else if (expanded.stdout.length > 0) {
      for (const file of expanded.stdout.split('\0').filter(Boolean)) {
        if (matcher.ignores(file)) {
          files.add(file);
        }
      }
    }
  }

  const copied: string[] = [];
  let canonicalWorktreeRoot: string;
  try {
    canonicalWorktreeRoot = await fs.realpath(worktreePath);
  } catch (error) {
    runLogger.warn(
      `Skipping .worktreeinclude copy: realpath(${worktreePath}) failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return copied;
  }

  for (const relativePath of files) {
    const srcPath = path.join(repoRoot, relativePath);
    const destPath = path.join(worktreePath, relativePath);
    try {
      if ((await fs.lstat(srcPath)).isSymbolicLink()) {
        runLogger.warn(`Skipping symlink in .worktreeinclude: ${relativePath}`);
        continue;
      }
      if (await destinationEscapesWorktree(destPath, canonicalWorktreeRoot)) {
        runLogger.warn(
          `Skipping .worktreeinclude entry: destination escapes worktree via symlink: ${relativePath}`,
        );
        continue;
      }
      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      copied.push(relativePath);
    } catch (e: unknown) {
      runLogger.debug(
        `Failed to copy ${relativePath} to worktree: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (copied.length > 0) {
    runLogger.debug(
      `Copied ${copied.length} files from .worktreeinclude: ${copied.join(', ')}`,
    );
  }

  return copied;
}

// ---------------------------------------------------------------------------
// Post-creation setup
// ---------------------------------------------------------------------------

/**
 * Post-creation setup for a newly created worktree.
 * - Copies .worktreeinclude files
 * - Symlinks directories (opt-in via settings)
 * - Configures git hooks path
 */
export async function performPostCreationSetup(
  repoRoot: string,
  worktreePath: string,
  options?: { symlinkDirectories?: string[] },
): Promise<void> {
  // 1. Copy .worktreeinclude files (best-effort)
  await copyWorktreeIncludeFiles(repoRoot, worktreePath);

  // 1b. Copy settings.local.json if present (project-scoped settings)
  const settingsLocalPath = path.join(
    repoRoot,
    CONFIG_DIR,
    'settings.local.json',
  );
  try {
    const sourceStat = await fs.lstat(settingsLocalPath);
    if (sourceStat.isSymbolicLink()) {
      runLogger.warn(
        `Skipping symlinked ${CONFIG_DIR}/settings.local.json: ${settingsLocalPath}`,
      );
    } else if (sourceStat.isFile()) {
      const [canonicalRepoRoot, canonicalSettingsPath, canonicalWorktreeRoot] =
        await Promise.all([
          fs.realpath(repoRoot),
          fs.realpath(settingsLocalPath),
          fs.realpath(worktreePath),
        ]);
      if (!isInsidePath(canonicalRepoRoot, canonicalSettingsPath)) {
        runLogger.warn(
          `Skipping ${CONFIG_DIR}/settings.local.json copy: source resolves outside the repository`,
        );
      } else {
        const destinationPath = path.join(
          worktreePath,
          CONFIG_DIR,
          'settings.local.json',
        );
        if (
          await destinationEscapesWorktree(
            destinationPath,
            canonicalWorktreeRoot,
          )
        ) {
          runLogger.warn(
            `Skipping ${CONFIG_DIR}/settings.local.json copy: destination escapes worktree via symlink`,
          );
        } else {
          await mkdir(path.dirname(destinationPath), { recursive: true });
          await copyFile(settingsLocalPath, destinationPath);
          runLogger.debug(
            `Copied ${CONFIG_DIR}/settings.local.json to worktree`,
          );
        }
      }
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      runLogger.debug(
        `Failed to copy ${CONFIG_DIR}/settings.local.json to worktree: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 2. Symlink directories to avoid disk bloat (e.g., node_modules)
  const dirsToSymlink = options?.symlinkDirectories ?? [];
  for (const rawDir of dirsToSymlink) {
    const dir = stripTrailingSeparators(rawDir.trim());
    if (isUnsafeRelativePath(dir)) {
      runLogger.warn(`Skipping symlink for "${rawDir}": invalid relative path`);
      continue;
    }
    const sourcePath = path.join(repoRoot, dir);
    const destPath = path.join(worktreePath, dir);
    try {
      const [canonicalRepoRoot, canonicalWorktreeRoot, sourceStat] =
        await Promise.all([
          fs.realpath(repoRoot),
          fs.realpath(worktreePath),
          fs.lstat(sourcePath),
        ]);
      if (
        !sourceStat.isDirectory() ||
        sourceStat.isSymbolicLink() ||
        (await pathContainsSymlink(repoRoot, dir))
      ) {
        runLogger.warn(
          `Skipping symlink for "${dir}": source is not a real directory`,
        );
        continue;
      }
      const canonicalSource = await fs.realpath(sourcePath);
      if (!isInsidePath(canonicalRepoRoot, canonicalSource)) {
        runLogger.warn(
          `Skipping symlink for "${dir}": source resolves outside the repository`,
        );
        continue;
      }
      if (await destinationEscapesWorktree(destPath, canonicalWorktreeRoot)) {
        runLogger.warn(
          `Skipping symlink for "${dir}": destination escapes the worktree`,
        );
        continue;
      }
      // A nested entry such as `a/b` needs its parent to exist first. Under a
      // sparse checkout that parent is often outside the cone, so without this
      // the symlink fails with ENOENT and is swallowed below.
      await mkdir(path.dirname(destPath), { recursive: true });
      await symlink(canonicalSource, destPath, 'dir');
      runLogger.debug(`Symlinked ${dir} from main repository to worktree`);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        runLogger.debug(
          `Failed to symlink ${dir}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // 3. Configure git hooks path from the main repo (best-effort)
  for (const candidatePath of [
    path.join(repoRoot, '.husky'),
    path.join(repoRoot, '.git', 'hooks'),
  ]) {
    try {
      const s = await stat(candidatePath);
      if (s.isDirectory()) {
        const { code } = await execFileNoThrow(
          'git',
          ['config', 'core.hooksPath', candidatePath],
          { cwd: worktreePath },
        );
        if (code === 0) {
          runLogger.debug(
            `Configured worktree to use hooks from: ${candidatePath}`,
          );
        }
        break;
      }
    } catch {
      // Path doesn't exist
    }
  }
}

// ---------------------------------------------------------------------------
// Core worktree creation (getOrCreate pattern with fast-resume)
// ---------------------------------------------------------------------------

type ReviewProvider = 'github' | 'gitlab' | 'other';

async function detectOriginReviewProvider(
  repoRoot: string,
): Promise<ReviewProvider> {
  const { code, stdout } = await execFileNoThrow(
    'git',
    ['remote', 'get-url', 'origin'],
    { cwd: repoRoot },
  );
  if (code !== 0) return 'other';

  const remoteUrl = stdout.trim().toLowerCase();
  if (remoteUrl.includes('gitlab')) return 'gitlab';
  if (remoteUrl.includes('github')) return 'github';
  return 'other';
}

function reviewFetchRefs(prNumber: number, provider: ReviewProvider): string[] {
  const githubRef = `pull/${prNumber}/head`;
  const gitlabRef = `merge-requests/${prNumber}/head`;
  if (provider === 'github') return [githubRef];
  if (provider === 'gitlab') return [gitlabRef];
  return [githubRef, gitlabRef];
}

/** FETCH_HEAD 属于整个仓库；本次请求用独立引用固定结果，避免并发 fetch 串线。 */
async function fetchReviewHead(
  repoRoot: string,
  prNumber: number,
  fetchEnv: Record<string, string | undefined>,
): Promise<string> {
  const provider = await detectOriginReviewProvider(repoRoot);
  const temporaryRef = `refs/${BRAND_TEMP_PATH_SLUG}/worktree-fetch/${randomUUID()}`;
  try {
    let firstFetchError = '';
    for (const reviewRef of reviewFetchRefs(prNumber, provider)) {
      const result = await execFileNoThrow(
        'git',
        ['fetch', 'origin', `${reviewRef}:${temporaryRef}`],
        {
          cwd: repoRoot,
          stdin: 'ignore',
          env: fetchEnv,
          timeout: WORKTREE_REVIEW_FETCH_TIMEOUT_MS,
        },
      );
      if (!firstFetchError) firstFetchError = result.stderr;
      if (result.code !== 0) continue;

      const head = await execFileNoThrow(
        'git',
        ['rev-parse', '--verify', `${temporaryRef}^{commit}`],
        { cwd: repoRoot },
      );
      if (head.code !== 0 || !head.stdout.trim()) {
        throw new Error(
          `Failed to resolve the fetched commit for PR/MR #${prNumber}.`,
        );
      }
      return head.stdout.trim();
    }
    throw new Error(
      `Failed to fetch PR/MR #${prNumber}: ${firstFetchError.trim() || 'it may not exist, the fetch may have timed out, or the repository may not have a remote named "origin"'}`,
    );
  } finally {
    const cleanup = await execFileNoThrow(
      'git',
      ['update-ref', '-d', temporaryRef],
      {
        cwd: repoRoot,
      },
    );
    if (cleanup.code !== 0) {
      runLogger.warn(
        `Temporary worktree fetch ref retained at ${temporaryRef}: ${cleanup.stderr.trim()}`,
      );
    }
  }
}

async function readFetchHeadMtime(repoRoot: string): Promise<number> {
  const gitPathResult = await execFileNoThrow(
    'git',
    ['rev-parse', '--git-path', 'FETCH_HEAD'],
    { cwd: repoRoot },
  );
  const gitPath = gitPathResult.stdout.trim();
  if (gitPathResult.code !== 0 || !gitPath) return 0;

  const fetchHeadPath = path.isAbsolute(gitPath)
    ? gitPath
    : path.resolve(repoRoot, gitPath);
  return stat(fetchHeadPath)
    .then((value) => value.mtimeMs)
    .catch(() => 0);
}

async function resolveOriginDefaultBranch(repoRoot: string): Promise<string> {
  const symbolicHead = await execFileNoThrow(
    'git',
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: repoRoot },
  );
  const symbolicBranch = symbolicHead.stdout.trim().replace(/^origin\//, '');
  if (
    symbolicHead.code === 0 &&
    symbolicBranch &&
    !symbolicBranch.startsWith('-')
  ) {
    const symbolicRef = await execFileNoThrow(
      'git',
      [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${symbolicBranch}`,
      ],
      { cwd: repoRoot },
    );
    if (symbolicRef.code === 0) return symbolicBranch;
  }

  for (const fallbackBranch of ['main', 'master']) {
    const fallbackRef = await execFileNoThrow(
      'git',
      [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${fallbackBranch}`,
      ],
      { cwd: repoRoot },
    );
    if (fallbackRef.code === 0) return fallbackBranch;
  }

  return 'main';
}

const WORKTREE_BASE_FILE = BRAND_WORKTREE_BASE_FILE;

/** 创建起点属于 checkout；不能随会话关闭、keep 或 owner 交接重置。 */
export async function readWorktreeBaseCommit(
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const layout = await resolveGitRepositoryLayout(worktreePath);
    if (!layout?.isWorktree) return undefined;
    const file = path.join(layout.gitDir, WORKTREE_BASE_FILE);
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.size > 65) return undefined;
    const base = (await fs.readFile(file, 'utf8')).trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base) ? base : undefined;
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT'))
      runLogger.warn(
        'Cannot read worktree creation baseline; deletion requires explicit discard.',
        error,
      );
    return undefined;
  }
}

/**
 * Creates a new git worktree for the given slug, or resumes it if it already exists.
 * Named worktrees reuse the same path across invocations.
 */
export async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: WorktreeCreateOptions,
): Promise<WorktreeCreateResult> {
  const releaseLock = await acquireRepositoryWorktreeLock(repoRoot);
  try {
    return await getOrCreateWorktreeUnlocked(repoRoot, slug, options);
  } finally {
    releaseLock();
  }
}

async function getOrCreateWorktreeUnlocked(
  repoRoot: string,
  slug: string,
  options?: WorktreeCreateOptions,
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug);
  const worktreeBranch = worktreeBranchName(slug);

  // Validate configured paths before any network or Git work: a bad value
  // should not cost the user a PR fetch first.
  const sparsePaths = normalizeSparsePaths(options?.sparsePaths);

  // Fast resume: if the worktree already exists, skip fetch and creation.
  const existingHead = await readWorktreeHeadState(worktreePath);
  if (existingHead) {
    runLogger.debug(`Resuming existing worktree at: ${worktreePath}`);
    // A process may have stopped after `git worktree add --no-checkout` but
    // before sparse-checkout populated the directory. Reconcile the requested
    // sparse cone before reporting a successful resume. Unlike creation-time
    // cleanup, failures here preserve the pre-existing worktree.
    if (
      sparsePaths.length > 0 &&
      !(await hasPopulatedSparseCheckout(worktreePath))
    ) {
      await populateSparseCheckout(worktreePath, sparsePaths);
    }
    return {
      worktreePath,
      worktreeBranch: existingHead.branch,
      // 旧 checkout 缺少可靠起点时保持未知，不能把当前 HEAD 当作无改动依据。
      headCommit: (await readWorktreeBaseCommit(worktreePath)) ?? '',
      existed: true,
    };
  }

  // New worktree: resolve base branch and create
  await mkdir(worktreesDir(repoRoot), { recursive: true });
  const fetchEnv = { ...process.env, ...GIT_NO_PROMPT_ENV } as Record<
    string,
    string | undefined
  >;

  let baseBranch: string;
  let baseSha: string | null = null;

  const useHead = options?.baseRef === 'head' && options.prNumber === undefined;

  if (useHead) {
    const headCwd = options?.fromCwd ?? repoRoot;
    const { code: headCode, stdout: headOut } = await execFileNoThrow(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: headCwd, env: fetchEnv },
    );
    if (headCode !== 0 || !headOut.trim()) {
      throw new Error(
        `Failed to resolve HEAD in ${headCwd}: git rev-parse failed`,
      );
    }
    baseSha = headOut.trim();
    baseBranch = baseSha;
  } else if (options?.prNumber) {
    baseSha = await fetchReviewHead(repoRoot, options.prNumber, fetchEnv);
    baseBranch = 'FETCH_HEAD';
  } else {
    const defaultBranch = await resolveOriginDefaultBranch(repoRoot);
    const originRef = `origin/${defaultBranch}`;

    // Check if we already have the remote ref locally
    const { code: revParseCode, stdout: revParseSha } = await execFileNoThrow(
      'git',
      ['rev-parse', '--verify', originRef],
      { cwd: repoRoot },
    );
    if (revParseCode === 0 && revParseSha.trim()) {
      baseBranch = originRef;
      baseSha = revParseSha.trim();

      const fetchHeadMtime = await readFetchHeadMtime(repoRoot);
      if (Date.now() - fetchHeadMtime > WORKTREE_FETCH_FRESHNESS_MS) {
        const { code: refreshCode } = await execFileNoThrow(
          'git',
          ['fetch', 'origin', defaultBranch],
          {
            cwd: repoRoot,
            stdin: 'ignore',
            env: fetchEnv,
            timeout: WORKTREE_BASE_FETCH_TIMEOUT_MS,
          },
        );
        if (refreshCode === 0) {
          const refreshed = await execFileNoThrow(
            'git',
            ['rev-parse', '--verify', originRef],
            { cwd: repoRoot },
          );
          if (refreshed.code === 0 && refreshed.stdout.trim()) {
            baseSha = refreshed.stdout.trim();
          }
        }
      }
    } else {
      const { code: fetchCode } = await execFileNoThrow(
        'git',
        ['fetch', 'origin', defaultBranch],
        {
          cwd: repoRoot,
          stdin: 'ignore',
          env: fetchEnv,
          timeout: WORKTREE_BASE_FETCH_TIMEOUT_MS,
        },
      );
      baseBranch = fetchCode === 0 ? originRef : 'HEAD';
    }
  }

  // Resolve base SHA if not already known
  if (!baseSha) {
    const { code: shaCode, stdout: shaOut } = await execFileNoThrow(
      'git',
      ['rev-parse', baseBranch],
      { cwd: repoRoot },
    );
    if (shaCode !== 0) {
      throw new Error(
        `Failed to resolve base branch "${baseBranch}": git rev-parse failed`,
      );
    }
    baseSha = shaOut.trim();
  }

  // Create worktree: -B (not -b) resets an orphan branch; --no-track avoids
  // Git config implicitly assigning an upstream.
  //
  // With sparsePaths the checkout is deferred: the cone must be configured
  // before any file lands on disk, otherwise the full tree is materialized
  // first and the setting only takes effect on the next checkout.

  // Git validates the target path and worktree registration *before* `-B` takes
  // effect, so a failed add can leave a pre-existing branch untouched. Record
  // whether the branch was ours to delete before attempting anything.
  const existingBranch = await execFileNoThrow(
    'git',
    ['rev-parse', '--verify', `refs/heads/${worktreeBranch}`],
    { cwd: repoRoot },
  );
  const existingBranchSha = existingBranch.stdout.trim();
  const branchExisted = existingBranch.code === 0 && Boolean(existingBranchSha);

  // `-B` resets an existing branch before creating the worktree. Reusing a
  // stale generated name is safe only when that branch still points at the
  // requested base; otherwise resetting it could discard the sole reference
  // to committed work from an earlier checkout.
  if (branchExisted && existingBranchSha !== baseSha) {
    throw new Error(
      `Refusing to reset existing worktree branch "${worktreeBranch}" from ${existingBranchSha} to ${baseSha}; remove or rename the branch after preserving its commits.`,
    );
  }

  const { code: createCode, stderr: createStderr } = await execFileNoThrow(
    'git',
    [
      'worktree',
      'add',
      '--no-track',
      ...(sparsePaths.length > 0 ? ['--no-checkout'] : []),
      '-B',
      worktreeBranch,
      worktreePath,
      // 已验证的基准 SHA 不能在检出时重新解析为可能被其他 fetch 改动的分支。
      baseSha,
    ],
    { cwd: repoRoot },
  );
  if (createCode !== 0) {
    // Only drop a branch this call created. Deleting a pre-existing one would
    // discard commits that `-B` never got the chance to reset.
    if (!branchExisted) {
      await execFileNoThrow('git', ['branch', '-D', worktreeBranch], {
        cwd: repoRoot,
      });
    }
    throw new Error(`Failed to create worktree: ${createStderr}`);
  }

  if (sparsePaths.length > 0) {
    await applySparseCheckout(
      repoRoot,
      worktreePath,
      branchExisted ? undefined : worktreeBranch,
      sparsePaths,
    );
  }

  try {
    const layout = await resolveGitRepositoryLayout(worktreePath);
    if (!layout?.isWorktree)
      throw new Error('Cannot resolve private worktree Git metadata.');
    await fs.writeFile(
      path.join(layout.gitDir, WORKTREE_BASE_FILE),
      baseSha + '\n',
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  } catch (error) {
    // 无法保存起点时不发布可删除的创建结果，也不销毁已存在的 checkout。
    throw new Error(
      `Cannot persist worktree creation baseline; checkout retained at ${worktreePath}.`,
      { cause: error },
    );
  }

  return {
    worktreePath,
    worktreeBranch,
    headCommit: baseSha,
    baseBranch,
    existed: false,
  };
}

/**
 * Restrict a freshly added `--no-checkout` worktree to `sparsePaths`, then
 * populate it.
 *
 * Failures remove the half-created worktree instead of leaving an empty
 * checkout behind, which would otherwise look like a successful creation whose
 * files are all missing.
 *
 * `createdBranch` is only set when this call created the branch; a pre-existing
 * branch is left alone so cleanup cannot discard user commits.
 */
async function applySparseCheckout(
  repoRoot: string,
  worktreePath: string,
  createdBranch: string | undefined,
  sparsePaths: string[],
): Promise<void> {
  const failAndCleanup = async (message: string): Promise<never> => {
    // Must run from the main checkout: Git refuses to remove a worktree while
    // the working directory is inside it.
    await execFileNoThrow(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: repoRoot },
    );
    if (createdBranch) {
      await execFileNoThrow('git', ['branch', '-D', createdBranch], {
        cwd: repoRoot,
      });
    }
    throw new Error(message);
  };

  try {
    await populateSparseCheckout(worktreePath, sparsePaths);
  } catch (error) {
    return failAndCleanup(
      error instanceof Error
        ? error.message
        : `Failed to populate sparse worktree: ${String(error)}`,
    );
  }
}

async function populateSparseCheckout(
  worktreePath: string,
  sparsePaths: string[],
): Promise<void> {
  const setResult = await execFileNoThrow(
    'git',
    ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
    { cwd: worktreePath },
  );
  if (setResult.code !== 0) {
    throw new Error(
      `Failed to apply worktree sparsePaths: ${
        setResult.stderr.trim() || `git exited with ${setResult.code}`
      }`,
    );
  }

  const checkoutResult = await execFileNoThrow('git', ['checkout'], {
    cwd: worktreePath,
  });
  if (checkoutResult.code !== 0) {
    throw new Error(
      `Failed to check out sparse worktree: ${
        checkoutResult.stderr.trim() || `git exited with ${checkoutResult.code}`
      }`,
    );
  }
}

async function hasPopulatedSparseCheckout(
  worktreePath: string,
): Promise<boolean> {
  const result = await execFileNoThrow(
    'git',
    ['config', '--bool', 'core.sparseCheckout'],
    { cwd: worktreePath },
  );
  if (result.code !== 0 || result.stdout.trim() !== 'true') return false;

  // sparse-checkout 先写配置再物化索引；配置存在不代表首次检出已完成。
  const layout = await resolveGitRepositoryLayout(worktreePath);
  if (!layout) return false;
  try {
    return (await stat(path.join(layout.gitDir, 'index'))).isFile();
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Agent worktree creation (no global session state mutation)
// ---------------------------------------------------------------------------

/**
 * Create a lightweight worktree for a subagent.
 * Reuses getOrCreateWorktree/performPostCreationSetup but does NOT touch
 * global session state (process.chdir, etc.).
 *
 * 路径预占锁防止与会话切换、清理交错；进程内 Git 锁避免并发修改 .git/config。
 * 已有 checkout 只有在没有会话 owner 证据时才允许复用。
 */
export async function createAgentWorktree(
  slug: string,
  repoRoot: string,
  options?: WorktreeCreateOptions,
): Promise<{
  worktreePath: string;
  worktreeBranch?: string;
  headCommit: string;
  gitRoot: string;
}> {
  const result = await createEphemeralWorktree(slug, repoRoot, options);
  return {
    worktreePath: result.worktreePath,
    worktreeBranch: result.worktreeBranch,
    headCommit: result.headCommit,
    gitRoot: repoRoot,
  };
}

/** Agent 与 Bridge 共用临时 checkout 的创建、复用和并发保护。 */
async function createEphemeralWorktree(
  slug: string,
  repoRoot: string,
  options?: WorktreeCreateOptions,
): Promise<WorktreeCreateResult> {
  validateWorktreeSlug(slug);
  const worktreePath = worktreePathFor(repoRoot, slug);
  return withWorktreeReservation(worktreePath, async (reservation) => {
    // 允许新路径和预建空目录；已有 checkout 必须没有会话 owner 证据，
    // 在 getOrCreateWorktree 可能调整 sparse checkout 之前完成检查。
    const entries = await fs.readdir(worktreePath).catch((error: unknown) => {
      if (isErrnoCode(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (entries?.length && !(await isUnownedGitWorktree(worktreePath, repoRoot))) {
      throw new Error(
        `Cannot resume agent worktree at ${worktreePath}: repository identity or ownership cannot be verified.`,
      );
    }

    reservation.assertHeld();
    const result = await getOrCreateWorktree(repoRoot, slug, options);

    const { worktreeBranch, existed } = result;
    reservation.assertHeld();
    if (!existed) {
      runLogger.debug(
        `Created agent worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
      );
      await performPostCreationSetup(repoRoot, worktreePath, options);
    } else {
      // 完成复用前更新时间，过期清理在持锁删除前再次核验。
      const now = new Date();
      await utimes(worktreePath, now, now);
      runLogger.debug(`Resuming existing agent worktree at: ${worktreePath}`);
    }
    return result;
  });
}

/**
 * Remove a worktree created by createAgentWorktree.
 * Removes the worktree directory and deletes the temporary branch.
 *
 * 持路径预占锁检查 owner，并通过进程内 Git 锁串行清理。
 * 自动清理传入校验条件，在锁内复查改动，并保留 Git 的非强制删除保护。
 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch: string | undefined,
  gitRoot: string,
  options?: { staleCutoff?: Date; baseSha?: string },
): Promise<boolean> {
  try {
    return await withWorktreeReservation(worktreePath, async (reservation) => {
      // 名称符合临时目录格式不代表没有会话认领；持锁校验，避免与 Enter/Restore 交错。
      if (!(await isUnownedGitWorktree(worktreePath, gitRoot))) {
        runLogger.debug(
          `Preserving agent worktree with ownership evidence or unverifiable state: ${worktreePath}`,
        );
        return false;
      }
      const releaseLock = await acquireRepositoryWorktreeLock(gitRoot);
      try {
        reservation.assertHeld();
        if (
          options?.baseSha !== undefined &&
          (await hasWorktreeChanges(worktreePath, options.baseSha))
        ) {
          return false;
        }
        const staleCutoff = options?.staleCutoff;
        if (staleCutoff) {
          // 扫描只选择候选；目录时间不能证明已有文件或 HEAD 没有变化。
          // 在路径锁和 Git 操作锁内重新验证，失败时保留 checkout。
          if ((await fs.stat(worktreePath)).mtimeMs >= staleCutoff.getTime()) {
            return false;
          }
          const [status, unpushed] = await Promise.all([
            execFileNoThrow(
              'git',
              [
                '--no-optional-locks',
                'status',
                '--porcelain',
                '--untracked-files=all',
              ],
              { cwd: worktreePath },
            ),
            execFileNoThrow(
              'git',
              ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
              { cwd: worktreePath },
            ),
          ]);
          if (
            status.code !== 0 ||
            status.stdout.trim() ||
            unpushed.code !== 0 ||
            unpushed.stdout.trim()
          ) {
            return false;
          }
        }
        reservation.assertHeld();
        // Bridge 的兼容入口可能仍位于即将删除的 checkout；拒绝清理时不能提前切 cwd。
        if (isInsidePath(worktreePath, process.cwd())) {
          process.chdir(gitRoot);
          const resolved = process.cwd();
          setCwd(resolved);
          setOriginalCwd(resolved);
        }
        const { code: removeCode, stderr: removeError } = await execFileNoThrow(
          'git',
          [
            'worktree',
            'remove',
            ...(options ? [] : ['--force']),
            worktreePath,
          ],
          { cwd: gitRoot },
        );

        if (removeCode !== 0) {
          runLogger.debug(`Failed to remove agent worktree: ${removeError}`);
          return false;
        }
        runLogger.debug(`Removed agent worktree at: ${worktreePath}`);

        // 自动清理只处理生成的临时分支；用户改名后的分支不属于清理目标。
        if (
          worktreeBranch !== worktreeBranchName(path.basename(worktreePath))
        ) {
          return true;
        }

        // 即使 checkout 已切换到别的 HEAD，旧临时分支也可能保留未合并提交。
        const { code: deleteBranchCode, stderr: deleteBranchError } =
          await execFileNoThrow('git', ['branch', '-d', worktreeBranch], {
            cwd: gitRoot,
          });

        if (deleteBranchCode !== 0) {
          runLogger.debug(
            `Could not delete agent worktree branch: ${deleteBranchError}`,
          );
        }
        return true;
      } finally {
        releaseLock();
      }
    });
  } catch (error) {
    runLogger.debug(
      `Preserving agent worktree after cleanup failed at ${worktreePath}: ${String(error)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stale ephemeral worktree cleanup
// ---------------------------------------------------------------------------

/**
 * Remove stale agent/workflow worktrees older than cutoffDate.
 *
 * Safety:
 * - 仅选择临时名称格式，删除前持锁检查 owner；名称本身不能证明目录可删除
 * - Skips the provided current worktree path
 * - Fail-closed: skips if git status fails or shows any tracked/untracked changes
 * - Fail-closed: skips if any commits aren't reachable from a remote
 */
export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
  repoRoot: string,
  currentWorktreePath?: string,
): Promise<number> {
  const dir = worktreesDir(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const cutoffMs = cutoffDate.getTime();
  let removed = 0;

  for (const slug of entries) {
    if (!EPHEMERAL_WORKTREE_PATTERNS.some((p) => p.test(slug))) {
      continue;
    }

    const wtPath = path.join(dir, slug);
    if (currentWorktreePath === wtPath) {
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(wtPath)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoffMs) {
      continue;
    }

    const branch = worktreeBranchName(slug);
    if (
      await removeAgentWorktree(
        wtPath,
        branch,
        repoRoot,
        {
          staleCutoff: cutoffDate,
        },
      )
    ) {
      removed++;
    }
  }

  if (removed > 0) {
    const releaseLock = await acquireRepositoryWorktreeLock(repoRoot);
    try {
      await execFileNoThrow('git', ['worktree', 'prune'], { cwd: repoRoot });
    } finally {
      releaseLock();
    }
    runLogger.debug(
      `cleanupStaleAgentWorktrees: removed ${removed} stale worktree(s)`,
    );
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Worktree session-level API
// ---------------------------------------------------------------------------

export async function readCurrentGitBranch(
  cwd: string,
): Promise<string | undefined> {
  const layout = await resolveGitRepositoryLayout(cwd);
  return layout ? (await readGitHead(layout))?.branch : undefined;
}

/**
 * Returns whether the current CLI session may manage this worktree's
 * lifecycle. Missing or ambiguous provenance is treated as attached (fail
 * closed): older owner and inherited-child state cannot be distinguished
 * safely without an ownership token.
 */
export function ownsWorktreeLifecycle(
  settings: Pick<
    WorktreeSettings,
    'path' | 'originalCwd' | 'lifecycle'
  >,
): boolean {
  return settings.lifecycle === 'owner';
}

/** Raised when worktree creation is requested outside a Git repository. */
export class WorktreeRepositoryNotFoundError extends FatalConfigError {
  constructor(cwd: string) {
    super(`Cannot create a worktree: "${cwd}" is not inside a Git repository.`);
    this.name = 'WorktreeRepositoryNotFoundError';
  }
}

interface RegisteredWorktree {
  worktreePath: string;
  worktreeBranch?: string;
  locked?: boolean;
  prunable?: boolean;
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function listRegisteredWorktrees(
  repoRoot: string,
): Promise<RegisteredWorktree[]> {
  const result = await execFileNoThrow(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: repoRoot },
  );
  if (result.code !== 0) {
    throw new Error(
      `Cannot list registered worktrees for ${repoRoot}: ${result.stderr.trim() || `git exited with code ${result.code}`}`,
    );
  }

  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { worktreePath: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && current) {
      current.worktreeBranch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if ((line === 'locked' || line.startsWith('locked ')) && current) {
      current.locked = true;
    } else if (
      (line === 'prunable' || line.startsWith('prunable ')) &&
      current
    ) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Validate and describe a model-requested switch into an existing worktree.
 *
 * First entry may target any registered worktree in the current repository,
 * or in a repository nested under the launch root. Once the session is already
 * isolated, switching is deliberately narrower: the target must be another
 * managed worktree of the same repository.
 */
export async function resolveExistingWorktreeForSession(
  sessionId: string,
  requestedPath: string,
  launchRoot: string,
  activeSettings?: WorktreeSettings,
  originalCwd: string = launchRoot,
): Promise<WorktreeMaterialization> {
  const currentCwd = await fs.realpath(
    activeSettings?.worktreeCwd ?? originalCwd,
  );
  let targetPath: string;
  try {
    targetPath = await fs.realpath(path.resolve(currentCwd, requestedPath));
  } catch (error) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const targetStat = await stat(targetPath).catch(() => undefined);
  if (!targetStat?.isDirectory()) {
    throw new Error(`Cannot enter worktree: ${requestedPath} is not a directory.`);
  }
  if (targetPath === currentCwd) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath} is the current working directory.`,
    );
  }

  const ownerRepoRoot = await findProjectRootForWorktree(targetPath);
  if (!ownerRepoRoot) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath} is not in a Git repository.`,
    );
  }
  const canonicalOwnerRoot = await fs.realpath(ownerRepoRoot);
  if (targetPath === canonicalOwnerRoot) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath} is the main working tree, not a linked worktree.`,
    );
  }

  const currentRepoRoot = await findProjectRootForWorktree(currentCwd);
  const canonicalLaunchRoot = await fs.realpath(launchRoot).catch(() =>
    path.resolve(launchRoot),
  );
  if (activeSettings) {
    const canonicalCurrentRoot = currentRepoRoot
      ? await fs.realpath(currentRepoRoot)
      : undefined;
    const managedRoot = path.join(
      canonicalOwnerRoot,
      CONFIG_DIR,
      'worktrees',
    );
    if (
      canonicalCurrentRoot !== canonicalOwnerRoot ||
      !isSameOrChildPath(targetPath, managedRoot)
    ) {
      throw new Error(
        `Cannot enter worktree: ${requestedPath} is not a ${BRAND_NAME}-managed worktree of the current repository.`,
      );
    }
  } else {
    const canonicalCurrentRoot = currentRepoRoot
      ? await fs.realpath(currentRepoRoot)
      : undefined;
    const sameRepo = canonicalCurrentRoot === canonicalOwnerRoot;
    const nestedRepo = isSameOrChildPath(canonicalOwnerRoot, canonicalLaunchRoot);
    if (!sameRepo && !nestedRepo) {
      throw new Error(
        `Cannot enter worktree: ${requestedPath} belongs to a repository outside ${canonicalLaunchRoot}.`,
      );
    }
  }

  const registered = await listRegisteredWorktrees(canonicalOwnerRoot);
  let target: RegisteredWorktree | undefined;
  for (const candidate of registered) {
    const canonicalCandidate = await fs
      .realpath(candidate.worktreePath)
      .catch(() => path.resolve(candidate.worktreePath));
    if (canonicalCandidate === targetPath) {
      target = candidate;
      break;
    }
  }
  if (!target) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath} is not registered by git. Run "git -C ${canonicalOwnerRoot} worktree list" to inspect registered worktrees.`,
    );
  }
  if (target.prunable) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath} is marked prunable by git.`,
    );
  }
  if (target.locked) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath} is locked by another worktree owner.`,
    );
  }
  const durableOwner = await readWorktreeOwnerState(targetPath, false);
  if (
    durableOwner?.ownerSessionId &&
    durableOwner.ownerSessionId !== sessionId
  ) {
    throw new Error(
      `Cannot enter worktree: ${requestedPath} is owned by another active ${BRAND_NAME} session.`,
    );
  }

  return {
    worktreePath: targetPath,
    worktreeName: path.basename(targetPath),
    worktreeBranch: target.worktreeBranch,
    originalBranch:
      activeSettings?.originalBranch ??
      (await readCurrentGitBranch(originalCwd)),
    enteredExisting: true,
    created: false,
  };
}

// ---------------------------------------------------------------------------
// Session-level worktree lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a worktree for an interactive session.
 *
 * 仅创建并描述 Worktree；运行时状态由 WorktreeSessionService 安装。
 */
export async function createWorktreeForSession(
  slug: string,
  projectRoot: string,
  hookSystem?: {
    hasWorktreeCreateHook: () => boolean;
    executeWorktreeCreateHook: (
      name: string,
    ) => Promise<{ worktreePath: string }>;
  },
  options?: WorktreeCreateOptions,
  originalCwd: string = projectRoot,
): Promise<WorktreeMaterialization> {
  validateWorktreeSlug(slug);

  let hookBased = false;
  let worktreePath: string;
  let worktreeBranch: string | undefined;
  let originalHeadCommit: string | undefined;
  let originalBranch: string | undefined;
  let created: boolean;

  // Try hook-based creation first (allows user-configured VCS)
  if (hookSystem?.hasWorktreeCreateHook()) {
    const hookResult = await hookSystem.executeWorktreeCreateHook(slug);
    worktreePath = hookResult.worktreePath;
    hookBased = true;
    created = true;
    runLogger.debug(`Created hook-based worktree at: ${worktreePath}`);
  } else {
    // Fall back to git worktree
    if (!projectRoot) {
      throw new Error(
        'Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
          'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
      );
    }

    // Original branch is optional session metadata, read without starting Git.
    originalBranch = await readCurrentGitBranch(originalCwd);

    const result = await getOrCreateWorktree(projectRoot, slug, options);
    created = !result.existed;

    if (!result.existed) {
      runLogger.debug(
        `Created worktree at: ${result.worktreePath} on branch: ${result.worktreeBranch}`,
      );
      try {
        await performPostCreationSetup(projectRoot, result.worktreePath, options);
      } catch (error) {
        // Worktree 已创建但后置配置失败时，不应留下无法进入的 checkout。
        try {
          await cleanupWorktree(result.worktreePath, projectRoot, {
            force: true,
          });
        } catch (cleanupError) {
          runLogger.warn(
            `Failed to clean up worktree after post-creation setup failure: ${
              cleanupError instanceof Error
                ? cleanupError.message
              : String(cleanupError)
            }`,
          );
          throw new AggregateError(
            [error, cleanupError],
            'Worktree post-creation setup failed and cleanup also failed.',
          );
        }
        throw error;
      }
    } else {
      runLogger.debug(`Resuming existing worktree at: ${result.worktreePath}`);
    }

    worktreePath = result.worktreePath;
    worktreeBranch = result.worktreeBranch;
    originalHeadCommit = result.headCommit;
  }

  return {
    worktreePath,
    worktreeName: slug,
    worktreeBranch,
    originalBranch,
    originalHeadCommit,
    hookBased,
    created,
  };
}

/**
 * Remove a session-managed worktree after verifying durable ownership.
 *
 * Lifecycle strings are only an initial UI guard. Destructive cleanup also
 * requires the current session id to match both the settings and the owner
 * metadata stored in the linked worktree's private Git directory. Missing or
 * ambiguous ownership fails closed.
 */
export async function cleanupWorktreeSession(
  request: WorktreeCleanupRequest,
  hookSystem?: {
    executeWorktreeRemoveHook: (
      worktreePath: string,
    ) => Promise<WorktreeRemoveHookResult | boolean>;
  },
): Promise<WorktreeCleanupResult> {
  const { worktreeSettings, currentSessionId } = request;
  if (!ownsWorktreeLifecycle(worktreeSettings)) {
    return { removed: false, reason: 'not-owner' };
  }

  if (
    !currentSessionId ||
    !worktreeSettings.sessionId ||
    worktreeSettings.sessionId !== currentSessionId
  ) {
    return { removed: false, reason: 'owner-mismatch' };
  }

  const worktreePath = worktreeSettings.path;
  const originalCwd = worktreeSettings.originalCwd;
  const hookBased = worktreeSettings.hookBased ?? false;

  if (!worktreePath || !originalCwd) {
    runLogger.debug(
      'cleanupWorktreeSession: missing worktree path or original cwd',
    );
    return { removed: false, reason: 'missing-context' };
  }

  if (
    !(await isWorktreeOwnedBySession(worktreePath, currentSessionId, hookBased))
  ) {
    return { removed: false, reason: 'owner-mismatch' };
  }

  // 运行目录由会话事务管理；清理命令显式使用 originalCwd，不能修改 ACP Host 的 cwd。
  try {
    if (hookBased) {
      const hookResult = normalizeWorktreeRemoveHookResult(
        await hookSystem?.executeWorktreeRemoveHook(worktreePath),
      );
      if (hookResult.status !== 'removed') {
        return {
          removed: false,
          reason: 'cleanup-failed',
          message:
            hookResult.status === 'unknown'
              ? 'WorktreeRemove hook did not confirm whether the worktree was removed.'
              : 'WorktreeRemove hook retained the worktree.',
        };
      }
      runLogger.debug(`Removed hook-based worktree at: ${worktreePath}`);
    } else {
      await cleanupWorktree(worktreePath, originalCwd, {
        force: request.force === true,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runLogger.warn(`Failed to remove worktree ${worktreePath}: ${message}`);
    return { removed: false, reason: 'cleanup-failed', message };
  }

  runLogger.debug('Worktree session cleaned up completely');
  return { removed: true };
}

function normalizeWorktreeRemoveHookResult(
  result: WorktreeRemoveHookResult | boolean | undefined,
): WorktreeRemoveHookResult {
  if (typeof result === 'boolean') {
    return { status: result ? 'removed' : 'retained' };
  }
  return result ?? { status: 'retained' };
}

/**
 * 补偿本次 prepare 新建、但尚未提交给会话状态的 Worktree。
 * 仅接收当前调用刚创建的资源，因此不复用会话所有权校验。
 */
export async function cleanupCreatedWorktreeForSession(
  session: Pick<WorktreeMaterialization, 'worktreePath' | 'hookBased'>,
  originalCwd: string,
  hookSystem?: {
    executeWorktreeRemoveHook: (
      worktreePath: string,
    ) => Promise<WorktreeRemoveHookResult | boolean>;
  },
): Promise<void> {
  if (session.hookBased) {
    const hookResult = normalizeWorktreeRemoveHookResult(
      await hookSystem?.executeWorktreeRemoveHook(session.worktreePath),
    );
    if (hookResult.status !== 'removed') {
      throw new Error(
        `WorktreeRemove hook returned ${hookResult.status} while compensating ${session.worktreePath}.`,
      );
    }
    return;
  }

  await cleanupWorktree(session.worktreePath, originalCwd, { force: true });
}

// ---------------------------------------------------------------------------
// Change counting
// ---------------------------------------------------------------------------

/**
 * Count uncommitted files and new commits in a worktree relative to a base SHA.
 * Returns null if git commands fail (fail-closed).
 */
export async function countWorktreeChanges(
  worktreePath: string,
  baseSha?: string,
): Promise<WorktreeChangeSummary | null> {
  const status = await execFileNoThrow(
    'git',
    ['-C', worktreePath, 'status', '--porcelain'],
    { cwd: worktreePath },
  );
  if (status.code !== 0) return null;

  const changedFiles = status.stdout
    .split('\n')
    .filter((l) => l.trim() !== '').length;

  if (!baseSha) {
    // git status succeeded but no baseline commit → can't count commits.
    // Fail-closed rather than claim 0.
    return null;
  }

  const revList = await execFileNoThrow(
    'git',
    ['-C', worktreePath, 'rev-list', '--count', `${baseSha}..HEAD`],
    { cwd: worktreePath },
  );
  if (revList.code !== 0) return null;

  const rawCommitCount = revList.stdout.trim();
  if (!/^\d+$/.test(rawCommitCount)) return null;
  const commits = Number.parseInt(rawCommitCount, 10);
  return { changedFiles, commits };
}

// ---------------------------------------------------------------------------
// Hook helpers
// ---------------------------------------------------------------------------

/**
 * Check if a WorktreeCreate hook is registered in the given HookSystem.
 */
export function hasWorktreeCreateHook(hookSystem?: {
  getRegistry: () => {
    getHooksForEvent: (eventName: HookEventName) => unknown[];
  };
}): boolean {
  if (!hookSystem) return false;
  const entries = hookSystem
    .getRegistry()
    .getHooksForEvent(HookEventName.WorktreeCreate);
  return entries.length > 0;
}

/**
 * Check if a WorktreeRemove hook is registered in the given HookSystem.
 */
export function hasWorktreeRemoveHook(hookSystem?: {
  getRegistry: () => {
    getHooksForEvent: (eventName: HookEventName) => unknown[];
  };
}): boolean {
  if (!hookSystem) return false;
  const entries = hookSystem
    .getRegistry()
    .getHooksForEvent(HookEventName.WorktreeRemove);
  return entries.length > 0;
}

/**
 * Execute WorktreeCreate hooks via the HookSystem and extract the worktree path.
 * Returns the worktree path from the first successful hook output.
 * Throws if hooks fail or produce no usable output.
 */
export async function executeWorktreeCreateHook(
  hookSystem: {
    fireWorktreeCreateEvent: (
      name: string,
      signal?: AbortSignal,
    ) => Promise<AggregatedHookResult>;
  },
  name: string,
): Promise<{ worktreePath: string }> {
  const result = await hookSystem.fireWorktreeCreateEvent(name);

  const successfulHookCount =
    result.successfulHookCount ??
    (result.success && result.allOutputs.length > 0 ? 1 : 0);
  if (!result.success || successfulHookCount === 0) {
    const failedOutputs = result.errors.map((e) => e.message).join('; ');
    throw new Error(
      `WorktreeCreate hook failed: ${failedOutputs || 'no successful output'}`,
    );
  }

  // Try to extract worktreePath from hookSpecificOutput, then from stdout
  for (const output of result.allOutputs) {
    const specific = output.hookSpecificOutput as
      | { worktreePath?: string }
      | undefined;
    if (specific?.worktreePath) {
      return {
        worktreePath: await canonicalizeHookWorktreePath(
          specific.worktreePath,
        ),
      };
    }
  }

  // Fallback: use stdout content as worktreePath
  for (const output of result.allOutputs) {
    const stdout = (output as { stdoutContent?: string }).stdoutContent;
    if (stdout) {
      return { worktreePath: await canonicalizeHookWorktreePath(stdout) };
    }
  }

  throw new Error(
    'WorktreeCreate hook succeeded but returned no worktree path',
  );
}

async function canonicalizeHookWorktreePath(candidate: string): Promise<string> {
  const normalized = candidate.trim();
  if (!normalized) {
    throw new Error(
      'WorktreeCreate hook succeeded but returned no worktree path',
    );
  }
  // Hook 契约要求绝对路径；ACP 多会话的执行 cwd 不等于进程 cwd，不能隐式补全。
  if (!path.isAbsolute(normalized)) {
    throw new Error(
      `WorktreeCreate hook must return an absolute path; received "${candidate}".`,
    );
  }

  try {
    return await fs.realpath(normalized);
  } catch (error) {
    throw new Error(
      `WorktreeCreate hook returned an invalid worktree path "${candidate}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 执行 WorktreeRemove Hook，并返回 Hook 对清理结果的确认状态。
 *
 * 已注册的 Hook 不代表它实际执行：当事件下的 Hook 都是异步或被 `if:`
 * 条件过滤时，Hook 系统会返回空的成功结果。此时不能视为已删除，以免留下
 * 没有 owner 的 Worktree。未声明 status 的历史 Hook 保持成功执行即删除的兼容语义。
 */
export async function executeWorktreeRemoveHookWithStatus(
  hookSystem: {
    getRegistry: () => {
      getHooksForEvent: (eventName: HookEventName) => unknown[];
    };
    fireWorktreeRemoveEvent: (
      worktreePath: string,
      signal?: AbortSignal,
    ) => Promise<AggregatedHookResult>;
  },
  worktreePath: string,
): Promise<WorktreeRemoveHookResult> {
  const entries = hookSystem
    .getRegistry()
    .getHooksForEvent(HookEventName.WorktreeRemove);
  if (entries.length === 0) return { status: 'retained' };

  let result: AggregatedHookResult;
  try {
    result = await hookSystem.fireWorktreeRemoveEvent(worktreePath);
  } catch (error) {
    runLogger.debug(
      `WorktreeRemove hook execution failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { status: 'unknown' };
  }

  for (const err of result.errors) {
    runLogger.debug(`WorktreeRemove hook failed: ${err.message}`);
  }

  const statuses = new Set<WorktreeRemoveHookStatus>();
  for (const output of result.allOutputs) {
    const status = (output.hookSpecificOutput as { status?: unknown } | undefined)
      ?.status;
    if (isWorktreeRemoveHookStatus(status)) {
      statuses.add(status);
    }
  }

  if (statuses.size > 1) {
    return { status: 'unknown' };
  }
  if (statuses.size === 1) {
    return { status: [...statuses][0] };
  }
  if ((result.successfulHookCount ?? 0) > 0) {
    // 未声明 status 的历史 Hook 保持原有“成功执行即删除”的兼容语义。
    return { status: 'removed' };
  }
  return { status: result.errors.length > 0 ? 'unknown' : 'retained' };
}

/** 保持历史布尔调用方兼容。 */
export async function executeWorktreeRemoveHook(
  hookSystem: {
    getRegistry: () => {
      getHooksForEvent: (eventName: HookEventName) => unknown[];
    };
    fireWorktreeRemoveEvent: (
      worktreePath: string,
      signal?: AbortSignal,
    ) => Promise<AggregatedHookResult>;
  },
  worktreePath: string,
): Promise<boolean> {
  return (
    (await executeWorktreeRemoveHookWithStatus(hookSystem, worktreePath))
      .status === 'removed'
  );
}

function isWorktreeRemoveHookStatus(
  value: unknown,
): value is WorktreeRemoveHookStatus {
  return value === 'removed' || value === 'retained' || value === 'unknown';
}

/**
 * Service for managing Git worktrees within the CLI.
 * Handles creation, cleanup, and environment setup for isolated sessions.
 */
export class WorktreeService {
  constructor(
    private readonly projectRoot: string,
    private readonly callbacks?: WorktreeCallbacks,
  ) {}

  /**
   * Creates a new worktree and prepares the environment.
   */
  async setup(
    name?: string,
    options?: WorktreeCreateOptions,
  ): Promise<WorktreeInfo> {
    let worktreeName = name?.trim();
    let prNumber = options?.prNumber;

    if (worktreeName) {
      const parsedReview = parsePRReference(worktreeName);
      if (parsedReview !== null) {
        prNumber = parsedReview;
        worktreeName = `pr-${parsedReview}`;
      }
    }

    if (!worktreeName) {
      const now = new Date();
      const timestamp = now
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '-')
        .replace('Z', '');
      const randomSuffix = Math.random().toString(36).substring(2, 6);
      worktreeName = `${timestamp}-${randomSuffix}`;
    }

    const result = await createEphemeralWorktree(
      worktreeName,
      this.projectRoot,
      {
        ...options,
        prNumber,
      },
    );

    // Fire WorktreeCreate callback (best-effort)
    try {
      this.callbacks?.onWorktreeCreate?.(worktreeName);
    } catch {
      // Ignore errors in callbacks
    }

    return {
      name: worktreeName,
      path: result.worktreePath,
      baseSha: result.headCommit,
      created: !result.existed,
    };
  }

  /**
   * Checks if a worktree has changes and cleans it up if it's unmodified.
   */
  async maybeCleanup(info: WorktreeInfo): Promise<boolean> {
    const removed = await removeAgentWorktree(
      info.path,
      info.worktreeBranch ?? worktreeBranchName(info.name),
      this.projectRoot,
      { baseSha: info.baseSha },
    );
    if (removed) {
      runLogger.log(`Automatically cleaned up unmodified worktree: ${info.path}`);
      try {
        this.callbacks?.onWorktreeRemove?.(info.path);
      } catch {
        // 回调失败不能改变已完成的清理结果。
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Low-level worktree utilities (preserved for backward compat)
// ---------------------------------------------------------------------------

export async function createWorktreeService(
  cwd: string,
  callbacks?: WorktreeCallbacks,
): Promise<WorktreeService> {
  const projectRoot = await findProjectRootForWorktree(cwd);
  if (!projectRoot) {
    throw new WorktreeRepositoryNotFoundError(cwd);
  }
  return new WorktreeService(projectRoot, callbacks);
}

/**
 * Resolve the canonical repository root used to store managed worktrees.
 * Returns undefined when cwd is not inside a Git repository.
 */
export async function findProjectRootForWorktree(
  cwd: string,
): Promise<string | undefined> {
  const layout = await resolveGitRepositoryLayout(cwd);
  return layout ? path.dirname(layout.commonDir) : undefined;
}

/**
 * Backward-compatible project-root lookup. Callers that require a Git
 * repository must use findProjectRootForWorktree() or createWorktreeService().
 */
export async function getProjectRootForWorktree(cwd: string): Promise<string> {
  return (await findProjectRootForWorktree(cwd)) ?? cwd;
}

export async function createWorktree(
  projectRoot: string,
  name: string,
): Promise<string> {
  const worktreePath = getWorktreePath(projectRoot, name);
  const branchName = `worktree-${name}`;

  // Serialize to prevent .git/config.lock contention with concurrent agents
  const releaseLock = await acquireRepositoryWorktreeLock(projectRoot);
  try {
    // Use -B to reset any orphan branch left by a previous failed creation
    const { code, stderr } = await execFile(
      'git',
      ['worktree', 'add', worktreePath, '-B', branchName],
      { cwd: projectRoot },
    );
    if (code !== 0) {
      // Tear down: clean up any partially-registered worktree before
      // propagating the error (prevents a broken fast-resume on next run).
      await execFileNoThrow(
        'git',
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: projectRoot },
      );
      throw new Error(
        `Failed to create worktree: ${stderr.trim() || 'git worktree add exited with code ' + code}`,
      );
    }
  } finally {
    releaseLock();
  }

  return worktreePath;
}

export function isGeminiWorktree(
  dirPath: string,
  projectRoot: string,
): boolean {
  try {
    const realDirPath = realpathSync(dirPath);
    const realProjectRoot = realpathSync(projectRoot);
    const worktreesBaseDir = path.join(
      realProjectRoot,
      CONFIG_DIR,
      'worktrees',
    );
    const relative = path.relative(worktreesBaseDir, realDirPath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export async function hasWorktreeChanges(
  dirPath: string,
  baseSha?: string,
): Promise<boolean> {
  try {
    // 1. Check for uncommitted changes
    const statusResult = await execFileNoThrow(
      'git',
      ['status', '--porcelain'],
      { cwd: dirPath },
    );
    if (statusResult.code !== 0) {
      return true;
    }
    if (statusResult.stdout.trim() !== '') {
      return true;
    }

    // 2. Check if the current commit has moved from the base
    if (!baseSha) return true;

    const { code: revListCode, stdout: revListOutput } =
      await execFileNoThrow(
        'git',
        ['rev-list', '--count', `${baseSha}..HEAD`],
        { cwd: dirPath },
      );
    if (revListCode !== 0 || !/^\d+$/.test(revListOutput.trim())) {
      return true;
    }
    if (Number.parseInt(revListOutput.trim(), 10) > 0) {
      return true;
    }

    return false;
  } catch (e: unknown) {
    runLogger.debug(
      `Failed to check worktree changes at ${dirPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return true;
  }
}

export async function cleanupWorktree(
  dirPath: string,
  projectRoot: string,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return; // Worktree already gone
    }
    throw error;
  }

  const releaseLock = await acquireRepositoryWorktreeLock(projectRoot);
  try {
    // 1. Discover the branch name associated with this worktree path
    const { stdout } = await execFileNoThrow(
      'git',
      ['-C', dirPath, 'branch', '--show-current'],
      { cwd: projectRoot },
    );
    const branchName = stdout.trim() || undefined;

    // 2. Remove the worktree — check exit code and throw on failure
    const removeArgs = ['worktree', 'remove', dirPath];
    if (options.force === true) removeArgs.push('--force');
    const removeResult = await execFileNoThrow('git', removeArgs, {
      cwd: projectRoot,
    });
    if (removeResult.code !== 0) {
      const errMsg =
        removeResult.stderr.trim() || `exit code ${removeResult.code}`;
      throw new Error(`git worktree remove failed: ${errMsg}`);
    }

    // 3. Removal includes the branch. The caller has already checked changes
    // or explicitly authorized discarding them. A clean worktree may start
    // ahead of the original checkout, so -d can incorrectly retain its branch.
    if (branchName) {
      const branchResult = await execFileNoThrow(
        'git',
        ['branch', '-D', branchName],
        { cwd: projectRoot },
      );
      if (branchResult.code !== 0) {
        const errMsg =
          branchResult.stderr.trim() || `exit code ${branchResult.code}`;
        throw new Error(
          `git branch delete failed for ${branchName}: ${errMsg}`,
        );
      }
    }
  } finally {
    releaseLock();
  }
}
