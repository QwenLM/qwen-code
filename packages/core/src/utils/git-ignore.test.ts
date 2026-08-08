/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isGitIgnored } from './git-ignore.js';

describe('isGitIgnored', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `git-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(isGitIgnored(plain, 'anything.md')).toBe(false);
  });
});
