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
  GITHUB_PR_ISSUES_BATCH_SIZE,
  buildPullRequestIssuesQuery,
  fetchGitHubPullRequestIssues,
  parsePullRequestIssuesResponse,
} from './github-pr-issues.js';

const mockExecFile = vi.mocked(execFile);

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function mockGh(
  responder: (args: string[]) => {
    error?: Error & { code?: string; stderr?: string };
    stdout?: string;
  },
) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
      const { error, stdout } = responder(args as string[]);
      (cb as ExecCallback)(error ?? null, stdout ?? '', error?.stderr ?? '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function prNode(
  number: number,
  issues: Array<{ number: number; state: string; stateReason?: string }>,
) {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    closingIssuesReferences: {
      nodes: issues.map((issue) => ({
        number: issue.number,
        url: `https://github.com/o/r/issues/${issue.number}`,
        state: issue.state,
        stateReason: issue.stateReason ?? null,
      })),
    },
  };
}

describe('buildPullRequestIssuesQuery', () => {
  it('aliases one pullRequest lookup per number with a capped closing list', () => {
    const query = buildPullRequestIssuesQuery([42, 7]);
    expect(query).toContain('query($owner: String!, $name: String!)');
    expect(query).toContain('p42: pullRequest(number: 42)');
    expect(query).toContain('p7: pullRequest(number: 7)');
    expect(query).toContain('closingIssuesReferences(first: 10)');
    expect(query).toContain('{ number url state stateReason }');
  });
});

describe('parsePullRequestIssuesResponse', () => {
  it('maps GitHub issue states, dropping unresolved aliases and malformed nodes', () => {
    const payload = {
      data: {
        repository: {
          p1: prNode(1, [
            { number: 10, state: 'OPEN' },
            { number: 11, state: 'CLOSED', stateReason: 'COMPLETED' },
            { number: 12, state: 'CLOSED', stateReason: 'NOT_PLANNED' },
            { number: 13, state: 'CLOSED', stateReason: 'DUPLICATE' },
          ]),
          p2: {
            number: 2,
            url: 'https://github.com/o/r/pull/2',
            closingIssuesReferences: {
              nodes: [{ number: 'x', url: 'https://github.com/o/r/issues/9' }],
            },
          },
          p3: null,
        },
      },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'p3'] }],
    };

    const result = parsePullRequestIssuesResponse(JSON.stringify(payload));

    expect([...result.keys()]).toEqual([1, 2]);
    expect(result.get(1)?.issues.map((issue) => issue.state)).toEqual([
      'open',
      'completed',
      'not_planned',
      'not_planned',
    ]);
    expect(result.get(1)?.issues[0]).toEqual({
      number: 10,
      url: 'https://github.com/o/r/issues/10',
      state: 'open',
    });
    expect(result.get(2)).toEqual({
      url: 'https://github.com/o/r/pull/2',
      issues: [],
    });
  });

  it('throws when the payload carries no repository data', () => {
    expect(() =>
      parsePullRequestIssuesResponse(JSON.stringify({ message: 'bad' })),
    ).toThrow(/repository data/);
    expect(() =>
      parsePullRequestIssuesResponse(
        JSON.stringify({ data: { repository: null } }),
      ),
    ).toThrow(/repository data/);
  });
});

describe('fetchGitHubPullRequestIssues', () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-pr-issues-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns not_a_repo outside a git repository and never spawns gh', async () => {
    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
      kind: 'not_a_repo',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs gh api graphql at the git root with the repository placeholders', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    const nested = path.join(dir, 'sub');
    fs.mkdirSync(nested);
    mockGh(() => ({
      stdout: JSON.stringify({
        data: {
          repository: { p42: prNode(42, [{ number: 7, state: 'OPEN' }]) },
        },
      }),
    }));

    const result = await fetchGitHubPullRequestIssues(
      nested,
      { GH_TOKEN: 'x' },
      [42],
    );

    expect(result).toEqual({
      kind: 'ok',
      pullRequests: new Map([
        [
          42,
          {
            url: 'https://github.com/o/r/pull/42',
            issues: [
              {
                number: 7,
                url: 'https://github.com/o/r/issues/7',
                state: 'open',
              },
            ],
          },
        ],
      ]),
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        'graphql',
        '-F',
        'owner={owner}',
        '-F',
        'name={repo}',
        '-f',
        expect.stringContaining('p42: pullRequest(number: 42)'),
      ],
      expect.objectContaining({
        cwd: dir,
        timeout: 10_000,
        env: expect.objectContaining({ GH_TOKEN: 'x' }),
      }),
      expect.any(Function),
    );
  });

  it('keeps the resolved aliases when gh exits non-zero over a NOT_FOUND number', async () => {
    // A binding to another repository's same-numbered PR does not resolve
    // here; gh reports the GraphQL error with a non-zero exit but still
    // prints every other alias.
    fs.mkdirSync(path.join(dir, '.git'));
    mockGh(() => ({
      error: Object.assign(new Error('gh: Could not resolve'), {
        stderr: 'gh: Could not resolve to a PullRequest',
      }),
      stdout: JSON.stringify({
        data: { repository: { p1: prNode(1, []), p2: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'p2'] }],
      }),
    }));

    const result = await fetchGitHubPullRequestIssues(dir, undefined, [1, 2]);

    expect(result.kind).toBe('ok');
    expect([
      ...(result.kind === 'ok' ? result.pullRequests.keys() : []),
    ]).toEqual([1]);
  });

  it('maps a missing gh binary to cli_unavailable', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGh(() => ({
      error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    }));

    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
      kind: 'cli_unavailable',
    });
  });

  it('reports a failure without output and a payload without data', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGh(() => ({
      error: Object.assign(new Error('exit 1'), {
        stderr: 'HTTP 401: Bad credentials',
      }),
    }));
    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
      kind: 'failed',
      message: 'HTTP 401: Bad credentials',
      gitRoot: dir,
    });

    mockGh(() => ({ stdout: JSON.stringify({ message: 'Server Error' }) }));
    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
      kind: 'failed',
      message: expect.stringContaining('repository data'),
      gitRoot: dir,
    });
  });

  it('chunks large number lists, deduping and dropping invalid numbers', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    const queries: string[] = [];
    mockGh((args) => {
      const query = args[args.length - 1]!;
      queries.push(query);
      const numbers = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map(
        (match) => Number(match[1]),
      );
      return {
        stdout: JSON.stringify({
          data: {
            repository: Object.fromEntries(
              numbers.map((number) => [`p${number}`, prNode(number, [])]),
            ),
          },
        }),
      };
    });
    const numbers = Array.from(
      { length: GITHUB_PR_ISSUES_BATCH_SIZE + 1 },
      (_, index) => index + 1,
    );

    const result = await fetchGitHubPullRequestIssues(dir, undefined, [
      ...numbers,
      1,
      0,
      -3,
      2.5,
    ]);

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.pullRequests.size : 0).toBe(
      GITHUB_PR_ISSUES_BATCH_SIZE + 1,
    );
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain(
      `p${GITHUB_PR_ISSUES_BATCH_SIZE + 1}: pullRequest`,
    );
    expect(queries[1]).not.toContain('p1: pullRequest');
  });

  it('fails the whole call when a later chunk fails', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    let calls = 0;
    mockGh(() => {
      calls += 1;
      return calls === 1
        ? {
            stdout: JSON.stringify({
              data: { repository: { p1: prNode(1, []) } },
            }),
          }
        : { error: Object.assign(new Error('boom'), { stderr: 'timeout' }) };
    });
    const numbers = Array.from(
      { length: GITHUB_PR_ISSUES_BATCH_SIZE + 1 },
      (_, index) => index + 1,
    );

    expect(await fetchGitHubPullRequestIssues(dir, undefined, numbers)).toEqual(
      {
        kind: 'failed',
        message: 'timeout',
        gitRoot: dir,
      },
    );
  });
});
