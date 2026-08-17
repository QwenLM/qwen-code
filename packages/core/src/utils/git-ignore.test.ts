/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isGitIgnored } from './git-ignore.js';

describe('isGitIgnored', () => {
  let dir: string;
  let outside: string;
  let originalConfigNosystem: string | undefined;
  let originalConfigGlobal: string | undefined;
  let originalXdgConfigHome: string | undefined;

  beforeEach(() => {
    originalConfigNosystem = process.env['GIT_CONFIG_NOSYSTEM'];
    originalConfigGlobal = process.env['GIT_CONFIG_GLOBAL'];
    originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    dir = join(
      tmpdir(),
      `git-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    // Process-level git-config hermeticity: the probe spawns git with the
    // ambient process.env, so a host global exclude (e.g. one ignoring
    // .qwen/) would leak into the verdicts. The config pins block the
    // gitconfig channel but NOT git's XDG default excludes file
    // ($XDG_CONFIG_HOME/git/ignore), which git consults without any
    // config — pin XDG_CONFIG_HOME away from the host's too.
    writeFileSync(join(dir, 'empty-gitconfig'), '');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = join(dir, 'empty-gitconfig');
    process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg');
    // Scrubbed init env: git-init honors GIT_DIR/GIT_WORK_TREE/
    // GIT_OBJECT_DIRECTORY as repo-placement selectors (ambient GIT_WORK_TREE
    // without GIT_DIR is a hard fatal; ambient GIT_DIR re-homes the fixture
    // repository — mutating a foreign repo when it points at one).
    const initEnv: NodeJS.ProcessEnv = { ...process.env };
    delete initEnv['GIT_DIR'];
    delete initEnv['GIT_WORK_TREE'];
    delete initEnv['GIT_OBJECT_DIRECTORY'];
    delete initEnv['GIT_INDEX_FILE'];
    delete initEnv['GIT_COMMON_DIR'];
    execFileSync('git', ['init', '-q'], { cwd: dir, env: initEnv });
    // A genuinely repo-less location: a sibling temp dir the repo walk
    // cannot reach. (A subdirectory of the repo would let git walk up and
    // resolve the enclosing worktree, passing for the wrong reason.)
    outside = mkdtempSync(join(tmpdir(), 'git-ignore-plain-'));
  });

  afterEach(() => {
    if (originalConfigNosystem === undefined)
      delete process.env['GIT_CONFIG_NOSYSTEM'];
    else process.env['GIT_CONFIG_NOSYSTEM'] = originalConfigNosystem;
    if (originalConfigGlobal === undefined)
      delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = originalConfigGlobal;
    if (originalXdgConfigHome === undefined)
      delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('answers git’s own verdict for a representative file path', () => {
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    writeFileSync(join(dir, '.gitignore'), '.qwen/\n');
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(true);
  });

  it('is fresh by default: a rule edit flips the next answer', () => {
    writeFileSync(join(dir, '.gitignore'), '.qwen/\n');
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(true);
    writeFileSync(
      join(dir, '.gitignore'),
      '.qwen/*\n!.qwen/audits/\n!.qwen/audits/**\n',
    );
    expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
  });

  it('treats a non-worktree as not-ignored', () => {
    expect(isGitIgnored(outside, 'anything.md')).toBe(false);
  });

  // Every repository-selecting variable the probe scrubs needs its own
  // pinned arm: deleting any one scrub line ships green unless a fixture
  // proves the -C worktree's verdict still wins under it.
  for (const envName of [
    'GIT_WORK_TREE',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
  ]) {
    it(`answers for the -C worktree even when ${envName} points elsewhere`, () => {
      const foreign = mkdtempSync(join(tmpdir(), 'git-ignore-foreign-'));
      execFileSync('git', ['init', '-q'], { cwd: foreign });
      writeFileSync(join(foreign, '.gitignore'), '.qwen/\n');
      const saved = process.env[envName];
      const savedGitDir = process.env['GIT_DIR'];
      // GIT_WORK_TREE needs a paired GIT_DIR to be legal; point both (or
      // the gitdir/index/object selectors alone) at the foreign repo.
      process.env[envName] =
        envName === 'GIT_WORK_TREE' ? foreign : join(foreign, '.git');
      if (envName === 'GIT_WORK_TREE')
        process.env['GIT_DIR'] = join(foreign, '.git');
      try {
        // dir itself has no ignore rules: the foreign tree's .qwen/ rule
        // must not answer for it.
        expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
      } finally {
        if (saved === undefined) delete process.env[envName];
        else process.env[envName] = saved;
        if (envName === 'GIT_WORK_TREE') {
          if (savedGitDir === undefined) delete process.env['GIT_DIR'];
          else process.env['GIT_DIR'] = savedGitDir;
        }
        rmSync(foreign, { recursive: true, force: true });
      }
    });
  }

  it('answers for the -C worktree even when GIT_COMMON_DIR points elsewhere', () => {
    // GIT_COMMON_DIR selects where check-ignore resolves info/exclude and
    // config, so the foreign rule must sit in the foreign COMMON DIR's
    // info/exclude (a worktree .gitignore would not reach through it).
    const foreign = mkdtempSync(join(tmpdir(), 'git-ignore-common-'));
    execFileSync('git', ['init', '-q'], { cwd: foreign });
    mkdirSync(join(foreign, '.git', 'info'), { recursive: true });
    writeFileSync(join(foreign, '.git', 'info', 'exclude'), '.qwen/\n');
    const saved = process.env['GIT_COMMON_DIR'];
    process.env['GIT_COMMON_DIR'] = join(foreign, '.git');
    try {
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['GIT_COMMON_DIR'];
      else process.env['GIT_COMMON_DIR'] = saved;
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  // ':' is a reserved Win32 filename character, so the fixture directory
  // cannot be created on Windows.
  it.skipIf(process.platform === 'win32')(
    'probes a colon-leading path literally, not as pathspec magic',
    () => {
      mkdirSync(join(dir, ':weird', '.qwen'), { recursive: true });
      // Without the './' disambiguation git parses ':weird/...' as a
      // pathspec magic and answers the wrong pathname (ignored here while
      // the literal directory is not).
      expect(isGitIgnored(dir, ':weird/.qwen/x.md')).toBe(false);
      writeFileSync(join(dir, '.gitignore'), ':weird/.qwen/\n');
      expect(isGitIgnored(dir, ':weird/.qwen/x.md')).toBe(true);
    },
  );
});
