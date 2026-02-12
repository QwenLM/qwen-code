/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/** Default timeout for all git commands (ms). */
const GIT_COMMAND_TIMEOUT = 5_000;

/**
 * Result returned by {@link BranchHandler.checkBranchChange}.
 */
export interface BranchChangeResult {
  /** Whether the branch changed since the last check. */
  changed: boolean;
  /** Previous branch name (`null` on first check). */
  previousBranch: string | null;
  /** Current branch name. */
  currentBranch: string;
  /**
   * Files changed between the two branches (via `git diff --name-only`).
   * Only populated when `changed` is `true`.
   * May be `null` if the diff command fails (e.g. no common ancestor).
   */
  changedFiles: string[] | null;
}

/**
 * Callback invoked when a branch change is detected.
 */
export type BranchChangeCallback = (
  result: BranchChangeResult,
) => void | Promise<void>;

/**
 * Executor abstraction for running git commands.
 * Allows dependency injection in tests without fragile child_process mocking.
 */
export interface GitExecutor {
  exec(
    args: string[],
    cwd: string,
    timeout?: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Default executor that shells out to the real `git` binary via `execFile`.
 * Uses argument arrays (no shell interpolation → no injection risk)
 * and enforces a per-command timeout to prevent hanging on locked repos.
 */
export class DefaultGitExecutor implements GitExecutor {
  async exec(
    args: string[],
    cwd: string,
    timeout: number = GIT_COMMAND_TIMEOUT,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, { cwd, timeout });
  }
}

/**
 * BranchHandler monitors Git branch changes and provides
 * precise changed-file lists for targeted incremental updates.
 *
 * Key design choices:
 * - Uses `execFile` with argument arrays (no shell interpolation → no injection risk).
 * - All git commands carry a timeout to prevent hanging on locked repos.
 * - `checkBranchChange()` returns a rich {@link BranchChangeResult} that
 *   includes the changed file list, so the caller never needs to do a
 *   separate full-repo scan after a branch switch.
 * - Accepts an optional {@link GitExecutor} for easy test mocking.
 *
 * @example
 * ```typescript
 * const handler = new BranchHandler(projectRoot);
 * const result = await handler.checkBranchChange();
 * if (result.changed) {
 *   console.log(`Branch: ${result.previousBranch} → ${result.currentBranch}`);
 *   console.log(`Changed files: ${result.changedFiles?.length ?? '?'}`);
 * }
 * ```
 */
export class BranchHandler {
  private projectRoot: string;
  private lastBranch: string | null = null;
  private callbacks: BranchChangeCallback[] = [];
  private git: GitExecutor;

  /**
   * Creates a new BranchHandler instance.
   *
   * @param projectRoot The root directory of the Git repository.
   * @param gitExecutor Optional executor for running git commands (DI for tests).
   */
  constructor(projectRoot: string, gitExecutor?: GitExecutor) {
    this.projectRoot = path.resolve(projectRoot);
    this.git = gitExecutor ?? new DefaultGitExecutor();
  }

  /**
   * Registers a callback to be invoked when a branch change is detected.
   */
  onBranchChange(callback: BranchChangeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Removes a previously registered callback.
   */
  offBranchChange(callback: BranchChangeCallback): void {
    const index = this.callbacks.indexOf(callback);
    if (index !== -1) {
      this.callbacks.splice(index, 1);
    }
  }

  /**
   * Checks if the current branch has changed since the last check.
   * When a change is detected, also fetches the list of changed files
   * between the old and new branch via `git diff --name-only`.
   *
   * @returns A {@link BranchChangeResult} with change details.
   */
  async checkBranchChange(): Promise<BranchChangeResult> {
    try {
      const currentBranch = await this.getCurrentBranch();

      if (this.lastBranch !== null && this.lastBranch !== currentBranch) {
        const previousBranch = this.lastBranch;
        this.lastBranch = currentBranch;

        // Get the precise file diff between branches
        const changedFiles = await this.getChangedFilesBetween(
          previousBranch,
          currentBranch,
        );

        const result: BranchChangeResult = {
          changed: true,
          previousBranch,
          currentBranch,
          changedFiles,
        };

        // Invoke callbacks
        for (const callback of this.callbacks) {
          try {
            await callback(result);
          } catch (error) {
            console.error(`BranchHandler callback error: ${error}`);
          }
        }

        return result;
      }

      // First check or no change
      this.lastBranch = currentBranch;
      return {
        changed: false,
        previousBranch: this.lastBranch,
        currentBranch,
        changedFiles: null,
      };
    } catch (error) {
      console.warn(`BranchHandler: Failed to get current branch: ${error}`);
      return {
        changed: false,
        previousBranch: this.lastBranch,
        currentBranch: this.lastBranch ?? '',
        changedFiles: null,
      };
    }
  }

  /**
   * Gets the current Git branch name.
   * Returns the short commit hash if in detached HEAD state.
   */
  async getCurrentBranch(): Promise<string> {
    const { stdout } = await this.git.exec(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      this.projectRoot,
    );
    const branch = stdout.trim();

    // In detached HEAD state, --abbrev-ref returns literal "HEAD".
    // Fall back to short commit hash for uniqueness.
    if (branch === 'HEAD') {
      const { stdout: hashOut } = await this.git.exec(
        ['rev-parse', '--short', 'HEAD'],
        this.projectRoot,
      );
      return hashOut.trim();
    }
    return branch;
  }

  /**
   * Quick check: is the git working tree dirty?
   * Uses `git status --porcelain` which is very fast.
   *
   * @returns `true` if there are uncommitted changes (staged, unstaged, or untracked).
   */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const { stdout } = await this.git.exec(
        ['status', '--porcelain'],
        this.projectRoot,
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Checks if the project directory is a Git repository.
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.git.exec(['rev-parse', '--git-dir'], this.projectRoot);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets the last known branch (from the previous check).
   */
  getLastBranch(): string | null {
    return this.lastBranch;
  }

  /**
   * Sets the last known branch without triggering callbacks.
   * Useful for initialization.
   */
  setLastBranch(branch: string | null): void {
    this.lastBranch = branch;
  }

  /**
   * Gets list of files changed between two commits/branches.
   *
   * @param from Source branch/commit.
   * @param to Target branch/commit (default: HEAD).
   * @returns Array of changed file paths (relative to repo root), or `null` on failure.
   */
  async getChangedFilesBetween(
    from: string,
    to: string = 'HEAD',
  ): Promise<string[] | null> {
    try {
      const { stdout } = await this.git.exec(
        ['diff', '--name-only', `${from}...${to}`],
        this.projectRoot,
      );
      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch {
      return null;
    }
  }
}
