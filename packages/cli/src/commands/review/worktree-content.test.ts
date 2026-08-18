/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `worktreeMatchesHead` against the REAL git binary — the mocked fetch-pr
// suite cannot see an invalid invocation (it stubs `gitRawWithInput`), and a
// round-10 defect shipped a `hash-object --stdin-paths -z` command no git
// accepts, silently disabling the whole content cross-check. These run the
// binary so the invocation shape is falsifiable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeMatchesHead } from './fetch-pr.js';
import { untrustedLocalConfig, plantedHooks } from './lib/git.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('untrustedLocalConfig against real git', () => {
  let wt: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8' });
  beforeEach(() => {
    wt = realpathSync(mkdtempSync(join(tmpdir(), 'ulc-')));
    git('init', '-q');
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  it('is clean on a plain repo', () => {
    expect(untrustedLocalConfig(wt)).toEqual([]);
  });

  it('flags a command-executing key', () => {
    git('config', '--local', 'core.fsmonitor', '/tmp/evil.sh');
    expect(untrustedLocalConfig(wt)).toContain('core.fsmonitor');
  });

  it('flags a key whose subsection name contains "=" — the last-= / -z parse', () => {
    // `[diff "a=b"] command=…` renders in --list as `diff.a=b.command=val`;
    // splitting at the FIRST `=` truncated the key to `diff.a`, missing the
    // `diff\..+\.command` pattern. The -z parse keeps the whole key.
    git('config', '--local', 'diff.a=b.command', '/tmp/evil.sh');
    expect(untrustedLocalConfig(wt)).toContain('diff.a=b.command');
  });

  it('does not flag ordinary keys', () => {
    git('config', '--local', 'user.name', 'someone');
    git('config', '--local', 'core.bare', 'false');
    expect(untrustedLocalConfig(wt)).toEqual([]);
  });
});

describe.skipIf(!hasGit)('plantedHooks against real git', () => {
  let wt: string;
  beforeEach(() => {
    wt = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-')));
    execFileSync('git', ['-C', wt, 'init', '-q']);
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  it('ignores the sample hooks git ships', () => {
    expect(plantedHooks(join(wt, '.git', 'hooks'))).toEqual([]);
  });

  it('flags an executable non-sample hook', () => {
    const h = join(wt, '.git', 'hooks', 'reference-transaction');
    writeFileSync(h, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    expect(plantedHooks(join(wt, '.git', 'hooks'))).toContain(
      'reference-transaction',
    );
  });

  it('ignores a non-executable file', () => {
    writeFileSync(join(wt, '.git', 'hooks', 'note.txt'), 'x', { mode: 0o644 });
    expect(plantedHooks(join(wt, '.git', 'hooks'))).toEqual([]);
  });
});

describe.skipIf(!hasGit)('worktreeMatchesHead against real git', () => {
  let wt: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8' });

  beforeEach(() => {
    wt = realpathSync(mkdtempSync(join(tmpdir(), 'wtmh-')));
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(wt, 'a.txt'), 'hello\n');
    mkdirSync(join(wt, 'sub'));
    writeFileSync(join(wt, 'sub', 'b.txt'), 'world\n');
    symlinkSync('a.txt', join(wt, 'link.txt'));
    git('add', '-A');
    git('commit', '-qm', 'init');
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  it('accepts a pristine checkout — regular files and a symlink', () => {
    expect(worktreeMatchesHead(wt)).toBe(true);
  });

  it('rejects a tampered tracked file whose bytes no longer hash to HEAD', () => {
    writeFileSync(join(wt, 'sub', 'b.txt'), 'TAMPERED\n');
    expect(worktreeMatchesHead(wt)).toBe(false);
  });

  it('rejects a retargeted tracked symlink — hash-object would follow it', () => {
    writeFileSync(join(wt, 'secret.txt'), 'secret\n');
    rmSync(join(wt, 'link.txt'));
    symlinkSync('secret.txt', join(wt, 'link.txt'));
    expect(worktreeMatchesHead(wt)).toBe(false);
  });

  it('accepts a repo whose only files are symlinks', () => {
    rmSync(wt, { recursive: true, force: true });
    wt = realpathSync(mkdtempSync(join(tmpdir(), 'wtmh-')));
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(wt, 'target.txt'), 'x\n');
    symlinkSync('target.txt', join(wt, 'l.txt'));
    git('add', '-A');
    git('commit', '-qm', 'links');
    expect(worktreeMatchesHead(wt)).toBe(true);
    rmSync(join(wt, 'l.txt'));
    symlinkSync('/etc/passwd', join(wt, 'l.txt'));
    expect(worktreeMatchesHead(wt)).toBe(false);
  });
});
