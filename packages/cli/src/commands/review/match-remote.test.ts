/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git` around the pure core (covered by lib/remote-match.test.ts):
// the repository gate, the `git remote -v` read, and the exit-code contract
// the /review skill's Step 1 branches on. A mocked child_process would pass
// while the real invocation breaks — the class of bug the parse-args suite
// exists for.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Argv, CommandModule } from 'yargs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stdoutSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
const stderrSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: stdoutSpy,
  writeStderrLineSafe: stderrSpy,
}));

import { matchRemoteCommand, runMatchRemote } from './match-remote.js';

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

  it('prints every match and exits 7 when several remotes serve the repo', () => {
    git('remote', 'add', 'upstream', 'https://github.com/QwenLM/qwen-code.git');
    git('remote', 'add', 'mirror', 'git@github.com:QwenLM/qwen-code.git');
    process.chdir(repo);
    run();
    expect(stdoutSpy).toHaveBeenCalledWith('upstream');
    expect(stdoutSpy).toHaveBeenCalledWith('mirror');
    expect(process.exitCode).toBe(7);
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
      // git's own fatal is surfaced, not swallowed behind a fixed guess —
      // container CI's `dubious ownership` refusals must read as what they
      // are.
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('git cannot resolve this repository'),
      );
    } finally {
      process.chdir(savedCwd);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('resolves from a bare repository too — a mirror checkout is still a git repo', () => {
    // The exit-1 contract is "not a git repository / git unavailable"; a
    // bare clone is neither — `git remote -v` and the fetch/worktree steps
    // the flow runs next all succeed inside one.
    const bareRepo = mkdtempSync(join(tmpdir(), 'match-remote-bare-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', bareRepo]);
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'git@github.com:QwenLM/qwen-code.git'],
        { cwd: bareRepo, stdio: 'ignore' },
      );
      process.chdir(bareRepo);
      run();
      expect(stdoutSpy).toHaveBeenCalledWith('origin');
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.chdir(savedCwd);
      rmSync(bareRepo, { recursive: true, force: true });
    }
  });

  it('falls through to github.com when GH_HOST is empty or whitespace', () => {
    // Intentional fall-through (resolveGhHost): a templated CI export of
    // GH_HOST= must read as "no host", not route matching at a host named
    // "" and hard-stop.
    git('remote', 'add', 'origin', 'git@github.com:QwenLM/qwen-code.git');
    process.chdir(repo);
    const savedGhHost = process.env['GH_HOST'];
    try {
      for (const empty of ['', ' ']) {
        process.env['GH_HOST'] = empty;
        stdoutSpy.mockClear();
        run({ host: undefined });
        expect(stdoutSpy).toHaveBeenCalledWith('origin');
        expect(process.exitCode).toBeUndefined();
      }
    } finally {
      if (savedGhHost === undefined) delete process.env['GH_HOST'];
      else process.env['GH_HOST'] = savedGhHost;
    }
  });

  it('inherits an operator-exported GH_HOST when --host is absent', () => {
    // The bare-PR-number path omits --host; a GHE operator who exports
    // GH_HOST must not be rematched against github.com and hard-stopped.
    git('remote', 'add', 'origin', 'git@ghe.example.com:QwenLM/qwen-code.git');
    process.chdir(repo);
    const savedGhHost = process.env['GH_HOST'];
    process.env['GH_HOST'] = 'ghe.example.com';
    try {
      run({ host: undefined });
      expect(stdoutSpy).toHaveBeenCalledWith('origin');
      expect(process.exitCode).toBeUndefined();
    } finally {
      if (savedGhHost === undefined) delete process.env['GH_HOST'];
      else process.env['GH_HOST'] = savedGhHost;
    }
  });

  it('resolves from a subdirectory too — git walks up to the checkout', () => {
    // The skill runs every subcommand from the main checkout; a run that
    // happens to start in a subdirectory must see the same remotes, exactly
    // like `git remote -v` typed there.
    git('remote', 'add', 'origin', 'git@github.com:QwenLM/qwen-code.git');
    const sub = join(repo, 'packages', 'core');
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    run();
    expect(stdoutSpy).toHaveBeenCalledWith('origin');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('matchRemoteCommand builder', () => {
  // The demandOption guards are the misuse stop: without them a missing
  // --owner becomes String(undefined), matches nothing, exits 6 — and the
  // skill reads 6 as "go lightweight", silently degrading the review.
  it('demands --owner and --repo; --host stays optional', () => {
    const opts: Record<string, { demandOption?: boolean }> = {};
    const stub = {
      option: (name: string, config: { demandOption?: boolean }) => {
        opts[name] = config;
        return stub;
      },
    } as unknown as Argv;
    ((matchRemoteCommand as CommandModule).builder as (y: Argv) => Argv)(stub);
    expect(opts['owner']?.demandOption).toBe(true);
    expect(opts['repo']?.demandOption).toBe(true);
    expect(opts['host']).toBeDefined();
    expect(opts['host']?.demandOption).toBeFalsy();
  });
});
