/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `.worktreeinclude` support in
 * `GitWorktreeService.setupWorktrees()` (Phase D-4).
 *
 * Real git + real `fs` against a temp repo: the unit-test file mocks
 * simple-git too heavily to exercise the `git ls-files` listing the
 * resolve step is built on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  WORKTREE_INCLUDE_FILE,
  listIgnoredFiles,
  parseWorktreeInclude,
} from './gitWorktreeService.js';

const exists = (p: string) =>
  fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);

const read = (p: string) => fs.readFile(p, 'utf8');

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

describe('parseWorktreeInclude', () => {
  it('skips comments and blank lines but keeps surrounding whitespace', () => {
    expect(
      parseWorktreeInclude(
        ['# a comment', '', '  ', '.env', '  config\\  ', ' spaced.txt'].join(
          '\n',
        ),
      ),
    ).toEqual(['.env', '  config\\  ', ' spaced.txt']);
  });

  it('strips a trailing CR so CRLF files round-trip', () => {
    expect(parseWorktreeInclude('.env\r\n.local/\r\n')).toEqual([
      '.env',
      '.local/',
    ]);
  });

  it('treats a line whose first character is not # as a pattern', () => {
    expect(parseWorktreeInclude('  #not-a-comment')).toEqual([
      '  #not-a-comment',
    ]);
  });
});

describe('listIgnoredFiles', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-ignore-')),
    );
    gitIn(repoRoot, 'init', '-q', '-b', 'main');
    gitIn(repoRoot, 'config', 'user.email', 't@e.com');
    gitIn(repoRoot, 'config', 'user.name', 't');
    gitIn(repoRoot, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.env\n.local/\n');
    await fs.writeFile(path.join(repoRoot, 'tracked.txt'), 'tracked\n');
    gitIn(repoRoot, 'add', '.');
    gitIn(repoRoot, 'commit', '-q', '-m', 'init', '--no-verify');
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('lists files inside a fully-ignored directory instead of the dir', async () => {
    await fs.mkdir(path.join(repoRoot, '.local', 'sub'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.local', 'top.txt'), 'top\n');
    await fs.writeFile(path.join(repoRoot, '.local', 'sub', 'deep.txt'), 'd\n');

    const listed = await listIgnoredFiles(repoRoot);

    expect(listed.sort()).toEqual(['.local/sub/deep.txt', '.local/top.txt']);
  });

  it('omits tracked files', async () => {
    await fs.writeFile(path.join(repoRoot, '.env'), 'A=1\n');

    expect(await listIgnoredFiles(repoRoot)).toEqual(['.env']);
  });
});

describe('GitWorktreeService.setupWorktrees() — .worktreeinclude', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoParent: string;
  let repoRoot: string;
  let baseDir: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-include-'));
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    baseDir = path.join(repoParent, 'worktrees');
    await fs.mkdir(repoRoot);

    gitIn(repoRoot, 'init', '-q', '-b', 'main');
    gitIn(repoRoot, 'config', 'user.email', 't@e.com');
    gitIn(repoRoot, 'config', 'user.name', 't');
    gitIn(repoRoot, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.env\n.local/\nsecrets/*.json\n',
    );
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'hi\n');
    gitIn(repoRoot, 'add', '.');
    gitIn(repoRoot, 'commit', '-q', '-m', 'init', '--no-verify');
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  /** Runs setupWorktrees for one worktree and returns its checkout path. */
  async function setup(root = repoRoot) {
    const service = new GitWorktreeService(root, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's1',
      sourceRepoPath: root,
      worktreeNames: ['one'],
    });
    expect(result.success).toBe(true);
    expect(result.worktrees).toHaveLength(1);
    return result.worktrees[0].path;
  }

  async function writeIgnoredFixtures() {
    await fs.writeFile(path.join(repoRoot, '.env'), 'TOKEN=abc\n');
    await fs.mkdir(path.join(repoRoot, '.local', 'sub'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.local', 'top.txt'), 'top\n');
    await fs.writeFile(path.join(repoRoot, '.local', 'sub', 'deep.txt'), 'd\n');
    await fs.mkdir(path.join(repoRoot, 'secrets'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'secrets', 'id.json'),
      '{"k":"v"}\n',
    );
  }

  it('copies the gitignored paths named by the file', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      ['.env', '.local/', 'secrets/id.json'].join('\n'),
    );
    // Committed, like a real repository's file.
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const wt = await setup();

    expect(await read(path.join(wt, '.env'))).toBe('TOKEN=abc\n');
    expect(await read(path.join(wt, '.local', 'top.txt'))).toBe('top\n');
    expect(await read(path.join(wt, '.local', 'sub', 'deep.txt'))).toBe('d\n');
    expect(await read(path.join(wt, 'secrets', 'id.json'))).toBe('{"k":"v"}\n');
  });

  it('leaves gitignored paths the file does not name out of the worktree', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');

    const wt = await setup();

    expect(await read(path.join(wt, '.env'))).toBe('TOKEN=abc\n');
    expect(await exists(path.join(wt, '.local'))).toBe(false);
    expect(await exists(path.join(wt, 'secrets'))).toBe(false);
  });

  it('copies nothing when the file is absent', async () => {
    await writeIgnoredFixtures();

    const wt = await setup();

    expect(await exists(path.join(wt, '.env'))).toBe(false);
  });

  it('honours a negation so a listed path is excluded again', async () => {
    await fs.mkdir(path.join(repoRoot, 'secrets'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'secrets', 'id.json'), '{}\n');
    await fs.writeFile(path.join(repoRoot, 'secrets', 'other.json'), '{}\n');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      ['secrets/*.json', '!secrets/other.json'].join('\n'),
    );

    const wt = await setup();

    expect(await exists(path.join(wt, 'secrets', 'id.json'))).toBe(true);
    expect(await exists(path.join(wt, 'secrets', 'other.json'))).toBe(false);
  });

  it('never copies a tracked file named by a pattern', async () => {
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      'README.md\n',
    );

    const wt = await setup();

    // Present because it is tracked, not because the pattern selected it.
    expect(await read(path.join(wt, 'README.md'))).toBe('hi\n');
  });

  it('ignores a file over the size cap', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      '.env\n' + '\n'.repeat(1024 * 1024),
    );

    const wt = await setup();

    expect(await exists(path.join(wt, '.env'))).toBe(false);
  });

  it('still creates the worktree when the file cannot be parsed', async () => {
    await writeIgnoredFixtures();
    // A directory named `.worktreeinclude` is not a file; the step skips it.
    await fs.mkdir(path.join(repoRoot, WORKTREE_INCLUDE_FILE));

    const wt = await setup();

    expect(await exists(wt)).toBe(true);
    expect(await exists(path.join(wt, '.env'))).toBe(false);
  });

  it('applies to `createUserWorktree`, the path --worktree uses', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.createUserWorktree('flag', 'main');

    expect(result.success).toBe(true);
    expect(await read(path.join(result.worktree!.path, '.env'))).toBe(
      'TOKEN=abc\n',
    );
  });
});
