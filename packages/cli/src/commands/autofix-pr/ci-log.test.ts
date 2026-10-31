/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeFileSync,
  symlinkSync,
  lstatSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  gh: vi.fn((..._args: string[]): string => ''),
  root: '',
  stdout: vi.fn((_line: string) => {}),
}));

vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  gh: mocks.gh,
  ensureAuthenticated: () => {},
}));

vi.mock('./state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state.js')>()),
  watchRoot: () => mocks.root,
  resolveWatchRoot: () => mocks.root,
  requireState: () => ({ host: 'github.com', owner: 'o', repo: 'r' }),
  assertOwnedBySession: () => {},
  assertWatching: () => {},
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLineSafe: () => {},
}));

import { runCiLog, tailJob } from './ci-log.js';

describe('tailJob', () => {
  const file = (lines: string[]) => `${lines.join('\n')}\n`;

  it('keeps the last lines of a job and says how many were dropped', () => {
    expect(file(tailJob('build', 'one\ntwo\nthree\n', 2))).toBe(
      [
        'build\t… 1 earlier lines omitted',
        'build\ttwo',
        'build\tthree',
        '',
      ].join('\n'),
    );
    expect(file(tailJob('test', 'alpha', 2))).toBe('test\talpha\n');
  });

  it('ends a job at its last error, before the post-job steps', () => {
    const log = [
      'Run npm test',
      'FAIL a.test.ts',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.',
      'Cleaning up orphan processes',
    ].join('\n');
    expect(file(tailJob('test', log, 2))).toBe(
      [
        'test\t… 1 earlier lines omitted',
        'test\tFAIL a.test.ts',
        'test\t##[error]Process completed with exit code 1.',
        'test\t… 2 later lines omitted',
        '',
      ].join('\n'),
    );
  });

  it('keeps a short log whole', () => {
    expect(file(tailJob('test', 'ok', 200))).toBe('test\tok\n');
  });

  it('keeps a tail longer than the engine takes as arguments', () => {
    const log = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const text = file(tailJob('test', log, 200_000));
    expect(text.endsWith('test\tline 199999\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(200_001);
  });
});

describe('runCiLog', () => {
  beforeEach(() => {
    mocks.root = mkdtempSync(join(tmpdir(), 'autofix-ci-log-'));
    mkdirSync(join(mocks.root, '.qwen', 'tmp'), { recursive: true });
    mocks.gh.mockReset();
    mocks.stdout.mockReset();
  });

  afterEach(() => {
    rmSync(mocks.root, { recursive: true, force: true });
  });

  it('refuses a line count that would keep the whole log', () => {
    for (const lines of [0, -5, Number.NaN, 1.5]) {
      expect(() => runCiLog(7, 1, lines)).toThrow(/positive integer/);
    }
  });

  it('refuses a malformed PR number or run id', () => {
    expect(() => runCiLog(Number.NaN, 1, 200)).toThrow(/PR number/);
    expect(() => runCiLog(7, 1.5, 200)).toThrow(/run id/);
  });

  // `gh run view --log-failed` refuses a run that is still in progress, which
  // is when snapshot first reports the failed job.
  it('reads finished failed jobs one by one while the run is still going', () => {
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args.includes('--paginate')) {
        return [
          '{"id":1,"name":"Lint","conclusion":"success"}',
          '{"id":2,"name":"Test","conclusion":"failure"}',
          '{"id":3,"name":"E2E","conclusion":"timed_out"}',
        ].join('\n');
      }
      const id = args.at(-1)!.match(/jobs\/(\d+)\/logs/)![1];
      return `\u001b[31merror in job ${id}\u001b[0m`;
    });
    runCiLog(7, 456, 200);
    expect(mocks.gh.mock.calls[0]).toContain(
      'repos/o/r/actions/runs/456/jobs?per_page=30',
    );
    expect(mocks.gh.mock.calls.slice(1).map((call) => call.at(-1))).toEqual([
      'repos/o/r/actions/jobs/2/logs',
      'repos/o/r/actions/jobs/3/logs',
    ]);
    const { path, jobs } = JSON.parse(mocks.stdout.mock.calls[0][0]);
    expect(jobs).toEqual(['Test', 'E2E']);
    expect(readFileSync(path, 'utf8')).toBe(
      'Test\terror in job 2\nE2E\terror in job 3\n',
    );
  });

  it('replaces a link planted at its log path instead of writing through it', () => {
    mocks.gh.mockImplementation((...args: string[]) =>
      args.includes('--paginate')
        ? '{"id":2,"name":"Test","conclusion":"failure"}'
        : 'boom',
    );
    const outside = join(mocks.root, 'outside.txt');
    writeFileSync(outside, 'keep me');
    const log = join(mocks.root, '.qwen', 'tmp', 'autofix-pr-7-ci-456.log');
    symlinkSync(outside, log);
    runCiLog(7, 456, 200);
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    expect(lstatSync(log).isFile()).toBe(true);
    expect(readFileSync(log, 'utf8')).toBe('Test\tboom\n');
  });

  it('falls back for a gh without --allow-escape-sequences', () => {
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args.includes('--paginate')) {
        return '{"id":2,"name":"Test","conclusion":"failure"}';
      }
      if (args.includes('--allow-escape-sequences')) {
        throw Object.assign(new Error('gh failed'), {
          stderr: 'unknown flag: --allow-escape-sequences',
        });
      }
      return 'boom';
    });
    runCiLog(7, 456, 200);
    expect(mocks.gh.mock.calls.at(-1)).toEqual([
      'api',
      'repos/o/r/actions/jobs/2/logs',
    ]);
    const { path } = JSON.parse(mocks.stdout.mock.calls[0][0]);
    expect(readFileSync(path, 'utf8')).toBe('Test\tboom\n');
  });

  it('lists the jobs left once its time is spent, so the shell never kills it unwritten', () => {
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args.includes('--paginate')) {
        return [
          '{"id":2,"name":"Test","conclusion":"failure"}',
          '{"id":3,"name":"E2E","conclusion":"failure"}',
        ].join('\n');
      }
      clock += 9 * 60_000;
      return 'boom';
    });
    try {
      runCiLog(7, 456, 200);
    } finally {
      now.mockRestore();
    }
    const { path, jobs } = JSON.parse(mocks.stdout.mock.calls[0][0]);
    expect(jobs).toEqual(['Test', 'E2E']);
    expect(readFileSync(path, 'utf8')).toBe(
      'Test\tboom\nE2E\tlog unavailable: ci-log ran out of time; the jobs above were read\n',
    );
  });

  it('counts the listing of the jobs in its time', () => {
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args.includes('--paginate')) {
        clock += 9 * 60_000;
        return '{"id":2,"name":"Test","conclusion":"failure"}';
      }
      return 'boom';
    });
    try {
      runCiLog(7, 456, 200);
    } finally {
      now.mockRestore();
    }
    const { path } = JSON.parse(mocks.stdout.mock.calls[0][0]);
    expect(readFileSync(path, 'utf8')).toBe(
      'Test\tlog unavailable: ci-log ran out of time; the jobs above were read\n',
    );
    // The listing is all that was asked.
    expect(mocks.gh).toHaveBeenCalledTimes(1);
  });

  it('keeps the other logs when one cannot be read', () => {
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args.includes('--paginate')) {
        return [
          '{"id":2,"name":"Test","conclusion":"failure"}',
          '{"id":3,"name":"E2E","conclusion":"failure"}',
        ].join('\n');
      }
      if (args.at(-1)!.includes('jobs/3/')) {
        throw Object.assign(new Error('gh failed'), {
          stderr: 'HTTP 404: Not Found\n',
        });
      }
      return 'boom';
    });
    runCiLog(7, 456, 200);
    const { path, jobs } = JSON.parse(mocks.stdout.mock.calls[0][0]);
    expect(jobs).toEqual(['Test', 'E2E']);
    expect(readFileSync(path, 'utf8')).toBe(
      'Test\tboom\nE2E\tlog unavailable: HTTP 404: Not Found\n',
    );
  });

  it('refuses a run with no finished failed job instead of writing an empty log', () => {
    mocks.gh.mockImplementation((...args: string[]) =>
      args.includes('--paginate')
        ? '{"id":1,"name":"Lint","conclusion":"success"}'
        : '',
    );
    expect(() => runCiLog(7, 456, 200)).toThrow(
      /run 456 has no finished job that failed or timed out/,
    );
    expect(mocks.stdout).not.toHaveBeenCalled();
    expect(
      existsSync(join(mocks.root, '.qwen', 'tmp', 'autofix-pr-7-ci-456.log')),
    ).toBe(false);
  });
});
