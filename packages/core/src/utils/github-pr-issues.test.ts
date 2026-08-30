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
  SESSION_PR_ISSUE_LIST_LIMIT,
  buildPullRequestIssuesQuery,
  fetchGitHubPullRequestIssues,
  parsePullRequestIssuesResponse,
} from './github-pr-issues.js';

const mockExecFile = vi.mocked(execFile);

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

// Mirrors execFile's real callback shape: stderr arrives as the third
// argument, and the error object itself carries none.
function mockGh(
  responder: (args: string[]) => {
    error?: Error & { code?: string; killed?: boolean };
    stdout?: string;
    stderr?: string;
  },
) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
      const { error, stdout, stderr } = responder(args as string[]);
      (cb as ExecCallback)(error ?? null, stdout ?? '', stderr ?? '');
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
    // The variables must feed the repository scope; gh rejects a document
    // that declares but never uses them.
    expect(query).toContain('repository(owner: $owner, name: $name)');
    expect(query).toContain('p42: pullRequest(number: 42)');
    expect(query).toContain('p7: pullRequest(number: 7)');
    // The sidecar reader voids the whole file above its per-PR cap, so the
    // fetch bound must be that very constant, not a look-alike literal.
    expect(query).toContain(
      `closingIssuesReferences(first: ${SESSION_PR_ISSUE_LIST_LIMIT})`,
    );
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
            // Legacy closed issues carry no reason at all.
            { number: 14, state: 'CLOSED' },
          ]),
          p2: {
            number: 2,
            url: 'https://github.com/o/r/pull/2',
            closingIssuesReferences: {
              nodes: [
                { number: 'x', url: 'https://github.com/o/r/issues/9' },
                { number: 0, url: 'https://github.com/o/r/issues/0' },
                { number: 1.5, url: 'https://github.com/o/r/issues/1' },
                { number: 3 },
              ],
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
      'completed',
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

  it('rejects any partial error other than an alias-level NOT_FOUND', () => {
    // Absence must mean "no such PR": a server error nulling one alias, or
    // a sub-field error nulling a resolved PR's closing references, would
    // otherwise retire a merged binding with a false empty snapshot.
    const withError = (error: unknown) =>
      JSON.stringify({
        data: { repository: { p1: prNode(1, []), p2: null } },
        errors: [error],
      });
    expect(() =>
      parsePullRequestIssuesResponse(
        withError({
          type: 'INTERNAL_SERVER_ERROR',
          path: ['repository', 'p2'],
        }),
      ),
    ).toThrow(/partial error/);
    expect(() =>
      parsePullRequestIssuesResponse(
        withError({
          type: 'NOT_FOUND',
          path: ['repository', 'p1', 'closingIssuesReferences'],
        }),
      ),
    ).toThrow(/partial error/);
    expect(() =>
      parsePullRequestIssuesResponse(withError({ message: 'no type at all' })),
    ).toThrow(/partial error/);
    expect(
      parsePullRequestIssuesResponse(
        withError({ type: 'NOT_FOUND', path: ['repository', 'p2'] }),
      ).size,
    ).toBe(1);
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
      // GH_REPO would redirect gh's `{owner}`/`{repo}` placeholders to
      // another repository; the sanitized env must not carry it.
      { GH_TOKEN: 'x', GH_REPO: 'other/repo' },
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
        `query=${buildPullRequestIssuesQuery([42])}`,
      ],
      expect.objectContaining({
        cwd: dir,
        timeout: 10_000,
        env: expect.objectContaining({ GH_TOKEN: 'x' }),
      }),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({ GH_REPO: 'other/repo' }),
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
      error: new Error('gh: Could not resolve'),
      stderr: 'gh: Could not resolve to a PullRequest',
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

  it('keeps the timeout message when a killed gh left a truncated payload', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGh(() => ({
      error: Object.assign(new Error('killed'), { killed: true }),
      stdout: '{"data":{"repository":{"p1":{"number":1,"url":"https://gi',
    }));

    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
      kind: 'failed',
      message: 'gh api graphql timed out after 10s',
      gitRoot: dir,
    });
  });

  it('fails the call on a partial error that is not an alias-level NOT_FOUND', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGh(() => ({
      error: new Error('exit 1'),
      stderr: 'gh: server error',
      stdout: JSON.stringify({
        data: { repository: { p1: prNode(1, []), p2: null } },
        errors: [{ type: 'INTERNAL_SERVER_ERROR', path: ['repository', 'p2'] }],
      }),
    }));

    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1, 2])).toEqual({
      kind: 'failed',
      message: expect.stringContaining('partial error'),
      gitRoot: dir,
    });
  });

  it('maps a repository gh cannot resolve to repo_unresolved', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    // One fixture per diagnostic the classifier accepts — gh's wording is
    // no contract, so each alternative is pinned on its own.
    for (const stderr of [
      'no git remotes found\n',
      'error parsing "owner" value: no git remotes found',
      'none of the git remotes configured for this repository point to a known GitHub host',
    ]) {
      mockGh(() => ({ error: new Error('exit 1'), stderr }));
      expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
        kind: 'repo_unresolved',
      });
    }
    // A GH_HOST pointing at another host is an environment problem: gh's
    // own message says unsetting the variable fixes it, so it must stay a
    // transient failure and never retire bindings.
    mockGh(() => ({
      error: new Error('exit 1'),
      stderr:
        'error parsing "owner" value: none of the git remotes configured for this repository correspond to the GH_HOST environment variable. Try adding a matching remote or unsetting the variable.',
    }));
    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
      kind: 'failed',
      message: expect.stringContaining('GH_HOST'),
      gitRoot: dir,
    });
  });

  it('maps a repository GitHub no longer serves to repo_unresolved', async () => {
    // Renamed, deleted, or access revoked: gh resolves the placeholders
    // from the remote, and GitHub answers NOT_FOUND on the repository
    // itself — structural, so merged bindings must converge on it.
    fs.mkdirSync(path.join(dir, '.git'));
    mockGh(() => ({
      error: new Error('exit 1'),
      stderr: 'gh: Could not resolve to a Repository',
      stdout: JSON.stringify({
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', path: ['repository'] }],
      }),
    }));

    expect(await fetchGitHubPullRequestIssues(dir, undefined, [1])).toEqual({
      kind: 'repo_unresolved',
    });
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
      error: new Error('exit 1'),
      stderr: 'HTTP 401: Bad credentials',
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
    expect(queries.join(' ')).not.toMatch(/number: (-3|0|2\.5)\)/);
  });

  it('never puts a non-safe integer into the document', async () => {
    // 1e21 passes `Number.isInteger` but stringifies as `1e+21`, an invalid
    // Int literal that fails the entire query rather than one alias.
    fs.mkdirSync(path.join(dir, '.git'));
    let query = '';
    mockGh((args) => {
      query = args[args.length - 1]!;
      return {
        stdout: JSON.stringify({
          data: { repository: { p7: prNode(7, []) } },
        }),
      };
    });

    const result = await fetchGitHubPullRequestIssues(dir, undefined, [
      1e21,
      Number.MAX_SAFE_INTEGER + 2,
      7,
    ]);

    expect(result.kind).toBe('ok');
    expect(query).toContain('p7: pullRequest(number: 7)');
    expect(query).not.toContain('1e+21');
    expect(query).not.toContain(String(Number.MAX_SAFE_INTEGER + 2));
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
        : { error: new Error('boom'), stderr: 'timeout' };
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
