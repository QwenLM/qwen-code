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

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `git-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // A genuinely repo-less location: a sibling temp dir the repo walk
    // cannot reach. (A subdirectory of the repo would let git walk up and
    // resolve the enclosing worktree, passing for the wrong reason.)
    outside = mkdtempSync(join(tmpdir(), 'git-ignore-plain-'));
  });

  afterEach(() => {
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
