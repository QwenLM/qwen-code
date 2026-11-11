/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  internalGitArgs,
  internalGitEnv,
  resolveGitRepositoryLayout,
} from '@qwen-code/core';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runLogger } from '@qwen-code/core';

export interface DiffFile {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  isBinary: boolean;
  isNewFile: boolean;
  isUntracked: boolean;
  isTruncated?: boolean;
}

/** Maximum number of diff lines per file to avoid performance issues. */
export const MAX_LINES_PER_FILE = 400;

/**
 * Fetches the list of files with changes.
 * Combines unstaged changes (git diff HEAD), staged changes (git diff --cached),
 * and untracked files (git ls-files --others).
 */
export function fetchGitDiffFiles(): DiffFile[] {
  try {
    // Collect all changed paths with their stats, merging staged + unstaged
    const fileMap = new Map<string, DiffFile>();

    // Helper: parse numstat output and merge into fileMap.
    // When newFiles is provided, only paths in that set are marked as new.
    // When forceNewFile is true, all paths are marked as new.
    const parseAndMerge = (
      output: string,
      opts: { forceNewFile?: boolean; newFiles?: Set<string> } = {},
    ) => {
      const lines = output.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const path = parts[2];
          const isBinary = parts[0] === '-' && parts[1] === '-';
          const linesAdded = isBinary ? 0 : parseInt(parts[0], 10) || 0;
          const linesRemoved = isBinary ? 0 : parseInt(parts[1], 10) || 0;
          const isNewFile =
            opts.forceNewFile ||
            opts.newFiles?.has(path) ||
            (linesAdded > 0 && linesRemoved === 0);

          const existing = fileMap.get(path);
          if (existing) {
            existing.linesAdded += linesAdded;
            existing.linesRemoved += linesRemoved;
            if (isNewFile) existing.isNewFile = true;
          } else {
            fileMap.set(path, {
              path,
              linesAdded,
              linesRemoved,
              isBinary,
              isNewFile,
              isUntracked: false,
            });
          }
        }
      }
    };

    // 1. Unstaged changes (modified tracked files)
    try {
      const unstagedOutput = git(['diff', 'HEAD', '--numstat']);
      parseAndMerge(unstagedOutput);
    } catch {
      // Ignore if HEAD doesn't exist yet (empty repo)
    }

    // 2. Staged changes (git add'd files not yet committed)
    try {
      const stagedOutput = git(['diff', '--cached', '--numstat']);
      const nameStatusOutput = git(['diff', '--cached', '--name-status']);
      const stagedNewFiles = new Set<string>();
      for (const line of nameStatusOutput.trim().split('\n').filter(Boolean)) {
        const [status, filePath] = line.split('\t');
        if (status === 'A' && filePath) {
          stagedNewFiles.add(filePath);
        }
      }
      parseAndMerge(stagedOutput, { newFiles: stagedNewFiles });
    } catch {
      // Ignore errors from cached diff
    }

    const files: DiffFile[] = Array.from(fileMap.values());

    // 3. Untracked files
    try {
      const untrackedOutput = git(
        ['ls-files', '--others', '--exclude-standard'],
      );

      const untrackedLines = untrackedOutput.trim().split('\n').filter(Boolean);
      for (const path of untrackedLines) {
        if (!fileMap.has(path)) {
          files.push({
            path,
            linesAdded: 0,
            linesRemoved: 0,
            isBinary: false,
            isNewFile: true,
            isUntracked: true,
          });
        }
      }
    } catch {
      // Ignore errors from untracked listing
    }

    return files;
  } catch (error) {
    runLogger.debug('Failed to fetch git diff files:', error);
    return [];
  }
}

/**
 * Builds a synthetic unified diff from file content (new-file scenario),
 * pre-truncated to MAX_LINES_PER_FILE to avoid O(file_size) allocations.
 */
function buildSyntheticDiffTruncated(
  filePath: string,
  content: string,
): { diffString: string; truncated: boolean } {
  const lines = content.split('\n');
  const limit = Math.min(lines.length, MAX_LINES_PER_FILE);
  const truncated = lines.length > MAX_LINES_PER_FILE;
  const body = lines
    .slice(0, limit)
    .map((l) => `+${l}`)
    .join('\n');
  return {
    diffString: `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
    truncated,
  };
}

/**
 * Truncates a unified diff string so that at most MAX_LINES_PER_FILE content
 * lines (non-header) are kept. Header lines (diff, index, ---, +++, @@) are
 * always preserved.
 */
function truncateDiffString(diff: string): {
  diffString: string;
  truncated: boolean;
} {
  const lines = diff.split('\n');
  let contentLines = 0;
  const result: string[] = [];
  for (const line of lines) {
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@ ')
    ) {
      result.push(line);
      continue;
    }
    if (contentLines >= MAX_LINES_PER_FILE) {
      return { diffString: result.join('\n'), truncated: true };
    }
    result.push(line);
    contentLines++;
  }
  return { diffString: result.join('\n'), truncated: false };
}

// Internal reads must not execute repository-selected fsmonitor helpers.
function git(
  args: string[],
  options: Pick<ExecFileSyncOptions, 'stdio' | 'timeout' | 'maxBuffer'> = {},
): string {
  return execFileSync('git', [...internalGitArgs(), ...args], {
    ...options,
    shell: false,
    env: internalGitEnv(),
    encoding: 'utf-8',
    cwd: process.cwd(),
  });
}

/**
 * Resolves the raw unified diff string for a file using a 4-tier fallback:
 * 1. Unstaged diff (git diff HEAD -- file)
 * 2. Staged diff (git diff --cached -- file)
 * 3. Staged new file (git show :file → synthetic diff)
 * 4. Untracked file (readFileSync → synthetic diff)
 *
 * Returns null if no diff could be obtained.
 */
type RawDiffResult =
  | { kind: 'real'; raw: string }
  | { kind: 'synthetic'; filePath: string; content: string }
  | null;

function resolveRawDiff(filePath: string): RawDiffResult {
  // 1. Unstaged diff
  try {
    const unstaged = git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
      filePath,
    ]);
    if (unstaged.trim()) return { kind: 'real', raw: unstaged };
  } catch {
    // No HEAD (empty repo) — fall through
  }

  // 2. Staged diff
  try {
    const staged = git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--cached',
      '--',
      filePath,
    ]);
    if (staged.trim()) return { kind: 'real', raw: staged };
  } catch {
    // Ignore
  }

  // 3. Staged new file
  try {
    const content = git(['show', `:${filePath}`]);
    return { kind: 'synthetic', filePath, content };
  } catch {
    // Not in index
  }

  // 4. Untracked file
  try {
    const content = readFileSync(resolve(process.cwd(), filePath), 'utf-8');
    return { kind: 'synthetic', filePath, content };
  } catch {
    // Cannot read file
  }

  return null;
}

/**
 * Fetches the raw unified diff string for a specific file.
 * Returns { diffString, truncated } — content is capped at MAX_LINES_PER_FILE.
 */
export function fetchGitDiffString(filePath: string): {
  diffString: string;
  truncated: boolean;
} {
  try {
    const result = resolveRawDiff(filePath);
    if (!result) return { diffString: '', truncated: false };
    if (result.kind === 'real') return truncateDiffString(result.raw);
    return buildSyntheticDiffTruncated(result.filePath, result.content);
  } catch (error) {
    runLogger.debug(`Failed to fetch diff string for ${filePath}:`, error);
    return { diffString: '', truncated: false };
  }
}

/**
 * Checks if we're in a git repository
 */
export async function isGitRepository(cwd = process.cwd()): Promise<boolean> {
  return (await resolveGitRepositoryLayout(cwd)) !== null;
}
