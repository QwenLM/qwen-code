/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '@qwen-code/qwen-code-core';
import { guardCheckCommand, guardTripped } from './guard-check.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import type {
  GuardDirReport,
  GuardReport,
  GuardStatus,
} from './lib/files-plan.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

function report(audits: GuardStatus, tmp: GuardStatus): GuardReport {
  const mk = (dir: string, status: GuardStatus): GuardDirReport => ({
    dir,
    representative: `${dir}/probe`,
    ignored: status === 'ok',
    trackedFiles: [],
    status,
  });
  return {
    dirs: [mk('.qwen/audits', audits), mk('.qwen/tmp', tmp)],
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
    const relocatedPlan = join(fallback, 'plan.json');
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
      const relocatedPlan = join(fallback, 'plan.json');
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
    const relocatedPlan = join(fallback, 'plan.json');
    writeFileSync(relocatedPlan, JSON.stringify({ guard: planTime }));
    run({ reportSlug: 'mod', plan: relocatedPlan });
    expect(process.exitCode).toBeUndefined();
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
