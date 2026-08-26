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
  fetchAttributionRepoKeys,
  fetchCurrentBranchName,
  fetchCurrentBranchPullRequest,
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  normalizeRemoteToWebUrl,
  parseGhPrList,
  repoKeyFromWebUrl,
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
        // The full field set must request `state` too: a non-slim
        // `--state all` query without it maps every merged/closed PR as
        // open/draft.
        expect.stringMatching(/reviewDecision.*state/),
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
        'number,url,headRefName,state,updatedAt',
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

describe('normalizeRemoteToWebUrl', () => {
  it('normalizes https remotes, stripping .git', () => {
    expect(normalizeRemoteToWebUrl('https://github.com/o/r.git')).toBe(
      'https://github.com/o/r',
    );
  });

  it('normalizes scp-style ssh remotes', () => {
    expect(normalizeRemoteToWebUrl('git@github.com:o/r.git')).toBe(
      'https://github.com/o/r',
    );
  });

  it('normalizes ssh:// remotes', () => {
    expect(normalizeRemoteToWebUrl('ssh://git@github.com/o/r')).toBe(
      'https://github.com/o/r',
    );
  });

  it('keeps enterprise hosts', () => {
    expect(normalizeRemoteToWebUrl('git@code.example.com:team/repo.git')).toBe(
      'https://code.example.com/team/repo',
    );
  });

  it('drops the port an ssh:// remote carries', () => {
    expect(
      normalizeRemoteToWebUrl('ssh://git@host.example.com:2222/team/repo.git'),
    ).toBe('https://host.example.com/team/repo');
  });

  it('accepts any scp-style user, not only git@', () => {
    expect(normalizeRemoteToWebUrl('jdoe@gitlab.corp:team/repo.git')).toBe(
      'https://gitlab.corp/team/repo',
    );
  });

  it('rejects garbage and non-http protocols', () => {
    expect(normalizeRemoteToWebUrl('not a url')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('git://github.com/o/r')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('')).toBeUndefined();
  });

  it('rejects Windows drive-letter local-path origins', () => {
    // `git clone C:\\src\\origin.git` leaves a drive path as the remote;
    // it matches the scp shape with the drive letter as "host" and would
    // otherwise fabricate https://c//src/origin. Real hostnames are never
    // a single character; drive letters always are.
    expect(normalizeRemoteToWebUrl('C:\\src\\origin.git')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('D:/repos/origin.git')).toBeUndefined();
  });
});

describe('repoKeyFromWebUrl', () => {
  it('extracts host/owner/repo from web and PR URLs', () => {
    expect(repoKeyFromWebUrl('https://github.com/o/r')).toBe('github.com/o/r');
    expect(repoKeyFromWebUrl('https://github.com/o/r/pull/42')).toBe(
      'github.com/o/r',
    );
  });

  it('lowercases host, owner, and repo', () => {
    expect(repoKeyFromWebUrl('https://GitHub.com/Owner/Repo/pull/1')).toBe(
      'github.com/owner/repo',
    );
  });

  it('canonicalizes a www. host prefix', () => {
    // An origin remote spelled with www. must key identically to gh's own
    // page URLs or the repo gate never matches them.
    expect(repoKeyFromWebUrl('https://www.github.com/o/r')).toBe(
      'github.com/o/r',
    );
  });

  it('returns undefined for non-http URLs and missing path segments', () => {
    expect(repoKeyFromWebUrl('javascript:alert(1)')).toBeUndefined();
    expect(repoKeyFromWebUrl('https://github.com/o')).toBeUndefined();
    expect(repoKeyFromWebUrl('not a url')).toBeUndefined();
  });
});

describe('fetchRemoteWebUrl', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-remote-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves and normalizes the origin remote', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        expect(args).toEqual(['remote', 'get-url', 'origin']);
        (cb as ExecCallback)(null, 'git@github.com:o/r.git\n', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchRemoteWebUrl(dir)).toBe('https://github.com/o/r');
  });

  it('returns undefined outside a git repository without spawning git', async () => {
    expect(await fetchRemoteWebUrl(dir)).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns undefined when git fails (no origin)', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(
          new Error('fatal: no remote named origin'),
          '',
          '',
        );
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchRemoteWebUrl(dir)).toBeUndefined();
  });
});

describe('fetchCurrentBranchPullRequest', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-branch-pr-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves number, url, state, and head branch from gh', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        expect(args).toEqual([
          'pr',
          'view',
          '--json',
          'number,url,state,headRefName',
        ]);
        (cb as ExecCallback)(
          null,
          JSON.stringify({
            number: 77,
            url: 'https://github.com/o/r/pull/77',
            state: 'OPEN',
            headRefName: 'feat/x',
          }),
          '',
        );
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'pr',
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'open',
      headRefName: 'feat/x',
    });
  });

  it('fails closed when gh reports no recognizable state', async () => {
    // A retry that resolves the branch's existing PR must never bind on a
    // shape the caller cannot gate on — an unparseable pre-state is an
    // error, not a proved absence.
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhSuccess({ number: 77, url: 'https://github.com/o/r/pull/77' });
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'SOMETHING_NEW',
    });
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
  });

  it('reports none when gh proves the branch has no PR', async () => {
    // gh exits non-zero with a characteristic message when the branch
    // simply has no PR — a proved absence, distinct from a fetch failure.
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(
      Object.assign(new Error('exit code 1'), {
        stderr: 'no pull requests found for branch "feat/x"',
      }),
    );
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'none',
    });
  });

  it('reports error when the gh fetch fails', async () => {
    // Timeouts, rate limits, and auth failures prove nothing about the
    // branch's PRs; the attribution gate must decline on them instead of
    // reading them as "no prior PR".
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(Object.assign(new Error('network timeout'), { killed: true }));
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
  });

  it('reports error outside a git repository without spawning gh', async () => {
    // No repo proves nothing about a branch's PR — a gate-passing command
    // may clone the repo into the working dir and resolve its existing PR
    // post-run — so the pre-state fails closed instead of reading as
    // "no prior PR".
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('fetchCurrentBranchName', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-branch-name-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the checked-out branch', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        expect(args).toEqual(['branch', '--show-current']);
        (cb as ExecCallback)(null, 'feat/x\n', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchCurrentBranchName(dir)).toBe('feat/x');
  });

  it('returns undefined outside a git repository without spawning git', async () => {
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns undefined on a detached HEAD or git failure', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(null, '', '');
        return {} as ReturnType<typeof execFile>;
      },
    );
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();

    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(new Error('not a git repository'), '', '');
        return {} as ReturnType<typeof execFile>;
      },
    );
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();
  });
});

describe('fetchAttributionRepoKeys', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-repo-keys-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the repo key and the fork-parent key', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        expect(args).toEqual(['repo', 'view', '--json', 'url,parent']);
        (cb as ExecCallback)(
          null,
          JSON.stringify({
            url: 'https://github.com/fork/r',
            parent: { url: 'https://github.com/parent/r' },
          }),
          '',
        );
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchAttributionRepoKeys(dir)).toEqual({
      resolved: 'github.com/fork/r',
      parent: 'github.com/parent/r',
    });
  });

  it('omits the parent key for a non-fork repo', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhSuccess({ url: 'https://github.com/o/r', parent: {} });
    expect(await fetchAttributionRepoKeys(dir)).toEqual({
      resolved: 'github.com/o/r',
    });
  });

  it('returns no keys outside a git repository without spawning gh', async () => {
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('fails closed when gh cannot answer', async () => {
    // An unresolvable pre-run identity must decline attribution, not read
    // as "any repo may bind".
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(Object.assign(new Error('network timeout'), { killed: true }));
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});

    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(null, 'not json', '');
        return {} as ReturnType<typeof execFile>;
      },
    );
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});
  });
});
