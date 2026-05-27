/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { simpleGit, CheckRepoActions } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { Storage } from '../config/storage.js';
import { isCommandAvailable } from '../utils/shell-utils.js';
import { isNodeError } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { fileExists, isWithinRoot } from '../utils/fileUtils.js';
import { initRepositoryWithMainBranch } from './gitInit.js';

const debugLogger = createDebugLogger('GIT_WORKTREE_SERVICE');

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
 * Service for managing git worktrees.
 *
 * Git worktrees allow multiple working directories to share a single repository,
 * enabling isolated environments without copying the entire repo.
 */
export class GitWorktreeService {
  private sourceRepoPath: string;
  private git: SimpleGit;
  private readonly customBaseDir?: string;

  constructor(sourceRepoPath: string, customBaseDir?: string) {
    this.sourceRepoPath = path.resolve(sourceRepoPath);
    this.git = simpleGit(this.sourceRepoPath);
    this.customBaseDir = customBaseDir;
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
      const out = await this.git.revparse(['--show-toplevel']);
      const top = out.trim();
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
   * Checks if the source path is a git repository.
   */
  async isGitRepository(): Promise<boolean> {
    try {
      const isRoot = await this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
      if (isRoot) {
        return true;
      }
    } catch {
      // IS_REPO_ROOT check failed — fall through to the general check
    }
    // Not the root (or root check threw) — check if we're inside a git repo
    try {
      return await this.git.checkIsRepo();
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
      await initRepositoryWithMainBranch(this.git);

      // Create initial commit so we can create worktrees
      await this.git.add('.');
      await this.git.commit('Initial commit', {
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
    const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim();
  }

  /**
   * Gets the current commit hash.
   */
  async getCurrentCommitHash(): Promise<string> {
    const hash = await this.git.revparse(['HEAD']);
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
      const out = (await this.git.raw(['rev-parse', '--verify', ref])).trim();
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
      await this.git.raw([
        'worktree',
        'add',
        '-b',
        branchName,
        worktreePath,
        base,
      ]);

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
      dirtyStateSnapshot = (await this.git.stash(['create'])).trim();
    } catch {
      // Ignore — proceed without dirty state if stash create fails
    }

    // Discover untracked files so they can be copied into each worktree.
    // `git ls-files --others --exclude-standard` is read-only and safe.
    let untrackedFiles: string[] = [];
    try {
      const raw = await this.git.raw([
        'ls-files',
        '--others',
        '--exclude-standard',
      ]);
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
    try {
      // Remove the worktree from git
      await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
      return { success: true };
    } catch (error) {
      // Try to remove the directory manually if git worktree remove fails
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        // Prune worktree references
        await this.git.raw(['worktree', 'prune']);
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
      for (const branchName of worktreeBranches) {
        try {
          await this.git.branch(['-D', branchName]);
          result.removedBranches.push(branchName);
        } catch {
          // Branch might already be deleted, ignore
        }
      }
    } catch {
      // Ignore branch listing/deletion errors
    }

    // Prune worktree references
    try {
      await this.git.raw(['worktree', 'prune']);
    } catch {
      // Ignore prune errors
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
    const worktreeGit = simpleGit(worktreePath);

    const base =
      (await this.resolveBaseline(worktreeGit)) ??
      baseBranch ??
      (await this.getCurrentBranch());

    try {
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
    const worktreeGit = simpleGit(worktreePath);
    const targetGit = simpleGit(target);

    try {
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
    // `this.git`, the candidate's HEAD-SHA + branch + common-dir +
    // toplevel come from a fresh simple-git rooted at `worktreePath`
    // via a single combined rev-parse.
    const probeGit = simpleGit(worktreePath);
    let ourCommonDir: string;
    let headCommit: string;
    let branch: string;
    let probeCommonDir: string;
    let probeToplevel: string;
    try {
      const [ourRaw, probeRaw] = await Promise.all([
        this.git.raw(['rev-parse', '--git-common-dir']),
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

      await this.git.raw([
        'worktree',
        'add',
        '-b',
        branchName,
        worktreePath,
        base,
      ]);

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
      if (symlinkPaths.length > 0) {
        await this.symlinkConfiguredDirectories(
          worktreePath,
          symlinkPaths,
        ).catch((error) => {
          debugLogger.warn(
            `createUserWorktree: symlinkConfiguredDirectories failed for ${slug}: ${error}`,
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
          await this.git.raw(['rev-parse', '--git-common-dir'])
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

    const worktreeGit = simpleGit(worktreePath);
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
   * Phase D-2 symlink loop. For each configured directory under the main
   * repository, creates a symbolic link from the new worktree to the
   * main-repo location (`<worktreePath>/<dir>` → `<repoRoot>/<dir>`).
   *
   * Fail-open semantics — the worktree IS already on disk and usable by
   * the time this runs, so a symlink failure must NOT abort the parent
   * `createUserWorktree` call. Per-entry failures are logged at debug or
   * warn level depending on cause:
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
   */
  private async symlinkConfiguredDirectories(
    worktreePath: string,
    configured: readonly string[],
  ): Promise<void> {
    for (const raw of configured) {
      if (typeof raw !== 'string' || raw.length === 0) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: skipping non-string / empty entry: ${JSON.stringify(raw)}`,
        );
        continue;
      }

      // Reject absolute paths and any traversal-prone form. Resolve first
      // to catch `./foo/../../etc` style escapes that look relative.
      if (path.isAbsolute(raw)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing absolute path "${raw}"`,
        );
        continue;
      }
      // Reject any literal `..` segment up front. The post-resolve
      // `isWithinRoot` check below would still accept `foo/../bar`
      // (resolves to `bar`, which is inside the repo), but the public
      // contract — settingsSchema description, docs/users/features/
      // worktree.md, WorktreeSettings JSDoc — promises rejection of
      // any entry containing `..`. Enforce that promise here.
      if (raw.split(/[\\/]/).includes('..')) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — contains '..' segment`,
        );
        continue;
      }
      const sourceAbs = path.resolve(this.sourceRepoPath, raw);
      const repoRootAbs = path.resolve(this.sourceRepoPath);
      if (sourceAbs === repoRootAbs) {
        // `""` / `"."` / `"./"` etc. — pointless and would alias the
        // entire repo into itself. Reject explicitly so the path-prefix
        // checks below don't have to handle this degenerate case.
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing empty / repo-root path "${raw}"`,
        );
        continue;
      }
      if (!isWithinRoot(sourceAbs, repoRootAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — resolves outside repo root (${sourceAbs} vs ${repoRootAbs})`,
        );
        continue;
      }

      // Refuse to symlink git-internal paths into the worktree. `.git`
      // would silently break commits / status / diff inside the
      // worktree (the worktree's own gitlink file points at the parent
      // common-dir, and a symlink would shadow it). The whole `.qwen`
      // tree is also off-limits: linking `.qwen` (parent) would
      // recursively pull `.qwen/worktrees` into the new worktree,
      // recreating the loop; linking `.qwen/worktrees` directly
      // creates the same loop more obviously; and `.qwen/projects`
      // / `.qwen/tmp` are CLI metadata users have no legitimate
      // reason to share across worktrees.
      const gitDirAbs = path.join(repoRootAbs, '.git');
      if (isWithinRoot(sourceAbs, gitDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing git-internal path "${raw}"`,
        );
        continue;
      }
      const qwenDirAbs = path.join(repoRootAbs, '.qwen');
      if (isWithinRoot(sourceAbs, qwenDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — ` +
            `the .qwen tree is CLI-managed; symlinking any of it could ` +
            `create a worktrees-inside-worktrees loop or alias CLI metadata.`,
        );
        continue;
      }

      // Confirm the source exists. We don't insist on it being a directory
      // specifically — `node_modules` is canonically a dir, but a user
      // who wants to share a single file (`.env`, `secrets.json`) via
      // `symlinkDirectories` should still get the link.
      let sourceStat: { isDirectory: () => boolean } | null = null;
      try {
        sourceStat = await fs.stat(sourceAbs);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          debugLogger.debug(
            `symlinkConfiguredDirectories: source missing, skipping: ${sourceAbs}`,
          );
        } else {
          debugLogger.warn(
            `symlinkConfiguredDirectories: cannot stat ${sourceAbs}: ${error}`,
          );
        }
        continue;
      }

      // Resolve through any symlinks in the source path and RE-RUN the
      // containment + blocklist checks against the realpath. The lexical
      // checks above only see `path.resolve(repoRoot, raw)` — they can't
      // tell that `<repo>/node_modules` is actually a symlink chaining
      // into `.git`, an outside dir, or `.qwen`. Without this step a
      // committed-or-out-of-band source symlink bypasses every guard the
      // lexical loop set up. Use the realpath as the symlink target so
      // the new link points canonically rather than preserving the chain.
      let realSource: string;
      try {
        realSource = await fs.realpath(sourceAbs);
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot realpath source "${sourceAbs}": ${error}`,
        );
        continue;
      }
      if (!isWithinRoot(realSource, repoRootAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — real source ${realSource} escapes repo root ${repoRootAbs}`,
        );
        continue;
      }
      if (isWithinRoot(realSource, gitDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — real source ${realSource} resolves inside .git`,
        );
        continue;
      }
      if (isWithinRoot(realSource, qwenDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — real source ${realSource} resolves inside .qwen`,
        );
        continue;
      }

      const destAbs = path.join(worktreePath, raw);

      // Ensure the parent directory of `destAbs` exists. For top-level
      // entries (`node_modules`) this is a no-op against the worktree
      // root, but for nested values (`tools/cache`) we may need to
      // create the intermediate dirs first — git worktree add does NOT
      // create them.
      try {
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot mkdir parent of ${destAbs}: ${error}`,
        );
        continue;
      }

      // Sibling-drift defense to the round-7 source-side realpath check:
      // `path.join(worktreePath, raw)` is lexical too. If `git worktree
      // add` materialized a committed symlink under the worktree
      // (e.g. HEAD ships `tools → /etc`), then the OS-side resolution
      // of `<worktree>/tools/cache` traverses through the committed
      // symlink and our `fs.mkdir` / `fs.symlink` write OUTSIDE the
      // worktree. Realpath the dest parent and refuse if it escapes.
      let realDestParent: string;
      try {
        realDestParent = await fs.realpath(path.dirname(destAbs));
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot realpath dest parent for "${raw}" (${path.dirname(destAbs)}): ${error}`,
        );
        continue;
      }
      const realWorktreePath = await fs.realpath(worktreePath).catch(() => worktreePath);
      if (!isWithinRoot(realDestParent, realWorktreePath)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — dest parent ${realDestParent} escapes worktree root ${realWorktreePath} (committed-symlink chain)`,
        );
        continue;
      }

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
        debugLogger.debug(
          `symlinkConfiguredDirectories: linked ${destAbs} → ${realSource} (${symlinkType})`,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          debugLogger.debug(
            `symlinkConfiguredDirectories: destination exists, skipping: ${destAbs}`,
          );
        } else {
          debugLogger.warn(
            `symlinkConfiguredDirectories: failed to link ${destAbs} → ${realSource}: ${error}`,
          );
        }
      }
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
      const out = await this.git.raw([
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
    try {
      await this.git.branch(['-d', branchName]);
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
        await this.git.branch(['-D', branchName]);
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
      const tipSha = (await this.git.revparse([branchName])).trim();
      if (!tipSha) return true;
      // List every local branch and remote-tracking ref whose tip is at
      // or above the worktree branch's tip. If anything other than the
      // worktree branch itself appears, the commits are covered.
      const refs = (
        await this.git.raw([
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
