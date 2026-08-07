/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git` around the pure core (covered by lib/remote-match.test.ts):
// the worktree gate, the `git remote -v` read, and the exit-code contract
// the /review skill's Step 1 branches on. A mocked child_process would pass
// while the real invocation breaks — the class of bug the parse-args suite
// exists for.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stdoutSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
const stderrSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLineSafe: stdoutSpy,
  writeStderrLineSafe: stderrSpy,
}));

import { runMatchRemote } from './match-remote.js';

let repo: string;
let savedCwd: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function run(overrides: Record<string, unknown> = {}): void {
  runMatchRemote({
    owner: 'QwenLM',
    repo: 'qwen-code',
    host: 'github.com',
    ...overrides,
  } as never);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'match-remote-'));
  savedCwd = process.cwd();
  execFileSync('git', ['init', '-q', repo]);
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(savedCwd);
  process.exitCode = undefined;
  rmSync(repo, { recursive: true, force: true });
});

describe('runMatchRemote (real git)', () => {
  it('prints the matching remote and exits 0', () => {
    git('remote', 'add', 'origin', 'git@github.com:QwenLM/qwen-code.git');
    process.chdir(repo);
    run();
    expect(stdoutSpy).toHaveBeenCalledWith('origin');
    expect(process.exitCode).toBeUndefined();
  });

  it('picks the upstream in a fork layout', () => {
    git('remote', 'add', 'origin', 'git@github.com:QwenLM/qwen-code.git');
    git('remote', 'add', 'wenshao', 'git@github.com:wenshao/qwen-code.git');
    process.chdir(repo);
    run();
    expect(stdoutSpy).toHaveBeenCalledWith('origin');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints none and exits 6 when no remote matches', () => {
    git('remote', 'add', 'wenshao', 'git@github.com:wenshao/qwen-code.git');
    process.chdir(repo);
    run({ owner: 'shao' }); // the substring-decoy owner: must NOT match `wenshao`
    expect(stdoutSpy).toHaveBeenCalledWith('none');
    expect(process.exitCode).toBe(6);
  });

  it('prints every match and exits 2 when several remotes serve the repo', () => {
    git('remote', 'add', 'upstream', 'https://github.com/QwenLM/qwen-code.git');
    git('remote', 'add', 'mirror', 'git@github.com:QwenLM/qwen-code.git');
    process.chdir(repo);
    run();
    expect(stdoutSpy).toHaveBeenCalledWith('upstream');
    expect(stdoutSpy).toHaveBeenCalledWith('mirror');
    expect(process.exitCode).toBe(2);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('warning:'));
  });

  it('does not match across hosts', () => {
    git('remote', 'add', 'origin', 'git@github.com:QwenLM/qwen-code.git');
    process.chdir(repo);
    run({ host: 'ghe.example.com' });
    expect(stdoutSpy).toHaveBeenCalledWith('none');
    expect(process.exitCode).toBe(6);
  });

  it('exits 1 outside a git repository', () => {
    const bare = mkdtempSync(join(tmpdir(), 'match-remote-norepo-'));
    try {
      process.chdir(bare);
      run();
      expect(process.exitCode).toBe(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('resolves from a subdirectory too — git walks up to the checkout', () => {
    // The skill runs every subcommand from the main checkout; a run that
    // happens to start in a subdirectory must see the same remotes, exactly
    // like `git remote -v` typed there.
    git('remote', 'add', 'origin', 'git@github.com:QwenLM/qwen-code.git');
    const sub = join(repo, 'packages', 'core');
    execFileSync('mkdir', ['-p', sub]);
    process.chdir(sub);
    run();
    expect(stdoutSpy).toHaveBeenCalledWith('origin');
    expect(process.exitCode).toBeUndefined();
  });
});
