/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentViewInputSnapshot } from './protocol.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 4_096;
const MAX_UNTRACKED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 32 * 1024 * 1024;

export async function captureAgentViewInputSnapshot(
  cwd: string,
): Promise<AgentViewInputSnapshot> {
  const rootOutput = await runGit(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
  ]);
  const root = await fs.realpath(rootOutput.trim());
  const head = await readHead(root);
  const indexEntries = await runGitBuffer(root, [
    'ls-files',
    '--stage',
    '-z',
    '--',
  ]);
  if (
    indexEntries
      .toString('utf8')
      .split('\0')
      .some((entry) => entry.startsWith('160000 '))
  ) {
    throw new Error(
      'Agent View coordination does not support repositories with Git submodules.',
    );
  }
  const staged = await runGitBuffer(root, [
    'diff',
    '--cached',
    '--binary',
    '--no-ext-diff',
    '--submodule=short',
    '--',
  ]);
  const unstaged = await runGitBuffer(root, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--submodule=short',
    '--',
  ]);
  const untrackedOutput = await runGitBuffer(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
  ]);
  const untrackedPaths = parseNulList(untrackedOutput);
  if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
    throw new Error(
      `Cannot snapshot checkout with more than ${MAX_UNTRACKED_FILES} untracked files.`,
    );
  }

  const hash = createHash('sha256');
  frame(hash, 'format', Buffer.from('qwen-agent-view-input-v1'));
  frame(hash, 'root', Buffer.from(root));
  frame(hash, 'head', Buffer.from(head));
  frame(hash, 'staged', staged);
  frame(hash, 'unstaged', unstaged);

  let untrackedBytes = 0;
  for (const relativePath of untrackedPaths.sort()) {
    const absolutePath = path.resolve(root, relativePath);
    if (!isWithin(root, absolutePath)) {
      throw new Error(`Untracked path escapes the repository: ${relativePath}`);
    }

    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `Untracked snapshot input must be a regular file: ${relativePath}`,
      );
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      throw new Error(
        `Untracked file exceeds ${MAX_UNTRACKED_FILE_BYTES} bytes: ${relativePath}`,
      );
    }
    untrackedBytes += stat.size;
    if (untrackedBytes > MAX_UNTRACKED_TOTAL_BYTES) {
      throw new Error(
        `Untracked files exceed ${MAX_UNTRACKED_TOTAL_BYTES} snapshot bytes.`,
      );
    }

    const realPath = await fs.realpath(absolutePath);
    if (!isWithin(root, realPath)) {
      throw new Error(
        `Untracked path resolves outside the repository: ${relativePath}`,
      );
    }
    const content = await fs.readFile(realPath);
    frame(hash, 'untracked-path', Buffer.from(relativePath));
    frame(hash, 'untracked-content', content);
  }

  return `sha256:${hash.digest('hex')}`;
}

export async function isAgentViewSnapshottedPath(
  repositoryRoot: string,
  candidatePath: string,
): Promise<boolean> {
  const root = await fs.realpath(repositoryRoot);
  const candidate = path.resolve(candidatePath);
  if (!isWithin(root, candidate)) return false;
  const relativePath = path.relative(root, candidate);
  if (!relativePath) return true;
  if (
    relativePath
      .split(path.sep)
      .some((segment) => segment.toLowerCase() === '.git')
  ) {
    return false;
  }
  try {
    await execFileAsync(
      'git',
      ['-C', root, 'check-ignore', '--quiet', '--', relativePath],
      { windowsHide: true },
    );
    return false;
  } catch (error) {
    if (isExitCode(error, 1)) return true;
    throw error;
  }
}

async function readHead(root: string): Promise<string> {
  try {
    return (await runGit(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  } catch {
    const inside = (
      await runGit(root, ['rev-parse', '--is-inside-work-tree'])
    ).trim();
    if (inside !== 'true') throw new Error(`${root} is not a Git worktree.`);
    return '<unborn>';
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

async function runGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function parseNulList(value: Buffer): string[] {
  if (value.length === 0) return [];
  return value
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    error instanceof Error && 'code' in error && Number(error.code) === code
  );
}

function frame(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: Buffer,
): void {
  hash.update(`${label.length}:${label}:${value.length}:`);
  hash.update(value);
  hash.update('\0');
}
