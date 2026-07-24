/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  fetchGitHubPullRequests,
  parseGhPrList,
  GITHUB_PR_LIST_LIMIT,
} from './github-prs.js';

const mockExecFile = vi.mocked(execFile);

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function mockGhSuccess(payload: unknown) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCallback)(null, JSON.stringify(payload), '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function mockGhError(error: Error & { code?: string; stderr?: string }) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCallback)(error, '', error.stderr ?? '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function ghPrEntry(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/o/r/pull/1',
    author: { login: 'octocat' },
    headRefName: 'fix/thing',
    isDraft: false,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    updatedAt: '2026-07-24T10:00:00Z',
    ...overrides,
  };
}

describe('parseGhPrList', () => {
  it('maps gh entries to the daemon shape and sorts by updatedAt desc', () => {
    const older = ghPrEntry({
      number: 1,
      updatedAt: '2026-07-20T10:00:00Z',
    });
    const newer = ghPrEntry({
      number: 2,
      isDraft: true,
      reviewDecision: null,
      updatedAt: '2026-07-24T10:00:00Z',
    });

    const result = parseGhPrList(JSON.stringify([older, newer]));

    expect(result.map((pr) => pr.number)).toEqual([2, 1]);
    expect(result[0]).toMatchObject({
      state: 'draft',
      reviewDecision: null,
      checks: 'passing',
      updatedAt: Math.floor(Date.parse('2026-07-24T10:00:00Z') / 1000),
    });
    expect(result[1]).toMatchObject({
      state: 'open',
      reviewDecision: 'approved',
    });
  });

  it('maps every review decision variant', () => {
    const entries = [
      ghPrEntry({ number: 1, reviewDecision: 'APPROVED' }),
      ghPrEntry({ number: 2, reviewDecision: 'CHANGES_REQUESTED' }),
      ghPrEntry({ number: 3, reviewDecision: 'REVIEW_REQUIRED' }),
      ghPrEntry({ number: 4, reviewDecision: '' }),
    ];
    const result = parseGhPrList(JSON.stringify(entries));
    expect(result.map((pr) => pr.reviewDecision)).toEqual([
      'approved',
      'changes_requested',
      'review_required',
      null,
    ]);
  });

  it.each([
    ['failing', [{ __typename: 'CheckRun', conclusion: 'FAILURE' }]],
    ['failing', [{ __typename: 'CheckRun', conclusion: 'CANCELLED' }]],
    ['failing', [{ __typename: 'StatusContext', state: 'ERROR' }]],
    ['pending', [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }]],
    ['pending', [{ __typename: 'StatusContext', state: 'PENDING' }]],
    [
      'pending',
      [
        { __typename: 'CheckRun', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'EXPECTED' },
      ],
    ],
    [
      'passing',
      [
        { __typename: 'CheckRun', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', conclusion: 'SKIPPED' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
      ],
    ],
    ['none', []],
  ])('aggregates checks to %s', (expected, rollup) => {
    const result = parseGhPrList(
      JSON.stringify([ghPrEntry({ statusCheckRollup: rollup })]),
    );
    expect(result[0]?.checks).toBe(expected);
  });

  it('failing wins over pending and passing', () => {
    const result = parseGhPrList(
      JSON.stringify([
        ghPrEntry({
          statusCheckRollup: [
            { __typename: 'CheckRun', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', status: 'QUEUED' },
            { __typename: 'StatusContext', state: 'FAILURE' },
          ],
        }),
      ]),
    );
    expect(result[0]?.checks).toBe('failing');
  });

  it('drops entries without a numeric PR number and tolerates missing fields', () => {
    const result = parseGhPrList(
      JSON.stringify([
        { title: 'no number' },
        ghPrEntry({ author: null, reviewDecision: null, updatedAt: 'bad' }),
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      author: '',
      reviewDecision: null,
      updatedAt: 0,
    });
  });

  it('throws on non-array output', () => {
    expect(() => parseGhPrList('{"oops":true}')).toThrow(
      'unexpected gh output',
    );
  });
});

describe('fetchGitHubPullRequests', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns not_a_repo outside a git repository and never spawns gh', async () => {
    const result = await fetchGitHubPullRequests(dir);

    expect(result).toEqual({ kind: 'not_a_repo' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs gh pr list at the git root with the expected arguments', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    const nested = path.join(dir, 'sub', 'dir');
    fs.mkdirSync(nested, { recursive: true });
    mockGhSuccess([ghPrEntry()]);

    const result = await fetchGitHubPullRequests(nested);

    expect(result).toEqual({
      kind: 'ok',
      pullRequests: [expect.objectContaining({ number: 1, state: 'open' })],
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        String(GITHUB_PR_LIST_LIMIT),
        '--json',
        expect.stringContaining('reviewDecision'),
      ],
      expect.objectContaining({ cwd: dir }),
      expect.any(Function),
    );
  });

  it('returns cli_unavailable when gh is not installed', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(
      Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    );

    const result = await fetchGitHubPullRequests(dir);

    expect(result).toEqual({ kind: 'cli_unavailable' });
  });

  it('returns failed with a single-line stderr message when gh exits non-zero', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(
      Object.assign(new Error('exit 1'), {
        stderr: 'gh: not logged in\nRun gh auth login',
      }),
    );

    const result = await fetchGitHubPullRequests(dir);

    expect(result).toEqual({
      kind: 'failed',
      message: 'gh: not logged in Run gh auth login',
    });
  });

  it('returns failed when gh emits invalid JSON', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(null, 'not json', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    const result = await fetchGitHubPullRequests(dir);

    expect(result.kind).toBe('failed');
  });
});
