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

  it('drift-check reports content drift, deletion, and new files', () => {
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
      existsSync(join(sidecarDir, 'callers', caller.replace(/^\//, ''))),
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
