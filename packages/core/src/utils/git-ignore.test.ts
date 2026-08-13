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

  beforeEach(() => {
    originalConfigNosystem = process.env['GIT_CONFIG_NOSYSTEM'];
    originalConfigGlobal = process.env['GIT_CONFIG_GLOBAL'];
    dir = join(
      tmpdir(),
      `git-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    // Process-level git-config hermeticity: the probe spawns git with the
    // ambient process.env, so a host global exclude (e.g. one ignoring
    // .qwen/) would leak into the verdicts.
    writeFileSync(join(dir, 'empty-gitconfig'), '');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = join(dir, 'empty-gitconfig');
    execFileSync('git', ['init', '-q'], { cwd: dir });
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

  it('answers for the -C worktree even when GIT_WORK_TREE points elsewhere', () => {
    // GIT_WORK_TREE overrides `-C` path resolution for a spawn that
    // inherits the ambient env; the probe scrubs it so the `-C` worktree
    // stays the sole repository selector.
    const foreign = mkdtempSync(join(tmpdir(), 'git-ignore-foreign-'));
    execFileSync('git', ['init', '-q'], { cwd: foreign });
    writeFileSync(join(foreign, '.gitignore'), '.qwen/\n');
    const saved = process.env['GIT_WORK_TREE'];
    process.env['GIT_WORK_TREE'] = foreign;
    try {
      // dir itself has no ignore rules: the foreign tree's .qwen/ rule
      // must not answer for it.
      expect(isGitIgnored(dir, '.qwen/audits/x.md')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['GIT_WORK_TREE'];
      else process.env['GIT_WORK_TREE'] = saved;
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
