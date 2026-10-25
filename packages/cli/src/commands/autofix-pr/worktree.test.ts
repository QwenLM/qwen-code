/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unsavedWork } from './cleanup.js';
import { autofixPrPaths } from './state.js';
import { requireWorktree, untrustedGitfile } from './worktree.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  })
    .toString()
    .trim();

describe('untrustedGitfile (real git)', () => {
  let root: string;
  let worktree: string;
  let marker: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-gitfile-')));
    git(root, 'init', '-q', '-b', 'main');
    git(
      root,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    );
    worktree = autofixPrPaths(root, 7).worktreePath;
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    git(
      root,
      'worktree',
      'add',
      '-q',
      '-b',
      autofixPrPaths(root, 7).branch,
      worktree,
    );
    marker = join(root, 'fsmonitor-ran');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Points the worktree's `.git` at a git directory built inside it. */
  const plantGitDir = () => {
    const fake = join(worktree, 'fake');
    mkdirSync(join(fake, 'refs', 'heads'), { recursive: true });
    mkdirSync(join(fake, 'objects', 'info'), { recursive: true });
    writeFileSync(
      join(fake, 'HEAD'),
      `ref: refs/heads/${autofixPrPaths(root, 7).branch}\n`,
    );
    const ref = join(fake, 'refs', 'heads', autofixPrPaths(root, 7).branch);
    mkdirSync(dirname(ref), { recursive: true });
    writeFileSync(ref, `${git(root, 'rev-parse', 'HEAD')}\n`);
    writeFileSync(
      join(fake, 'objects', 'info', 'alternates'),
      `${join(root, '.git', 'objects')}\n`,
    );
    writeFileSync(
      join(fake, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch ${marker}"\n`,
    );
    writeFileSync(join(worktree, '.git'), `gitdir: ${fake}\n`);
  };

  it("trusts the clone's own linked worktree", () => {
    expect(untrustedGitfile(worktree, root)).toBeNull();
  });

  it('refuses a gitfile pointed at a git directory the worktree holds, before git reads its config', () => {
    plantGitDir();
    expect(untrustedGitfile(worktree, root)).toMatch(
      /not to this clone's own entry for a worktree/,
    );
    const paths = autofixPrPaths(root, 7);
    expect(() => requireWorktree(paths, 7, root)).toThrow(
      /no git command runs in/,
    );
    expect(unsavedWork(paths, [])).toMatch(/not to this clone's own entry/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a .git directory, and the entry of another worktree', () => {
    const other = join(root, '.qwen', 'tmp', 'other');
    git(root, 'worktree', 'add', '-q', '-b', 'other', other);
    writeFileSync(join(worktree, '.git'), readFileSync(join(other, '.git')));
    expect(untrustedGitfile(worktree, root)).toMatch(
      /the entry of another worktree/,
    );
    rmSync(join(worktree, '.git'));
    mkdirSync(join(worktree, '.git'));
    expect(untrustedGitfile(worktree, root)).toMatch(
      /not the gitfile of a linked worktree/,
    );
  });

  it('leaves a directory with no .git to the worktree check', () => {
    rmSync(join(worktree, '.git'));
    expect(untrustedGitfile(worktree, root)).toBeNull();
    expect(() => requireWorktree(autofixPrPaths(root, 7), 7, root)).toThrow(
      /is not a git worktree/,
    );
  });
});
