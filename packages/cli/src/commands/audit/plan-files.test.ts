/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planFilesCommand } from './plan-files.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

describe('planFilesCommand handler', () => {
  let repo: string;
  let target: string;
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
    repo = mkdtempSync(join(tmpdir(), 'audit-plan-files-'));
    process.env['QWEN_HOME'] = join(repo, 'qwen-home');
    // Process-level git-config hermeticity: the guard's in-process
    // check-ignore probes spawn git with the ambient process.env, so
    // pinning only the `git init` subprocess leaks a host global exclude
    // (e.g. one ignoring .qwen/) into the verdicts.
    writeFileSync(join(repo, 'empty-gitconfig'), '');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = join(repo, 'empty-gitconfig');
    // Scrubbed fixture env: the repository-selecting variables override
    // `-C` resolution, so an ambient GIT_DIR re-homes this `git init`
    // into a foreign repository (and GIT_WORK_TREE without GIT_DIR is a
    // hard fatal) — the same scrub gitEnv() applies to the probes.
    const initEnv: NodeJS.ProcessEnv = { ...process.env };
    delete initEnv['GIT_DIR'];
    delete initEnv['GIT_WORK_TREE'];
    delete initEnv['GIT_INDEX_FILE'];
    delete initEnv['GIT_OBJECT_DIRECTORY'];
    execFileSync('git', ['init', '-q'], { cwd: repo, env: initEnv });
    target = join(repo, 'mod');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.ts'), 'const a = 1;\n');
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
    (planFilesCommand.handler as (a: unknown) => void)({
      _: ['audit', 'plan-files'],
      ...argv,
    });

  it('writes the plan and prints it on success', () => {
    const out = join(repo, 'plan.json');
    run({ path: 'mod', out });
    expect(process.exitCode).toBeUndefined();
    const plan = JSON.parse(readFileSync(out, 'utf8')) as {
      effort: string;
      subjectFiles: unknown[];
    };
    expect(plan.effort).toBe('medium');
    expect(plan.subjectFiles).toHaveLength(1);
    expect(vi.mocked(writeStdoutLine)).toHaveBeenCalled();
  });

  it('refuses an empty target with exit 3 and the refusal JSON', () => {
    const empty = join(repo, 'empty');
    mkdirSync(empty);
    const out = join(repo, 'refusal.json');
    run({ path: 'empty', out });
    expect(process.exitCode).toBe(3);
    const refusal = JSON.parse(readFileSync(out, 'utf8')) as {
      reason: string;
    };
    expect(refusal.reason).toBe('empty-subjects');
  });

  it('honors an explicit --effort over the args-report verdict', () => {
    const argsReport = join(repo, 'args.json');
    writeFileSync(
      argsReport,
      JSON.stringify({
        targetPath: 'mod',
        targetPathAbsolute: target,
        effort: 'low',
      }),
    );
    const lowOut = join(repo, 'low.json');
    run({ argsReport, out: lowOut });
    expect(JSON.parse(readFileSync(lowOut, 'utf8')).effort).toBe('low');
    const mediumOut = join(repo, 'medium.json');
    run({ argsReport, effort: 'medium', out: mediumOut });
    expect(JSON.parse(readFileSync(mediumOut, 'utf8')).effort).toBe('medium');
  });

  it('surfaces a relative targetPathAbsolute with the regenerate error', () => {
    // Absolute is load-bearing: the consumer resolve()'s a relative value
    // against the invocation cwd and plans against whatever sits there.
    const relReport = join(repo, 'rel-args.json');
    writeFileSync(
      relReport,
      JSON.stringify({
        targetPath: 'mod',
        targetPathAbsolute: 'relative/mod',
        effort: 'medium',
      }),
    );
    expect(() => run({ argsReport: relReport, out: 'o' })).toThrow(
      /not a parse-args verdict/,
    );
  });

  it('re-validates a recorded target that vanished after parse-args', () => {
    const argsReport = join(repo, 'stale-args.json');
    writeFileSync(
      argsReport,
      JSON.stringify({
        targetPath: 'gone',
        targetPathAbsolute: join(repo, 'gone'),
        effort: 'medium',
      }),
    );
    expect(() => run({ argsReport, out: join(repo, 'p.json') })).toThrow(
      /Path does not exist/,
    );
  });

  it('enforces the either-or guard on truthiness, not undefined-ness', () => {
    expect(() => run({ path: 'mod', argsReport: 'x', out: 'o' })).toThrow(
      /exactly one of/,
    );
    // An empty-string value used to slip past the === undefined check and
    // crash the reader.
    expect(() => run({ argsReport: '', out: 'o' })).toThrow(/exactly one of/);
    expect(() => run({ out: 'o' })).toThrow(/exactly one of/);
  });

  it('surfaces a truncated args-report with the designed diagnostic', () => {
    const corrupt = join(repo, 'corrupt-args.json');
    writeFileSync(corrupt, '{"targetPath": ');
    expect(() => run({ argsReport: corrupt, out: 'o' })).toThrow(
      /not a parse-args verdict/,
    );
  });

  it('surfaces a JSON-literal-null args-report with the same diagnostic', () => {
    // JSON.parse('null') succeeds and bypasses the parse try/catch; the
    // shape check must not dereference null.
    const nullReport = join(repo, 'null-args.json');
    writeFileSync(nullReport, 'null');
    expect(() => run({ argsReport: nullReport, out: 'o' })).toThrow(
      /not a parse-args verdict/,
    );
  });

  it('surfaces an unwritable --out with a clean diagnostic', () => {
    // A file squatting where the --out parent belongs used to throw a raw
    // EEXIST out of the handler, replacing the designed exit codes; the
    // write goes through the clean diagnostic instead.
    const squatter = join(repo, 'squatter');
    writeFileSync(squatter, 'x');
    expect(() =>
      run({ path: 'mod', out: join(squatter, 'nested', 'plan.json') }),
    ).toThrow(/plan-files: cannot write/);
  });

  it('applies the exclude remedy only when the plan succeeds', () => {
    const excludeFile = join(repo, '.git', 'info', 'exclude');
    // A refusing run leaves the mutation out.
    const empty = join(repo, 'empty');
    mkdirSync(empty);
    run({ path: 'empty', out: join(repo, 'r.json'), applyExcludeRemedy: true });
    expect(process.exitCode).toBe(3);
    // git init creates the exclude file; the REFUSING run must not add rules.
    expect(readFileSync(excludeFile, 'utf8')).not.toContain('/.qwen/audits/');
    // A succeeding run applies it, and the re-probe sees the flip.
    process.exitCode = undefined;
    run({ path: 'mod', out: join(repo, 'p.json'), applyExcludeRemedy: true });
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(excludeFile, 'utf8')).toContain('/.qwen/audits/');
    const plan = JSON.parse(readFileSync(join(repo, 'p.json'), 'utf8')) as {
      guard: { dirs: Array<{ status: string }> };
    };
    expect(plan.guard.dirs.every((d) => d.status === 'ok')).toBe(true);
  });
});
