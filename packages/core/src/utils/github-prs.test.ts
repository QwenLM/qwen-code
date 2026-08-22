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
  createGitHubPullRequest,
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
    ['passing', [{ __typename: 'CheckRun', conclusion: 'NEUTRAL' }]],
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

  it('maps the gh state field to merged/closed, falling back to isDraft', () => {
    const result = parseGhPrList(
      JSON.stringify([
        ghPrEntry({ number: 1, state: 'MERGED' }),
        ghPrEntry({ number: 2, state: 'CLOSED' }),
        ghPrEntry({ number: 3, state: 'OPEN' }),
        ghPrEntry({ number: 4, state: 'OPEN', isDraft: true }),
      ]),
    );
    expect(result.map((pr) => pr.state)).toEqual([
      'merged',
      'closed',
      'open',
      'draft',
    ]);
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
      expect.objectContaining({ cwd: dir, timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it('uses slim fields and the requested state/limit when asked', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhSuccess([ghPrEntry({ state: 'MERGED' })]);

    const result = await fetchGitHubPullRequests(dir, undefined, {
      state: 'all',
      limit: 500,
      slim: true,
    });

    expect(result).toEqual({
      kind: 'ok',
      pullRequests: [expect.objectContaining({ number: 1, state: 'merged' })],
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '500',
        '--json',
        'number,url,headRefName,state',
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

  it('names the timeout when gh is killed after the deadline', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(
      Object.assign(new Error('Command failed: gh pr list --state open'), {
        killed: true,
        stderr: '',
      }),
    );

    const result = await fetchGitHubPullRequests(dir);

    expect(result).toEqual({
      kind: 'failed',
      message: 'gh pr list timed out after 10s',
      gitRoot: dir,
    });
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
      gitRoot: dir,
    });
  });

  it('keeps stderr past the display cap so the route can sanitize paths', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    // Push the absolute path beyond the 512-char display cap; core must not
    // cut it off before the route redacts it.
    const padding = 'x'.repeat(600);
    mockGhError(
      Object.assign(new Error('exit 1'), {
        stderr: `${padding} ${dir} denied`,
      }),
    );

    const result = await fetchGitHubPullRequests(dir);

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.message).toContain(`${dir} denied`);
      expect(result.message.length).toBeGreaterThan(512);
    }
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

describe('createGitHubPullRequest', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-create-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('clears repository-shifting git env vars when spawning gh pr create', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    vi.stubEnv('GIT_DIR', '/somewhere/else/.git');
    vi.stubEnv('GIT_WORK_TREE', '/somewhere/else');
    let seenEnv: Record<string, string | undefined> | undefined;
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, opts: unknown, cb: unknown) => {
        seenEnv = (opts as { env?: Record<string, string | undefined> }).env;
        (cb as ExecCallback)(null, 'https://github.com/o/r/pull/42\n', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    const result = await createGitHubPullRequest(dir, { title: 'My PR' });

    expect(result).toEqual({
      kind: 'ok',
      url: 'https://github.com/o/r/pull/42',
      number: 42,
    });
    expect(seenEnv).toBeDefined();
    expect(seenEnv).not.toHaveProperty('GIT_DIR');
    expect(seenEnv).not.toHaveProperty('GIT_WORK_TREE');
  });

  it('forwards a workspace env while still stripping repository selectors', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    let seenEnv: Record<string, string | undefined> | undefined;
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, opts: unknown, cb: unknown) => {
        seenEnv = (opts as { env?: Record<string, string | undefined> }).env;
        (cb as ExecCallback)(null, 'https://github.com/o/r/pull/7\n', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    const result = await createGitHubPullRequest(
      dir,
      { title: 'My PR' },
      { GH_TOKEN: 'ws-token', GH_REPO: 'evil/repo', PATH: '/usr/bin' },
    );

    expect(result).toEqual({
      kind: 'ok',
      url: 'https://github.com/o/r/pull/7',
      number: 7,
    });
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.['GH_TOKEN']).toBe('ws-token');
    expect(seenEnv).not.toHaveProperty('GH_REPO');
  });
});
