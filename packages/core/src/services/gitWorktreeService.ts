/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { simpleGit, CheckRepoActions } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { Storage } from '../config/storage.js';
import { isCommandAvailable } from '../utils/shell-utils.js';
import { isNodeError } from '../utils/errors.js';

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
  /** Branch prefix for worktree branches (default: 'worktrees') */
  branchPrefix?: string;
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
      await this.git.init(false, { '--initial-branch': 'main' });

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
   * Creates a single worktree.
   */
  async createWorktree(
    sessionId: string,
    name: string,
    baseBranch?: string,
    branchPrefix: string = WORKTREES_DIR,
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
      const branchName = `${branchPrefix}/${sessionId}/${sanitizedName}`;

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

    const branchPrefix = config.branchPrefix ?? WORKTREES_DIR;

    // Create worktrees for each entry
    for (const name of config.worktreeNames) {
      const createResult = await this.createWorktree(
        config.sessionId,
        name,
        config.baseBranch,
        branchPrefix,
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
        await this.cleanupSession(config.sessionId, branchPrefix);
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
  async listWorktrees(
    sessionId: string,
    branchPrefix: string = WORKTREES_DIR,
  ): Promise<WorktreeInfo[]> {
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
          const branchName = `${branchPrefix}/${sessionId}/${entry.name}`;

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
  async cleanupSession(
    sessionId: string,
    branchPrefix: string = WORKTREES_DIR,
  ): Promise<{
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

    const worktrees = await this.listWorktrees(sessionId, branchPrefix);

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

    // Clean up branches
    const prefix = `${branchPrefix}/${sessionId}/`;
    try {
      const branches = await this.git.branch(['-a']);
      for (const branchName of Object.keys(branches.branches)) {
        if (branchName.startsWith(prefix)) {
          try {
            await this.git.branch(['-D', branchName]);
            result.removedBranches.push(branchName);
          } catch {
            // Branch might already be deleted, ignore
          }
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
}
