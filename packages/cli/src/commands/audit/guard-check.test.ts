/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '@qwen-code/qwen-code-core';
import { guardCheckCommand, guardTripped } from './guard-check.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  AUDITS_DIR,
  AUDIT_TMP_DIR,
  type GuardDirReport,
  type GuardReport,
  type GuardStatus,
} from './lib/files-plan.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

/** The plan filename SKILL.md pins. Relocation credit keys on THIS name —
 *  the "original is gone" proof looks for it under .qwen/tmp — so every
 *  fixture that means to exercise a credit arm must use it; a differently
 *  named plan is refused on the name alone, before the arm under test. */
const PINNED_PLAN_NAME = 'audit-plan-2026-08-13-120000.json';

function report(audits: GuardStatus, tmp: GuardStatus): GuardReport {
  const mk = (dir: string, status: GuardStatus): GuardDirReport => ({
    dir,
    representative: `${dir}/probe`,
    ignored: status === 'ok',
    trackedFiles: [],
    status,
  });
  // Build from the exported constants: guardTripped matches the plan-time
  // baseline by exact dir equality, and live reports carry the platform
  // join('.qwen', 'audits') — hardcoded POSIX literals never match on
  // Windows and the relocation tests fire vacuously.
  return {
    dirs: [mk(AUDITS_DIR, audits), mk(AUDIT_TMP_DIR, tmp)],
    fallbackRoot: '/fallback',
  };
}

describe('guardTripped', () => {
  it('fires on any exposed directory when no plan-time state is given', () => {
    expect(guardTripped(report('ok', 'ok'))).toBe(false);
    expect(guardTripped(report('ok', 'unprotected'))).toBe(true);
    expect(guardTripped(report('tracked', 'ok'))).toBe(true);
    expect(guardTripped(report('git-failed', 'ok'))).toBe(true);
  });

  it('suppresses plan-time exposure only once the relocation is verified', () => {
    // Without verification a suppression would let a scripted run that
    // skipped the Step 1 warning land committable artifacts at exit 0.
    expect(guardTripped(report('tracked', 'ok'), report('tracked', 'ok'))).toBe(
      true,
    );
    expect(
      guardTripped(
        report('unprotected', 'unprotected'),
        report('unprotected', 'unprotected'),
      ),
    ).toBe(true);
    expect(
      guardTripped(report('tracked', 'ok'), report('tracked', 'ok'), true),
    ).toBe(false);
    expect(
      guardTripped(
        report('unprotected', 'unprotected'),
        report('unprotected', 'unprotected'),
        true,
      ),
    ).toBe(false);
  });

  it('still fires for a directory that turned exposed after plan time', () => {
    expect(
      guardTripped(report('ok', 'tracked'), report('ok', 'ok'), true),
    ).toBe(true);
  });

  it('treats no-worktree as unexposed', () => {
    expect(guardTripped(report('no-worktree', 'no-worktree'))).toBe(false);
  });
});

describe('guardCheckCommand handler', () => {
  let repo: string;
  let originalCwd: string;
  let originalExitCode: typeof process.exitCode;
  let originalQwenHome: string | undefined;
  let originalConfigNosystem: string | undefined;
  let originalConfigGlobal: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    originalQwenHome = process.env['QWEN_HOME'];
    originalConfigNosystem = process.env['GIT_CONFIG_NOSYSTEM'];
    originalConfigGlobal = process.env['GIT_CONFIG_GLOBAL'];
    process.exitCode = undefined;
    repo = mkdtempSync(join(tmpdir(), 'audit-guard-check-'));
    // Hermetic: the fallback root lives under QWEN_HOME.
    process.env['QWEN_HOME'] = join(repo, 'qwen-home');
    // Process-level git-config hermeticity: the in-process check-ignore
    // probes spawn git with the ambient process.env, so pinning only the
    // `git init` subprocess leaks a host global exclude (e.g. one ignoring
    // .qwen/) into the verdicts.
    writeFileSync(join(repo, 'empty-gitconfig'), '');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = join(repo, 'empty-gitconfig');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    process.chdir(repo);
    vi.mocked(writeStdoutLine).mockClear();
    vi.mocked(writeStderrLine).mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    if (originalConfigNosystem === undefined)
      delete process.env['GIT_CONFIG_NOSYSTEM'];
    else process.env['GIT_CONFIG_NOSYSTEM'] = originalConfigNosystem;
    if (originalConfigGlobal === undefined)
      delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = originalConfigGlobal;
    rmSync(repo, { recursive: true, force: true });
  });

  const run = (argv: Record<string, unknown>) =>
    (guardCheckCommand.handler as (a: unknown) => void)({
      _: ['audit', 'guard-check'],
      ...argv,
    });

  it('exits 5 when the dirs are exposed and no plan is given', () => {
    run({ reportSlug: 'mod' });
    expect(process.exitCode).toBe(5);
    const printed = JSON.parse(
      vi.mocked(writeStdoutLine).mock.calls[0][0],
    ) as GuardReport;
    expect(printed.dirs[0].status).toBe('unprotected');
  });

  it('exits 0 when the dirs are ignored', () => {
    writeFileSync(join(repo, '.gitignore'), '.qwen/audits/\n.qwen/tmp/\n');
    run({ reportSlug: 'mod' });
    expect(process.exitCode).toBeUndefined();
  });

  it('fails closed on a corrupt plan: the baseline drops, the trip fires', () => {
    const planPath = join(repo, 'plan.json');
    writeFileSync(planPath, '{"guard": ');
    run({ reportSlug: 'mod', plan: planPath });
    expect(vi.mocked(writeStderrLine).mock.calls[0][0]).toContain(
      'not valid JSON',
    );
    // Exposed dirs with no plan-time baseline re-fire.
    expect(process.exitCode).toBe(5);
  });

  it('fails closed on a valid-JSON wrong-shape guard section', () => {
    // A raw TypeError out of guardTripped would exit 1 and bypass the
    // exit-5 relocation path; the unusable section degrades to a missing
    // baseline instead.
    const planPath = join(repo, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ guard: {} }));
    run({ reportSlug: 'mod', plan: planPath });
    expect(process.exitCode).toBe(5);
  });

  it('does not credit a plan in the repo: the relocation never happened', () => {
    // The .gitignore verifies the fallback landing, so planRelocated's
    // containment check is the deciding arm (with the landing unverified
    // the test would pass even if containment always answered true).
    writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    const inRepoPlan = join(repo, 'plan.json');
    writeFileSync(inRepoPlan, JSON.stringify({ guard: planTime }));
    run({ reportSlug: 'mod', plan: inRepoPlan });
    expect(process.exitCode).toBe(5);
  });

  it('does not credit a relocation whose fallback root is itself exposed', () => {
    // QWEN_HOME inside the worktree (the beforeEach fixture): the fallback
    // root sits inside a repo with nothing ignoring it, so crediting the
    // relocation would certify committable artifacts at exit 0.
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    const relocatedPlan = join(fallback, PINNED_PLAN_NAME);
    writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
    run({ reportSlug: 'mod', plan: relocatedPlan });
    expect(process.exitCode).toBe(5);
  });

  it('credits a relocation to a fallback outside any worktree', () => {
    const outsideHome = mkdtempSync(join(tmpdir(), 'audit-qwen-home-'));
    try {
      process.env['QWEN_HOME'] = outsideHome;
      const fallback = Storage.getAuditFallbackDir(repo);
      const planTime = report('unprotected', 'unprotected');
      planTime.fallbackRoot = fallback;
      const relocatedPlan = join(fallback, PINNED_PLAN_NAME);
      writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
      run({ reportSlug: 'mod', plan: relocatedPlan });
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(outsideHome, { recursive: true, force: true });
    }
  });

  it('credits a relocation to an in-worktree fallback that is ignored', () => {
    // The fallback inside the worktree is safe exactly when git says the
    // landing is ignored there.
    writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    const relocatedPlan = join(fallback, PINNED_PLAN_NAME);
    writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
    run({ reportSlug: 'mod', plan: relocatedPlan });
    expect(process.exitCode).toBeUndefined();
  });

  it('drops the relocation credit for a plan under a name the writer never emits', () => {
    // The credit's "the original is gone" proof looks for the pinned name
    // under .qwen/tmp. Keyed on the handed basename instead, `--plan
    // <fallback>/anything.json` asks about a file that never existed, and
    // the real audit-plan-<ts>.json keeps sitting there committable while
    // the guard reports the relocation complete.
    writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    // Deliberately NOT the pinned name: that is the whole point here.
    const relocatedPlan = join(fallback, 'plan.json');
    writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
    run({ reportSlug: 'mod', plan: relocatedPlan });
    expect(process.exitCode).toBe(5);
  });

  it('drops the relocation credit for an unsafe report slug', () => {
    // The argv slug is agent-transcribed and interpolated into probe
    // paths: a traversal shape must not re-home the probe (a foreign
    // ignore rule would answer ignored and credit the relocation), and
    // exit 5 must re-fire instead.
    writeFileSync(join(repo, '.gitignore'), 'qwen-home/\ndecoy.md\n');
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    const relocatedPlan = join(fallback, PINNED_PLAN_NAME);
    writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
    run({ reportSlug: '../../decoy', plan: relocatedPlan });
    expect(process.exitCode).toBe(5);
  });

  // The PATH shim stands in for a git that answers only outside the
  // fallback landing — the fallback probe fails without an answer while
  // the main guard probes stay healthy.
  it.skipIf(process.platform === 'win32')(
    'does not credit a relocation whose fallback probe has no answer',
    () => {
      writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
      const shimDir = join(repo, 'git-shim');
      mkdirSync(shimDir, { recursive: true });
      const savedPath = process.env['PATH'];
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\nfor arg in "$@"; do case "$arg" in *qwen-home*) exit 3;; esac; done\nPATH="${savedPath}" exec git "$@"\n`,
      );
      chmodSync(join(shimDir, 'git'), 0o755);
      process.env['PATH'] = `${shimDir}${delimiter}${savedPath ?? ''}`;
      try {
        const fallback = Storage.getAuditFallbackDir(repo);
        const planTime = report('unprotected', 'unprotected');
        planTime.fallbackRoot = fallback;
        const relocatedPlan = join(fallback, PINNED_PLAN_NAME);
        writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
        run({ reportSlug: 'mod', plan: relocatedPlan });
        expect(process.exitCode).toBe(5);
      } finally {
        process.env['PATH'] = savedPath;
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not credit a symlinked plan: the original stays committable',
    () => {
      writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
      const fallback = Storage.getAuditFallbackDir(repo);
      const planTime = report('unprotected', 'unprotected');
      planTime.fallbackRoot = fallback;
      // The plan "lands" at the fallback only as a symlink; its target
      // remains where it can be committed.
      const original = join(repo, PINNED_PLAN_NAME);
      writeFileSync(original, JSON.stringify({ guard: planTime }));
      const linked = join(fallback, PINNED_PLAN_NAME);
      symlinkSync(original, linked);
      run({ reportSlug: 'mod', plan: linked });
      expect(process.exitCode).toBe(5);
    },
  );

  it('does not credit a copied plan whose original remains in .qwen/tmp', () => {
    writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    // A killed mid-relocation leaves the original under .qwen/tmp while a
    // copy sits at the fallback: the stageable original voids the credit.
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    const original = join(
      repo,
      '.qwen',
      'tmp',
      'audit-plan-2026-08-13-120000.json',
    );
    const body = JSON.stringify({ guard: planTime });
    writeFileSync(original, body);
    const copied = join(fallback, 'audit-plan-2026-08-13-120000.json');
    writeFileSync(copied, body);
    run({ reportSlug: 'mod', plan: copied });
    expect(process.exitCode).toBe(5);
  });

  it('does not credit a relocation killed before every tmp artifact moved', () => {
    // Step 0 writes the args record BEFORE the guard verdict; a relocation
    // killed after the plan lands leaves it committable in the exposed
    // directory, so the plan file's departure alone never proves the
    // multi-file move completed.
    writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'audit-args-2026-08-13-120000.json'),
      '{}',
    );
    const body = JSON.stringify({ guard: planTime });
    writeFileSync(join(fallback, PINNED_PLAN_NAME), body);
    run({ reportSlug: 'mod', plan: join(fallback, PINNED_PLAN_NAME) });
    expect(process.exitCode).toBe(5);
  });

  it('does not credit a plan whose hardlink twin stays committable in the repo', () => {
    writeFileSync(join(repo, '.gitignore'), 'qwen-home/\n');
    const fallback = Storage.getAuditFallbackDir(repo);
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    // The relocation renames the plan out of .qwen/tmp, but a hardlink
    // twin keeps a stageable copy at an in-repo path the containment
    // checks can never see — nlink > 1 voids the credit.
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    const planName = 'audit-plan-2026-08-13-120000.json';
    const original = join(repo, '.qwen', 'tmp', planName);
    writeFileSync(original, JSON.stringify({ guard: planTime }));
    linkSync(original, join(repo, 'docs', planName));
    renameSync(original, join(fallback, planName));
    run({ reportSlug: 'mod', plan: join(fallback, planName) });
    expect(process.exitCode).toBe(5);
  });

  it('fails closed when only the post-midnight report shape is re-included at the landing', () => {
    // The relocated report is written at write time: a checkpoint before
    // midnight must probe the next calendar date's report shape at the
    // landing, mirroring checkLocalOnlyGuard's next-date probe.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-15T23:59:00'));
      const fallback = Storage.getAuditFallbackDir(repo);
      const hash = basename(fallback);
      writeFileSync(
        join(repo, '.gitignore'),
        [
          'qwen-home/*',
          '!qwen-home/audits/',
          'qwen-home/audits/*',
          `!qwen-home/audits/${hash}/`,
          `qwen-home/audits/${hash}/*`,
          `!qwen-home/audits/${hash}/2026-08-16-*.md`,
        ].join('\n'),
      );
      const planTime = report('unprotected', 'unprotected');
      planTime.fallbackRoot = fallback;
      const relocatedPlan = join(fallback, PINNED_PLAN_NAME);
      writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
      run({ reportSlug: 'mod', plan: relocatedPlan });
      expect(process.exitCode).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes the recovered plan ts in the primary directories', () => {
    // The artifacts keep their plan-time timestamp: a checkpoint probing
    // only its own instant's names never asks about the plan-ts-named
    // file, so a name-selective re-include keyed to the plan ts escapes
    // every checkpoint.
    const planTs = '2026-08-13-120000';
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      join(repo, '.gitignore'),
      [
        '.qwen/*',
        '!.qwen/tmp/',
        '.qwen/tmp/*',
        `!.qwen/tmp/audit-plan-${planTs}.json`,
      ].join('\n'),
    );
    const planPath = join(repo, '.qwen', 'tmp', `audit-plan-${planTs}.json`);
    writeFileSync(planPath, JSON.stringify({ guard: report('ok', 'ok') }));
    run({ reportSlug: 'mod', plan: planPath });
    expect(process.exitCode).toBe(5);
  });

  it('does not credit a relocation when a tmp shape is re-included at the landing', () => {
    // The relocation lands the whole tmp class at the fallback root; a
    // name-selective re-include of ONE shape must void the credit even
    // when the probed report and sidecar shapes stay ignored.
    const fallback = Storage.getAuditFallbackDir(repo);
    const hash = basename(fallback);
    writeFileSync(
      join(repo, '.gitignore'),
      [
        'qwen-home/*',
        '!qwen-home/audits/',
        'qwen-home/audits/*',
        `!qwen-home/audits/${hash}/`,
        `qwen-home/audits/${hash}/*`,
        `!qwen-home/audits/${hash}/audit-findings-specialist-01-*.md`,
      ].join('\n'),
    );
    const planTime = report('unprotected', 'unprotected');
    planTime.fallbackRoot = fallback;
    const relocatedPlan = join(fallback, PINNED_PLAN_NAME);
    writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
    run({ reportSlug: 'mod', plan: relocatedPlan });
    expect(process.exitCode).toBe(5);
  });

  it('probes the plan’s own reportSlug over the agent-transcribed argv slug', () => {
    // A name-selective re-include keyed on the REAL slug stays invisible
    // to a misnamed probe: the plan's artifacts.reportSlug is
    // authoritative for the probed name.
    writeFileSync(
      join(repo, '.gitignore'),
      '.qwen/*\n!.qwen/audits/\n.qwen/audits/*\n!.qwen/audits/[0-9]*-mod.md\n',
    );
    const planPath = join(repo, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({ artifacts: { reportSlug: 'mod' } }),
    );
    // argv slug misnamed on purpose: with the plan's slug honored, the
    // re-included report name is probed and the guard fires.
    run({ reportSlug: 'm0d', plan: planPath });
    expect(process.exitCode).toBe(5);
  });
});
