/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execAsync = promisify(exec);

/**
 * Callback invoked when a branch change is detected.
 */
export type BranchChangeCallback = (
  previousBranch: string | null,
  currentBranch: string,
) => void | Promise<void>;

/**
 * BranchHandler monitors Git branch changes and triggers callbacks
 * when the current branch differs from the last known branch.
 *
 * This is useful for triggering index updates after branch switches,
 * since switching branches often changes a significant portion of files.
 *
 * @example
 * ```typescript
 * const handler = new BranchHandler(projectRoot);
 * handler.onBranchChange(async (prev, curr) => {
 *   console.log(`Branch changed from ${prev} to ${curr}`);
 *   await changeDetector.detectChanges();
 * });
 *
 * // Check periodically or on-demand
 * await handler.checkBranchChange();
 * ```
 */
export class BranchHandler {
  private projectRoot: string;
  private lastBranch: string | null = null;
  private callbacks: BranchChangeCallback[] = [];

  /**
   * Creates a new BranchHandler instance.
   *
   * @param projectRoot The root directory of the Git repository.
   */
  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /**
   * Registers a callback to be invoked when a branch change is detected.
   *
   * @param callback Function to call on branch change.
   */
  onBranchChange(callback: BranchChangeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Removes a previously registered callback.
   *
   * @param callback The callback to remove.
   */
  offBranchChange(callback: BranchChangeCallback): void {
    const index = this.callbacks.indexOf(callback);
    if (index !== -1) {
      this.callbacks.splice(index, 1);
    }
  }

  /**
   * Checks if the current branch has changed since the last check.
   * If changed, triggers all registered callbacks.
   *
   * @returns True if branch changed, false otherwise.
   */
  async checkBranchChange(): Promise<boolean> {
    try {
      const currentBranch = await this.getCurrentBranch();

      if (this.lastBranch !== null && this.lastBranch !== currentBranch) {
        // Branch has changed - invoke callbacks
        const previousBranch = this.lastBranch;
        this.lastBranch = currentBranch;

        for (const callback of this.callbacks) {
          try {
            await callback(previousBranch, currentBranch);
          } catch (error) {
            console.error(`BranchHandler callback error: ${error}`);
          }
        }

        return true;
      }

      // First check or no change - just update stored branch
      this.lastBranch = currentBranch;
      return false;
    } catch (error) {
      // Not a git repo or git not available - ignore
      console.warn(`BranchHandler: Failed to get current branch: ${error}`);
      return false;
    }
  }

  /**
   * Gets the current Git branch name.
   *
   * @returns Current branch name.
   * @throws Error if not in a Git repository or git command fails.
   */
  async getCurrentBranch(): Promise<string> {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: this.projectRoot,
    });
    return stdout.trim();
  }

  /**
   * Gets the current Git commit hash (short form).
   *
   * @returns Current commit hash (7 characters).
   * @throws Error if not in a Git repository.
   */
  async getCurrentCommitHash(): Promise<string> {
    const { stdout } = await execAsync('git rev-parse --short HEAD', {
      cwd: this.projectRoot,
    });
    return stdout.trim();
  }

  /**
   * Gets the full Git HEAD reference.
   * Useful for detecting detached HEAD state.
   *
   * @returns HEAD reference or commit hash if detached.
   */
  async getHeadRef(): Promise<string> {
    const { stdout } = await execAsync('git rev-parse HEAD', {
      cwd: this.projectRoot,
    });
    return stdout.trim();
  }

  /**
   * Checks if the project directory is a Git repository.
   *
   * @returns True if it's a Git repository.
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await execAsync('git rev-parse --git-dir', {
        cwd: this.projectRoot,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets the last known branch (from the previous check).
   *
   * @returns Last known branch name, or null if never checked.
   */
  getLastBranch(): string | null {
    return this.lastBranch;
  }

  /**
   * Sets the last known branch without triggering callbacks.
   * Useful for initialization.
   *
   * @param branch Branch name to set.
   */
  setLastBranch(branch: string | null): void {
    this.lastBranch = branch;
  }

  /**
   * Gets list of files changed between two commits/branches.
   * Useful for targeted incremental updates after branch switch.
   *
   * @param from Source branch/commit.
   * @param to Target branch/commit (default: current).
   * @returns Array of changed file paths (relative to repo root).
   */
  async getChangedFilesBetween(
    from: string,
    to: string = 'HEAD',
  ): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `git diff --name-only ${from}...${to}`,
        { cwd: this.projectRoot },
      );

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch {
      // If diff fails (e.g., no common ancestor), return empty
      return [];
    }
  }

  /**
   * Gets list of untracked files in the repository.
   *
   * @returns Array of untracked file paths.
   */
  async getUntrackedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        'git ls-files --others --exclude-standard',
        {
          cwd: this.projectRoot,
        },
      );

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Gets list of modified files (staged and unstaged).
   *
   * @returns Array of modified file paths.
   */
  async getModifiedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('git diff --name-only HEAD', {
        cwd: this.projectRoot,
      });

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }
}
