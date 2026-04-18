/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isCommandAvailable } from '../utils/shell-utils.js';
import type { SimpleGit } from 'simple-git';
import { simpleGit, CheckRepoActions } from 'simple-git';
import type { Storage } from '../config/storage.js';
import { isNodeError } from '../utils/errors.js';
import { initRepositoryWithMainBranch } from './gitInit.js';

export interface SnapshotFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface RestoreProjectOptions {
  untrackedPathsToDelete?: string[];
}

function countTextLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split(/\r?\n/).length;
  return content.endsWith('\n') ? lines - 1 : lines;
}

function isLikelyBinary(content: Buffer): boolean {
  if (content.includes(0)) {
    return true;
  }

  const text = content.toString('utf8');
  let replacementChars = 0;
  for (const char of text) {
    if (char === '\uFFFD') {
      replacementChars++;
    }
  }

  return replacementChars > Math.max(1, text.length * 0.01);
}

const MAX_UNTRACKED_FILE_LINE_COUNT_BYTES = 1024 * 1024;

async function countUntrackedFileAdditions(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size > MAX_UNTRACKED_FILE_LINE_COUNT_BYTES) {
    return 0;
  }

  const content = await fs.readFile(filePath);
  if (isLikelyBinary(content)) {
    return 0;
  }

  return countTextLines(content.toString('utf8'));
}

function resolveProjectRelativePath(
  projectRoot: string,
  relativePath: string,
): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return undefined;
  }

  const absolutePath = path.resolve(projectRoot, relativePath);
  const pathWithinProject = path.relative(projectRoot, absolutePath);
  if (
    pathWithinProject === '' ||
    pathWithinProject.startsWith('..') ||
    path.isAbsolute(pathWithinProject)
  ) {
    return undefined;
  }

  return absolutePath;
}

async function snapshotContainsPath(
  repo: SimpleGit,
  commitHash: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await repo.raw('cat-file', '-e', `${commitHash}:${relativePath}`);
    return true;
  } catch {
    return false;
  }
}

export class GitService {
  private projectRoot: string;
  private storage: Storage;

  constructor(projectRoot: string, storage: Storage) {
    this.projectRoot = path.resolve(projectRoot);
    this.storage = storage;
  }

  private getHistoryDir(): string {
    return this.storage.getHistoryDir();
  }

  async initialize(): Promise<void> {
    const { available: gitAvailable } = isCommandAvailable('git');
    if (!gitAvailable) {
      throw new Error(
        'Checkpointing is enabled, but Git is not installed. Please install Git or disable checkpointing to continue.',
      );
    }
    try {
      await this.setupShadowGitRepository();
    } catch (error) {
      throw new Error(
        `Failed to initialize checkpointing: ${error instanceof Error ? error.message : 'Unknown error'}. Please check that Git is working properly or disable checkpointing.`,
      );
    }
  }

  /**
   * Creates a hidden git repository in the project root.
   * The Git repository is used to support checkpointing.
   */
  async setupShadowGitRepository() {
    const repoDir = this.getHistoryDir();
    const gitConfigPath = path.join(repoDir, '.gitconfig');

    await fs.mkdir(repoDir, { recursive: true });

    // We don't want to inherit the user's name, email, or gpg signing
    // preferences for the shadow repository, so we create a dedicated gitconfig.
    const gitConfigContent =
      '[user]\n  name = Qwen Code\n  email = qwen-code@qwen.ai\n[commit]\n  gpgsign = false\n';
    await fs.writeFile(gitConfigPath, gitConfigContent);

    const repo = simpleGit(repoDir).env({
      // Prevent git from using the user's global git config.
      HOME: repoDir,
      XDG_CONFIG_HOME: repoDir,
    });
    let isRepoDefined = false;
    try {
      isRepoDefined = await repo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
    } catch {
      // Some Git/simple-git combinations throw for non-repo directories
      // instead of returning false. Treat that as "not initialized yet".
      isRepoDefined = false;
    }

    if (!isRepoDefined) {
      await initRepositoryWithMainBranch(repo);
      await repo.commit('Initial commit', { '--allow-empty': null });
    }

    const userGitIgnorePath = path.join(this.projectRoot, '.gitignore');
    const shadowGitIgnorePath = path.join(repoDir, '.gitignore');

    let userGitIgnoreContent = '';
    try {
      userGitIgnoreContent = await fs.readFile(userGitIgnorePath, 'utf-8');
    } catch (error) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.writeFile(shadowGitIgnorePath, userGitIgnoreContent);

    await this.ensureBaselineSnapshot();
  }

  private async ensureBaselineSnapshot(): Promise<void> {
    const repo = this.shadowGitRepository;

    let headTreeEntries = '';
    try {
      headTreeEntries = await repo.raw('ls-tree', '-r', '--name-only', 'HEAD');
    } catch {
      headTreeEntries = '';
    }

    if (headTreeEntries.trim().length > 0) {
      return;
    }

    await repo.add('.');
    try {
      await repo.commit('Initial snapshot');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('nothing to commit')) {
        await repo.commit('Initial commit', { '--allow-empty': null });
      } else {
        throw error;
      }
    }
  }

  private get shadowGitRepository(): SimpleGit {
    const repoDir = this.getHistoryDir();
    return simpleGit(this.projectRoot).env({
      GIT_DIR: path.join(repoDir, '.git'),
      GIT_WORK_TREE: this.projectRoot,
      // Prevent git from using the user's global git config.
      HOME: repoDir,
      XDG_CONFIG_HOME: repoDir,
    });
  }

  async getCurrentCommitHash(): Promise<string> {
    const hash = await this.shadowGitRepository.raw('rev-parse', 'HEAD');
    return hash.trim();
  }

  async createFileSnapshot(message: string): Promise<string> {
    try {
      const repo = this.shadowGitRepository;
      await repo.add('.');
      const commitResult = await repo.commit(message);
      return commitResult.commit;
    } catch (error) {
      throw new Error(
        `Failed to create checkpoint snapshot: ${error instanceof Error ? error.message : 'Unknown error'}. Checkpointing may not be working properly.`,
      );
    }
  }

  async restoreProjectFromSnapshot(
    commitHash: string,
    options: RestoreProjectOptions = {},
  ): Promise<void> {
    const repo = this.shadowGitRepository;
    await repo.raw(['restore', '--source', commitHash, '.']);

    const untrackedPathsToDelete = options.untrackedPathsToDelete ?? [];
    if (untrackedPathsToDelete.length === 0) {
      return;
    }

    for (const relativePath of new Set(untrackedPathsToDelete)) {
      const absolutePath = resolveProjectRelativePath(
        this.projectRoot,
        relativePath,
      );
      if (!absolutePath) {
        continue;
      }

      if (await snapshotContainsPath(repo, commitHash, relativePath)) {
        continue;
      }

      await fs.rm(absolutePath, { recursive: true, force: true });
    }
  }

  async getSnapshotDiffSummary(
    commitHash: string,
    targetCommitHash?: string,
  ): Promise<SnapshotFileChange[]> {
    const repo = this.shadowGitRepository;
    const diffArgs = ['diff', '--numstat', commitHash];
    if (targetCommitHash) {
      diffArgs.push(targetCommitHash);
    }
    diffArgs.push('--');
    const diffOutput = await repo.raw(...diffArgs);
    const changes = new Map<string, SnapshotFileChange>();

    for (const line of diffOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const [rawAdditions, rawDeletions, ...pathParts] = trimmed.split('\t');
      const filePath = pathParts.join('\t').trim();
      if (!filePath) {
        continue;
      }

      changes.set(filePath, {
        path: filePath,
        additions: rawAdditions === '-' ? 0 : Number(rawAdditions) || 0,
        deletions: rawDeletions === '-' ? 0 : Number(rawDeletions) || 0,
      });
    }

    if (!targetCommitHash) {
      const untrackedOutput = await repo.raw(
        'ls-files',
        '--others',
        '--exclude-standard',
      );
      for (const relativePath of untrackedOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (changes.has(relativePath)) {
          continue;
        }

        const absolutePath = path.join(this.projectRoot, relativePath);
        let additions = 0;
        try {
          additions = await countUntrackedFileAdditions(absolutePath);
        } catch (error) {
          if (
            !isNodeError(error) ||
            (error.code !== 'ENOENT' && error.code !== 'EISDIR')
          ) {
            throw error;
          }
        }

        changes.set(relativePath, {
          path: relativePath,
          additions,
          deletions: 0,
        });
      }
    }

    return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
}
