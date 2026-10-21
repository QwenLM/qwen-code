/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  repoRoot: () => mocks.root,
  requireState: () => ({ host: 'github.com', owner: 'o', repo: 'r' }),
  assertOwnedBySession: () => {},
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLineSafe: () => {},
}));

import { runCiLog, tailPerJob } from './ci-log.js';

describe('tailPerJob', () => {
  it('keeps the last lines of each job and says how many were dropped', () => {
    const jobs = [
      { name: 'build', log: 'one\ntwo\nthree\n' },
      { name: 'test', log: 'alpha' },
    ];
    expect(tailPerJob(jobs, 2)).toEqual({
      text: [
        'build\t… 1 earlier lines omitted',
        'build\ttwo',
        'build\tthree',
        'test\talpha',
        '',
      ].join('\n'),
      jobs: ['build', 'test'],
    });
  });

  it('ends each job at its last error, before the post-job steps', () => {
    const log = [
      'Run npm test',
      'FAIL a.test.ts',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.',
      'Cleaning up orphan processes',
    ].join('\n');
    expect(tailPerJob([{ name: 'test', log }], 2).text).toBe(
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
    expect(tailPerJob([{ name: 'test', log: 'ok' }], 200)).toEqual({
      text: 'test\tok\n',
      jobs: ['test'],
    });
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
      'repos/o/r/actions/runs/456/jobs?per_page=100',
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
});
