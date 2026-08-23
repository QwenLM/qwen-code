/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
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

/** Every regular file under a root (empty directories contribute nothing). */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
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
      captureSidecar(p, sidecarDir);
      const before = new Set(readdirSync(sidecarDir));
      // Reads fine (../caller.ts resolves), but the '..' must not normalize
      // the copy out of sidecarDir/callers.
      const extended = captureSidecar(p, sidecarDir, ['../caller.ts']);
      expect(extended.callerHashes['../caller.ts']).toBeDefined();
      expect(extended.callerNames).toEqual(['../caller.ts']);
      expect(existsSync(join(sidecarDir, 'caller.ts'))).toBe(false);
      // Positive pin on WHERE nothing lands: the blocked copy must not
      // add ANY sidecar-root entry (nothing escaped to repo or parent),
      // and the source file stays untouched.
      const added = readdirSync(sidecarDir).filter((e) => !before.has(e));
      expect(added).toEqual([]);
      expect(existsSync(join(dir, 'caller.ts'))).toBe(true);
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

  it('surfaces a valid-JSON wrong-shape sidecar as corruption, not a TypeError', () => {
    const p = plan();
    captureSidecar(p, sidecarDir);
    // {}: valid JSON, wrong shape — driftCheck must hit the friendly
    // corruption diagnostic instead of a raw TypeError.
    writeFileSync(join(sidecarDir, 'sidecar.json'), '{}', 'utf8');
    expect(() => driftCheck(p, sidecarDir)).toThrow(/corrupt or truncated/);
    // The extend re-run recovers the same way as for a truncated file.
    const recovered = captureSidecar(p, sidecarDir);
    expect(recovered.meta.recaptured).toContain('re-captured mid-run');
  });

  it.skipIf(process.platform === 'win32')(
    'never hangs reading a FIFO swapped into a walked path',
    () => {
      const p = plan();
      captureSidecar(p, sidecarDir);
      // A writer-less FIFO where a walked file used to be must not hang
      // the checkpoint (or the capture, at run start).
      rmSync(join(dir, 'src', 'a.ts'));
      execFileSync('mkfifo', [join(dir, 'src', 'a.ts')]);
      const drift = driftCheck(p, sidecarDir);
      expect(drift.driftedFiles).toEqual(['src/a.ts']);
      // A FRESH capture skips the FIFO instead of hanging on the read.
      rmSync(sidecarDir, { recursive: true, force: true });
      const recapture = captureSidecar(p, sidecarDir);
      expect(recapture.hashes['src/a.ts']).toBeUndefined();
    },
  );

  it('recaptures fresh when the existing sidecar is corrupt', () => {
    const caller = join(dir, 'caller.ts');
    writeFileSync(caller, 'call();\n');
    const p = plan();
    captureSidecar(p, sidecarDir);
    // A capture killed mid-write leaves a truncated sidecar.json. The
    // Step-4 re-run that extends the caller set re-enters the extend branch
    // and must recover instead of throwing the corrupt-sidecar error again.
    writeFileSync(join(sidecarDir, 'sidecar.json'), '{"meta": ', 'utf8');
    const recaptured = captureSidecar(p, sidecarDir, [caller]);
    expect(recaptured.callerNames).toEqual([caller]);
    expect(recaptured.hashes['src/a.ts']).toBeDefined();
    // The fresh capture RESET the run-start baseline mid-run: the sidecar
    // says so, so the skill stops on it like headUnknown.
    expect(recaptured.meta.recaptured).toContain('re-captured mid-run');
    expect(() => driftCheck(p, sidecarDir)).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'name-records a FIFO caller without opening it',
    () => {
      // A writer-less FIFO caller must not hang the capture at read.
      execFileSync('mkfifo', [join(dir, 'pipe-caller')]);
      const p = plan();
      const sidecar = captureSidecar(p, sidecarDir, [join(dir, 'pipe-caller')]);
      expect(sidecar.callerNames).toEqual([join(dir, 'pipe-caller')]);
      expect(sidecar.callerHashes[join(dir, 'pipe-caller')]).toBeUndefined();
      expect(driftCheck(p, sidecarDir).driftedCallers).toEqual([
        join(dir, 'pipe-caller'),
      ]);
    },
  );

  it('baselines an over-cap caller through the streaming hash', () => {
    // The 10MB bound limits memory (chunked reads) and the archived copy —
    // not baseline eligibility. A name-only over-cap caller reported
    // phantom drift at every checkpoint with no remedy, so the hash now
    // streams regardless of size.
    const big = join(dir, 'big-caller.ts');
    writeFileSync(big, 'x'.repeat(10 * 1024 * 1024 + 1));
    const p = plan();
    const sidecar = captureSidecar(p, sidecarDir, [big]);
    expect(sidecar.callerNames).toEqual([big]);
    expect(sidecar.callerHashes[big]).toBeDefined();
    expect(driftCheck(p, sidecarDir).driftedCallers).toEqual([]);
    // The archived copy stays capped: the drift contract is the hash, not
    // the copy, so an over-cap caller must not exhaust the sidecar disk.
    const dest = join(
      sidecarDir,
      'callers',
      big.replace(/^([A-Za-z]:)?[\\/]/, ''),
    );
    expect(existsSync(dest)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'never baselines a caller through a symlink, and keeps the hash when the copy cannot land',
    () => {
      // A symlinked caller is name-only by design: content opens are
      // O_NOFOLLOW, so nothing is read through a link the audited agent
      // could re-point between the baseline and a checkpoint. The absence
      // of a hash is what makes drift-check report it every time — the
      // safe direction.
      writeFileSync(join(dir, 'real-caller.ts'), 'call();\n');
      symlinkSync(join(dir, 'real-caller.ts'), join(dir, 'link-caller.ts'));
      const p = plan();
      const link = join(dir, 'link-caller.ts');
      const sidecar = captureSidecar(p, sidecarDir, [link]);
      expect(sidecar.callerNames).toContain(link);
      expect(sidecar.callerHashes[link]).toBeUndefined();
      expect(driftCheck(p, sidecarDir).driftedCallers).toEqual([link]);
      // A squatter at the copy destination must not discard the hash: the
      // name-and-hash contract holds even when the copy cannot land.
      const realCaller = join(dir, 'real-caller.ts');
      const dest = join(
        sidecarDir,
        'callers',
        realCaller.replace(/^([A-Za-z]):\//, '$1/').replace(/^\//, ''),
      );
      mkdirSync(dest, { recursive: true }); // a dir where the copy lands
      const reExtended = captureSidecar(p, sidecarDir, [realCaller]);
      expect(reExtended.callerHashes[realCaller]).toBeDefined();
    },
  );
});

describe('the registered-caller policy', () => {
  it('refuses a credential-shaped caller and records the refusal', () => {
    // The caller channel takes an arbitrary absolute path from an agent,
    // AFTER the confirmation, and then content-copies it into the sidecar:
    // without this rule a registration is a hole straight through the
    // walk's own never-read-a-secret invariant.
    const secret = join(dir, 'prod.env');
    writeFileSync(secret, 'API_KEY=super-secret\n');
    const p = plan();
    const sidecar = captureSidecar(p, sidecarDir, [secret]);
    expect(sidecar.callerNames).toEqual([]);
    expect(sidecar.callerHashes[secret]).toBeUndefined();
    expect(sidecar.refusedCallers).toEqual([
      { caller: secret, reason: 'secret-shaped' },
    ]);
    // Nothing of it reached the archive.
    expect(existsSync(join(sidecarDir, 'callers'))).toBe(false);
  });

  it('refuses a caller outside the audited repository', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const outside = join(dir, 'outside-caller.ts');
    writeFileSync(outside, 'callerOnly();\n');
    const inside = join(repo, 'src', 'a.ts');
    const repoPlan = buildFilesPlan(
      join(repo, 'src'),
      join(repo, 'src'),
      'medium',
      collectAuditFiles(join(repo, 'src')),
    );
    const sidecar = captureSidecar(repoPlan, sidecarDir, [outside, inside]);
    // Reaching outside the audited PATH is the channel's whole purpose, so
    // the boundary is the repository — the in-repo caller is admitted.
    expect(sidecar.callerNames).toEqual([inside]);
    expect(sidecar.refusedCallers).toEqual([
      { caller: outside, reason: 'out-of-repo' },
    ]);
  });

  it('admits any non-secret caller outside a worktree', () => {
    // With no repository there is no containment boundary to enforce; the
    // name rule stands alone rather than refusing every registration.
    const caller = join(dir, 'plain-caller.ts');
    writeFileSync(caller, 'callerOnly();\n');
    const sidecar = captureSidecar(plan(), sidecarDir, [caller]);
    expect(sidecar.callerNames).toEqual([caller]);
    expect(sidecar.refusedCallers).toBeUndefined();
  });

  it('keeps drive-letter-distinct callers in separate archive paths', () => {
    // The copy key turns a root prefix into a path SEGMENT, so `C:/a/b.ts`
    // and `D:/a/b.ts` cannot collide on one destination with the later copy
    // silently overwriting the earlier.
    const a = join(dir, 'x', 'same.ts');
    const b = join(dir, 'y', 'same.ts');
    mkdirSync(join(dir, 'x'), { recursive: true });
    mkdirSync(join(dir, 'y'), { recursive: true });
    writeFileSync(a, 'const a = 1;\n');
    writeFileSync(b, 'const b = 2;\n');
    const sidecar = captureSidecar(plan(), sidecarDir, [a, b]);
    expect(sidecar.callerHashes[a]).not.toBe(sidecar.callerHashes[b]);
    expect(driftCheck(plan(), sidecarDir).driftedCallers).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'never copies a caller through a symlinked intermediate under the sidecar',
    () => {
      // O_NOFOLLOW guards only the final component: a symlinked callers/
      // subdirectory under the sidecar would carry the copy out of
      // containment on the extend re-run.
      const caller = join(dir, 'caller.ts');
      writeFileSync(caller, 'caller-secret-content()\n');
      const escape = join(dir, 'escape');
      mkdirSync(escape, { recursive: true });
      const p = plan();
      captureSidecar(p, sidecarDir);
      symlinkSync(escape, join(sidecarDir, 'callers'));
      const extended = captureSidecar(p, sidecarDir, [caller]);
      expect(filesUnder(escape)).toEqual([]);
      // The hash baseline survives the skipped copy.
      expect(extended.callerHashes[caller]).toBeDefined();
    },
  );
});

describe('captureSidecar inside a worktree', () => {
  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Isolate the helper repos from ambient config (a user/global
        // core.excludesFile or hooks.path would leak into the capture).
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(dir, 'empty-gitconfig'),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  }

  /** A PATH shim exiting 3 stands in for a missing/hanging git binary:
   *  every spawn fails without an answer (status 3, no git message). */
  function withBrokenGit<T>(fn: () => T): T {
    const shimDir = join(dir, 'git-shim');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexit 3\n');
    chmodSync(join(shimDir, 'git'), 0o755);
    const savedPath = process.env['PATH'];
    process.env['PATH'] = `${shimDir}${delimiter}${savedPath ?? ''}`;
    try {
      return fn();
    } finally {
      process.env['PATH'] = savedPath;
    }
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

  it.skipIf(process.platform === 'win32')(
    "never runs the audited repo's fsmonitor command at capture",
    () => {
      // Repo-local core.fsmonitor names a program; the capture's git arms
      // must not execute it as the auditor against a hostile checkout.
      const repo = join(dir, 'repo-fsmon');
      mkdirSync(repo, { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'f.ts'), 'const f = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-m', 'init', '-q'], repo);
      const marker = join(dir, 'fsmonitor-marker');
      git(['config', 'core.fsmonitor', `touch ${marker}`], repo);
      // Dirty tracked content and add an untracked file so both capture
      // arms have work.
      writeFileSync(join(repo, 'f.ts'), 'const f = 2;\n');
      writeFileSync(join(repo, 'u.ts'), 'const u = 1;\n');
      const repoPlan = buildFilesPlan(
        repo,
        repo,
        'medium',
        collectAuditFiles(repo),
      );
      captureSidecar(repoPlan, sidecarDir);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never copies untracked subjects through a symlinked sidecar subdirectory',
    () => {
      const repo = join(dir, 'repo-escape');
      mkdirSync(repo, { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'tracked.ts'), 'const t = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-m', 'init', '-q'], repo);
      writeFileSync(join(repo, 'u.ts'), 'const u = 1;\n');
      const repoPlan = buildFilesPlan(
        repo,
        repo,
        'medium',
        collectAuditFiles(repo),
      );
      const escape = join(dir, 'escape-untracked');
      mkdirSync(escape, { recursive: true });
      mkdirSync(sidecarDir, { recursive: true });
      symlinkSync(escape, join(sidecarDir, 'untracked'));
      const sidecar = captureSidecar(repoPlan, sidecarDir);
      expect(filesUnder(escape)).toEqual([]);
      expect(sidecar.meta.captureDegraded).toContain('untracked');
    },
  );

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
    // Every enumerated copy failed: the capture must publish as degraded,
    // not silently partial.
    expect(sidecar.meta.captureDegraded).toEqual(['untracked']);
  });

  it('a subtree-touching commit fires both git-state arms', () => {
    const repo = join(dir, 'repo5');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    writeFileSync(join(dir, 'empty-gitconfig'), '');
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
    // Content change + commit: HEAD and the subtree both moved.
    writeFileSync(join(repo, 'mod', 'tracked.ts'), 'const t = 2;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'change', '-q'], repo);
    const drift = driftCheck(modPlan, sidecarDir);
    expect(drift.headMoved).toBe(true);
    expect(drift.subtreeMoved).toBe(true);
  });

  it('covers a gitignored vendored subtree the index never sees', () => {
    const repo = join(dir, 'repo6');
    mkdirSync(join(repo, 'vendor', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'empty-gitconfig'), '');
    git(['init', '-q'], repo);
    writeFileSync(join(repo, '.gitignore'), 'vendor/\n');
    writeFileSync(join(repo, 'vendor', 'lib', 'v.ts'), 'export const v = 1;\n');
    git(['add', '.gitignore'], repo);
    git(['commit', '-m', 'init', '-q'], repo);

    const vendorPlan = buildFilesPlan(
      join(repo, 'vendor', 'lib'),
      join(repo, 'vendor', 'lib'),
      'medium',
      collectAuditFiles(join(repo, 'vendor', 'lib')),
    );
    const sidecar = captureSidecar(vendorPlan, sidecarDir);
    // No HEAD entry under the gitignored subtree: no subtree hash to track,
    // but the content baseline exists and the untracked copy landed.
    expect(sidecar.hashes['v.ts']).toBeDefined();
    expect(sidecar.meta.subtreeHash).toBeUndefined();
    expect(existsSync(join(sidecarDir, 'untracked', 'v.ts'))).toBe(true);
    writeFileSync(join(repo, 'vendor', 'lib', 'v.ts'), 'export const v = 2;\n');
    expect(driftCheck(vendorPlan, sidecarDir).driftedFiles).toEqual(['v.ts']);
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

  it.skipIf(process.platform === 'win32')(
    'marks vcsProbeFailed when the toplevel probe fails without an answer',
    () => {
      const repo = join(dir, 'repo-vf');
      mkdirSync(join(repo, 'mod'), { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-m', 'init', '-q'], repo);
      const modPlan = buildFilesPlan(
        join(repo, 'mod'),
        join(repo, 'mod'),
        'medium',
        collectAuditFiles(join(repo, 'mod')),
      );
      const sidecar = withBrokenGit(() => captureSidecar(modPlan, sidecarDir));
      expect(sidecar.meta.noVcs).toBe(true);
      expect(sidecar.meta.vcsProbeFailed).toBe(true);
      // The checkpoint re-probes with a working git: the content arm keeps
      // answering, and the unknown head is marked, not guessed.
      writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 2;\n');
      const drift = driftCheck(modPlan, sidecarDir);
      expect(drift.headUnknown).toBe(true);
      expect(drift.driftedFiles).toEqual(['a.ts']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports headUnknown when the checkpoint probe fails without an answer',
    () => {
      const repo = join(dir, 'repo-hu');
      mkdirSync(join(repo, 'mod'), { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-m', 'init', '-q'], repo);
      const modPlan = buildFilesPlan(
        join(repo, 'mod'),
        join(repo, 'mod'),
        'medium',
        collectAuditFiles(join(repo, 'mod')),
      );
      captureSidecar(modPlan, sidecarDir);
      const drift = withBrokenGit(() => driftCheck(modPlan, sidecarDir));
      expect(drift.headUnknown).toBe(true);
      expect(drift.subtreeUnknown).toBe(true);
      // The content arm is fs-based and keeps answering.
      expect(drift.driftedFiles).toEqual([]);
    },
  );

  it('captures the diff arm on an unborn HEAD via the index-vs-worktree diff', () => {
    // No commit: HEAD does not exist, so `git diff HEAD` would exit 128
    // and the arm would stay degraded for the whole run — every extend
    // re-run retrying the same certain failure. The index-vs-worktree
    // diff answers pre-commit (staged content is the index there), so the
    // arm captures instead of degrading.
    const repo = join(dir, 'repo-unborn');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
    git(['add', '.'], repo);
    writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 2;\n'); // dirty
    const modPlan = buildFilesPlan(
      join(repo, 'mod'),
      join(repo, 'mod'),
      'medium',
      collectAuditFiles(join(repo, 'mod')),
    );
    const sidecar = captureSidecar(modPlan, sidecarDir);
    expect(sidecar.meta.headSha).toBeUndefined();
    expect(sidecar.meta.headUnborn).toBe(true);
    expect(sidecar.meta.captureDegraded ?? []).not.toContain('diff');
    expect(readFileSync(join(sidecarDir, 'diff.patch'), 'utf8')).toContain(
      '-const a = 1;',
    );
    expect(sidecar.hashes['a.ts']).toBeDefined();
  });

  it('treats a still-unborn HEAD as definitively unmoved', () => {
    const repo = join(dir, 'repo-unborn2');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
    const modPlan = buildFilesPlan(
      join(repo, 'mod'),
      join(repo, 'mod'),
      'medium',
      collectAuditFiles(join(repo, 'mod')),
    );
    captureSidecar(modPlan, sidecarDir);
    const drift = driftCheck(modPlan, sidecarDir);
    expect(drift.headMoved).toBe(false);
    expect(drift.headUnknown).toBeFalsy();
  });

  it('treats the first landing commit on an unborn HEAD as moved', () => {
    const repo = join(dir, 'repo-unborn3');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
    const modPlan = buildFilesPlan(
      join(repo, 'mod'),
      join(repo, 'mod'),
      'medium',
      collectAuditFiles(join(repo, 'mod')),
    );
    captureSidecar(modPlan, sidecarDir);
    git(['add', '.'], repo);
    git(['commit', '-m', 'first', '-q'], repo);
    const drift = driftCheck(modPlan, sidecarDir);
    expect(drift.headMoved).toBe(true);
    expect(drift.headUnknown).toBeFalsy();
  });

  it.skipIf(process.platform === 'win32')(
    'reports headUnknown when the checkpoint probe has no answer on an unborn sidecar',
    () => {
      // A failed probe at checkpoint is NOT "still unborn": treating the
      // silence as unmoved would pass a moved HEAD clean under a broken git.
      const repo = join(dir, 'repo-unborn-probe');
      mkdirSync(join(repo, 'mod'), { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
      const modPlan = buildFilesPlan(
        join(repo, 'mod'),
        join(repo, 'mod'),
        'medium',
        collectAuditFiles(join(repo, 'mod')),
      );
      const captured = captureSidecar(modPlan, sidecarDir);
      expect(captured.meta.headUnborn).toBe(true);
      const drift = withBrokenGit(() => driftCheck(modPlan, sidecarDir));
      expect(drift.headUnknown).toBe(true);
      expect(drift.headMoved).toBe(false);
    },
  );

  // The shim fails only `rev-parse HEAD` (exit 3, no git message) and
  // passes every other invocation through to the real git.
  it.skipIf(process.platform === 'win32')(
    'does not record headUnborn from a transient rev-parse failure on a born HEAD',
    () => {
      const repo = join(dir, 'repo-born-probe');
      mkdirSync(join(repo, 'mod'), { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-m', 'init', '-q'], repo);
      const shimDir = join(dir, 'git-shim-head');
      mkdirSync(shimDir, { recursive: true });
      const savedPath = process.env['PATH'];
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\nprev=''\nfor arg in "$@"; do\n  if [ "$prev $arg" = "rev-parse HEAD" ]; then exit 3; fi\n  prev="$arg"\ndone\nPATH="${savedPath}" exec git "$@"\n`,
      );
      chmodSync(join(shimDir, 'git'), 0o755);
      process.env['PATH'] = `${shimDir}${delimiter}${savedPath ?? ''}`;
      let captured: ReturnType<typeof captureSidecar>;
      try {
        const modPlan = buildFilesPlan(
          join(repo, 'mod'),
          join(repo, 'mod'),
          'medium',
          collectAuditFiles(join(repo, 'mod')),
        );
        captured = captureSidecar(modPlan, sidecarDir);
        // The definitive unborn fatal is the gate: a transient failure on
        // a BORN HEAD leaves headSha undefined, never headUnborn.
        expect(captured.meta.headUnborn).toBeFalsy();
        expect(captured.meta.headSha).toBeUndefined();
      } finally {
        process.env['PATH'] = savedPath;
      }
      // The checkpoint then reports headUnknown instead of passing on the
      // silence (born branch: no baseline to compare against).
      const modPlan = buildFilesPlan(
        join(repo, 'mod'),
        join(repo, 'mod'),
        'medium',
        collectAuditFiles(join(repo, 'mod')),
      );
      const drift = driftCheck(modPlan, sidecarDir);
      expect(drift.headUnknown).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'repairs a probe-failed capture on the extend re-run once git answers',
    () => {
      const repo = join(dir, 'repo-repair');
      mkdirSync(repo, { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
      git(['add', '.'], repo);
      git(['commit', '-m', 'first', '-q'], repo);
      const repoPlan = buildFilesPlan(
        repo,
        repo,
        'medium',
        collectAuditFiles(repo),
      );
      // Git is down at capture: the toplevel probe fails without an answer,
      // so both arms AND the HEAD/subtree baselines are skipped.
      const captured = withBrokenGit(() =>
        captureSidecar(repoPlan, sidecarDir),
      );
      expect(captured.meta.vcsProbeFailed).toBe(true);
      expect(captured.meta.noVcs).toBe(true);
      expect(captured.meta.headSha).toBeUndefined();
      expect(captured.meta.subtreeHash).toBeUndefined();
      // Git recovers; the extend re-run (caller registration) is the only
      // command that can retry — it must re-probe and re-capture the
      // baselines and both arms against the preserved hash baselines.
      const caller = join(repo, 'caller.ts');
      writeFileSync(caller, 'call();\n');
      const extended = captureSidecar(repoPlan, sidecarDir, [caller]);
      expect(extended.meta.vcsProbeFailed).toBeUndefined();
      expect(extended.meta.noVcs).toBe(false);
      expect(extended.meta.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(extended.meta.subtreeHash).toMatch(/^[0-9a-f]{40}$/);
      expect(extended.meta.captureDegraded ?? []).toEqual([]);
      expect(extended.callerNames).toEqual([caller]);
      expect(extended.hashes['a.ts']).toBe(captured.hashes['a.ts']);
    },
  );

  it('scopes the diff arm literally when the audited dir name carries glob syntax', () => {
    // A raw pathspec fnmatch-expands a[b] onto the sibling 'ab'; the
    // :(literal) magic keeps the capture scoped to the audited directory.
    const repo = join(dir, 'repo-glob');
    mkdirSync(join(repo, 'a[b]'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'a[b]', 'f.ts'), 'const f = 1;\n');
    writeFileSync(join(repo, 'ab.ts'), 'const s = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    writeFileSync(join(repo, 'a[b]', 'f.ts'), 'const f = 2;\n'); // dirty
    writeFileSync(join(repo, 'ab.ts'), 'const s = 2;\n'); // dirty sibling
    const modPlan = buildFilesPlan(
      join(repo, 'a[b]'),
      join(repo, 'a[b]'),
      'medium',
      collectAuditFiles(join(repo, 'a[b]')),
    );
    captureSidecar(modPlan, sidecarDir);
    const diff = readFileSync(join(sidecarDir, 'diff.patch'), 'utf8');
    expect(diff).toContain('a[b]/f.ts');
    expect(diff).not.toContain('ab.ts');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO planted at sidecar.json instead of hanging the write',
    () => {
      const repo = join(dir, 'repo-fifo');
      mkdirSync(repo, { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
      const repoPlan = buildFilesPlan(
        repo,
        repo,
        'medium',
        collectAuditFiles(repo),
      );
      mkdirSync(sidecarDir, { recursive: true });
      execFileSync('mkfifo', [join(sidecarDir, 'sidecar.json')]);
      // loadSidecar rejects the FIFO; the fresh-capture recovery must
      // refuse the incumbent too — an unguarded write would open it
      // O_WRONLY and block forever. The guard's open (O_NONBLOCK) fails
      // with ENXIO instead, and the message names the path.
      expect(() => captureSidecar(repoPlan, sidecarDir)).toThrow(
        /cannot write the sidecar/,
      );
    },
  );
});
