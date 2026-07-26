/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isValidGitSha, isValidRefName } from './gitDirect.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MAX_RECENT_BRANCHES = 20;
const MAX_REFLOG_ENTRIES = 200;

export interface GitBranchInfo {
  name: string;
  isHead: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Unix epoch seconds of the branch tip commit. */
  commitDate: number;
  commitSubject: string;
}

export interface GitTagInfo {
  name: string;
  /** Unix epoch seconds of the tag (annotated) or tagged commit (lightweight). */
  date: number;
  subject: string;
}

export interface GitBranchesResult {
  local: GitBranchInfo[];
  remote: GitBranchInfo[];
  tags: GitTagInfo[];
  recent: string[];
  head: string;
  detached: boolean;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

const SEPARATOR = '\x00';

/**
 * List all local branches, remote branches, tags, and recent branches for
 * the repository at `cwd`. Uses `git for-each-ref` for structured output and
 * `git reflog` for recency.
 */
export async function fetchGitBranches(
  cwd: string,
): Promise<GitBranchesResult> {
  const [localRaw, remoteRaw, tagsRaw, headRaw, reflogRaw] = await Promise.all([
    runGit(cwd, [
      'for-each-ref',
      '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)',
      'refs/heads/',
    ]).catch(() => ''),
    runGit(cwd, [
      'for-each-ref',
      '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)',
      'refs/remotes/',
    ]).catch(() => ''),
    runGit(cwd, [
      'for-each-ref',
      '--format=%(refname:short)%00%(creatordate:unix)%00%(subject)',
      '--sort=-creatordate',
      'refs/tags/',
    ]).catch(() => ''),
    runGit(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(() => ''),
    execFileAsync(
      'git',
      ['reflog', 'show', '--format=%gs', `-${MAX_REFLOG_ENTRIES}`],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
    )
      .then(({ stdout }) => stdout)
      .catch(() => ''),
  ]);

  const local = parseBranchLines(localRaw);
  const remote = parseBranchLines(remoteRaw);
  const tags = parseTagLines(tagsRaw);
  const recent = parseRecentBranches(reflogRaw, headRaw.trim());

  const headTrimmed = headRaw.trim();
  const detached = !headTrimmed;

  return {
    local,
    remote,
    tags,
    recent,
    head: headTrimmed || (await getDetachedHead(cwd)),
    detached,
  };
}

function parseBranchLines(raw: string): GitBranchInfo[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.split(SEPARATOR)[0]?.endsWith('/HEAD'))
    .map((line) => {
      const parts = line.split(SEPARATOR);
      const name = parts[0] ?? '';
      const isHead = parts[1] === '*';
      const upstream = parts[2] || undefined;
      const track = parts[3] ?? '';
      const commitDate = parseInt(parts[4] ?? '0', 10) || 0;
      const commitSubject = parts[5] ?? '';

      let ahead = 0;
      let behind = 0;
      const aheadMatch = /ahead (\d+)/.exec(track);
      const behindMatch = /behind (\d+)/.exec(track);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);

      return {
        name,
        isHead,
        upstream,
        ahead,
        behind,
        commitDate,
        commitSubject,
      };
    });
}

function parseTagLines(raw: string): GitTagInfo[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(SEPARATOR);
      return {
        name: parts[0] ?? '',
        date: parseInt(parts[1] ?? '0', 10) || 0,
        subject: parts[2] ?? '',
      };
    });
}

function parseRecentBranches(reflogRaw: string, currentHead: string): string[] {
  if (!reflogRaw.trim()) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of reflogRaw.trim().split('\n')) {
    // reflog messages for checkouts look like:
    //   "checkout: moving from X to Y"
    const match = /^checkout: moving from .+ to (.+)$/.exec(line);
    if (!match) continue;
    const branch = match[1];
    if (
      branch &&
      !seen.has(branch) &&
      branch !== currentHead &&
      !/^[0-9a-f]{7,40}$/.test(branch)
    ) {
      seen.add(branch);
      result.push(branch);
      if (result.length >= MAX_RECENT_BRANCHES) break;
    }
  }
  return result;
}

async function getDetachedHead(cwd: string): Promise<string> {
  try {
    const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    return sha.trim();
  } catch {
    return '';
  }
}

/**
 * Whether `value` is safe to pass to git as a checkout target or branch start
 * point: a plausible ref name (branch, tag, or short/full SHA) that cannot be
 * mistaken for a git option (`-f`, `--patch`, `--output=…`) or a pathspec (`.`)
 * that `git checkout` would act on destructively.
 */
export function isValidCheckoutRef(value: string): boolean {
  const ref = value.trim();
  if (!ref || ref.startsWith('-')) return false;
  // 'HEAD' is a valid checkout target/start point even though
  // isValidRefName rejects it as a branch name.
  if (ref === 'HEAD') return true;
  return isValidRefName(ref) || isValidGitSha(ref);
}

export interface GitCheckoutResult {
  branch: string;
  detached: boolean;
}

/**
 * Checkout a branch, tag, or revision. Returns the resulting HEAD state.
 * Throws on dirty tree or invalid ref.
 */
export async function gitCheckout(
  cwd: string,
  ref: string,
): Promise<GitCheckoutResult> {
  if (!isValidCheckoutRef(ref)) {
    throw new Error(`invalid checkout ref: ${ref}`);
  }
  // `--` terminates options/pathspecs so a validated ref can never be
  // reinterpreted as a path (e.g. `.` wiping the working tree).
  await runGit(cwd, ['checkout', ref, '--']);
  const headRaw = await runGit(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(
    () => '',
  );
  const trimmed = headRaw.trim();
  if (trimmed) {
    return { branch: trimmed, detached: false };
  }
  const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  return { branch: sha.trim(), detached: true };
}

/**
 * Create a new branch and check it out. Throws if the branch already exists
 * or the working tree is dirty.
 */
export async function gitCreateBranch(
  cwd: string,
  name: string,
  startPoint?: string,
): Promise<GitCheckoutResult> {
  if (!isValidRefName(name) || name.startsWith('-')) {
    throw new Error(`invalid branch name: ${name}`);
  }
  const args = ['checkout', '-b', name];
  if (startPoint) {
    if (!isValidCheckoutRef(startPoint)) {
      throw new Error(`invalid start point: ${startPoint}`);
    }
    args.push(startPoint);
  }
  args.push('--');
  await runGit(cwd, args);
  return { branch: name, detached: false };
}

export interface GitPushResult {
  success: boolean;
  output: string;
}

/**
 * Push the current branch. If `setUpstream` is true and no upstream is
 * configured, uses `--set-upstream origin <branch>`.
 */
export async function gitPush(
  cwd: string,
  opts?: { setUpstream?: boolean; force?: boolean },
): Promise<GitPushResult> {
  const args = ['push'];
  if (opts?.force) args.push('--force-with-lease');
  if (opts?.setUpstream) {
    const branch = (
      await runGit(cwd, ['symbolic-ref', '--short', 'HEAD'])
    ).trim();
    args.push('--set-upstream', 'origin', branch);
  }
  const output = await runGit(cwd, args);
  return { success: true, output: output.trim() };
}

export interface GitPullResult {
  success: boolean;
  output: string;
}

/**
 * Pull (fetch + merge) or fetch-only from the remote.
 */
export async function gitPull(
  cwd: string,
  opts?: { rebase?: boolean; fetchOnly?: boolean },
): Promise<GitPullResult> {
  if (opts?.fetchOnly) {
    const output = await runGit(cwd, ['fetch', '--all', '--prune']);
    return { success: true, output: output.trim() };
  }
  const args = ['pull'];
  if (opts?.rebase) args.push('--rebase');
  const output = await runGit(cwd, args);
  return { success: true, output: output.trim() };
}

export interface GitCommitResult {
  sha: string;
  subject: string;
}

/**
 * Commit staged changes (or all tracked changes with `all: true`).
 */
export async function gitCommit(
  cwd: string,
  message: string,
  opts?: { all?: boolean },
): Promise<GitCommitResult> {
  const args = ['commit', '-m', message];
  if (opts?.all) args.push('-a');
  await runGit(cwd, args);
  const sha = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
  const subject = (await runGit(cwd, ['log', '-1', '--format=%s'])).trim();
  return { sha, subject };
}
