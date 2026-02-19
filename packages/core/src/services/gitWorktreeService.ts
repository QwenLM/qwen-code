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
import type { ArenaConfigFile } from '../agents/arena/types.js';

/**
 * Commit message used for the baseline snapshot in arena worktrees.
 * After overlaying the user's dirty state (tracked changes + untracked files),
 * a commit with this message is created so that later diffs only capture the
 * agent's changes — not the pre-existing local edits.
 */
export const ARENA_BASELINE_MESSAGE = 'arena: baseline (dirty state overlay)';

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

export interface ArenaWorktreeConfig {
  /** Arena session identifier */
  arenaSessionId: string;
  /** Source repository path (project root) */
  sourceRepoPath: string;
  /** Names/identifiers for each worktree to create */
  worktreeNames: string[];
  /** Base branch to create worktrees from (defaults to current branch) */
  baseBranch?: string;
}

export interface CreateWorktreeResult {
  success: boolean;
  worktree?: WorktreeInfo;
  error?: string;
}

export interface ArenaWorktreeSetupResult {
  success: boolean;
  arenaSessionId: string;
  worktrees: WorktreeInfo[];
  worktreesByName: Record<string, WorktreeInfo>;
  errors: Array<{ name: string; error: string }>;
  wasRepoInitialized: boolean;
}

/**
 * Service for managing git worktrees for Arena multi-agent execution.
 *
 * Git worktrees allow multiple working directories to share a single repository,
 * enabling isolated environments for each Arena agent without copying the entire repo.
 */
export class GitWorktreeService {
  private sourceRepoPath: string;
  private git: SimpleGit;
  private readonly customArenaBaseDir?: string;

  constructor(sourceRepoPath: string, customArenaBaseDir?: string) {
    this.sourceRepoPath = path.resolve(sourceRepoPath);
    this.git = simpleGit(this.sourceRepoPath);
    this.customArenaBaseDir = customArenaBaseDir;
  }

  /**
   * Gets the directory where Arena worktrees are stored.
   * @param customDir - Optional custom base directory override
   */
  static getArenaBaseDir(customDir?: string): string {
    if (customDir) {
      return path.resolve(customDir);
    }
    return path.join(Storage.getGlobalQwenDir(), 'arena');
  }

  /**
   * Gets the directory for a specific Arena session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getArenaSessionDir(
    arenaSessionId: string,
    customBaseDir?: string,
  ): string {
    return path.join(
      GitWorktreeService.getArenaBaseDir(customBaseDir),
      arenaSessionId,
    );
  }

  /**
   * Gets the worktrees directory for a specific Arena session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getWorktreesDir(
    arenaSessionId: string,
    customBaseDir?: string,
  ): string {
    return path.join(
      GitWorktreeService.getArenaSessionDir(arenaSessionId, customBaseDir),
      'worktrees',
    );
  }

  /**
   * Instance-level arena base dir, using the custom dir if provided at construction.
   */
  getArenaBaseDirForInstance(): string {
    return GitWorktreeService.getArenaBaseDir(this.customArenaBaseDir);
  }

  /**
   * Checks if git is available on the system.
   */
  async checkGitAvailable(): Promise<{ available: boolean; error?: string }> {
    const { available } = isCommandAvailable('git');
    if (!available) {
      return {
        available: false,
        error: 'Git is not installed. Please install Git to use Arena feature.',
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
      await this.git.commit('Initial commit for Arena', {
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
   * Creates a single worktree for an Arena agent.
   */
  async createWorktree(
    arenaSessionId: string,
    name: string,
    baseBranch?: string,
  ): Promise<CreateWorktreeResult> {
    try {
      const worktreesDir = GitWorktreeService.getWorktreesDir(
        arenaSessionId,
        this.customArenaBaseDir,
      );
      await fs.mkdir(worktreesDir, { recursive: true });

      // Sanitize name for use as branch and directory name
      const sanitizedName = this.sanitizeName(name);
      const worktreePath = path.join(worktreesDir, sanitizedName);
      const branchName = `arena/${arenaSessionId}/${sanitizedName}`;

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
        id: `${arenaSessionId}/${sanitizedName}`,
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
   * Sets up all worktrees for an Arena session.
   * This is the main entry point for Arena worktree creation.
   */
  async setupArenaWorktrees(
    config: ArenaWorktreeConfig,
  ): Promise<ArenaWorktreeSetupResult> {
    const result: ArenaWorktreeSetupResult = {
      success: false,
      arenaSessionId: config.arenaSessionId,
      worktrees: [],
      worktreesByName: {},
      errors: [],
      wasRepoInitialized: false,
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
      const initResult = await this.initializeRepository();
      if (initResult.error) {
        result.errors.push({ name: 'initialization', error: initResult.error });
        return result;
      }
      result.wasRepoInitialized = initResult.initialized;
    }

    // Create arena session directory
    const sessionDir = GitWorktreeService.getArenaSessionDir(
      config.arenaSessionId,
      this.customArenaBaseDir,
    );
    await fs.mkdir(sessionDir, { recursive: true });

    // Save arena config for later reference
    const arenaConfigPath = path.join(sessionDir, 'config.json');
    const configFile: ArenaConfigFile = {
      arenaSessionId: config.arenaSessionId,
      sourceRepoPath: config.sourceRepoPath,
      worktreeNames: config.worktreeNames,
      baseBranch: config.baseBranch,
      createdAt: Date.now(),
    };
    await fs.writeFile(arenaConfigPath, JSON.stringify(configFile, null, 2));

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

    // Create worktrees for each agent
    for (const name of config.worktreeNames) {
      const createResult = await this.createWorktree(
        config.arenaSessionId,
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
        await this.cleanupArenaSession(config.arenaSessionId);
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
          await wtGit.commit(ARENA_BASELINE_MESSAGE, {
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
   * Lists all worktrees for an Arena session.
   */
  async listArenaWorktrees(arenaSessionId: string): Promise<WorktreeInfo[]> {
    const worktreesDir = GitWorktreeService.getWorktreesDir(
      arenaSessionId,
      this.customArenaBaseDir,
    );

    try {
      const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
      const worktrees: WorktreeInfo[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const worktreePath = path.join(worktreesDir, entry.name);
          const branchName = `arena/${arenaSessionId}/${entry.name}`;

          // Try to get stats for creation time
          let createdAt = Date.now();
          try {
            const stats = await fs.stat(worktreePath);
            createdAt = stats.birthtimeMs;
          } catch {
            // Ignore stat errors
          }

          worktrees.push({
            id: `${arenaSessionId}/${entry.name}`,
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
   * Cleans up all worktrees and branches for an Arena session.
   */
  async cleanupArenaSession(arenaSessionId: string): Promise<{
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

    const worktrees = await this.listArenaWorktrees(arenaSessionId);

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

    // Remove arena session directory
    const sessionDir = GitWorktreeService.getArenaSessionDir(
      arenaSessionId,
      this.customArenaBaseDir,
    );
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(
        `Failed to remove session directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    // Clean up arena branches
    const branchPrefix = `arena/${arenaSessionId}/`;
    try {
      const branches = await this.git.branch(['-a']);
      for (const branchName of Object.keys(branches.branches)) {
        if (branchName.startsWith(branchPrefix)) {
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
   * Prefers the arena baseline commit (which includes the dirty state overlay)
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
   * Diffs from the arena baseline commit (which already includes the user's
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
        // Fallback: diff from merge-base (legacy / non-arena worktrees)
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
        this.getArenaBaseDirForInstance(),
        `.arena-apply-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`,
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
   * Lists all Arena sessions.
   */
  static async listArenaSessions(customBaseDir?: string): Promise<
    Array<{
      arenaSessionId: string;
      createdAt: number;
      sourceRepoPath: string;
      worktreeCount: number;
    }>
  > {
    const arenaDir = GitWorktreeService.getArenaBaseDir(customBaseDir);
    const sessions: Array<{
      arenaSessionId: string;
      createdAt: number;
      sourceRepoPath: string;
      worktreeCount: number;
    }> = [];

    try {
      const entries = await fs.readdir(arenaDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = path.join(arenaDir, entry.name, 'config.json');
          try {
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent) as ArenaConfigFile;

            const worktreesDir = path.join(arenaDir, entry.name, 'worktrees');
            let worktreeCount = 0;
            try {
              const worktreeEntries = await fs.readdir(worktreesDir);
              worktreeCount = worktreeEntries.length;
            } catch {
              // Ignore if worktrees dir doesn't exist
            }

            sessions.push({
              arenaSessionId: entry.name,
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
   * Finds the arena baseline commit in a worktree, if one exists.
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
          ARENA_BASELINE_MESSAGE,
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
