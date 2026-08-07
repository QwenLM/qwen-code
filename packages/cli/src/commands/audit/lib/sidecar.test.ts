/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSidecar, driftCheck } from './sidecar.js';
import { buildFilesPlan, collectAuditFiles } from './files-plan.js';

let dir: string;
let sidecarDir: string;

beforeEach(() => {
  dir = join(
    tmpdir(),
    `audit-sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n');
  writeFileSync(join(dir, 'src', 'a.test.ts'), 'test\n');
  sidecarDir = join(dir, 'sidecar');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plan() {
  return buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
}

describe('captureSidecar outside any worktree', () => {
  it('records noVcs and hashes every walked file', () => {
    const sidecar = captureSidecar(plan(), sidecarDir);
    expect(sidecar.meta.noVcs).toBe(true);
    expect(Object.keys(sidecar.hashes).sort()).toEqual([
      'src/a.test.ts',
      'src/a.ts',
    ]);
  });

  it('drift-check reports content drift and deletion', () => {
    const p = plan();
    captureSidecar(p, sidecarDir);
    const clean = driftCheck(p, sidecarDir);
    expect(clean.driftedFiles).toEqual([]);
    expect(clean.headMoved).toBe(false);

    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 2;\n');
    const drifted = driftCheck(p, sidecarDir);
    expect(drifted.driftedFiles).toEqual(['src/a.ts']);
    expect(drifted.deletedFiles).toEqual([]);

    rmSync(join(dir, 'src', 'a.test.ts'));
    const deleted = driftCheck(p, sidecarDir);
    expect(deleted.deletedFiles).toEqual(['src/a.test.ts']);
  });

  it('hashes raw bytes: an edit invisible to utf8 decoding still drifts', () => {
    // 0xE9 and 0xFC both decode to U+FFFD — a utf8-keyed hash cannot see
    // this edit.
    const latin1 = join(dir, 'src', 'latin1.ts');
    writeFileSync(latin1, Buffer.from([0x61, 0xe9, 0x0a]));
    const p = plan();
    captureSidecar(p, sidecarDir);
    writeFileSync(latin1, Buffer.from([0x61, 0xfc, 0x0a]));
    expect(driftCheck(p, sidecarDir).driftedFiles).toEqual(['src/latin1.ts']);
  });

  it('drift-check classifies a directory-replaced file as drift, not a crash', () => {
    const p = plan();
    captureSidecar(p, sidecarDir);
    rmSync(join(dir, 'src', 'a.ts'));
    mkdirSync(join(dir, 'src', 'a.ts'));
    expect(driftCheck(p, sidecarDir).driftedFiles).toEqual(['src/a.ts']);
  });

  it('reports a plan-enumerated file absent at capture as deleted', () => {
    writeFileSync(join(dir, 'src', 'gone.ts'), 'const g = 1;\n');
    const p = plan();
    rmSync(join(dir, 'src', 'gone.ts'));
    captureSidecar(p, sidecarDir); // no baseline for gone.ts
    expect(driftCheck(p, sidecarDir).deletedFiles).toEqual(['src/gone.ts']);
  });

  it('reports a file absent at capture as new when it (re)appears', () => {
    writeFileSync(join(dir, 'src', 'late.ts'), 'const l = 1;\n');
    const p = plan();
    rmSync(join(dir, 'src', 'late.ts'));
    captureSidecar(p, sidecarDir); // no baseline for late.ts
    writeFileSync(join(dir, 'src', 'late.ts'), 'const l = 2;\n');
    expect(driftCheck(p, sidecarDir).newFiles).toEqual(['src/late.ts']);
  });

  it('baselines a file named __proto__ like any other walked file', () => {
    writeFileSync(join(dir, '__proto__'), 'const p = 1;\n');
    const p = plan();
    captureSidecar(p, sidecarDir);
    const drift = driftCheck(p, sidecarDir);
    expect(drift.driftedFiles).toEqual([]);
    expect(drift.deletedFiles).toEqual([]);
    expect(drift.newFiles).toEqual([]);
  });

  it('never hashes uncoverable files', () => {
    writeFileSync(join(dir, 'logo.png'), 'not-a-png');
    const sidecar = captureSidecar(plan(), sidecarDir);
    expect(sidecar.uncoverableNames).toContain('logo.png');
    expect(sidecar.hashes['logo.png']).toBeUndefined();
  });
});

describe('caller registration', () => {
  it('copies and hashes callers, and a re-run preserves the baseline', () => {
    const caller = join(dir, 'caller.ts');
    writeFileSync(caller, 'call();\n');
    const p = plan();
    const first = captureSidecar(p, sidecarDir);
    const baselineHash = first.hashes['src/a.ts'];

    // Mid-fan-out: the user edits a walked file (drift the next checkpoint
    // catches) while 1c's registration extends the sidecar.
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 2;\n');
    const extended = captureSidecar(p, sidecarDir, [caller]);
    expect(extended.hashes['src/a.ts']).toBe(baselineHash);
    expect(Object.keys(extended.callerHashes)).toEqual([caller]);
    expect(extended.callerNames).toEqual([caller]);
    // Caller copies are keyed by their full path under callers/.
    expect(
      existsSync(
        join(sidecarDir, 'callers', caller.replace(/^([A-Za-z]:)?[\\/]/, '')),
      ),
    ).toBe(true);

    const drift = driftCheck(p, sidecarDir);
    expect(drift.driftedFiles).toEqual(['src/a.ts']);
    expect(drift.driftedCallers).toEqual([]);

    writeFileSync(caller, 'call(2);\n');
    expect(driftCheck(p, sidecarDir).driftedCallers).toEqual([caller]);
  });

  it('records an unreadable caller by name and drift-check reports it', () => {
    const caller = join(dir, 'caller.ts');
    writeFileSync(caller, 'call();\n');
    const p = plan();
    captureSidecar(p, sidecarDir);
    // The file vanishes between 1c's registration and the snapshot: it is
    // name-recorded, never silently dropped.
    rmSync(caller);

    const extended = captureSidecar(p, sidecarDir, [caller]);
    expect(extended.callerNames).toEqual([caller]);
    expect(extended.callerHashes[caller]).toBeUndefined();
    expect(driftCheck(p, sidecarDir).driftedCallers).toEqual([caller]);
  });

  it('never copies a traversal caller path outside the sidecar', () => {
    writeFileSync(join(dir, 'caller.ts'), 'call();\n');
    const p = plan();
    const prevCwd = process.cwd();
    process.chdir(join(dir, 'src'));
    try {
      // Reads fine (../caller.ts resolves), but the '..' must not normalize
      // the copy out of sidecarDir/callers.
      const extended = captureSidecar(p, sidecarDir, ['../caller.ts']);
      expect(extended.callerHashes['../caller.ts']).toBeDefined();
      expect(extended.callerNames).toEqual(['../caller.ts']);
      expect(existsSync(join(sidecarDir, 'caller.ts'))).toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('name-records a caller already unreadable at first capture', () => {
    const caller = join(dir, 'missing.ts'); // never created
    const p = plan();
    const sidecar = captureSidecar(p, sidecarDir, [caller]);
    expect(sidecar.callerNames).toEqual([caller]);
    expect(sidecar.callerHashes[caller]).toBeUndefined();
    expect(driftCheck(p, sidecarDir).driftedCallers).toEqual([caller]);
  });
});

describe('captureSidecar inside a worktree', () => {
  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  }

  it('captures the SHA, subtree hash, path-scoped diff, and untracked copies', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'tracked.ts'), 'const t = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'untracked.ts'), 'const u = 1;\n');
    writeFileSync(join(repo, 'mod', 'tracked.ts'), 'const t = 2;\n'); // dirty
    writeFileSync(join(repo, 'elsewhere.ts'), 'const e = 1;\n'); // out of scope

    const modPlan = buildFilesPlan(
      join(repo, 'mod'),
      join(repo, 'mod'),
      'medium',
      collectAuditFiles(join(repo, 'mod')),
    );
    const sidecar = captureSidecar(modPlan, sidecarDir);
    expect(sidecar.meta.noVcs).toBe(false);
    expect(sidecar.meta.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(sidecar.meta.subtreeHash).toMatch(/^[0-9a-f]{40}$/);

    // The path-scoped diff covers the dirty tracked file in scope.
    expect(readFileSync(join(sidecarDir, 'diff.patch'), 'utf8')).toContain(
      'tracked.ts',
    );
    // Untracked copies: the enumerated in-scope file lands; the
    // out-of-scope one does not.
    expect(existsSync(join(sidecarDir, 'untracked', 'untracked.ts'))).toBe(
      true,
    );
    expect(existsSync(join(sidecarDir, 'untracked', 'elsewhere.ts'))).toBe(
      false,
    );
  });

  it('expands a collapsed nested-repository listing onto enumerated files', () => {
    const repo = join(dir, 'repo4');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    // A nested repo the outer repo does not register: ls-files --others
    // collapses it to a single trailing-/ entry.
    mkdirSync(join(repo, 'mod', 'nested'), { recursive: true });
    git(['init', '-q'], join(repo, 'mod', 'nested'));
    writeFileSync(join(repo, 'mod', 'nested', 's.ts'), 'const s = 1;\n');

    const modPlan = buildFilesPlan(
      join(repo, 'mod'),
      join(repo, 'mod'),
      'medium',
      collectAuditFiles(join(repo, 'mod')),
    );
    captureSidecar(modPlan, sidecarDir);
    expect(existsSync(join(sidecarDir, 'untracked', 'nested', 's.ts'))).toBe(
      true,
    );
  });

  it('degrades, not aborts, when an untracked copy cannot land', () => {
    const repo = join(dir, 'repo3');
    mkdirSync(repo, { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'tracked.ts'), 'const t = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    writeFileSync(join(repo, 'untracked.ts'), 'const u = 1;\n');
    const repoPlan = buildFilesPlan(
      repo,
      repo,
      'medium',
      collectAuditFiles(repo),
    );
    // A squatter where the untracked copies land makes every copy fail.
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'untracked'), 'squatter');
    const sidecar = captureSidecar(repoPlan, sidecarDir);
    expect(sidecar.hashes['untracked.ts']).toBeDefined();
    expect(existsSync(join(sidecarDir, 'untracked', 'untracked.ts'))).toBe(
      false,
    );
  });

  it('a content-preserving HEAD move fires no content drift', () => {
    const repo = join(dir, 'repo2');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'tracked.ts'), 'const t = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);

    const modPlan = buildFilesPlan(
      join(repo, 'mod'),
      join(repo, 'mod'),
      'medium',
      collectAuditFiles(join(repo, 'mod')),
    );
    captureSidecar(modPlan, sidecarDir);
    git(['commit', '--allow-empty', '-m', 'move', '-q'], repo);
    const drift = driftCheck(modPlan, sidecarDir);
    expect(drift.headMoved).toBe(true);
    expect(drift.subtreeMoved).toBe(false);
    expect(drift.driftedFiles).toEqual([]);
  });
});
