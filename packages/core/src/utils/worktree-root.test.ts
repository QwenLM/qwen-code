/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKTREE_ROOT,
  InvalidWorktreeRootError,
  WORKTREE_ROOT_MAX_LENGTH,
  assertWorktreeRootContainment,
  assertWorktreeRootContainmentSync,
  extractWorktreeFromPath,
  getWorktreeRootPrefixes,
  isPathInsideWorktreeRoot,
  parseWorktreeRoot,
  resolveWorktreeRootPath,
  validateWorktreeRoot,
} from './worktree-root.js';

describe('worktree-root validation and parsing', () => {
  it('defaults to .qwen/worktrees when undefined', () => {
    expect(validateWorktreeRoot(undefined)).toBeUndefined();
    const parsed = parseWorktreeRoot(undefined);
    expect(parsed).toEqual({
      normalized: DEFAULT_WORKTREE_ROOT,
      segments: ['.qwen', 'worktrees'],
      isDefault: true,
    });
  });

  it('normalizes valid repository-relative paths', () => {
    expect(parseWorktreeRoot('.worktrees')).toEqual({
      normalized: '.worktrees',
      segments: ['.worktrees'],
      isDefault: false,
    });
    expect(parseWorktreeRoot('./.worktrees/')).toEqual({
      normalized: '.worktrees',
      segments: ['.worktrees'],
      isDefault: false,
    });
    expect(parseWorktreeRoot('tmp\\qwen-wt\\nested')).toEqual({
      normalized: 'tmp/qwen-wt/nested',
      segments: ['tmp', 'qwen-wt', 'nested'],
      isDefault: false,
    });
    expect(parseWorktreeRoot('.qwen/wt')).toEqual({
      normalized: '.qwen/wt',
      segments: ['.qwen', 'wt'],
      isDefault: false,
    });
    expect(parseWorktreeRoot('.qwen\\worktrees\\')).toEqual({
      normalized: '.qwen/worktrees',
      segments: ['.qwen', 'worktrees'],
      isDefault: true,
    });
  });

  it.each([
    ['non-string number', 42],
    ['non-string null', null],
    ['non-string array', ['.worktrees']],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['leading space', ' .worktrees'],
    ['trailing space', '.worktrees '],
    ['over-long path', 'a'.repeat(WORKTREE_ROOT_MAX_LENGTH + 1)],
    ['NUL byte', '.worktrees\0x'],
    ['newline injection', '.worktrees\n*'],
    ['CR injection', '.worktrees\rfoo'],
    ['POSIX absolute', '/tmp/worktrees'],
    ['Windows backslash root', '\\worktrees'],
    ['Windows drive absolute', 'C:\\worktrees'],
    ['Windows drive relative', 'D:worktrees'],
    ['tilde home', '~'],
    ['tilde subpath', '~/worktrees'],
    ['colon in segment', 'wt:ads'],
    ['NTFS less-than', 'wt<a'],
    ['NTFS greater-than', 'wt>a'],
    ['NTFS double quote', 'wt"a'],
    ['NTFS pipe', 'wt|sh'],
    ['NTFS question mark', 'wt?a'],
    ['NTFS glob star', 'wt*a'],
    ['DOS reserved CON', 'CON'],
    ['DOS reserved nul lowercase', 'tmp/nul'],
    ['DOS reserved COM1 with ext', 'COM1.wt'],
    ['DOS reserved LPT9', 'tmp/LPT9'],
    ['parent traversal', '../outside'],
    ['nested traversal', 'a/../../outside'],
    ['repo root dot', '.'],
    ['repo root dot slash', './.'],
    ['.git exact', '.git'],
    ['.git uppercase', '.GIT'],
    ['inside .git', '.git/worktrees'],
    ['nested .git segment', 'tmp/.git/wt'],
    ['trailing dot bypass .git.', '.git.'],
    ['trailing dot bypass .qwen.', '.qwen.'],
    ['segment trailing whitespace', 'tmp /wt'],
    ['segment leading whitespace', 'tmp/ wt'],
    ['.qwen directly', '.qwen'],
    ['.qwen uppercase directly', '.QWEN'],
    ['.qwen with trailing slash', '.qwen/'],
  ])('rejects invalid worktree.root (%s)', (_label, candidate) => {
    expect(validateWorktreeRoot(candidate)).toBeTypeOf('string');
    expect(() => parseWorktreeRoot(candidate)).toThrow(
      InvalidWorktreeRootError,
    );
  });

  it('reports the dedicated ".." traversal diagnostic rather than trailing-dot (M5)', () => {
    expect(validateWorktreeRoot('../outside')).toContain('".."');
    expect(validateWorktreeRoot('a/../../outside')).toContain('".."');
  });
});

describe('worktree-root path helpers', () => {
  it('resolves root path and prefixes for multi-segment roots', () => {
    const repo = path.resolve('/tmp/sample-repo');
    expect(resolveWorktreeRootPath(repo, '.worktrees')).toBe(
      path.join(repo, '.worktrees'),
    );
    expect(getWorktreeRootPrefixes(repo, 'tmp/wts/nested')).toEqual([
      path.join(repo, 'tmp'),
      path.join(repo, 'tmp', 'wts'),
      path.join(repo, 'tmp', 'wts', 'nested'),
    ]);
  });

  it('detects nested paths inside default and custom roots without matching top-level ancestors', () => {
    expect(
      isPathInsideWorktreeRoot('/repo/.worktrees/slug-1', '.worktrees'),
    ).toBe(true);
    expect(
      isPathInsideWorktreeRoot(
        '/repo/.worktrees/slug-1/packages/a',
        '.worktrees',
      ),
    ).toBe(true);
    expect(isPathInsideWorktreeRoot('/repo/.worktrees', '.worktrees')).toBe(
      false,
    );
    expect(
      isPathInsideWorktreeRoot('/repo/src/worktrees/a', '.worktrees'),
    ).toBe(false);
    expect(isPathInsideWorktreeRoot('/repo/tmp/wts/slug-2', 'tmp/wts')).toBe(
      true,
    );
    // R1-1 witness: a repo living directly under `/tmp/qwen-code` must not
    // match `worktree.root: "tmp"`, and an anchored repo at `/home/u/worktrees/repo`
    // must not match `worktree.root: "worktrees"`.
    expect(isPathInsideWorktreeRoot('/tmp/qwen-code', 'tmp')).toBe(false);
    expect(
      isPathInsideWorktreeRoot(
        '/home/u/worktrees/repo',
        'worktrees',
        '/home/u/worktrees/repo',
      ),
    ).toBe(false);
    expect(
      isPathInsideWorktreeRoot(
        '/home/u/worktrees/repo/worktrees/feat-1',
        'worktrees',
        '/home/u/worktrees/repo',
      ),
    ).toBe(true);
  });

  it('extracts repoRoot, slug, and worktreePath for single and multi-segment roots', () => {
    const repo = path.resolve('/tmp/my-repo');
    const wt = path.join(repo, 'tmp', 'wts', 'feat-a');
    const nested = path.join(wt, 'src', 'index.ts');
    expect(extractWorktreeFromPath(nested, 'tmp/wts')).toEqual({
      repoRoot: repo,
      slug: 'feat-a',
      worktreePath: wt,
    });
    expect(extractWorktreeFromPath(nested, 'tmp/wts', repo)).toEqual({
      repoRoot: repo,
      slug: 'feat-a',
      worktreePath: wt,
    });
    expect(
      extractWorktreeFromPath(path.join(repo, 'src'), 'tmp/wts'),
    ).toBeNull();
    // R1-1 witness: filesystem-top `/tmp/qwen-code` and anchored standalone repo
    // `/home/u/worktrees/repo` return null.
    expect(extractWorktreeFromPath('/tmp/qwen-code', 'tmp')).toBeNull();
    expect(
      extractWorktreeFromPath(
        '/home/u/worktrees/repo',
        'worktrees',
        '/home/u/worktrees/repo',
      ),
    ).toBeNull();
  });
});

describe('worktree-root runtime symlink/junction containment', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('allows non-existent or in-repo custom roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-root-test-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });

    const parsed = parseWorktreeRoot('.worktrees');
    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, '.worktrees'),
        parsed,
        path.join(repo, '.git'),
      ),
    ).resolves.toBeUndefined();
    expect(() =>
      assertWorktreeRootContainmentSync(
        repo,
        path.join(repo, '.worktrees'),
        parsed,
        path.join(repo, '.git'),
      ),
    ).not.toThrow();
  });

  it('rejects a custom root symlink escaping outside the repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-root-escape-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(repo, '.worktrees'));

    const parsed = parseWorktreeRoot('.worktrees');
    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, '.worktrees'),
        parsed,
        path.join(repo, '.git'),
      ),
    ).rejects.toThrow(InvalidWorktreeRootError);
    expect(() =>
      assertWorktreeRootContainmentSync(
        repo,
        path.join(repo, '.worktrees'),
        parsed,
        path.join(repo, '.git'),
      ),
    ).toThrow(InvalidWorktreeRootError);
  });

  it('rejects an intermediate prefix symlink escaping outside the repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-root-prefix-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(repo, 'tmp'));

    const parsed = parseWorktreeRoot('tmp/wts');
    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, 'tmp', 'wts'),
        parsed,
        path.join(repo, '.git'),
      ),
    ).rejects.toThrow(InvalidWorktreeRootError);
  });

  it('rejects a symlink resolving to .git or the repository root itself', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-root-git-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.symlink(path.join(repo, '.git'), path.join(repo, 'to-git'));
    await fs.symlink(repo, path.join(repo, 'to-repo'));

    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, 'to-git'),
        parseWorktreeRoot('to-git'),
        path.join(repo, '.git'),
      ),
    ).rejects.toThrow(InvalidWorktreeRootError);

    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, 'to-repo'),
        parseWorktreeRoot('to-repo'),
        path.join(repo, '.git'),
      ),
    ).rejects.toThrow(InvalidWorktreeRootError);
  });

  it('rejects an existing regular file along worktree.root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-root-file-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.worktrees'), 'not a dir');

    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, '.worktrees'),
        parseWorktreeRoot('.worktrees'),
        path.join(repo, '.git'),
      ),
    ).rejects.toThrow(InvalidWorktreeRootError);
  });

  it('rejects an in-repo symlinked prefix for a custom worktree.root (R1-3)', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wt-root-inrepo-sym-'),
    );
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const realBuild = path.join(repo, 'real-build');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(realBuild, { recursive: true });
    await fs.symlink(realBuild, path.join(repo, 'build'));

    const parsed = parseWorktreeRoot('build/wts');
    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, 'build', 'wts'),
        parsed,
        path.join(repo, '.git'),
      ),
    ).rejects.toThrow(InvalidWorktreeRootError);
    expect(() =>
      assertWorktreeRootContainmentSync(
        repo,
        path.join(repo, 'build', 'wts'),
        parsed,
        path.join(repo, '.git'),
      ),
    ).toThrow(InvalidWorktreeRootError);
  });

  it('allows an operator-symlinked default .qwen/worktrees outside the repo while still rejecting .git', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-root-default-'));
    dirs.push(root);
    const repo = path.join(root, 'repo');
    const external = path.join(root, 'external-wt');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(path.join(repo, '.qwen'), { recursive: true });
    await fs.mkdir(external, { recursive: true });
    await fs.symlink(external, path.join(repo, '.qwen', 'worktrees'));

    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, '.qwen', 'worktrees'),
        parseWorktreeRoot(undefined),
        path.join(repo, '.git'),
      ),
    ).resolves.toBeUndefined();

    // Repointing default `.qwen/worktrees` into `.git` must still be rejected.
    await fs.unlink(path.join(repo, '.qwen', 'worktrees'));
    await fs.symlink(
      path.join(repo, '.git'),
      path.join(repo, '.qwen', 'worktrees'),
    );
    await expect(
      assertWorktreeRootContainment(
        repo,
        path.join(repo, '.qwen', 'worktrees'),
        parseWorktreeRoot(undefined),
        path.join(repo, '.git'),
      ),
    ).rejects.toThrow(InvalidWorktreeRootError);
    expect(() =>
      assertWorktreeRootContainmentSync(
        repo,
        path.join(repo, '.qwen', 'worktrees'),
        parseWorktreeRoot(undefined),
        path.join(repo, '.git'),
      ),
    ).toThrow(InvalidWorktreeRootError);
  });
});
