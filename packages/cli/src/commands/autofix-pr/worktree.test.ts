/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unsavedWork } from './cleanup.js';
import { autofixPrPaths } from './state.js';
import {
  requireWorktree,
  untrustedGitfile,
  untrustedSubmodules,
} from './worktree.js';

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
    expect(unsavedWork(paths, [], undefined, root)).toMatch(
      /not to this clone's own entry/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('reads the gitfile as git does, so a spelling git resolves inside the worktree is refused', () => {
    const real = readFileSync(join(worktree, '.git'), 'utf8')
      .slice('gitdir: '.length)
      .trim();
    // Two spaces: git takes " <real>", a path relative to the worktree, and
    // reads the git directory planted there.
    plantGitDir();
    const planted = join(worktree, ` ${real}`);
    mkdirSync(dirname(planted), { recursive: true });
    execFileSync('mv', [join(worktree, 'fake'), planted]);
    writeFileSync(join(worktree, '.git'), `gitdir:  ${real}\n`);
    git(worktree, '--no-optional-locks', 'status', '--porcelain');
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(untrustedGitfile(worktree, root)).toMatch(
      /names no git directory|not to this clone's own entry/,
    );
    for (const text of [`x\ngitdir: ${real}\n`, `gitdir: ${real}  \n`]) {
      writeFileSync(join(worktree, '.git'), text);
      expect(untrustedGitfile(worktree, root)).not.toBeNull();
    }
    expect(() => requireWorktree(autofixPrPaths(root, 7), 7, root)).toThrow(
      /no git command runs in/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('trusts a submodule whose git directory the clone keeps, and refuses one it does not', () => {
    // A submodule the clone keeps, as `git submodule` checks it out.
    const lib = join(root, 'lib');
    git(root, 'init', '-q', '-b', 'main', lib);
    git(
      lib,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'lib',
    );
    git(
      root,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      lib,
      'vendor/lib',
    );
    git(
      root,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '-m',
      'sub',
    );
    git(worktree, 'reset', '-q', '--hard', git(root, 'rev-parse', 'HEAD'));
    git(
      worktree,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '-q',
      '--init',
    );
    expect(untrustedGitfile(worktree, root)).toBeNull();
    expect(untrustedSubmodules(worktree, root)).toBeNull();
    // Its git directory embedded in the submodule, where the tree can write.
    const sub = join(worktree, 'vendor', 'lib');
    rmSync(join(sub, '.git'));
    mkdirSync(join(sub, '.git'));
    expect(untrustedSubmodules(worktree, root)).toMatch(
      /is not the gitfile of a submodule the clone keeps/,
    );
    expect(unsavedWork(autofixPrPaths(root, 7), [], undefined, root)).toMatch(
      /is not the gitfile of a submodule the clone keeps/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'reads a submodule path with a CR and an LF in it as git does',
    () => {
      const head = git(worktree, 'rev-parse', 'HEAD');
      const name = 'line\r\nbreak';
      git(
        worktree,
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${head},${name}`,
      );
      // Checked out, with its git directory embedded where the tree writes.
      mkdirSync(join(worktree, name, '.git'), { recursive: true });
      expect(untrustedSubmodules(worktree, root)).toMatch(
        /is not the gitfile of a submodule the clone keeps/,
      );
    },
  );

  it('refuses a submodule it cannot read, and skips only one not checked out', () => {
    const head = git(worktree, 'rev-parse', 'HEAD');
    git(
      worktree,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${head},gone`,
    );
    expect(untrustedSubmodules(worktree, root)).toBeNull();
    // A file where the submodule should be: its `.git` cannot be read.
    git(worktree, 'update-index', '--add', '--cacheinfo', `160000,${head},odd`);
    writeFileSync(join(worktree, 'odd'), '');
    expect(untrustedSubmodules(worktree, root)).toMatch(/cannot be read/);
  });

  it('reads an index whose listing runs past 1 MiB', () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: worktree,
      input: '',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    })
      .toString()
      .trim();
    const entries = Array.from(
      { length: 30_000 },
      (_, i) => `100644 ${blob}\tdir/a-fairly-long-file-name-${i}.txt`,
    ).join('\n');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: worktree,
      input: `${entries}\n`,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(
      execFileSync('git', ['ls-files', '--stage', '-z'], {
        cwd: worktree,
        maxBuffer: 64 * 1024 * 1024,
      }).length,
    ).toBeGreaterThan(1024 * 1024);
    expect(untrustedSubmodules(worktree, root)).toBeNull();
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

  it('refuses a worktree without its gitfile: git would walk up to a git directory planted beside it', () => {
    rmSync(join(worktree, '.git'));
    const planted = join(root, '.qwen', 'tmp', '.git');
    execFileSync('cp', ['-r', join(root, '.git'), planted]);
    execFileSync('git', [
      '--git-dir',
      planted,
      'config',
      'core.worktree',
      worktree,
    ]);
    execFileSync('git', [
      '--git-dir',
      planted,
      'config',
      'core.fsmonitor',
      `touch ${marker}`,
    ]);
    expect(untrustedGitfile(worktree, root)).toMatch(
      /is not a git worktree: it has no gitfile/,
    );
    expect(() => requireWorktree(autofixPrPaths(root, 7), 7, root)).toThrow(
      /is not a git worktree/,
    );
    expect(unsavedWork(autofixPrPaths(root, 7), [], undefined, root)).toMatch(
      /is not a git worktree/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('resolves the pointer as the kernel does, symlinks before `..`', () => {
    const real = readFileSync(join(worktree, '.git'), 'utf8')
      .slice('gitdir: '.length)
      .trim();
    // `L/../../..` names the clone's entry lexically, but through the link
    // git lands inside the worktree, on a git directory planted there.
    plantGitDir();
    const deep = join(worktree, 'x', 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    symlinkSync(deep, join(worktree, 'L'));
    const ups = real.split(sep).filter(Boolean).length;
    const lexical = `L${sep}${Array(ups + 1)
      .fill('..')
      .join(sep)}${real}`;
    writeFileSync(join(worktree, '.git'), `gitdir: ${lexical}\n`);
    expect(untrustedGitfile(worktree, root)).not.toBeNull();
  });

  // The rewritten gitfile and the fsmonitor hook are POSIX spellings.
  it.skipIf(process.platform === 'win32')(
    'anchors trust to the genuine clone, not the linked watch root',
    () => {
      const repl = realpathSync(
        mkdtempSync(join(tmpdir(), 'autofix-wt-repl-')),
      );
      git(repl, 'init', '-q', '-b', 'main');
      git(
        repl,
        '-c',
        'user.email=a@b',
        '-c',
        'user.name=a',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'r',
      );
      const hook = join(repl, 'fsmonitor.sh');
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      git(repl, 'config', 'core.fsmonitor', hook);
      // A linked worktree of the genuine clone, hosting a watch worktree of
      // the replacement; rewrite the linked root's gitfile so it vouches for
      // the replacement's worktree entries.
      const linked = join(root, 'linked');
      git(root, 'worktree', 'add', '-q', '--detach', linked);
      const nestedPaths = autofixPrPaths(linked, 7);
      mkdirSync(dirname(nestedPaths.worktreePath), { recursive: true });
      git(repl, 'worktree', 'add', '-q', '--detach', nestedPaths.worktreePath);
      writeFileSync(join(linked, '.git'), `gitdir: ${join(repl, '.git')}\n`);
      rmSync(marker, { force: true });
      try {
        // root = the linked watch root (what watchRoot() returns under the
        // daemon); trustRoot = the genuine clone. The check must still reject
        // and never run the replacement's fsmonitor.
        expect(() =>
          requireWorktree(nestedPaths, 7, linked, false, root),
        ).toThrow(/no git command runs in/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(nestedPaths.worktreePath, { recursive: true, force: true });
        rmSync(linked, { recursive: true, force: true });
        rmSync(repl, { recursive: true, force: true });
        git(root, 'worktree', 'prune');
      }
    },
  );
});
