/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { randomBytes, randomInt } from 'node:crypto';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import type { SimpleGit } from 'simple-git';
import { Storage } from '../config/storage.js';
import { isCommandAvailable } from '../utils/shell-utils.js';
import { isNodeError } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { fileExists, isWithinRoot } from '../utils/fileUtils.js';
import { loadSimpleGit } from '../utils/load-simple-git.js';
import { initRepositoryWithMainBranch } from './gitInit.js';

const debugLogger = createDebugLogger('GIT_WORKTREE_SERVICE');

/**
 * Repo-root opt-in file listing gitignored paths to copy into every new
 * general-purpose worktree. Committed, so it travels with the repository —
 * unlike the per-user `worktree.symlinkDirectories` setting. See
 * `copyIncludedPaths` for why both exist.
 */
const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/**
 * Caps on the committed `.worktreeinclude`. It is lower-trust input and
 * every pattern is re-evaluated per candidate, so an unbounded file is a
 * denial of service against worktree creation — see
 * `readWorktreeIncludePatterns`. Generous next to any legitimate file.
 */
const WORKTREE_INCLUDE_MAX_BYTES = 1024 * 1024;
const WORKTREE_INCLUDE_MAX_PATTERNS = 10_000;

/**
 * How many directory pathspecs to hand one scoped `git ls-files`. Keeps
 * the argv well under every platform's limit; a repo with more collapsed
 * ignored directories than this is listed across several calls.
 */
const WORKTREE_INCLUDE_PATHSPEC_BATCH = 1000;

/** Prefix applied to every general-purpose worktree branch. */
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

/** Returns the canonical branch name for a worktree slug. */
export function worktreeBranchForSlug(slug: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${slug}`;
}

/**
 * Filename of the in-worktree session marker. Created at worktree
 * provisioning time and consulted by `exit_worktree` to decide
 * whether the current session is allowed to drop the worktree. The
 * file lives outside the working tree (it is .gitignored as part of
 * `.qwen/worktrees/.gitignore`) so it cannot leak into commits.
 */
export const WORKTREE_SESSION_FILE = '.qwen-session';

/** Writes the owning session id into the worktree's session marker. */
export async function writeWorktreeSessionMarker(
  worktreePath: string,
  sessionId: string,
): Promise<void> {
  await fs.writeFile(
    path.join(worktreePath, WORKTREE_SESSION_FILE),
    sessionId,
    'utf8',
  );
  // The marker lives inside the worktree dir so a subagent running
  // `git add -A` inside it would otherwise add the session id to its
  // first commit. Write a `.git/info/exclude` rule so the marker is
  // ignored without requiring (or modifying) a tracked `.gitignore`.
  // `.git` inside a worktree is actually a file pointing at
  // `<repo>/.git/worktrees/<name>/`, so resolve `--git-dir` instead
  // of joining naively.
  try {
    const { simpleGit } = await loadSimpleGit();
    const wtGit = simpleGit(worktreePath);
    const gitDir = (await wtGit.revparse(['--git-dir'])).trim();
    const excludePath = path.isAbsolute(gitDir)
      ? path.join(gitDir, 'info', 'exclude')
      : path.join(worktreePath, gitDir, 'info', 'exclude');
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch {
      // File missing — fall through to fresh write.
    }
    const rule = WORKTREE_SESSION_FILE;
    if (!existing.split(/\r?\n/).includes(rule)) {
      const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      await fs.writeFile(excludePath, `${existing}${sep}${rule}\n`, 'utf8');
    }
  } catch {
    // Best-effort: if we can't write the exclude rule (read-only fs,
    // unusual worktree layout), the marker is still functional —
    // `git add -A` would just stage it. The ownership guard remains
    // intact either way.
  }
}

/**
 * Reads the owning session id stored at worktree provisioning time.
 * Returns `null` when the marker is missing or unreadable — callers
 * decide whether to treat that as "owner unknown, refuse" or "owner
 * unknown, allow with explicit override".
 */
export async function readWorktreeSessionMarker(
  worktreePath: string,
): Promise<string | null> {
  const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    // Distinguish "marker missing" (legitimate — worktree predates the
    // session-ownership guard) from "marker unreadable" (disk error,
    // permission, corrupt NFS). Both still return `null`, but the
    // unreadable case logs so an operator chasing a "wrong session
    // bypassed the ownership guard" report has a breadcrumb.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.warn(
        `readWorktreeSessionMarker: cannot read ${markerPath}: ${error}`,
      );
    }
    return null;
  }
}

/**
 * Commit message used for the baseline snapshot in worktrees.
 * After overlaying the user's dirty state (tracked changes + untracked files),
 * a commit with this message is created so that later diffs only capture the
 * agent's changes — not the pre-existing local edits.
 */
export const BASELINE_COMMIT_MESSAGE = 'baseline (dirty state overlay)';

/**
 * Default directory and branch-prefix name used for worktrees.
 * Changing this value affects the on-disk layout (`~/.qwen/<WORKTREES_DIR>/`)
 * **and** the default git branch prefix (`<WORKTREES_DIR>/<sessionId>/…`).
 */
export const WORKTREES_DIR = 'worktrees';

// ──────────────────────────────────────────────────────────────────────
// Ephemeral agent-worktree slug format. Shared between the producer
// (`AgentTool isolation: 'worktree'`), the consumer
// (`cleanupStaleAgentWorktrees`) and the validator
// (`validateUserWorktreeSlug` reserves the prefix). Changing any of
// these constants must be done in one place so a regex / generator
// mismatch can never silently leak or destroy work.
// ──────────────────────────────────────────────────────────────────────

/** Slug prefix used for worktrees created by `AgentTool isolation:'worktree'`. */
export const AGENT_WORKTREE_PREFIX = 'agent';

/** Number of random hex characters appended after the prefix. */
export const AGENT_WORKTREE_HEX_LENGTH = 7;

/** Regex that matches the exact ephemeral-agent slug shape. */
export const AGENT_WORKTREE_SLUG_PATTERN = new RegExp(
  `^${AGENT_WORKTREE_PREFIX}-[0-9a-f]{${AGENT_WORKTREE_HEX_LENGTH}}$`,
);

/**
 * Generates a fresh ephemeral-agent slug. Centralised so the format
 * stays in lock-step with {@link AGENT_WORKTREE_SLUG_PATTERN}.
 */
export function generateAgentWorktreeSlug(): string {
  const hex = randomBytes(Math.ceil(AGENT_WORKTREE_HEX_LENGTH / 2))
    .toString('hex')
    .slice(0, AGENT_WORKTREE_HEX_LENGTH);
  return `${AGENT_WORKTREE_PREFIX}-${hex}`;
}

/**
 * Attribute lines a `git worktree list --porcelain` record can carry after
 * its `worktree <path>` line. Anything else on those lines means the path
 * above contained a newline and the entry was truncated.
 */
function isWorktreeListPorcelainAttribute(line: string): boolean {
  return (
    line === 'bare' ||
    line === 'detached' ||
    line === 'locked' ||
    line === 'prunable' ||
    line.startsWith('HEAD ') ||
    line.startsWith('branch ') ||
    line.startsWith('locked ') ||
    line.startsWith('prunable ')
  );
}

export interface WorktreeInfo {
  /** Unique identifier for this worktree */
  id: string;
  /** Display name (e.g., model name) */
  name: string;
  /** Absolute path to the worktree directory */
  path: string;
  /** Git branch name for this worktree */
  branch: string;
  /** Whether the worktree is currently active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: number;
}

export interface WorktreeSetupConfig {
  /** Session identifier */
  sessionId: string;
  /** Source repository path (project root) */
  sourceRepoPath: string;
  /** Names/identifiers for each worktree to create */
  worktreeNames: string[];
  /** Base branch to create worktrees from (defaults to current branch) */
  baseBranch?: string;
  /** Extra metadata to persist alongside the session config */
  metadata?: Record<string, unknown>;
}

export interface CreateWorktreeResult {
  success: boolean;
  worktree?: WorktreeInfo;
  error?: string;
}

export interface WorktreeSetupResult {
  success: boolean;
  sessionId: string;
  worktrees: WorktreeInfo[];
  worktreesByName: Record<string, WorktreeInfo>;
  errors: Array<{ name: string; error: string }>;
}

/**
 * Minimal session config file written to disk.
 * Callers can extend via the `metadata` field in WorktreeSetupConfig.
 */
interface SessionConfigFile {
  sessionId: string;
  sourceRepoPath: string;
  worktreeNames: string[];
  baseBranch?: string;
  createdAt: number;
  [key: string]: unknown;
}

/**
 * Loop-invariant canonical paths shared by every entry resolution for one
 * worktree-creation cycle. Built once by `buildWorktreeEntryContext`, then
 * handed to `resolveWorktreeEntry` for each configured entry.
 *
 * Every field is canonical (realpath'd) precisely so the containment checks
 * in `resolveWorktreeEntry` compare canonical-to-canonical — see the long
 * note in `buildWorktreeEntryContext` for why the lexical form is a trap.
 */
interface WorktreeEntryContext {
  /** Canonical main-repo root. */
  repoRootAbs: string;
  /** `<repoRootAbs>/.git` — blocklisted subtree. */
  gitDirAbs: string;
  /** `<repoRootAbs>/.qwen` — blocklisted subtree. */
  qwenDirAbs: string;
  /** Worktree root as passed in; used lexically to build destinations. */
  worktreePath: string;
  /** Canonical worktree root, for containment checks on the dest side. */
  realWorktreePath: string;
}

/**
 * One entry that cleared every gate in `resolveWorktreeEntry`. Holding a
 * value of this type means: the source is inside the repo (both lexically
 * and after realpath), is not git- or CLI-internal, exists, and `destAbs`
 * has an existing parent directory that is inside the worktree.
 */
interface ResolvedWorktreeEntry {
  /** Canonical source path inside the main repo. */
  realSource: string;
  /** Destination inside the worktree. Parent exists and is contained. */
  destAbs: string;
  /** Source stat, for callers that branch on directory-vs-file. */
  sourceStat: { isDirectory: () => boolean };
}

/**
 * Service for managing git worktrees.
 *
 * Git worktrees allow multiple working directories to share a single repository,
 * enabling isolated environments without copying the entire repo.
 */
export class GitWorktreeService {
  private sourceRepoPath: string;
  private gitPromise: Promise<SimpleGit> | undefined;
  private readonly customBaseDir?: string;

  constructor(sourceRepoPath: string, customBaseDir?: string) {
    this.sourceRepoPath = path.resolve(sourceRepoPath);
    this.customBaseDir = customBaseDir;
  }

  private getGit(): Promise<SimpleGit> {
    this.gitPromise ??= loadSimpleGit().then(({ simpleGit }) =>
      simpleGit(this.sourceRepoPath),
    );
    return this.gitPromise;
  }

  /**
   * Gets the directory where worktrees are stored.
   * @param customDir - Optional custom base directory override
   */
  static getBaseDir(customDir?: string): string {
    if (customDir) {
      return path.resolve(customDir);
    }
    return path.join(Storage.getGlobalQwenDir(), WORKTREES_DIR);
  }

  /**
   * Gets the directory for a specific session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getSessionDir(sessionId: string, customBaseDir?: string): string {
    return path.join(GitWorktreeService.getBaseDir(customBaseDir), sessionId);
  }

  /**
   * Gets the worktrees directory for a specific session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getWorktreesDir(sessionId: string, customBaseDir?: string): string {
    return path.join(
      GitWorktreeService.getSessionDir(sessionId, customBaseDir),
      WORKTREES_DIR,
    );
  }

  /**
   * Instance-level base dir, using the custom dir if provided at construction.
   */
  getBaseDirForInstance(): string {
    return GitWorktreeService.getBaseDir(this.customBaseDir);
  }

  /**
   * Checks if git is available on the system.
   */
  async checkGitAvailable(): Promise<{ available: boolean; error?: string }> {
    const { available } = isCommandAvailable('git');
    if (!available) {
      return {
        available: false,
        error: 'Git is not installed. Please install Git.',
      };
    }
    return { available: true };
  }

  /**
   * Resolves the absolute path of the enclosing git repository's top
   * directory. Used by callers that need to anchor general-purpose
   * worktrees at the *repo* root rather than the cwd they were invoked
   * from — otherwise running `qwen` from a monorepo subdirectory would
   * scatter `.qwen/worktrees/` under each subdirectory instead of
   * gathering them under the repo root.
   *
   * Returns the canonical top-level path on success, or `null` when the
   * cwd is not inside a git repo (caller should error).
   */
  async getRepoTopLevel(): Promise<string | null> {
    try {
      // `raw` rather than `revparse`: the latter trims the output, silently
      // mutating a path that legitimately carries leading/trailing whitespace
      // into a different anchor. Strip only the LF terminator — git's stdout
      // is LF-terminated on every platform, so a trailing CR is path data,
      // not part of the terminator.
      const out = await (
        await this.getGit()
      ).raw(['rev-parse', '--show-toplevel']);
      const top = out.replace(/\n$/, '');
      return top.length > 0 ? top : null;
    } catch (error) {
      // Caller falls back to its cwd via `?? cwd`. Log so a corrupt
      // repo / permission failure leaves a trail — otherwise the
      // worktree creator and startup sweep can disagree silently about
      // where worktrees live, and the sweep would never find them.
      debugLogger.warn(
        `getRepoTopLevel failed at ${this.sourceRepoPath}: ${error}`,
      );
      return null;
    }
  }

  /**
   * Returns the repository's primary working tree path, or `null` when it
   * cannot be determined. Unlike `getRepoTopLevel()` — which answers
   * "which worktree is this cwd in" and so names a linked worktree's OWN
   * root when run inside one — this always resolves the MAIN tree:
   * `git worktree list --porcelain` lists the primary working tree first
   * regardless of where in the repository it runs. Callers anchoring a
   * check at the repository itself (not the current worktree) use this.
   *
   * The porcelain format is newline-delimited, so a main-tree path that
   * itself contains a newline splits across lines and the first entry
   * truncates. The remainder then appears where a record attribute belongs
   * — it is not one, which detects most truncations. Not all: a remainder
   * that is itself attribute-shaped (`detached`, `HEAD …`, …) — or a path
   * ending right at a newline, whose blank remainder ends the record — still
   * parses. The parsed anchor is therefore round-trip-validated below:
   * `rev-parse --git-common-dir` run AT the anchor must agree with this
   * repository's own common dir, otherwise this method returns `null` and
   * callers fall back to `getRepoTopLevel()`, whose single-value
   * `--show-toplevel` answer keeps interior newlines intact. (`--porcelain
   * -z` would be immune but needs Git >= 2.36.) A truncated anchor is not
   * merely wrong: it can resolve inside a DIFFERENT repository whose
   * worktree registry the caller's gate would then consult.
   */
  async getMainWorktreePath(): Promise<string | null> {
    try {
      const out = await (
        await this.getGit()
      ).raw(['worktree', 'list', '--porcelain']);
      const lines = out.split('\n');
      // git preserves a path's leading/trailing whitespace verbatim, and a
      // trim would silently mutate it into a different, wrong anchor. A
      // trailing CR is path data, not a terminator: git's stdout is
      // LF-terminated on every platform.
      const firstLine = lines[0] ?? '';
      if (!firstLine.startsWith('worktree ')) return null;
      for (const line of lines.slice(1)) {
        const attr = line.trim();
        if (attr === '') break; // blank line ends the first record
        if (!isWorktreeListPorcelainAttribute(attr)) return null;
      }
      const mainPath = firstLine.slice('worktree '.length);
      if (mainPath.length === 0) return null;
      // Round-trip validation (see the doc block): `--git-common-dir` answers
      // `.git` (relative) from a main tree and an absolute path from a linked
      // worktree, so resolve both sides. realpath both so a symlinked
      // ancestor on either side (macOS /tmp -> /private/tmp) cannot
      // manufacture a mismatch. A probe failure at the anchor fails closed.
      const realpathOr = async (p: string): Promise<string> => {
        try {
          return await fs.realpath(p);
        } catch {
          return p;
        }
      };
      const { simpleGit } = await loadSimpleGit();
      const [ourRaw, anchorRaw] = await Promise.all([
        (await this.getGit()).raw(['rev-parse', '--git-common-dir']),
        simpleGit(mainPath).raw(['rev-parse', '--git-common-dir']),
      ]);
      const ourCommonDir = await realpathOr(
        path.resolve(this.sourceRepoPath, ourRaw.trim()),
      );
      const anchorCommonDir = await realpathOr(
        path.resolve(mainPath, anchorRaw.trim()),
      );
      return ourCommonDir === anchorCommonDir ? mainPath : null;
    } catch (error) {
      debugLogger.warn(
        `getMainWorktreePath failed at ${this.sourceRepoPath}: ${error}`,
      );
      return null;
    }
  }

  /**
   * Checks if the source path is a git repository.
   */
  async isGitRepository(): Promise<boolean> {
    try {
      const [git, { CheckRepoActions }] = await Promise.all([
        this.getGit(),
        loadSimpleGit(),
      ]);
      try {
        const isRoot = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (isRoot) {
          return true;
        }
      } catch {
        // IS_REPO_ROOT check failed — fall through to the general check
      }
      // Not the root (or root check threw) — check if we're inside a git repo
      try {
        return await git.checkIsRepo();
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Initializes the source directory as a git repository.
   * Returns true if initialization was performed, false if already a repo.
   */
  async initializeRepository(): Promise<{
    initialized: boolean;
    error?: string;
  }> {
    const isRepo = await this.isGitRepository();
    if (isRepo) {
      return { initialized: false };
    }

    try {
      const git = await this.getGit();
      await initRepositoryWithMainBranch(git);

      // Create initial commit so we can create worktrees
      await git.add('.');
      await git.commit('Initial commit', {
        '--allow-empty': null,
      });

      return { initialized: true };
    } catch (error) {
      return {
        initialized: false,
        error: `Failed to initialize git repository: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Gets the current branch name.
   */
  async getCurrentBranch(): Promise<string> {
    const branch = await (
      await this.getGit()
    ).revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim();
  }

  /**
   * Gets the current commit hash.
   */
  async getCurrentCommitHash(): Promise<string> {
    const hash = await (await this.getGit()).revparse(['HEAD']);
    return hash.trim();
  }

  /**
   * Resolves a git ref name to a 40-char commit SHA. Returns `null` when
   * the ref is unknown / unborn / not a commit.
   *
   * Used by Phase D-3 to lock in `FETCH_HEAD` immediately after
   * `fetchPullRequestRef` succeeds, so the SHA passed to
   * `git worktree add` is immutable against a concurrent `git fetch` from
   * another process sharing the same repo, AND so `WorktreeExitDialog`'s
   * `rev-list <originalHeadCommit>..HEAD` counts only THIS session's new
   * work rather than every commit in the fetched PR.
   */
  async resolveRef(ref: string): Promise<string | null> {
    try {
      const out = (
        await (await this.getGit()).raw(['rev-parse', '--verify', ref])
      ).trim();
      return /^[0-9a-f]{40}$/.test(out) ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * Creates a single worktree.
   */
  async createWorktree(
    sessionId: string,
    name: string,
    baseBranch?: string,
  ): Promise<CreateWorktreeResult> {
    try {
      const worktreesDir = GitWorktreeService.getWorktreesDir(
        sessionId,
        this.customBaseDir,
      );
      await fs.mkdir(worktreesDir, { recursive: true });

      // Sanitize name for use as branch and directory name
      const sanitizedName = this.sanitizeName(name);
      const worktreePath = path.join(worktreesDir, sanitizedName);

      // Check if worktree already exists
      const exists = await this.pathExists(worktreePath);
      if (exists) {
        return {
          success: false,
          error: `Worktree already exists at ${worktreePath}`,
        };
      }

      // Determine base branch
      const base = baseBranch || (await this.getCurrentBranch());
      const shortSession = sessionId.slice(0, 6);
      const branchName = `${base}-${shortSession}-${sanitizedName}`;

      // Create the worktree with a new branch
      await (
        await this.getGit()
      ).raw(['worktree', 'add', '-b', branchName, worktreePath, base]);

      const worktree: WorktreeInfo = {
        id: `${sessionId}/${sanitizedName}`,
        name,
        path: worktreePath,
        branch: branchName,
        isActive: true,
        createdAt: Date.now(),
      };

      return { success: true, worktree };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create worktree for "${name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Sets up all worktrees for a session.
   * This is the main entry point for worktree creation.
   */
  async setupWorktrees(
    config: WorktreeSetupConfig,
  ): Promise<WorktreeSetupResult> {
    const result: WorktreeSetupResult = {
      success: false,
      sessionId: config.sessionId,
      worktrees: [],
      worktreesByName: {},
      errors: [],
    };

    // Validate worktree names early (before touching git)
    const sanitizedNames = new Map<string, string>();
    for (const name of config.worktreeNames) {
      const sanitized = this.sanitizeName(name);
      if (!sanitized) {
        result.errors.push({
          name,
          error: 'Worktree name becomes empty after sanitization',
        });
        continue;
      }
      const existing = sanitizedNames.get(sanitized);
      if (existing) {
        result.errors.push({
          name,
          error: `Worktree name collides with "${existing}" after sanitization`,
        });
        continue;
      }
      sanitizedNames.set(sanitized, name);
    }
    if (result.errors.length > 0) {
      return result;
    }

    // Check git availability
    const gitCheck = await this.checkGitAvailable();
    if (!gitCheck.available) {
      result.errors.push({ name: 'system', error: gitCheck.error! });
      return result;
    }

    // Ensure source is a git repository
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      result.errors.push({
        name: 'repository',
        error: 'Source path is not a git repository.',
      });
      return result;
    }

    // Create session directory
    const sessionDir = GitWorktreeService.getSessionDir(
      config.sessionId,
      this.customBaseDir,
    );
    await fs.mkdir(sessionDir, { recursive: true });

    // Save session config for later reference
    const configPath = path.join(sessionDir, 'config.json');
    const configFile: SessionConfigFile = {
      sessionId: config.sessionId,
      sourceRepoPath: config.sourceRepoPath,
      worktreeNames: config.worktreeNames,
      baseBranch: config.baseBranch,
      createdAt: Date.now(),
      ...config.metadata,
    };
    await fs.writeFile(configPath, JSON.stringify(configFile, null, 2));

    // Capture the current dirty state (tracked: staged + unstaged changes)
    // without modifying the source working tree or index.
    // NOTE: `git stash create` does NOT support --include-untracked;
    // untracked files are handled separately below via file copy.
    let dirtyStateSnapshot = '';
    try {
      dirtyStateSnapshot = (
        await (await this.getGit()).stash(['create'])
      ).trim();
    } catch {
      // Ignore — proceed without dirty state if stash create fails
    }

    // Discover untracked files so they can be copied into each worktree.
    // `git ls-files --others --exclude-standard` is read-only and safe.
    let untrackedFiles: string[] = [];
    try {
      const raw = await (
        await this.getGit()
      ).raw(['ls-files', '--others', '--exclude-standard']);
      untrackedFiles = raw.trim().split('\n').filter(Boolean);
    } catch {
      // Non-fatal: proceed without untracked files
    }

    // Create worktrees for each entry
    for (const name of config.worktreeNames) {
      const createResult = await this.createWorktree(
        config.sessionId,
        name,
        config.baseBranch,
      );

      if (createResult.success && createResult.worktree) {
        result.worktrees.push(createResult.worktree);
        result.worktreesByName[name] = createResult.worktree;
      } else {
        result.errors.push({
          name,
          error: createResult.error || 'Unknown error',
        });
      }
    }

    // If any worktree failed, clean up all created resources and fail
    if (result.errors.length > 0) {
      try {
        await this.cleanupSession(config.sessionId);
      } catch (error) {
        result.errors.push({
          name: 'cleanup',
          error: `Failed to cleanup after partial worktree creation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
      result.success = false;
      return result;
    }

    // Success only if all worktrees were created
    result.success = result.worktrees.length === config.worktreeNames.length;

    // Overlay the source repo's dirty state onto each worktree so agents
    // see the same files the user currently has on disk.
    if (result.success) {
      for (const worktree of result.worktrees) {
        const { simpleGit } = await loadSimpleGit();
        const wtGit = simpleGit(worktree.path);

        // 1. Apply tracked dirty changes (staged + unstaged)
        if (dirtyStateSnapshot) {
          try {
            await wtGit.raw(['stash', 'apply', dirtyStateSnapshot]);
          } catch {
            // Non-fatal: worktree still usable with committed state only
          }
        }

        // 2. Copy untracked files into the worktree
        for (const relPath of untrackedFiles) {
          try {
            const src = path.join(this.sourceRepoPath, relPath);
            const dst = path.join(worktree.path, relPath);
            await fs.mkdir(path.dirname(dst), { recursive: true });
            await fs.copyFile(src, dst);
          } catch {
            // Non-fatal: skip files that can't be copied
          }
        }

        // 3. Create a baseline commit capturing the full starting state
        //    (committed + dirty + untracked). This allows us to later diff
        //    only the agent's changes, excluding the pre-existing dirty state.
        try {
          await wtGit.add(['--all']);
          await wtGit.commit(BASELINE_COMMIT_MESSAGE, {
            '--allow-empty': null,
            '--no-verify': null,
          });
        } catch {
          // Non-fatal: diff will fall back to merge-base if baseline is missing
        }
      }
    }

    return result;
  }

  /**
   * Lists all worktrees for a session.
   */
  async listWorktrees(sessionId: string): Promise<WorktreeInfo[]> {
    const worktreesDir = GitWorktreeService.getWorktreesDir(
      sessionId,
      this.customBaseDir,
    );

    try {
      const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
      const worktrees: WorktreeInfo[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const worktreePath = path.join(worktreesDir, entry.name);

          // Read the actual branch from the worktree
          let branchName = '';
          try {
            branchName = execSync('git rev-parse --abbrev-ref HEAD', {
              cwd: worktreePath,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          } catch {
            // Fallback if git command fails
          }

          // Try to get stats for creation time
          let createdAt = Date.now();
          try {
            const stats = await fs.stat(worktreePath);
            createdAt = stats.birthtimeMs;
          } catch {
            // Ignore stat errors
          }

          worktrees.push({
            id: `${sessionId}/${entry.name}`,
            name: entry.name,
            path: worktreePath,
            branch: branchName,
            isActive: true,
            createdAt,
          });
        }
      }

      return worktrees;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Removes a single worktree.
   */
  async removeWorktree(
    worktreePath: string,
  ): Promise<{ success: boolean; error?: string }> {
    let git: SimpleGit;
    try {
      git = await this.getGit();
    } catch (error) {
      return {
        success: false,
        error: `Failed to remove worktree: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }

    try {
      // Remove the worktree from git
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      return { success: true };
    } catch (error) {
      // Try to remove the directory manually if git worktree remove fails
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        // Prune worktree references
        await git.raw(['worktree', 'prune']);
        return { success: true };
      } catch (_rmError) {
        return {
          success: false,
          error: `Failed to remove worktree: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    }
  }

  /**
   * Cleans up all worktrees and branches for a session.
   */
  async cleanupSession(sessionId: string): Promise<{
    success: boolean;
    removedWorktrees: string[];
    removedBranches: string[];
    errors: string[];
  }> {
    const result = {
      success: true,
      removedWorktrees: [] as string[],
      removedBranches: [] as string[],
      errors: [] as string[],
    };

    // Collect actual branch names from worktrees before removing them
    const worktrees = await this.listWorktrees(sessionId);
    const worktreeBranches = new Set(
      worktrees.map((w) => w.branch).filter(Boolean),
    );

    // Remove all worktrees
    for (const worktree of worktrees) {
      const removeResult = await this.removeWorktree(worktree.path);
      if (removeResult.success) {
        result.removedWorktrees.push(worktree.name);
      } else {
        result.errors.push(
          removeResult.error || `Failed to remove ${worktree.name}`,
        );
        result.success = false;
      }
    }

    // Remove session directory
    const sessionDir = GitWorktreeService.getSessionDir(
      sessionId,
      this.customBaseDir,
    );
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(
        `Failed to remove session directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    // Clean up branches that belonged to the worktrees
    try {
      const git = await this.getGit();
      for (const branchName of worktreeBranches) {
        try {
          await git.branch(['-D', branchName]);
          result.removedBranches.push(branchName);
        } catch {
          // Branch might already be deleted, ignore
        }
      }
      await git.raw(['worktree', 'prune']);
    } catch {
      // Ignore branch deletion, loader, and prune errors
    }

    return result;
  }

  /**
   * Gets the diff between a worktree and its baseline state.
   * Prefers the baseline commit (which includes the dirty state overlay)
   * so the diff only shows the agent's changes. Falls back to the base branch
   * when no baseline commit exists.
   */
  async getWorktreeDiff(
    worktreePath: string,
    baseBranch?: string,
  ): Promise<string> {
    try {
      const { simpleGit } = await loadSimpleGit();
      const worktreeGit = simpleGit(worktreePath);
      const base =
        (await this.resolveBaseline(worktreeGit)) ??
        baseBranch ??
        (await this.getCurrentBranch());
      return await this.withStagedChanges(worktreeGit, () =>
        worktreeGit.diff(['--binary', '--cached', base]),
      );
    } catch (error) {
      return `Error getting diff: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Applies raw changes from a worktree back to the target working directory.
   *
   * Diffs from the baseline commit (which already includes the user's
   * dirty state) so the patch only contains the agent's new changes.
   * Falls back to merge-base when no baseline commit exists.
   */
  async applyWorktreeChanges(
    worktreePath: string,
    targetPath?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const target = targetPath || this.sourceRepoPath;

    try {
      const { simpleGit } = await loadSimpleGit();
      const worktreeGit = simpleGit(worktreePath);
      const targetGit = simpleGit(target);
      // Prefer the baseline commit (created during worktree setup after
      // overlaying dirty state) so the patch excludes pre-existing edits.
      let base = await this.resolveBaseline(worktreeGit);
      const hasBaseline = !!base;

      if (!base) {
        // Fallback: diff from merge-base
        const targetHead = (await targetGit.revparse(['HEAD'])).trim();
        base = (
          await worktreeGit.raw(['merge-base', 'HEAD', targetHead])
        ).trim();
      }

      const patch = await this.withStagedChanges(worktreeGit, () =>
        worktreeGit.diff(['--binary', '--cached', base]),
      );

      if (!patch.trim()) {
        return { success: true };
      }

      const patchFile = path.join(
        this.getBaseDirForInstance(),
        `.worktree-apply-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`,
      );
      await fs.mkdir(path.dirname(patchFile), { recursive: true });
      await fs.writeFile(patchFile, patch, 'utf-8');

      try {
        // When using the baseline, the target working tree already matches the
        // patch pre-image (both have the dirty state), so a plain apply works.
        // --3way is only needed for the merge-base fallback path where the
        // pre-image may not match the working tree; it falls back to index
        // blob lookup which would fail on baseline-relative patches.
        const applyArgs = hasBaseline
          ? ['apply', '--whitespace=nowarn', patchFile]
          : ['apply', '--3way', '--whitespace=nowarn', patchFile];
        await targetGit.raw(applyArgs);
      } finally {
        await fs.rm(patchFile, { force: true });
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Failed to apply worktree changes: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Lists all sessions stored in the worktree base directory.
   */
  static async listSessions(customBaseDir?: string): Promise<
    Array<{
      sessionId: string;
      createdAt: number;
      sourceRepoPath: string;
      worktreeCount: number;
    }>
  > {
    const baseDir = GitWorktreeService.getBaseDir(customBaseDir);
    const sessions: Array<{
      sessionId: string;
      createdAt: number;
      sourceRepoPath: string;
      worktreeCount: number;
    }> = [];

    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = path.join(baseDir, entry.name, 'config.json');
          try {
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent) as SessionConfigFile;

            const worktreesDir = path.join(baseDir, entry.name, WORKTREES_DIR);
            let worktreeCount = 0;
            try {
              const worktreeEntries = await fs.readdir(worktreesDir);
              worktreeCount = worktreeEntries.length;
            } catch {
              // Ignore if worktrees dir doesn't exist
            }

            sessions.push({
              sessionId: entry.name,
              createdAt: config.createdAt || Date.now(),
              sourceRepoPath: config.sourceRepoPath || '',
              worktreeCount,
            });
          } catch {
            // Ignore sessions without valid config
          }
        }
      }

      return sessions.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  /**
   * Finds the baseline commit in a worktree, if one exists.
   * Returns the commit SHA, or null if not found.
   */
  private async resolveBaseline(
    worktreeGit: SimpleGit,
  ): Promise<string | null> {
    try {
      const sha = (
        await worktreeGit.raw([
          'log',
          '--grep',
          BASELINE_COMMIT_MESSAGE,
          '--format=%H',
          '-1',
        ])
      ).trim();
      return sha || null;
    } catch {
      return null;
    }
  }

  /** Stages all changes, runs a callback, then resets the index. */
  private async withStagedChanges<T>(
    git: SimpleGit,
    fn: () => Promise<T>,
  ): Promise<T> {
    await git.add(['--all']);
    try {
      return await fn();
    } finally {
      try {
        await git.raw(['reset']);
      } catch {
        // Best-effort: ignore reset failures
      }
    }
  }

  private sanitizeName(name: string): string {
    // Replace invalid characters with hyphens
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // User-facing worktree APIs (used by EnterWorktree / ExitWorktree tools
  // and AgentTool `isolation: 'worktree'`). These create worktrees under
  // `<projectRoot>/.qwen/worktrees/<slug>` rather than under the
  // session-scoped Arena baseDir.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Returns the directory holding all general-purpose worktrees for this
   * repo: `<projectRoot>/.qwen/worktrees`.
   */
  getUserWorktreesDir(): string {
    return path.join(this.sourceRepoPath, '.qwen', WORKTREES_DIR);
  }

  /**
   * Returns the absolute worktree path for a given slug.
   */
  getUserWorktreePath(slug: string): string {
    return path.join(this.getUserWorktreesDir(), slug);
  }

  /**
   * Generates an auto-slug `{adj}-{noun}-{6hex}` for an unnamed worktree.
   *
   * Uses `randomInt` for the word-list indices (uniform by construction
   * via rejection sampling — `randomBytes[i] % len` would be biased
   * whenever `len` doesn't divide `2^8`, and CodeQL's
   * `js/biased-cryptographic-random` rule flags it even when it
   * happens to be exact). Uses `randomBytes` for the suffix because
   * hex encoding of raw bytes is unbiased. ~16M combinations × 8 adj
   * × 8 noun ≈ 1B distinct slugs.
   */
  static generateAutoSlug(): string {
    const ADJECTIVES = [
      'swift',
      'bright',
      'calm',
      'keen',
      'bold',
      'eager',
      'kind',
      'quick',
    ];
    const NOUNS = ['fox', 'owl', 'elm', 'oak', 'ray', 'sky', 'leaf', 'pine'];
    const adj = ADJECTIVES[randomInt(0, ADJECTIVES.length)];
    const noun = NOUNS[randomInt(0, NOUNS.length)];
    const suffix = randomBytes(3).toString('hex');
    return `${adj}-${noun}-${suffix}`;
  }

  /**
   * Parses a PR reference from a string. Recognised forms:
   *
   * - `#123` — shorthand PR number
   * - `https://github.com/<owner>/<repo>/pull/123` — full GitHub URL
   *   (any host, any query string, any fragment)
   *
   * Returns the parsed PR number on match, `null` otherwise. The slug for
   * a PR worktree is derived by callers as `pr-<N>` and the branch as
   * `worktree-pr-<N>` (see `createUserWorktree`).
   *
   * Mirrors claude-code's `parsePRReference` (utils/worktree.ts:633) so
   * cross-CLI muscle memory transfers.
   */
  static parsePRReference(input: string): number | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();

    // GitHub-style PR URL: https://<host>/owner/repo/pull/<N>
    // - any host (public github.com or enterprise)
    // - optional trailing slash, query string, or fragment
    // - optional sub-path after `/pull/<N>/` (`/files`, `/commits`,
    //   `/checks`, etc.) — users routinely copy URLs while browsing
    //   files on a PR, and the PR number is still unambiguous
    const urlMatch = trimmed.match(
      /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i,
    );
    if (urlMatch?.[1]) {
      const n = parseInt(urlMatch[1], 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }

    // `#N` shorthand. Reject leading zeros (`#0123`) to keep round-trips
    // unambiguous — `gh pr view 0123` errors out anyway.
    const hashMatch = trimmed.match(/^#([1-9]\d*)$/);
    if (hashMatch?.[1]) {
      const n = parseInt(hashMatch[1], 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }

    return null;
  }

  /**
   * Identifies the registered worktree at `worktreePath` as a member of
   * THIS repository (`sourceRepoPath`). Returns the branch + HEAD commit
   * SHA on success, or `null` when the path is not a worktree of this
   * repo.
   *
   * Used by Phase D-1's re-attach path: when `--worktree foo` is passed
   * and `<repoRoot>/.qwen/worktrees/foo` already exists on disk, we
   * verify it really IS a Qwen-managed worktree of the current repo (not
   * a standalone `git init` someone dropped at that path) before
   * assuming it's safe to chdir into. Returning the HEAD SHA in the
   * same call avoids a second subprocess to recapture it after chdir.
   *
   * Implementation — a single `git rev-parse` returning four lines:
   * 1. `HEAD` → the worktree's HEAD commit SHA (must come BEFORE
   *    `--abbrev-ref` since the flag sticks for all subsequent refs).
   * 2. `--abbrev-ref HEAD` → the branch name. A detached HEAD produces
   *    `HEAD` here, which we treat as "no real branch" and return null
   *    — the caller's re-attach gate will then refuse, since the
   *    slug-derived branch couldn't possibly be `HEAD`.
   * 3. `--git-common-dir` → the common `.git` directory. For a real
   *    linked worktree of this repo that's `<sourceRepoPath>/.git`;
   *    for a sibling `git init` it resolves to `<worktreePath>/.git`.
   *    We compare against this repo's own common-dir to reject the
   *    latter.
   * 4. `--show-toplevel` → git's idea of the worktree top. For a real
   *    linked worktree this equals `worktreePath`; for a plain
   *    directory living UNDER the main repo (e.g. `mkdir
   *    <repo>/.qwen/worktrees/foo`) git walks up to the outer `.git`
   *    and returns the OUTER repo's root — which would otherwise pass
   *    the common-dir check and let us "re-attach" to a non-worktree
   *    directory. Compare paths to reject this.
   */
  async getRegisteredWorktreeBranch(
    worktreePath: string,
  ): Promise<{ branch: string; headCommit: string } | null> {
    let resolvedWorktreePath: string;
    try {
      const stat = await fs.stat(worktreePath);
      if (!stat.isDirectory()) return null;
      // `realpath` so macOS /var → /private/var canonicalises before
      // the toplevel comparison below — otherwise a real worktree
      // under /var/folders compares unequal to git's `/private/var/…`
      // answer and we'd reject every legitimate re-attach on macOS.
      resolvedWorktreePath = await fs.realpath(worktreePath);
    } catch {
      return null;
    }

    // Run the two probes in parallel: this repo's common-dir comes from
    // the source-repo client, the candidate's HEAD-SHA + branch + common-dir +
    // toplevel come from a fresh simple-git rooted at `worktreePath`
    // via a single combined rev-parse.
    let ourCommonDir: string;
    let headCommit: string;
    let branch: string;
    let probeCommonDir: string;
    let probeToplevel: string;
    try {
      const { simpleGit } = await loadSimpleGit();
      const probeGit = simpleGit(worktreePath);
      const [ourRaw, probeRaw] = await Promise.all([
        (await this.getGit()).raw(['rev-parse', '--git-common-dir']),
        probeGit.raw([
          'rev-parse',
          'HEAD',
          '--abbrev-ref',
          'HEAD',
          '--git-common-dir',
          '--show-toplevel',
        ]),
      ]);
      ourCommonDir = path.resolve(this.sourceRepoPath, ourRaw.trim());
      const lines = probeRaw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length < 4) return null;
      headCommit = lines[0]!;
      branch = lines[1]!;
      probeCommonDir = path.resolve(worktreePath, lines[2]!);
      probeToplevel = path.resolve(lines[3]!);
    } catch (error) {
      debugLogger.debug(
        `getRegisteredWorktreeBranch: probe at ${worktreePath} failed: ${error}`,
      );
      return null;
    }

    if (probeCommonDir !== ourCommonDir) {
      debugLogger.debug(
        `getRegisteredWorktreeBranch: ${worktreePath} belongs to a different repo (common-dir=${probeCommonDir}, expected ${ourCommonDir})`,
      );
      return null;
    }
    if (probeToplevel !== resolvedWorktreePath) {
      // Plain directory under the main repo — git walked up and
      // returned the outer repo's toplevel. Refuse to treat as a
      // worktree.
      debugLogger.debug(
        `getRegisteredWorktreeBranch: ${worktreePath} is not a registered worktree (toplevel=${probeToplevel}, expected ${resolvedWorktreePath})`,
      );
      return null;
    }
    if (!branch || branch === 'HEAD') return null;
    return { branch, headCommit };
  }

  /**
   * Returns true when `worktreePath` is a REGISTERED linked worktree of this
   * repository — i.e. git's own registry entry for it points back at exactly
   * this path — and it is not the repository's primary working tree.
   *
   * Two complementary checks, because neither alone suffices:
   *
   * 1. **Registry** (repo side): some `<commonDir>/worktrees/<name>/gitdir`
   *    must name this path. Everything read here belongs to the repository, so
   *    a candidate cannot forge it — fabricating `<target>/.git` and the git
   *    dir it points at (with its own `commondir`/`gitdir`) only controls
   *    candidate-side files, which are never consulted. This also rejects the
   *    primary working tree, which has no `worktrees/<name>` entry, along with
   *    other repositories' worktrees and a directory carrying a `.git` file
   *    *copied* from a real worktree (the entry names the original, not the
   *    copy).
   * 2. **Liveness** (inside the path): the path's own `--git-dir` must be that
   *    same entry. A registry record survives `rm -rf` of its directory (git
   *    tags it `prunable` and keeps it for gc.worktreePruneExpire, 3 months by
   *    default); if the path is then recreated as an ordinary directory, git
   *    resolves it into the MAIN checkout. The registry answers "is this path
   *    registered?"; only the probe answers "is it a worktree right now?".
   *
   * A `.git`-is-a-file heuristic would misfire here (the main tree also carries
   * a `.git` file under `git clone --separate-git-dir` and in submodules), and
   * reading the registry directly avoids parsing `git worktree list`, whose
   * porcelain form is newline-delimited — and so injectable by a worktree path
   * that itself contains a newline — unless `-z` is used, which needs
   * Git >= 2.36 and would break older git.
   *
   * Fail-closed: any git or I/O error returns false, so a caller that gates
   * isolation on this check rejects an unverifiable path rather than
   * silently pinning a sub-agent to a possibly-main tree.
   */
  async isRegisteredLinkedWorktree(worktreePath: string): Promise<boolean> {
    const realpathOr = async (p: string): Promise<string> => {
      try {
        return await fs.realpath(p);
      } catch {
        return path.resolve(p);
      }
    };
    try {
      const target = await fs.realpath(worktreePath);

      // ── Registry side, read from THIS repository ──────────────────────
      // `<commonDir>/worktrees/<name>/gitdir` records the path of the worktree
      // that entry belongs to. Everything read here lives on the repo side, so
      // a candidate directory cannot forge an entry: fabricating `<target>/.git`
      // (and the git dir it names, with its own `commondir`/`gitdir`) only
      // controls candidate-side files, which are never consulted.
      const ourCommonDir = path.resolve(
        this.sourceRepoPath,
        (
          await (await this.getGit()).raw(['rev-parse', '--git-common-dir'])
        ).trim(),
      );
      const worktreesDir = path.join(ourCommonDir, 'worktrees');
      let entryNames: string[];
      try {
        entryNames = await fs.readdir(worktreesDir);
      } catch {
        return false; // the repository has no linked worktrees at all
      }

      let entryGitDir: string | null = null;
      for (const name of entryNames) {
        const entry = path.join(worktreesDir, name);
        let pointer: string;
        try {
          pointer = (
            await fs.readFile(path.join(entry, 'gitdir'), 'utf8')
          ).trim();
        } catch {
          continue; // incomplete entry — ignore
        }
        // `gitdir` holds `<registeredPath>/.git`.
        if ((await realpathOr(path.dirname(pointer))) === target) {
          entryGitDir = entry;
          break;
        }
      }
      // No entry names this path. This also rejects the primary working tree,
      // which never has a `worktrees/<name>` entry of its own.
      if (!entryGitDir) return false;

      // ── Liveness probe, inside the path ───────────────────────────────
      // A registry record survives `rm -rf` of its directory (git tags it
      // `prunable` and keeps it for gc.worktreePruneExpire, 3 months by
      // default). If the path is later recreated as an ordinary directory, git
      // resolves it into the MAIN checkout, so its `--git-dir` will not be this
      // entry. The registry answers "is this path registered?"; only a probe
      // inside the path answers "is it a worktree right now?".
      const { simpleGit } = await loadSimpleGit();
      const rawGitDir = (
        await simpleGit(target).raw(['rev-parse', '--git-dir'])
      ).trim();
      const probeGitDir = await realpathOr(path.resolve(target, rawGitDir));
      return probeGitDir === (await realpathOr(entryGitDir));
    } catch (error) {
      debugLogger.debug(
        `isRegisteredLinkedWorktree: probe at ${worktreePath} failed: ${error}`,
      );
      return false;
    }
  }

  /**
   * Fetches the GitHub PR ref `refs/pull/<N>/head` from the `origin` remote
   * so a subsequent `createUserWorktree(..., 'FETCH_HEAD')` call can branch
   * off the PR's tip (Phase D-3). Returns `{ success: true }` on success,
   * or `{ success: false, error }` with a user-facing reason on failure.
   *
   * Implementation notes:
   *
   * - Uses `git fetch origin pull/<N>/head` (no `gh` CLI dependency).
   * - Hard timeout of 30s by default — overridable for tests. A hung git
   *   process on a misconfigured corporate proxy would otherwise stall
   *   the entire startup sequence.
   * - Does NOT create a local branch — leaves the ref accessible only
   *   via `FETCH_HEAD`. Subsequent `git worktree add -b <branch> <wt>
   *   FETCH_HEAD` materialises the worktree branch off it.
   *
   * Error message taxonomy is friendly because this is the user's first
   * impression when their `--worktree=#<N>` fails:
   * - missing `origin` → tell them the remote is required + how to fix
   * - timeout → mention the configured timeout so they can blame the network
   * - generic failure → "PR may not exist or origin is unreachable"
   */
  async fetchPullRequestRef(
    prNumber: number,
    options?: { timeoutMs?: number },
  ): Promise<{ success: true } | { success: false; error: string }> {
    if (
      !Number.isSafeInteger(prNumber) ||
      prNumber <= 0 ||
      prNumber > 1_000_000_000
    ) {
      // Out-of-range PR numbers can't sensibly hit GitHub. Reject locally
      // rather than firing a doomed network call.
      return {
        success: false,
        error: `Invalid PR number: ${prNumber}.`,
      };
    }
    const timeoutMs = options?.timeoutMs ?? 30_000;

    // Two-layer defense for the refspec argv element:
    //
    // 1. Regex digit-only validation at the call site — CodeQL's
    //    `js/second-order-command-line-injection` rule recognises
    //    `/^[1-9][0-9]*$/.test(x)` as a lexical sanitizer, which proves
    //    `prNumber` cannot resemble a `--upload-pack=…` flag. The
    //    entry guard above already establishes this at runtime, but
    //    CodeQL's interprocedural taint tracker doesn't see through
    //    that guard; the regex check IS the pattern its sanitizer
    //    library recognises.
    // 2. `--end-of-options` as a git-runtime marker. Even though
    //    layer 1 makes a flag-shaped refspec impossible, the marker
    //    tells git definitively that every subsequent argv element
    //    is positional — defense-in-depth against a future
    //    regression that loosens the entry guard.
    const prNumberStr = String(prNumber);
    if (!/^[1-9][0-9]*$/.test(prNumberStr)) {
      // Unreachable given the entry guard; here to make the
      // lexical sanitizer visible to static analyzers.
      return {
        success: false,
        error: `Invalid PR number: ${prNumber}.`,
      };
    }
    const refspec = `pull/${prNumberStr}/head`;

    try {
      // Force English git stderr so the error-taxonomy regexes below
      // match. Without this, users with non-English locales fall
      // through to the generic "PR may not exist" branch even for
      // well-known cases like missing-origin. The git binary itself is
      // unaffected by LANG/LC_ALL beyond message strings.
      await execFileAsync(
        'git',
        ['fetch', '--end-of-options', 'origin', refspec],
        {
          cwd: this.sourceRepoPath,
          timeout: timeoutMs,
          env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        },
      );
      return { success: true };
    } catch (error) {
      // execFile reports timeouts via `signal: 'SIGTERM'` on the
      // error object; the stderr text gives us the underlying git error.
      const err = error as NodeJS.ErrnoException & {
        stderr?: string | Buffer;
        signal?: string;
      };
      const stderr =
        typeof err.stderr === 'string'
          ? err.stderr
          : err.stderr instanceof Buffer
            ? err.stderr.toString('utf8')
            : '';
      const lower = stderr.toLowerCase();

      if (err.signal === 'SIGTERM') {
        return {
          success: false,
          error:
            `Failed to fetch PR #${prNumber}: timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            `Check network connectivity and any HTTP(S) proxy settings.`,
        };
      }
      if (
        lower.includes('does not appear to be a git repository') ||
        lower.includes('could not read from remote repository') ||
        lower.includes("'origin' does not appear")
      ) {
        return {
          success: false,
          error:
            `--worktree=#${prNumber} requires an "origin" remote that points at GitHub. ` +
            `Add one with \`git remote add origin <url>\` and retry.`,
        };
      }
      if (
        lower.includes('no such ref') ||
        lower.includes("couldn't find remote ref") ||
        lower.includes("couldn't find remote ref pull/")
      ) {
        return {
          success: false,
          error:
            `Failed to fetch PR #${prNumber}: the PR does not exist on origin, ` +
            `or origin is not a GitHub repository (only GitHub exposes refs/pull/<N>/head).`,
        };
      }
      // Generic fallback. Include the stderr first line so an operator
      // running with --debug can correlate, but keep it terse.
      const firstLine = stderr.split('\n').find((l) => l.trim().length > 0);
      const detail = firstLine ? ` (${firstLine.trim()})` : '';
      debugLogger.warn(
        `fetchPullRequestRef: git fetch pull/${prNumber}/head failed: ${error}`,
      );
      return {
        success: false,
        error: `Failed to fetch PR #${prNumber}: PR may not exist, or origin remote is unreachable${detail}.`,
      };
    }
  }

  /**
   * Validates a worktree slug. Returns null on success, or an error message.
   *
   * Rules (mirrors claude-code's `validateWorktreeSlug`):
   * - Non-empty, ≤ 64 chars
   * - Only `[a-zA-Z0-9._-]` characters; no path separators
   * - No `..` or leading/trailing dots (would resolve outside the worktrees dir)
   * - Must not start with `agent-`: that prefix is reserved for the
   *   ephemeral worktrees `AgentTool isolation:'worktree'` produces.
   *   The startup sweep auto-removes anything matching
   *   {@link AGENT_WORKTREE_SLUG_PATTERN}, so a user-named
   *   `agent-1234567` would be silently deleted after 30 days along
   *   with any work it contained.
   */
  static validateUserWorktreeSlug(slug: string): string | null {
    if (typeof slug !== 'string' || slug.length === 0) {
      return 'Worktree name must be a non-empty string.';
    }
    if (slug.length > 64) {
      return 'Worktree name must be at most 64 characters.';
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
      return 'Worktree name may only contain letters, digits, dots, underscores, and hyphens.';
    }
    if (slug.includes('..') || slug.startsWith('.') || slug.startsWith('-')) {
      return 'Worktree name must not start with "." or "-" or contain "..".';
    }
    if (slug.startsWith(`${AGENT_WORKTREE_PREFIX}-`)) {
      // The exact `agent-<7hex>` slugs that `generateAgentWorktreeSlug`
      // produces ARE allowed — those are the legitimate ephemeral
      // shape that the cleanup sweep is built around. Only reject
      // user-chosen names with the same prefix that don't match the
      // canonical pattern (e.g. `agent-feature`, `agent-1234567890`):
      // those would either get swept after 30 days or never (if not
      // matching the regex), confusing the user either way.
      if (!AGENT_WORKTREE_SLUG_PATTERN.test(slug)) {
        return (
          `Worktree name must not start with "${AGENT_WORKTREE_PREFIX}-": that prefix ` +
          `is reserved for ephemeral agent worktrees and is subject to ` +
          `automatic cleanup after 30 days.`
        );
      }
    }
    return null;
  }

  /**
   * Creates a general-purpose worktree at `<projectRoot>/.qwen/worktrees/<slug>`
   * with branch `worktree-<slug>`. Used by `EnterWorktreeTool` and
   * `AgentTool isolation:'worktree'`.
   *
   * Refuses to overwrite an existing branch: if `worktree-<slug>` already
   * exists (e.g., from a manual `git checkout -b worktree-foo` or a
   * teammate's push), the call fails with a clear error rather than
   * silently resetting the branch. The previous `-B` form would have
   * dropped any commits unique to that branch — see review #4073.
   */
  async createUserWorktree(
    slug: string,
    baseBranch?: string,
    options?: { symlinkDirectories?: readonly string[] },
  ): Promise<CreateWorktreeResult> {
    const validationError = GitWorktreeService.validateUserWorktreeSlug(slug);
    if (validationError) {
      debugLogger.warn(
        `createUserWorktree: invalid slug ${slug}: ${validationError}`,
      );
      return { success: false, error: validationError };
    }

    try {
      const worktreesDir = this.getUserWorktreesDir();
      await fs.mkdir(worktreesDir, { recursive: true });
      const worktreePath = path.join(worktreesDir, slug);

      if (await fileExists(worktreePath)) {
        const error = `Worktree already exists at ${worktreePath}`;
        debugLogger.warn(`createUserWorktree: ${error}`);
        return { success: false, error };
      }

      // Keep the worktrees directory and its contents out of the parent
      // repo's `git status` and any subsequent glob/grep that walks from
      // the parent root. Only writes when the file is missing — never
      // touches an existing user-managed `.qwen/.gitignore`.
      await this.ensureWorktreesGitignored();

      const base = baseBranch || (await this.getCurrentBranch());
      const branchName = worktreeBranchForSlug(slug);

      // Refuse to clobber a pre-existing branch with the same name. Use
      // `git show-ref --verify --quiet refs/heads/<branch>` (exit 0 →
      // branch exists). The previous `-B` form would have force-reset
      // such a branch and silently dropped unmerged commits.
      const branchExists = await this.localBranchExists(branchName);
      if (branchExists) {
        const error =
          `Cannot create worktree "${slug}": branch ${branchName} already exists. ` +
          `Choose a different name, or delete the branch first ` +
          `(e.g. \`git branch -d ${branchName}\`).`;
        debugLogger.warn(`createUserWorktree: ${error}`);
        return { success: false, error };
      }

      await (
        await this.getGit()
      ).raw(['worktree', 'add', '-b', branchName, worktreePath, base]);

      // Configure core.hooksPath so commits inside the worktree run the
      // main repo's hooks (the new worktree's .git directory has no hooks
      // of its own). Priority: .husky/ first (common for JS projects),
      // .git/hooks fallback. Mirrors claude-code's performPostCreationSetup.
      // Best-effort: hook failures must not abort worktree creation.
      await this.configureHooksPath(worktreePath).catch((error) => {
        debugLogger.warn(
          `createUserWorktree: failed to configure core.hooksPath for ${slug}: ${error}`,
        );
      });

      // Phase D-2: symlink user-configured directories from the main
      // repo into the new worktree (e.g. node_modules) so the model can
      // run tests / builds without a fresh install. Same fail-open
      // policy as hooksPath — failures log and continue.
      const symlinkPaths = options?.symlinkDirectories ?? [];
      let linkedDirs: ReadonlySet<string> = new Set<string>();
      if (symlinkPaths.length > 0) {
        linkedDirs = await this.symlinkConfiguredDirectories(
          worktreePath,
          symlinkPaths,
        ).catch((error) => {
          debugLogger.warn(
            `createUserWorktree: symlinkConfiguredDirectories failed for ${slug}: ${error}`,
          );
          return new Set<string>();
        });
      }

      // Phase D-4: copy the gitignored files selected by the repo's
      // `.worktreeinclude` patterns
      // into the new worktree (e.g. `.env`, local certs) so the model
      // gets an isolated copy of files git deliberately does not track.
      // Read from disk rather than plumbed through `options` — the file
      // belongs to the repository, so every creation path picks it up
      // without touching a single call site. Runs after the symlink pass
      // so a path present in both keeps the user's symlink. Same
      // fail-open policy: failures log and continue.
      const includePatterns = await this.readWorktreeIncludePatterns();
      if (includePatterns.length > 0) {
        await this.resolveIncludedFiles(includePatterns, linkedDirs)
          .then((files) =>
            files.length > 0
              ? this.copyIncludedPaths(worktreePath, files)
              : undefined,
          )
          .catch((error) => {
            debugLogger.warn(
              `createUserWorktree: copyIncludedPaths failed for ${slug}: ${error}`,
            );
          });
      }

      const worktree: WorktreeInfo = {
        id: slug,
        name: slug,
        path: worktreePath,
        branch: branchName,
        isActive: true,
        createdAt: Date.now(),
      };
      return { success: true, worktree };
    } catch (error) {
      const message = `Failed to create worktree "${slug}": ${error instanceof Error ? error.message : 'Unknown error'}`;
      debugLogger.warn(`createUserWorktree: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Configures `core.hooksPath` inside `worktreePath` to point at the main
   * repository's hooks directory. Prefers `.husky/` over `.git/hooks/` to
   * match the convention most JS projects use (husky's prepare script
   * configures `core.hooksPath=.husky` in the main repo).
   *
   * Skips the `git config` write subprocess when the value already
   * matches the desired one — common when this method runs against a
   * worktree that already inherits the same `core.hooksPath` from a
   * prior creation cycle. The probe read itself is still a subprocess
   * (claude-code's `parseGitConfigValue` reads the config file
   * directly to avoid even that, but the read runs once per worktree
   * creation so the extra ~14ms isn't worth the file-parsing complexity).
   */
  private async configureHooksPath(worktreePath: string): Promise<void> {
    // .husky/ is the convention for JS projects; check it first.
    const huskyPath = path.join(this.sourceRepoPath, '.husky');
    let hooksPath: string | null = null;
    try {
      await fs.stat(huskyPath);
      hooksPath = huskyPath;
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) {
        debugLogger.warn(
          `configureHooksPath: cannot stat ${huskyPath}: ${error}`,
        );
      }
    }

    // Fall back to the canonical hooks dir. Construct `<sourceRepoPath>/.git/hooks`
    // assumes `.git` is a directory — but when Qwen itself is launched
    // from a linked worktree, `.git` is a FILE pointing at the real
    // gitdir, and the constructed path ENOTDIRs. Use `git rev-parse
    // --git-common-dir` to get the canonical hooks parent regardless
    // of worktree/non-worktree shape. (PR #4174 review #3259975237.)
    if (!hooksPath) {
      try {
        const commonDir = (
          await (await this.getGit()).raw(['rev-parse', '--git-common-dir'])
        ).trim();
        const resolvedCommonDir = path.isAbsolute(commonDir)
          ? commonDir
          : path.resolve(this.sourceRepoPath, commonDir);
        const candidate = path.join(resolvedCommonDir, 'hooks');
        await fs.stat(candidate);
        hooksPath = candidate;
      } catch (error) {
        if (!(isNodeError(error) && error.code === 'ENOENT')) {
          debugLogger.warn(
            `configureHooksPath: cannot resolve git common hooks dir: ${error}`,
          );
        }
      }
    }
    if (!hooksPath) return;

    const { simpleGit } = await loadSimpleGit();
    const worktreeGit = simpleGit(worktreePath, {
      unsafe: { allowUnsafeHooksPath: true },
    });
    let existing = '';
    try {
      // Saves the write subprocess when value already matches. The probe
      // read is also a subprocess — claude-code skips even that via
      // parseGitConfigValue, but the read runs once per worktree
      // creation so the extra ~14ms isn't worth the file-parser tax.
      existing = (
        await worktreeGit.raw(['config', '--local', 'core.hooksPath'])
      ).trim();
    } catch {
      // Key not set — empty string means "proceed with the write".
    }
    // Only write when the key is unset. A non-empty existing value is
    // either inherited (system / global / local config from the user
    // or from a previous Qwen run) or an explicit user policy override
    // — in both cases overwriting silently replaces the user's choice.
    // (PR #4174 review #3259975242.)
    if (existing === '') {
      await worktreeGit.raw(['config', 'core.hooksPath', hooksPath]);
    } else if (existing !== hooksPath) {
      debugLogger.debug(
        `configureHooksPath: preserving existing core.hooksPath=${existing} ` +
          `(Qwen would have set it to ${hooksPath})`,
      );
    }
  }

  /**
   * Builds the loop-invariant half of the entry-validation context for one
   * worktree-creation cycle. Returns `null` when the repo root cannot be
   * canonicalised: every containment gate downstream compares against
   * `repoRootAbs`, so without it there is nothing safe to validate against
   * and the caller must skip the whole opt-in step. That is non-destructive
   * — the worktree itself is already on disk by this point.
   *
   * We must `fs.realpath` the repo root (rather than `path.resolve`, which
   * is purely lexical) so every containment check compares canonical paths
   * to canonical paths. `resolveWorktreeEntry`'s post-stat
   * `fs.realpath(sourceAbs)` produces a canonical path, and on any system
   * where the repo path contains a symlink component (macOS
   * `/tmp → /private/tmp` is ubiquitous; user-symlinked source trees on
   * Linux/Windows too) the lexical `path.resolve(sourceRepoPath)` does not
   * share a prefix with that canonical realpath. Without this hoist
   * `isWithinRoot(realSource, repoRootAbs)` silently rejects EVERY
   * configured entry — cf. PR #4381 round 8 regression.
   */
  private async buildWorktreeEntryContext(
    worktreePath: string,
    logPrefix: string,
  ): Promise<WorktreeEntryContext | null> {
    let repoRootAbs: string;
    try {
      repoRootAbs = await fs.realpath(this.sourceRepoPath);
    } catch {
      debugLogger.warn(
        `${logPrefix}: cannot realpath sourceRepoPath "${this.sourceRepoPath}", skipping all entries`,
      );
      return null;
    }
    // Same canonical-vs-canonical requirement on the dest side. The
    // worktree was just created by `git worktree add`, so the path should
    // exist; fall back to the input path on realpath error so a
    // weird-but-extant worktree path doesn't deadlock the whole loop.
    const realWorktreePath = await fs
      .realpath(worktreePath)
      .catch(() => worktreePath);
    return {
      repoRootAbs,
      gitDirAbs: path.join(repoRootAbs, '.git'),
      qwenDirAbs: path.join(repoRootAbs, '.qwen'),
      worktreePath,
      realWorktreePath,
    };
  }

  /**
   * Validates one configured entry and resolves it to a canonical source
   * plus a destination inside the worktree, or `null` when any gate
   * rejects it. Every rejection is logged here, so callers just skip.
   *
   * Shared by two callers with different trust levels:
   *
   * - `symlinkConfiguredDirectories` — entries from the user's own
   *   `worktree.symlinkDirectories` setting.
   * - `copyIncludedPaths` — entries from a repo-committed
   *   `.worktreeinclude`, whose content comes from anyone who can push to
   *   the repository, including a clone the user does not trust.
   *
   * The second is strictly lower-trust, and these gates are calibrated for
   * it. Never relax one for the benefit of the settings-driven path.
   *
   * Gate order matters. The lexical checks run first because they are free
   * and reject the obvious traversals; the realpath re-checks then re-run
   * the SAME containment and blocklist tests against the canonical path,
   * because a committed-or-out-of-band source symlink (`<repo>/node_modules
   * → /etc`) passes every lexical test.
   */
  private async resolveWorktreeEntry(
    raw: string,
    ctx: WorktreeEntryContext,
    logPrefix: string,
  ): Promise<ResolvedWorktreeEntry | null> {
    const { repoRootAbs, gitDirAbs, qwenDirAbs } = ctx;

    if (typeof raw !== 'string' || raw.length === 0) {
      debugLogger.warn(
        `${logPrefix}: skipping non-string / empty entry: ${JSON.stringify(raw)}`,
      );
      return null;
    }

    // Reject absolute paths and any traversal-prone form. Resolve first
    // to catch `./foo/../../etc` style escapes that look relative.
    if (path.isAbsolute(raw)) {
      debugLogger.warn(`${logPrefix}: refusing absolute path "${raw}"`);
      return null;
    }
    // Reject any literal `..` segment up front. The post-resolve
    // `isWithinRoot` check below would still accept `foo/../bar`
    // (resolves to `bar`, which is inside the repo), but the public
    // contract — settingsSchema description, docs/users/features/
    // worktree.md, WorktreeSettings JSDoc — promises rejection of
    // any entry containing `..`. Enforce that promise here.
    if (raw.split(/[\\/]/).includes('..')) {
      debugLogger.warn(
        `${logPrefix}: refusing path "${raw}" — contains '..' segment`,
      );
      return null;
    }
    const sourceAbs = path.resolve(repoRootAbs, raw);
    if (sourceAbs === repoRootAbs) {
      // `""` / `"."` / `"./"` etc. — pointless and would alias the
      // entire repo into itself. Reject explicitly so the path-prefix
      // checks below don't have to handle this degenerate case.
      debugLogger.warn(
        `${logPrefix}: refusing empty / repo-root path "${raw}"`,
      );
      return null;
    }
    if (!isWithinRoot(sourceAbs, repoRootAbs)) {
      debugLogger.warn(
        `${logPrefix}: refusing path "${raw}" — resolves outside repo root (${sourceAbs} vs ${repoRootAbs})`,
      );
      return null;
    }

    // Refuse to pull git-internal paths into the worktree. `.git`
    // would silently break commits / status / diff inside the
    // worktree (the worktree's own gitlink file points at the parent
    // common-dir, and an entry here would shadow it). The whole
    // `.qwen` tree is also off-limits: taking `.qwen` (parent) would
    // recursively pull `.qwen/worktrees` into the new worktree,
    // recreating the loop; taking `.qwen/worktrees` directly creates
    // the same loop more obviously; and `.qwen/projects` /
    // `.qwen/tmp` are CLI metadata users have no legitimate reason to
    // share across worktrees.
    // `gitDirAbs` / `qwenDirAbs` are canonical (derived from the
    // realpath'd `repoRootAbs`), so these comparisons stay consistent
    // with the post-stat realpath check below.
    if (isWithinRoot(sourceAbs, gitDirAbs)) {
      debugLogger.warn(`${logPrefix}: refusing git-internal path "${raw}"`);
      return null;
    }
    if (isWithinRoot(sourceAbs, qwenDirAbs)) {
      debugLogger.warn(
        `${logPrefix}: refusing path "${raw}" — ` +
          `the .qwen tree is CLI-managed; taking any of it could ` +
          `create a worktrees-inside-worktrees loop or alias CLI metadata.`,
      );
      return null;
    }

    // Confirm the source exists. We don't insist on it being a directory
    // specifically — `node_modules` is canonically a dir, but a user
    // who wants a single file (`.env`, `secrets.json`) should still get
    // it.
    let sourceStat: { isDirectory: () => boolean } | null = null;
    try {
      sourceStat = await fs.stat(sourceAbs);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        debugLogger.debug(
          `${logPrefix}: source missing, skipping: ${sourceAbs}`,
        );
      } else {
        debugLogger.warn(`${logPrefix}: cannot stat ${sourceAbs}: ${error}`);
      }
      return null;
    }

    // Resolve through any symlinks in the source path and RE-RUN the
    // containment + blocklist checks against the realpath. The lexical
    // checks above only see `path.resolve(repoRoot, raw)` — they can't
    // tell that `<repo>/node_modules` is actually a symlink chaining
    // into `.git`, an outside dir, or `.qwen`. Without this step a
    // committed-or-out-of-band source symlink bypasses every guard the
    // lexical checks set up. Callers use the realpath as the operand so
    // the result is one-hop and doesn't preserve the chain.
    let realSource: string;
    try {
      realSource = await fs.realpath(sourceAbs);
    } catch (error) {
      debugLogger.warn(
        `${logPrefix}: cannot realpath source "${sourceAbs}": ${error}`,
      );
      return null;
    }
    if (!isWithinRoot(realSource, repoRootAbs)) {
      debugLogger.warn(
        `${logPrefix}: refusing path "${raw}" — real source ${realSource} escapes repo root ${repoRootAbs}`,
      );
      return null;
    }
    if (isWithinRoot(realSource, gitDirAbs)) {
      debugLogger.warn(
        `${logPrefix}: refusing path "${raw}" — real source ${realSource} resolves inside .git`,
      );
      return null;
    }
    if (isWithinRoot(realSource, qwenDirAbs)) {
      debugLogger.warn(
        `${logPrefix}: refusing path "${raw}" — real source ${realSource} resolves inside .qwen`,
      );
      return null;
    }

    const destAbs = path.join(ctx.worktreePath, raw);

    // Ensure the parent directory of `destAbs` exists. For top-level
    // entries (`node_modules`) this is a no-op against the worktree
    // root, but for nested values (`tools/cache`) we may need to
    // create the intermediate dirs first — git worktree add does NOT
    // create them.
    try {
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
    } catch (error) {
      debugLogger.warn(
        `${logPrefix}: cannot mkdir parent of ${destAbs}: ${error}`,
      );
      return null;
    }

    // Sibling-drift defense to the source-side realpath check:
    // `path.join(worktreePath, raw)` is lexical too. If `git worktree
    // add` materialized a committed symlink under the worktree
    // (e.g. HEAD ships `tools → /etc`), then the OS-side resolution
    // of `<worktree>/tools/cache` traverses through the committed
    // symlink and our `fs.mkdir` / write lands OUTSIDE the worktree.
    // Realpath the dest parent and refuse if it escapes.
    let realDestParent: string;
    try {
      realDestParent = await fs.realpath(path.dirname(destAbs));
    } catch (error) {
      debugLogger.warn(
        `${logPrefix}: cannot realpath dest parent for "${raw}" (${path.dirname(destAbs)}): ${error}`,
      );
      return null;
    }
    if (!isWithinRoot(realDestParent, ctx.realWorktreePath)) {
      debugLogger.warn(
        `${logPrefix}: refusing path "${raw}" — dest parent ${realDestParent} escapes worktree root ${ctx.realWorktreePath} (committed-symlink chain)`,
      );
      return null;
    }

    return { realSource, destAbs, sourceStat };
  }

  /**
   * Phase D-2 symlink loop. For each configured directory under the main
   * repository, creates a symbolic link from the new worktree to the
   * main-repo location (`<worktreePath>/<dir>` → `<repoRoot>/<dir>`).
   *
   * Entry validation lives in `resolveWorktreeEntry`; this method owns
   * only the symlink write. Fail-open semantics — the worktree IS
   * already on disk and usable by the time this runs, so a symlink
   * failure must NOT abort the parent `createUserWorktree` call.
   * Per-entry failures are logged at debug or warn level depending on
   * cause:
   *
   * - **ENOENT on source** (the main repo does not have the directory):
   *   debug log, skip. Typical for users who configure `node_modules`
   *   but launch from a fresh clone where `npm install` hasn't run yet.
   * - **EEXIST on destination** (something already lives at the symlink
   *   target inside the worktree): debug log, skip. No overwrite; the
   *   existing content (whether file, dir, or stale link) wins.
   * - **Absolute path or path traversal in the configured value**:
   *   warn log, skip the entry. Configured values must stay relative to
   *   the repo root to prevent a setting from redirecting writes onto
   *   `/etc`, `~`, or anywhere outside the repo subtree.
   * - **Other I/O errors**: warn log, continue to the next entry.
   *
   * Mirrors claude-code's `symlinkDirectories` helper (utils/worktree.ts).
   *
   * Returns the repo-relative, slash-terminated paths it actually linked,
   * for the copy pass to skip.
   */
  private async symlinkConfiguredDirectories(
    worktreePath: string,
    configured: readonly string[],
  ): Promise<Set<string>> {
    const logPrefix = 'symlinkConfiguredDirectories';
    // Repo-relative paths of the links this pass actually created. The
    // copy pass consults it to avoid enumerating a tree that is now a
    // link into the main repo — see `resolveIncludedFiles`. It must
    // record only successful links, never the raw configured list: this
    // loop is fail-open per entry, and an entry that did NOT link (a
    // rejected path, an occupied destination) is still a legitimate
    // copy target.
    const linked = new Set<string>();
    const ctx = await this.buildWorktreeEntryContext(worktreePath, logPrefix);
    if (!ctx) return linked;

    for (const raw of configured) {
      const resolved = await this.resolveWorktreeEntry(raw, ctx, logPrefix);
      if (!resolved) continue;
      const { realSource, destAbs, sourceStat } = resolved;

      // `fs.symlink` rejects with EEXIST when the destination already
      // exists. Treat that as "user already populated this slot, leave
      // it alone" — same as claude-code's behavior.
      try {
        // On Windows, `fs.symlink(..., 'dir')` requires
        // SeCreateSymbolicLinkPrivilege (administrator rights, or
        // Developer Mode + unprivileged-symlink-creation enabled) and
        // EPERMs on default consumer installs. A junction is a reparse
        // point that achieves the same "this path resolves over there"
        // semantics for directories without elevation. `'file'` symlinks
        // on Windows also need the same privilege but there's no
        // junction-equivalent for files, so we leave `'file'` as-is and
        // accept the EPERM fall-through for the rare file-symlink case.
        const symlinkType = sourceStat.isDirectory()
          ? process.platform === 'win32'
            ? 'junction'
            : 'dir'
          : 'file';
        // Point at the canonical realpath rather than the lexical
        // `sourceAbs` so the new link is one-hop and doesn't preserve
        // the chain we just validated.
        await fs.symlink(realSource, destAbs, symlinkType);
        // Normalize to the POSIX, slash-terminated form `git ls-files`
        // emits for directories, so the copy pass can compare directly.
        linked.add(raw.split(path.sep).join('/').replace(/\/*$/, '') + '/');
        debugLogger.debug(
          `${logPrefix}: linked ${destAbs} → ${realSource} (${symlinkType})`,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          debugLogger.debug(
            `${logPrefix}: destination exists, skipping: ${destAbs}`,
          );
        } else {
          debugLogger.warn(
            `${logPrefix}: failed to link ${destAbs} → ${realSource}: ${error}`,
          );
        }
      }
    }
    return linked;
  }

  /**
   * Reads `<repoRoot>/.worktreeinclude` and returns its raw patterns.
   *
   * Format matches the convention the file already has in other agent
   * CLIs: gitignore-style patterns, one per line, `#` starts a comment,
   * blank lines and surrounding whitespace ignored. Matching happens in
   * `resolveIncludedFiles`; this method only strips the file down to
   * candidate pattern strings.
   *
   * Bounded on both bytes and lines. The file is committed, so its
   * content comes from anyone who can push — and every line becomes a
   * compiled matcher rule whose cost is paid on every candidate. An
   * unbounded file is a denial of service against worktree creation:
   * past a few hundred thousand rules the matcher exhausts the V8 heap,
   * and that abort is not a catchable exception, so the fail-open
   * `.catch` around this pass could not save the run. Over-cap input is
   * dropped whole rather than truncated — a half-applied pattern list is
   * a silently wrong answer, and refusing keeps the fail-open contract.
   *
   * A missing file is the overwhelmingly common case and returns `[]`
   * silently. Any other read error warns and returns `[]`: the worktree
   * is already on disk by the time this runs, so an unreadable or
   * oversized opt-in file must never abort creation.
   */
  private async readWorktreeIncludePatterns(): Promise<string[]> {
    const filePath = path.join(this.sourceRepoPath, WORKTREE_INCLUDE_FILE);
    let content: string;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > WORKTREE_INCLUDE_MAX_BYTES) {
        debugLogger.warn(
          `readWorktreeIncludePatterns: ${filePath} is ${stat.size} bytes, ` +
            `over the ${WORKTREE_INCLUDE_MAX_BYTES}-byte cap; ignoring the file`,
        );
        return [];
      }
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        debugLogger.warn(
          `readWorktreeIncludePatterns: cannot read ${filePath}: ${error}`,
        );
      }
      return [];
    }
    const patterns = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    if (patterns.length > WORKTREE_INCLUDE_MAX_PATTERNS) {
      debugLogger.warn(
        `readWorktreeIncludePatterns: ${filePath} has ${patterns.length} patterns, ` +
          `over the ${WORKTREE_INCLUDE_MAX_PATTERNS} cap; ignoring the file`,
      );
      return [];
    }
    return patterns;
  }

  /**
   * Expands `.worktreeinclude` patterns into the concrete repo-relative
   * file paths to copy.
   *
   * The candidate set is `git ls-files --others --ignored
   * --exclude-standard`, i.e. exactly the files git deliberately does NOT
   * track. That choice is load-bearing twice over:
   *
   * - **It is the feature's whole point.** Tracked files already arrive in
   *   the worktree via `git worktree add`; the gap this closes is the
   *   ignored ones (`.env`, local certs, machine-local config).
   * - **It bounds what a pattern can name.** `.worktreeinclude` is
   *   committed, so its content comes from anyone who can push — but a
   *   pattern can only ever select from what git already listed. `.git`
   *   internals, tracked files and anything outside the repo are simply
   *   not in the candidate set, so no pattern can reach them. The
   *   per-path gates in `resolveWorktreeEntry` still run afterwards as
   *   defense in depth.
   *
   * `--directory` collapses a fully-ignored directory into a single
   * `dir/` entry, so a pattern naming a path inside one would match
   * nothing against the first listing. Candidate directories are
   * therefore re-expanded with a second, scoped `ls-files` call.
   *
   * Deciding WHICH collapsed directories to re-expand cannot be done by
   * asking the matcher about the directory itself: gitignore semantics
   * let a separator-less pattern (`.env`) match at any depth, and a
   * leading-wildcard pattern (`*.pem`) has no literal prefix at all. The
   * predicate below therefore errs toward expanding — a needless
   * expansion costs one scoped listing whose entries the matcher then
   * discards, while a missed one silently drops files the user asked
   * for.
   */
  private async resolveIncludedFiles(
    patterns: string[],
    linkedDirs: ReadonlySet<string> = new Set(),
  ): Promise<string[]> {
    const lsIgnored = async (scope: string[]): Promise<string[]> => {
      // `core.quotepath=false` stops git octal-escaping non-ASCII bytes
      // in the paths it prints. Without it a name like `配置.env` comes
      // back as `"\351\205\215..."`, which matches no pattern and names
      // no file on disk, so it would be silently dropped. Pinned the
      // same way `gitDiff.ts` and `filesearch/crawler.ts` already do.
      // (`-z` would also solve it but needs Git >= 2.36, which this file
      // deliberately does not require.)
      const args = [
        '-c',
        'core.quotepath=false',
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        // `:(literal)` disables pathspec magic. Git parses a leading
        // `:(...)` in a pathspec as a magic signature, so a legitimately
        // named ignored directory such as `:(trap)/` — fed back here from
        // git's own listing — would fatal the entire call and silently
        // drop every collapsed directory, benign ones included.
        ...(scope.length > 0
          ? ['--', ...scope.map((dir) => `:(literal)${dir}`)]
          : ['--directory']),
      ];
      try {
        const raw = await (await this.getGit()).raw(args);
        return raw.trim().split('\n').filter(Boolean);
      } catch (error) {
        debugLogger.warn(
          `resolveIncludedFiles: \`git ${args.join(' ')}\` failed: ${error}`,
        );
        return [];
      }
    };

    /**
     * True for a repo-relative entry the copy pass could never use, so
     * it is dropped before matching or expansion rather than after.
     *
     * `.qwen` is CLI-managed and `resolveWorktreeEntry` rejects it
     * anyway; the point of filtering early is that the whole tree
     * includes `.qwen/worktrees`, so a broad committed pattern would
     * otherwise force an enumeration of every worktree the user has
     * accumulated, purely to warn-reject each result. Root-anchored
     * only, matching the gate it mirrors — a nested `sub/.qwen/foo` is
     * legitimate and must not be dropped.
     *
     * A directory the symlink pass just linked is skipped for the same
     * reason: its contents now resolve through the link into the main
     * repo, so every file under it would pass the source gates and then
     * die at the dest-parent containment check, one warning at a time.
     */
    const unusable = (entry: string): boolean => {
      if (entry === '.qwen' || entry.startsWith('.qwen/')) return true;
      // `dir` is slash-terminated, so this covers both the collapsed
      // entry for the link itself and anything pass 2 finds beneath it.
      for (const dir of linkedDirs) {
        if (entry.startsWith(dir)) return true;
      }
      return false;
    };

    const candidates = (await lsIgnored([])).filter((e) => !unusable(e));
    if (candidates.length === 0) return [];

    // `ignore@7` never throws from `add()` for any string, so there is
    // no compile-failure branch to handle: an unparseable pattern simply
    // matches nothing, and the remaining patterns are unaffected.
    const matcher = ignore().add(patterns);

    const files = candidates.filter(
      (entry) => !entry.endsWith('/') && matcher.ignores(entry),
    );

    // Which collapsed `dir/` entries are worth a scoped listing. See the
    // JSDoc: this deliberately over-selects rather than risk a miss.
    const dirs = candidates.filter((entry) => {
      if (!entry.endsWith('/')) return false;
      const withoutSlash = entry.slice(0, -1);
      if (matcher.ignores(withoutSlash) || matcher.ignores(entry)) return true;
      return patterns.some((pattern) => {
        const rooted = pattern.startsWith('/') ? pattern.slice(1) : pattern;
        // A pattern with no separator matches at any depth under
        // gitignore rules (`.env` matches `secrets/.env`), so every
        // collapsed directory is a possible home for it.
        if (!rooted.replace(/\/+$/, '').includes('/')) return true;
        const wildcardAt = rooted.search(/[*?[]/);
        const head = wildcardAt === -1 ? rooted : rooted.slice(0, wildcardAt);
        // Expand when either side prefixes the other: `vendor/cache/` is
        // worth listing for `vendor/**/*.bin` just as `vendor/` is for
        // `vendor/cache/x`. A pattern with no literal head at all
        // (`**/*.pem`) yields the empty string, which prefixes every
        // entry — so it expands everything, as it must.
        return head.startsWith(entry) || entry.startsWith(head);
      });
    });

    if (dirs.length > 0) {
      // Chunk the pathspecs. A repo with tens of thousands of collapsed
      // ignored directories would otherwise blow the OS argv limit, and
      // the resulting E2BIG is caught above — which would silently drop
      // every collapsed directory's contents while reporting success.
      for (let i = 0; i < dirs.length; i += WORKTREE_INCLUDE_PATHSPEC_BATCH) {
        const batch = dirs.slice(i, i + WORKTREE_INCLUDE_PATHSPEC_BATCH);
        for (const entry of await lsIgnored(batch)) {
          // The scoped pass collapses too: git stops at an embedded
          // repository and emits it as `dir/`. Those must not reach the
          // copy loop, which handles files only.
          if (entry.endsWith('/')) continue;
          if (unusable(entry)) continue;
          if (matcher.ignores(entry)) files.push(entry);
        }
      }
    }

    return [...new Set(files)];
  }

  /**
   * Phase D-4 copy loop. Copies each file selected by `.worktreeinclude`
   * from the main working tree into the new worktree.
   *
   * Complements `symlinkConfiguredDirectories` rather than duplicating it.
   * The two differ on both axes:
   *
   * - **Semantics.** A symlink is shared mutable state: an agent editing
   *   `.env` inside the worktree writes through to the main tree. A copy
   *   is per-worktree and isolated, which is what local config, secrets
   *   and certificates need. Conversely a copy of `node_modules` costs
   *   gigabytes, so heavy shared dirs still belong in
   *   `worktree.symlinkDirectories`.
   * - **Ownership.** `.worktreeinclude` is committed, so it travels with
   *   the repository and applies to everyone who clones it; the setting
   *   is per-user. That is also why entries here are lower-trust — see
   *   `resolveWorktreeEntry`.
   *
   * Runs AFTER the symlink pass, and both skip an occupied destination,
   * so when a path appears in both the symlink wins. That ordering is
   * deliberate: the user's own setting outranks a file committed by
   * whoever wrote the repository.
   *
   * Every entry here is a single file — `resolveIncludedFiles` already
   * expanded directories through git — so this is a flat `copyFile` loop
   * with no recursive walk. Symbolic links are skipped outright rather
   * than copied as links or dereferenced: dereferencing would pull
   * repo-external content into the worktree, and reproducing the link
   * would hand the worktree a path that resolves who-knows-where.
   *
   * Same fail-open policy as the symlink pass: per-entry failures log and
   * continue; the worktree stays usable.
   */
  private async copyIncludedPaths(
    worktreePath: string,
    entries: readonly string[],
  ): Promise<void> {
    const logPrefix = 'copyIncludedPaths';
    const ctx = await this.buildWorktreeEntryContext(worktreePath, logPrefix);
    if (!ctx) return;

    let copied = 0;
    for (const raw of entries) {
      // `git ls-files` reports POSIX separators on every platform; the
      // gates and `path.join` below expect native ones.
      const native = raw.split('/').join(path.sep);

      // Skip symlinks before anything else. `resolveWorktreeEntry`
      // realpaths the source, so a link pointing inside the repo would
      // otherwise be copied as its target's content under the link's
      // name — silently materialising a file the repo models as a link.
      const sourceAbs = path.resolve(ctx.repoRootAbs, native);
      const isLink = await fs
        .lstat(sourceAbs)
        .then((st) => st.isSymbolicLink())
        .catch(() => false);
      if (isLink) {
        debugLogger.debug(`${logPrefix}: skipping symlink: ${sourceAbs}`);
        continue;
      }

      const resolved = await this.resolveWorktreeEntry(native, ctx, logPrefix);
      if (!resolved) continue;
      const { realSource, destAbs } = resolved;

      // `lstat`, not `fileExists`: a broken symlink still occupies the
      // slot and must not be overwritten, but `fs.access(F_OK)` follows
      // the link and would report it absent.
      const destOccupied = await fs
        .lstat(destAbs)
        .then(() => true)
        .catch(() => false);
      if (destOccupied) {
        debugLogger.debug(
          `${logPrefix}: destination exists, skipping: ${destAbs}`,
        );
        continue;
      }

      try {
        await fs.copyFile(realSource, destAbs, fsConstants.COPYFILE_EXCL);
        copied++;
        debugLogger.debug(`${logPrefix}: copied ${realSource} → ${destAbs}`);
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          // Lost the race with the lstat probe above. Same contract:
          // leave the existing content alone.
          debugLogger.debug(
            `${logPrefix}: destination exists, skipping: ${destAbs}`,
          );
        } else {
          debugLogger.warn(
            `${logPrefix}: failed to copy ${realSource} → ${destAbs}: ${error}`,
          );
        }
      }
    }

    if (copied > 0) {
      debugLogger.debug(
        `${logPrefix}: copied ${copied} file(s) from ${WORKTREE_INCLUDE_FILE}`,
      );
    }
  }

  /**
   * Returns true if a local branch with the given name exists.
   *
   * Uses `for-each-ref` because `simple-git.raw` swallows the non-zero
   * exit of `show-ref --quiet` and always resolves with empty stdout —
   * so the previous `show-ref` form would always return `true` and
   * permanently block worktree creation. `for-each-ref` instead prints
   * the ref name when it exists and prints nothing when it does not,
   * always exiting 0, so we can decide on the output.
   *
   * Conservative on error: returns false so the caller's "not exists"
   * fast path attempts the create (which itself will fail loudly if the
   * branch exists for some reason this check missed).
   */
  private async localBranchExists(branchName: string): Promise<boolean> {
    try {
      const out = await (
        await this.getGit()
      ).raw([
        'for-each-ref',
        '--count=1',
        '--format=%(refname)',
        `refs/heads/${branchName}`,
      ]);
      return out.trim().length > 0;
    } catch (error) {
      // Defensive default: if we cannot tell, assume the branch is
      // absent so the create attempt fires. Worst case `git worktree
      // add -b` itself errors out on the duplicate. But log so the
      // root cause (disk full, permission, ref-store corruption) shows
      // up in debug output instead of being invisible.
      debugLogger.warn(`localBranchExists failed for ${branchName}: ${error}`);
      return false;
    }
  }

  /**
   * Ensures `<projectRoot>/.qwen/.gitignore` ignores the worktrees
   * directory. Idempotent: writes only when the file is missing. If the
   * file exists (user may have curated it), this method is a no-op so
   * we never disturb intentional configuration.
   */
  private async ensureWorktreesGitignored(): Promise<void> {
    try {
      const qwenDir = path.join(this.sourceRepoPath, '.qwen');
      await fs.mkdir(qwenDir, { recursive: true });
      const gitignorePath = path.join(qwenDir, '.gitignore');
      // `flag: 'wx'` is "open for write, fail if exists" — one atomic
      // syscall that handles the "preserve user-curated file" case
      // without the `fs.access` + `fs.writeFile` TOCTOU race two
      // concurrent agent invocations would otherwise hit.
      try {
        await fs.writeFile(
          gitignorePath,
          `# Auto-generated by qwen-code.\n${WORKTREES_DIR}/\n`,
          { encoding: 'utf8', flag: 'wx' },
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          return; // User-curated file already in place.
        }
        throw error;
      }
    } catch (error) {
      // Best-effort: if writing the gitignore fails (read-only fs, etc.)
      // it is not worth aborting the worktree creation.
      debugLogger.warn(
        `ensureWorktreesGitignored failed (non-fatal): ${error}`,
      );
    }
  }

  /**
   * Removes a user worktree, optionally deleting its branch.
   *
   * Branch deletion uses `-d` by default (refuses to drop branches that
   * have commits not merged into HEAD), so a worktree whose tree was
   * left "clean" because the agent committed its work doesn't lose
   * those commits when the cleanup helper sweeps it. Set
   * `forceDeleteBranch: true` to bypass — callers must have already
   * confirmed there is nothing of value on the branch.
   */
  async removeUserWorktree(
    slug: string,
    options: { deleteBranch?: boolean; forceDeleteBranch?: boolean } = {},
  ): Promise<{
    success: boolean;
    error?: string;
    branchPreserved?: boolean;
  }> {
    const worktreePath = this.getUserWorktreePath(slug);
    const branchName = worktreeBranchForSlug(slug);

    const removed = await this.removeWorktree(worktreePath);
    if (!removed.success) {
      return removed;
    }

    if (!options.deleteBranch) {
      return { success: true };
    }

    // Try a safe (non-force) delete first. `git branch -d` refuses to
    // remove branches whose tip is not reachable from HEAD or any
    // upstream — preserving any commits the subagent made before
    // ending with a clean working tree.
    const git = await this.getGit();
    try {
      await git.branch(['-d', branchName]);
      return { success: true };
    } catch (error) {
      // Refused either because the branch carries unmerged commits
      // (the common case, handled below by surfacing `branchPreserved`)
      // or because of a real failure (locked ref, permissions, disk
      // full). Log so the caller's "branch preserved" message can be
      // cross-referenced with a concrete reason.
      debugLogger.warn(
        `removeUserWorktree: safe branch delete failed for ${branchName}: ${error}`,
      );
    }

    if (options.forceDeleteBranch) {
      try {
        await git.branch(['-D', branchName]);
        return { success: true };
      } catch (error) {
        // Best-effort: branch may have been deleted already, or may not
        // exist (a no-op). Still log because a true filesystem error
        // would otherwise be invisible.
        debugLogger.warn(
          `removeUserWorktree: force branch delete failed for ${branchName}: ${error}`,
        );
      }
    }

    // Reached here when the branch had unmerged commits and the caller
    // did not opt into force-delete. Surface this so callers can leave
    // a note for the user.
    return { success: true, branchPreserved: true };
  }

  /**
   * Reports whether the tip of a user worktree's branch is reachable
   * only from itself — i.e. the branch carries commits that no other
   * local branch or remote ref points at, so dropping the branch would
   * silently destroy them. Used by callers that want to decide whether
   * removing the worktree would lose work the subagent committed but
   * never merged or pushed.
   *
   * Fail-closed: returns `true` on any git error so the caller defaults
   * to preserving rather than destroying the worktree.
   */
  async hasUnmergedWorktreeCommits(slug: string): Promise<boolean> {
    const branchName = worktreeBranchForSlug(slug);
    try {
      const git = await this.getGit();
      const tipSha = (await git.revparse([branchName])).trim();
      if (!tipSha) return true;
      // List every local branch and remote-tracking ref whose tip is at
      // or above the worktree branch's tip. If anything other than the
      // worktree branch itself appears, the commits are covered.
      const refs = (
        await git.raw([
          'for-each-ref',
          '--contains',
          tipSha,
          '--format=%(refname)',
          'refs/heads',
          'refs/remotes',
        ])
      )
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== `refs/heads/${branchName}`);
      return refs.length === 0;
    } catch (error) {
      // Fail-closed but log so a corrupted ref store or permission
      // problem can be diagnosed: without this, callers see the
      // conservative "has unmerged commits" reply with no clue about
      // the underlying git failure.
      debugLogger.warn(
        `hasUnmergedWorktreeCommits failed for slug ${slug}: ${error}`,
      );
      return true;
    }
  }

  /**
   * Reports whether a worktree has uncommitted tracked changes (staged or
   * unstaged) or untracked files. Used by `ExitWorktreeTool` to refuse
   * `remove` when the user has work in progress.
   *
   * Fail-closed: returns `true` on any git error so the caller assumes the
   * worktree is dirty rather than risking data loss.
   */
  async hasWorktreeChanges(worktreePath: string): Promise<boolean> {
    try {
      const { simpleGit } = await loadSimpleGit();
      const wtGit = simpleGit(worktreePath);
      const status = await wtGit.status();
      // Defensive: `status.isClean()` reads several status arrays, but
      // we OR with `conflicted.length` explicitly so future simple-git
      // versions that change the bookkeeping cannot silently let a
      // mid-merge worktree appear clean to the agent cleanup path
      // (which would then delete it and lose the resolution work).
      // `not_added` covers untracked; `staged`/`modified`/etc. cover
      // the rest.
      return !status.isClean() || status.conflicted.length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Counts uncommitted file changes in a worktree. Returns null if the
   * worktree can't be inspected (which the caller should treat as "dirty").
   */
  async countWorktreeChanges(
    worktreePath: string,
  ): Promise<{ tracked: number; untracked: number } | null> {
    try {
      const { simpleGit } = await loadSimpleGit();
      const wtGit = simpleGit(worktreePath);
      const status = await wtGit.status();
      // `conflicted` is mutually exclusive with the other arrays in
      // simple-git's status — a worktree mid-merge with no other
      // edits would otherwise read as `{tracked: 0, untracked: 0}`
      // and slip past the dirty-state guard in `exit_worktree`,
      // discarding the merge resolution. Treat as tracked changes.
      const tracked =
        status.staged.length +
        status.modified.length +
        status.deleted.length +
        status.renamed.length +
        status.created.length +
        status.conflicted.length;
      const untracked = status.not_added.length;
      return { tracked, untracked };
    } catch {
      return null;
    }
  }
}
