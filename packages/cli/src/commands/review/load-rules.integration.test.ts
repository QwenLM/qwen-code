/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real git: `loadCombined` reads each rule file through `git show
// <ref>:<path>`, and the ref resolution and plumbing are what this covers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCombined } from './load-rules.js';

let repo: string;
let home: string;
let cwd: string;
let savedEnv: NodeJS.ProcessEnv;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'review-rules-'));
  home = mkdtempSync(join(tmpdir(), 'review-rules-home-'));
  writeFileSync(join(home, '.gitconfig'), '');

  // Same isolation as git.integration.test.ts: without it, `git init` loads
  // the developer's templates and hooks, and a global `commit.gpgsign=true`
  // fails the suite for want of a key.
  savedEnv = { ...process.env };
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
  process.env['HOME'] = home;

  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));
  cwd = process.cwd();
  // `gitOpt` runs `git` in the process's directory — point it at the fixture.
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  process.env = savedEnv;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function commitAll(message: string): void {
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', message);
}

describe('loadCombined', () => {
  it('loads the Code Review section of CLAUDE.md and nothing else from it', () => {
    writeFileSync(
      join(repo, 'CLAUDE.md'),
      '# CLAUDE\n\n## Code Review\n- CLAUDE-RULE-ONE\n\n## Other\nbody\n',
    );
    commitAll('claude');

    const { combined, loaded } = loadCombined('HEAD');
    expect(loaded).toEqual(['CLAUDE.md']);
    expect(combined).toContain('### From CLAUDE.md');
    expect(combined).toContain('CLAUDE-RULE-ONE');
    expect(combined).not.toContain('body');
  });

  it('ignores a CLAUDE.md without a Code Review section', () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# CLAUDE\n\n## Conventions\n- x\n');
    commitAll('claude');

    const { combined, loaded } = loadCombined('HEAD');
    expect(loaded).toEqual([]);
    expect(combined).toBe('');
  });

  it('combines all three markdown sources in documented order', () => {
    // Pins CLAUDE.md's fifth position — AFTER QWEN.md — not just "last of a
    // pair"; moving its block above QWEN.md in loadCombined must fail this.
    writeFileSync(join(repo, 'AGENTS.md'), '## Code Review\n- AGENTS-RULE\n');
    writeFileSync(join(repo, 'QWEN.md'), '## Code Review\n- QWEN-RULE\n');
    writeFileSync(join(repo, 'CLAUDE.md'), '## Code Review\n- CLAUDE-RULE\n');
    commitAll('all');

    const { combined, loaded } = loadCombined('HEAD');
    expect(loaded).toEqual(['AGENTS.md', 'QWEN.md', 'CLAUDE.md']);
    expect(combined.indexOf('AGENTS-RULE')).toBeLessThan(
      combined.indexOf('QWEN-RULE'),
    );
    expect(combined.indexOf('QWEN-RULE')).toBeLessThan(
      combined.indexOf('CLAUDE-RULE'),
    );
  });
});
