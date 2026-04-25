/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

export type DesktopGitChangeSource = 'staged' | 'unstaged' | 'untracked';

export interface DesktopGitDiffHunk {
  id: string;
  source: DesktopGitChangeSource;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DesktopGitChangedFile {
  path: string;
  status: DesktopGitChangeStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  diff: string;
  hunks: DesktopGitDiffHunk[];
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
  scope: 'all' | 'file' | 'hunk';
  filePath?: string;
  hunkId?: string;
}

interface ParsedGitDiffHunk extends DesktopGitDiffHunk {
  patch: string;
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

    if (target.scope === 'hunk') {
      const hunk = await getSafeHunkPatch(projectPath, target);
      if (hunk.source === 'staged') {
        return;
      }

      await runGitWithInput(
        projectPath,
        ['apply', '--cached', '--recount', '--whitespace=nowarn'],
        hunk.patch,
      );
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

    if (target.scope === 'hunk') {
      const hunk = await getSafeHunkPatch(projectPath, target);
      if (hunk.source === 'staged') {
        await runGitWithInput(
          projectPath,
          [
            'apply',
            '--cached',
            '--reverse',
            '--recount',
            '--whitespace=nowarn',
          ],
          hunk.patch,
        );
      }

      await runGitWithInput(
        projectPath,
        ['apply', '--reverse', '--recount', '--whitespace=nowarn'],
        hunk.patch,
      );
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
  const diffParts: Array<{
    source: DesktopGitChangeSource;
    diff: string;
  }> = [
    { source: 'staged', diff: cachedDiff },
    { source: untracked ? 'untracked' : 'unstaged', diff: worktreeDiff },
    { source: 'untracked', diff: untrackedDiff },
  ];
  const diff = diffParts
    .map((part) => part.diff)
    .filter((part) => part.length > 0)
    .join('\n');
  const hunks = diffParts.flatMap((part) =>
    parseDiffHunks(entry.path, part.source, part.diff),
  );

  return {
    path: entry.path,
    status: getChangeStatus(entry),
    staged: entry.indexStatus !== ' ' && entry.indexStatus !== '?',
    unstaged: entry.worktreeStatus !== ' ' && entry.worktreeStatus !== '?',
    untracked,
    diff,
    hunks: hunks.map(({ patch: _patch, ...hunk }) => hunk),
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
    const content = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const lines = content.length > 0 ? content.split(/\r?\n/u) : [];
    const additions = lines.map((line) => `+${line}`).join('\n');
    return [
      `diff --git a/${safePath} b/${safePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${safePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      additions,
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  } catch {
    return `diff unavailable for untracked file ${safePath}`;
  }
}

async function getSafeHunkPatch(
  projectPath: string,
  target: DesktopGitTarget,
): Promise<ParsedGitDiffHunk> {
  const filePath = getSafeRelativePath(projectPath, target);
  const hunkId = getRequiredHunkId(target);
  const statusEntries = await getPorcelainStatus(projectPath);
  const entry = statusEntries.find((candidate) => candidate.path === filePath);

  if (!entry) {
    throw new DesktopHttpError(
      404,
      'git_hunk_not_found',
      'The requested Git hunk is no longer available.',
    );
  }

  const file = await describeChangedFileWithPatches(projectPath, entry);
  const hunk = file.hunks.find((candidate) => candidate.id === hunkId);
  if (!hunk) {
    throw new DesktopHttpError(
      404,
      'git_hunk_not_found',
      'The requested Git hunk is no longer available.',
    );
  }

  return hunk;
}

async function describeChangedFileWithPatches(
  projectPath: string,
  entry: PorcelainStatusEntry,
): Promise<{
  path: string;
  hunks: ParsedGitDiffHunk[];
}> {
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

  return {
    path: entry.path,
    hunks: [
      ...parseDiffHunks(entry.path, 'staged', cachedDiff),
      ...parseDiffHunks(
        entry.path,
        untracked ? 'untracked' : 'unstaged',
        worktreeDiff,
      ),
      ...parseDiffHunks(entry.path, 'untracked', untrackedDiff),
    ],
  };
}

function parseDiffHunks(
  filePath: string,
  source: DesktopGitChangeSource,
  diff: string,
): ParsedGitDiffHunk[] {
  if (!diff.trim()) {
    return [];
  }

  const normalizedDiff = diff.endsWith('\n') ? diff.slice(0, -1) : diff;
  const lines = normalizedDiff.split('\n');
  const headerLines: string[] = [];
  const hunks: ParsedGitDiffHunk[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (current) {
        pushParsedHunk(filePath, source, headerLines, current, hunks);
      }
      current = [line];
      continue;
    }

    if (current) {
      current.push(line);
    } else if (line.length > 0) {
      headerLines.push(line);
    }
  }

  if (current) {
    pushParsedHunk(filePath, source, headerLines, current, hunks);
  }

  return hunks;
}

function pushParsedHunk(
  filePath: string,
  source: DesktopGitChangeSource,
  headerLines: string[],
  hunkLines: string[],
  hunks: ParsedGitDiffHunk[],
): void {
  const header = hunkLines[0] ?? '';
  const range = parseHunkRange(header);
  if (!range) {
    return;
  }

  const ordinal = hunks.length;
  const patch = `${[...headerLines, ...hunkLines].join('\n')}\n`;
  hunks.push({
    id: createHunkId(filePath, source, ordinal, hunkLines),
    source,
    header,
    ...range,
    lines: hunkLines.slice(1),
    patch,
  });
}

function parseHunkRange(
  header: string,
): Omit<DesktopGitDiffHunk, 'id' | 'source' | 'header' | 'lines'> | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(header);
  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function createHunkId(
  filePath: string,
  source: DesktopGitChangeSource,
  ordinal: number,
  hunkLines: string[],
): string {
  return createHash('sha256')
    .update(`${source}\0${filePath}\0${ordinal}\0${hunkLines.join('\n')}`)
    .digest('hex')
    .slice(0, 16);
}

function getSafeRelativePath(
  projectPath: string,
  target: DesktopGitTarget,
): string {
  if (
    (target.scope !== 'file' && target.scope !== 'hunk') ||
    !target.filePath?.trim()
  ) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'filePath is required for file or hunk-scoped Git review operations.',
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

function getRequiredHunkId(target: DesktopGitTarget): string {
  if (target.scope !== 'hunk' || !target.hunkId?.trim()) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'hunkId is required for hunk-scoped Git review operations.',
    );
  }

  return target.hunkId;
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

function runGitWithInput(
  cwd: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 20_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new DesktopHttpError(400, 'git_error', error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new DesktopHttpError(
            400,
            'git_error',
            timedOut
              ? 'Git review operation timed out.'
              : stderr.trim() || `git exited with status ${code ?? 'unknown'}`,
          ),
        );
        return;
      }

      resolve(stdout);
    });
    child.stdin.end(input);
  });
}
