/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { DesktopHttpError } from '../http/errors.js';

export type DesktopGitChangeStatus =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'untracked'
  | 'unknown';

export interface DesktopGitChangedFile {
  path: string;
  status: DesktopGitChangeStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  diff: string;
}

export interface DesktopGitDiff {
  ok: true;
  files: DesktopGitChangedFile[];
  diff: string;
  generatedAt: string;
}

export interface DesktopGitCommitResult {
  commit: string;
  summary: string;
}

export interface DesktopGitTarget {
  scope: 'all' | 'file';
  filePath?: string;
}

export class DesktopGitReviewService {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async getDiff(projectPath: string): Promise<DesktopGitDiff> {
    const statusEntries = await getPorcelainStatus(projectPath);
    const files = await Promise.all(
      statusEntries.map((entry) => describeChangedFile(projectPath, entry)),
    );
    const diff = files
      .map((file) => file.diff)
      .filter((fileDiff) => fileDiff.length > 0)
      .join('\n');

    return {
      ok: true,
      files,
      diff,
      generatedAt: this.now().toISOString(),
    };
  }

  async stage(projectPath: string, target: DesktopGitTarget): Promise<void> {
    if (target.scope === 'all') {
      await runGit(projectPath, ['add', '-A']);
      return;
    }

    await runGit(projectPath, [
      'add',
      '--',
      getSafeRelativePath(projectPath, target),
    ]);
  }

  async revert(projectPath: string, target: DesktopGitTarget): Promise<void> {
    if (target.scope === 'all') {
      await runGitIgnoringFailure(projectPath, ['restore', '--staged', '.']);
      await runGitIgnoringFailure(projectPath, ['restore', '.']);
      await runGit(projectPath, ['clean', '-fd']);
      return;
    }

    const filePath = getSafeRelativePath(projectPath, target);
    await runGitIgnoringFailure(projectPath, [
      'restore',
      '--staged',
      '--',
      filePath,
    ]);
    await runGitIgnoringFailure(projectPath, ['restore', '--', filePath]);
    await runGit(projectPath, ['clean', '-fd', '--', filePath]);
  }

  async commit(
    projectPath: string,
    message: string,
  ): Promise<DesktopGitCommitResult> {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new DesktopHttpError(
        400,
        'bad_request',
        'Commit message must be a non-empty string.',
      );
    }

    const summary = await runGit(projectPath, ['commit', '-m', trimmedMessage]);
    const commit = (await runGit(projectPath, ['rev-parse', 'HEAD'])).trim();
    return { commit, summary };
  }
}

interface PorcelainStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

async function getPorcelainStatus(
  projectPath: string,
): Promise<PorcelainStatusEntry[]> {
  const stdout = await runGit(projectPath, ['status', '--porcelain=v1', '-z']);
  const records = stdout.split('\0').filter((record) => record.length > 0);
  const entries: PorcelainStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    const filePath = record.slice(3);
    entries.push({
      path: filePath,
      indexStatus,
      worktreeStatus,
    });

    if (
      (indexStatus === 'R' || indexStatus === 'C') &&
      records[index + 1] !== undefined
    ) {
      index += 1;
    }
  }

  return entries;
}

async function describeChangedFile(
  projectPath: string,
  entry: PorcelainStatusEntry,
): Promise<DesktopGitChangedFile> {
  const untracked = entry.indexStatus === '?' && entry.worktreeStatus === '?';
  const [cachedDiff, worktreeDiff, untrackedDiff] = await Promise.all([
    untracked
      ? Promise.resolve('')
      : runGit(projectPath, ['diff', '--cached', '--', entry.path]),
    untracked
      ? Promise.resolve('')
      : runGit(projectPath, ['diff', '--', entry.path]),
    untracked
      ? createUntrackedFileDiff(projectPath, entry.path)
      : Promise.resolve(''),
  ]);
  const diff = [cachedDiff, worktreeDiff, untrackedDiff]
    .filter((part) => part.length > 0)
    .join('\n');

  return {
    path: entry.path,
    status: getChangeStatus(entry),
    staged: entry.indexStatus !== ' ' && entry.indexStatus !== '?',
    unstaged: entry.worktreeStatus !== ' ' && entry.worktreeStatus !== '?',
    untracked,
    diff,
  };
}

function getChangeStatus(entry: PorcelainStatusEntry): DesktopGitChangeStatus {
  if (entry.indexStatus === '?' && entry.worktreeStatus === '?') {
    return 'untracked';
  }

  const status =
    entry.worktreeStatus !== ' ' ? entry.worktreeStatus : entry.indexStatus;
  if (status === 'A') {
    return 'added';
  }
  if (status === 'C') {
    return 'copied';
  }
  if (status === 'D') {
    return 'deleted';
  }
  if (status === 'M' || status === 'T') {
    return 'modified';
  }
  if (status === 'R') {
    return 'renamed';
  }

  return 'unknown';
}

async function createUntrackedFileDiff(
  projectPath: string,
  relativePath: string,
): Promise<string> {
  const safePath = getSafeRelativePath(projectPath, {
    scope: 'file',
    filePath: relativePath,
  });
  try {
    const raw = await readFile(`${projectPath}${sep}${safePath}`, 'utf8');
    const additions = raw
      .split(/\r?\n/u)
      .map((line) => `+${line}`)
      .join('\n');
    return [
      `diff --git a/${safePath} b/${safePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${safePath}`,
      '@@',
      additions,
    ].join('\n');
  } catch {
    return `diff unavailable for untracked file ${safePath}`;
  }
}

function getSafeRelativePath(
  projectPath: string,
  target: DesktopGitTarget,
): string {
  if (target.scope !== 'file' || !target.filePath?.trim()) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'filePath is required for file-scoped Git review operations.',
    );
  }

  const normalized = normalize(target.filePath);
  if (
    isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'filePath must stay inside the project.',
    );
  }

  const relativePath = relative(
    projectPath,
    `${projectPath}${sep}${normalized}`,
  );
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'filePath must stay inside the project.',
    );
  }

  return normalized;
}

async function runGitIgnoringFailure(
  cwd: string,
  args: string[],
): Promise<void> {
  try {
    await runGit(cwd, args);
  } catch {
    // Reverting untracked or unstaged paths can legitimately fail. The
    // following clean/restore step decides the final result.
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        maxBuffer: 1024 * 1024 * 8,
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message;
          reject(new DesktopHttpError(400, 'git_error', message));
          return;
        }

        resolve(stdout);
      },
    );
  });
}
