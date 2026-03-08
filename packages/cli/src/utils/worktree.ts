/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isCurrent: boolean;
}

export interface WorktreeSetupResult {
  worktreePath: string;
  branch: string;
  created: boolean;
}

/**
 * Resolves a path that may contain ~ or %USERPROFILE% to an absolute path
 */
export function expandHomeDir(p: string): string {
  if (!p) {
    return '';
  }
  let expandedPath = p;
  if (p.toLowerCase().startsWith('%userprofile%')) {
    expandedPath = homedir() + p.substring('%userprofile%'.length);
  } else if (p === '~' || p.startsWith('~/')) {
    expandedPath = homedir() + p.substring(1);
  }
  return path.normalize(expandedPath);
}

/**
 * Checks if a directory is a valid git repository
 */
export function isGitRepository(dir: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the current branch name
 */
export function getCurrentBranch(dir: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'HEAD';
  }
}

/**
 * Lists all worktrees for a git repository
 */
export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) {
          worktrees.push(current as WorktreeInfo);
        }
        current = { path: line.substring(9), isCurrent: false };
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring(7);
      } else if (line.startsWith('HEAD ')) {
        current.head = line.substring(5);
      } else if (line === '') {
        // Empty line marks end of a worktree entry
        if (current.path && current.branch) {
          worktrees.push(current as WorktreeInfo);
          current = {};
        }
      }
    }

    // Don't forget the last entry
    if (current.path && current.branch) {
      worktrees.push(current as WorktreeInfo);
    }

    // Mark the current worktree
    const currentWorktree = getCurrentWorktreePath(repoRoot);
    for (const wt of worktrees) {
      wt.isCurrent = wt.path === currentWorktree;
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Gets the path to the current worktree
 */
function getCurrentWorktreePath(repoRoot: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return repoRoot;
  }
}

/**
 * Creates a new worktree
 * @param repoRoot - The root of the git repository
 * @param worktreePath - The path where the worktree should be created
 * @param branch - The branch to create/check out in the worktree
 * @param createBranch - Whether to create a new branch
 * @returns The path to the created worktree
 */
export function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  createBranch: boolean = true,
): string {
  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    let cmd: string;
    if (createBranch) {
      // Create a new branch for the worktree
      cmd = `git worktree add -b "${branch}" "${worktreePath}"`;
    } else {
      // Check out existing branch
      cmd = `git worktree add "${worktreePath}" "${branch}"`;
    }

    execSync(cmd, { cwd: repoRoot, encoding: 'utf-8' });
    return worktreePath;
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to create worktree: ${err.message}`);
  }
}

/**
 * Removes a worktree
 */
export function removeWorktree(repoRoot: string, worktreePath: string): void {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
  } catch (error) {
    // Ignore errors during cleanup - worktree may already be removed
    const err = error as Error;
    if (!err.message.includes('not found')) {
      // Try to manually remove if git fails
      try {
        if (fs.existsSync(worktreePath)) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
      } catch {
        // Ignore manual removal errors too
      }
    }
  }
}

/**
 * Sets up a worktree for parallel session execution
 * This is the main entry point for the --worktree flag functionality
 *
 * @param repoRoot - The root of the git repository
 * @param worktreeName - Optional name for the worktree (auto-generated if not provided)
 * @param baseBranch - Optional base branch to create worktree from
 * @returns Information about the setup result
 */
export function setupWorktree(
  repoRoot: string,
  worktreeName?: string,
  _baseBranch?: string,
): WorktreeSetupResult {
  if (!isGitRepository(repoRoot)) {
    throw new Error(
      'Worktree functionality requires a git repository. Please initialize git first.',
    );
  }

  // Generate a unique worktree name if not provided
  const name = worktreeName || `worktree-${Date.now()}`;

  // Determine worktree base directory
  // Use .qwen/worktrees in the repo root, similar to Claude Code
  const worktreeBase = path.join(repoRoot, '.qwen', 'worktrees');
  if (!fs.existsSync(worktreeBase)) {
    fs.mkdirSync(worktreeBase, { recursive: true });
  }

  const worktreePath = path.join(worktreeBase, name);

  // Determine branch name
  const branchName = `worktree/${name}`;

  // Check if worktree already exists
  const existingWorktrees = listWorktrees(repoRoot);
  const existing = existingWorktrees.find((wt) => wt.path === worktreePath);

  if (existing) {
    // Worktree already exists, just return its info
    return {
      worktreePath,
      branch: existing.branch.replace('refs/heads/', ''),
      created: false,
    };
  }

  // Create the worktree
  createWorktree(repoRoot, worktreePath, branchName, true);

  return {
    worktreePath,
    branch: branchName,
    created: true,
  };
}

/**
 * Cleans up a worktree
 */
export function cleanupWorktree(repoRoot: string, worktreePath: string): void {
  removeWorktree(repoRoot, worktreePath);
}

/**
 * Gets the default worktree name based on current directory and timestamp
 */
export function generateWorktreeName(): string {
  const dirName = path.basename(process.cwd());
  const timestamp = Date.now().toString(36);
  return `${dirName}-${timestamp}`;
}
