/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import yargs from 'yargs';
import { GATE_OUTPUT_BUDGET_BYTES } from './lib/gate-budget.js';
import { getGhHost, setGhHost } from './lib/gh.js';

const mocks = vi.hoisted(() => ({
  gh: vi.fn((..._args: string[]): string => ''),
  root: '',
  stdout: vi.fn((_line: string) => {}),
}));

vi.mock('./lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/gh.js')>()),
  gh: mocks.gh,
  ensureAuthenticated: () => {},
}));

vi.mock('./lib/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/git.js')>()),
  repoRoot: () => mocks.root,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLineSafe: () => {},
}));

import {
  diffRepoWatch,
  runWatchRepo,
  watchRepoCommand,
  watchRepoCursorPath,
  type RepoPr,
  type WatchRepoCursor,
  type WatchRepoFilters,
} from './watch-repo.js';

function pr(
  number: number,
  overrides: Omit<Partial<RepoPr>, 'labels'> & {
    labels?: string[];
    requested?: string[];
  } = {},
): RepoPr {
  const { labels, requested, ...rest } = overrides;
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    isDraft: false,
    headRefOid: `${number}`.padEnd(40, 'a'),
    baseRefName: 'main',
    author: { login: 'alice', __typename: 'User' },
    labels: { nodes: (labels ?? []).map((name) => ({ name })) },
    reviewRequests: {
      nodes: (requested ?? []).map((login) => ({
        requestedReviewer: { login },
      })),
    },
    ...rest,
  };
}

const NO_FILTERS: WatchRepoFilters = {
  authors: [],
  labels: [],
  reviewRequested: false,
  excludeDrafts: false,
  excludeBots: false,
  excludeMine: false,
};

function cursor(overrides: Partial<WatchRepoCursor> = {}): WatchRepoCursor {
  return {
    version: 1,
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    viewer: 'me',
    initialized: true,
    heads: {},
    ...overrides,
  };
}

describe('diffRepoWatch', () => {
  it('records the open PRs silently on the first run', () => {
    const result = diffRepoWatch(
      [pr(1), pr(2)],
      cursor({ initialized: false }),
      NO_FILTERS,
      false,
    );
    expect(result.events).toEqual([]);
    expect(result.cursor.initialized).toBe(true);
    expect(Object.keys(result.cursor.heads)).toEqual(['1', '2']);
  });

  it('reports opened, pushed and ready PRs after that', () => {
    const before = cursor({
      heads: {
        '1': { sha: pr(1).headRefOid, draft: false },
        '2': { sha: 'old'.padEnd(40, '0'), draft: false },
        '3': { sha: pr(3).headRefOid, draft: true },
      },
    });
    const result = diffRepoWatch(
      [pr(1), pr(2), pr(3), pr(4, { labels: ['bug'], requested: ['me'] })],
      before,
      NO_FILTERS,
      false,
    );
    expect(result.events.map((e) => [e.type, e.number])).toEqual([
      ['pr_pushed', 2],
      ['pr_ready', 3],
      ['pr_opened', 4],
    ]);
    expect(result.events[2]).toMatchObject({
      title: 'PR 4',
      author: 'alice',
      url: 'https://github.com/o/r/pull/4',
      baseRef: 'main',
      labels: ['bug'],
      reviewRequested: true,
    });
    expect(result.cursor.heads['2']!.sha).toBe(pr(2).headRefOid);
    expect(result.cursor.heads['3']!.draft).toBe(false);
  });

  it('is quiet when nothing changed', () => {
    const before = diffRepoWatch(
      [pr(1)],
      cursor({ initialized: false }),
      NO_FILTERS,
      false,
    ).cursor;
    const result = diffRepoWatch([pr(1)], before, NO_FILTERS, false);
    expect(result.events).toEqual([]);
    expect(result.cursor).toEqual(before);
  });

  it('drops closed PRs from the cursor unless the list may have been cut', () => {
    const before = cursor({
      heads: {
        '1': { sha: pr(1).headRefOid, draft: false },
        '9': { sha: 'x', draft: false },
      },
    });
    expect(
      Object.keys(
        diffRepoWatch([pr(1)], before, NO_FILTERS, false).cursor.heads,
      ),
    ).toEqual(['1']);
    expect(
      Object.keys(
        diffRepoWatch([pr(1)], before, NO_FILTERS, true).cursor.heads,
      ),
    ).toEqual(['1', '9']);
  });

  it('carries at most one more page of unseen PRs, newest first', () => {
    const before = cursor({
      heads: Object.fromEntries(
        [1, 2, 3, 4, 5, 10].map((n) => [
          String(n),
          { sha: pr(n).headRefOid, draft: false },
        ]),
      ),
    });
    const after = diffRepoWatch([pr(10), pr(11)], before, NO_FILTERS, true);
    expect(Object.keys(after.cursor.heads)).toEqual(['4', '5', '10', '11']);
    expect(after.events.map((e) => [e.type, e.number])).toEqual([
      ['pr_opened', 11],
    ]);
    // A dropped PR that comes back is new to the cursor.
    const back = diffRepoWatch([pr(2), pr(10)], after.cursor, NO_FILTERS, true);
    expect(back.events.map((e) => [e.type, e.number])).toEqual([
      ['pr_opened', 2],
    ]);
  });

  it('applies the filters to events but follows every PR', () => {
    const prs = [
      pr(1, { author: { login: 'me', __typename: 'User' } }),
      pr(2, { author: { login: 'dependabot', __typename: 'Bot' } }),
      pr(3, { isDraft: true }),
      pr(4, { labels: ['area/cli'] }),
      pr(5, { requested: ['me'] }),
      pr(6, { author: { login: 'bob', __typename: 'User' } }),
    ];
    const run = (filters: Partial<WatchRepoFilters>) =>
      diffRepoWatch(
        prs,
        cursor(),
        { ...NO_FILTERS, ...filters },
        false,
      ).events.map((e) => e.number);
    expect(run({})).toEqual([1, 2, 3, 4, 5, 6]);
    expect(run({ excludeMine: true })).toEqual([2, 3, 4, 5, 6]);
    expect(run({ excludeBots: true })).toEqual([1, 3, 4, 5, 6]);
    expect(run({ excludeDrafts: true })).toEqual([1, 2, 4, 5, 6]);
    expect(run({ labels: ['area/cli'] })).toEqual([4]);
    expect(run({ reviewRequested: true })).toEqual([5]);
    expect(run({ authors: ['bob'] })).toEqual([6]);
    // Logins and labels compare without case, as on GitHub.
    expect(run({ authors: ['Bob'] })).toEqual([6]);
    expect(run({ labels: ['Area/CLI'] })).toEqual([4]);
    // Every PR is in the cursor even when the filters hid it.
    const filtered = diffRepoWatch(
      prs,
      cursor(),
      { ...NO_FILTERS, authors: ['bob'] },
      false,
    );
    expect(Object.keys(filtered.cursor.heads)).toHaveLength(6);
  });
});

describe('watchRepoCursorPath', () => {
  const name = (host: string, owner: string, repo: string) =>
    relative('/root', watchRepoCursorPath('/root', host, owner, repo));

  it('gives every spelling of one repository the same file', () => {
    expect(name('GHE.Corp', 'Acme', 'Web')).toBe(
      name('ghe.corp', 'acme', 'web'),
    );
    expect(name('github.com:443', 'o', 'r')).toBe(name('github.com', 'o', 'r'));
  });

  it('gives each filter set a file of its own, whatever its spelling', () => {
    const at = (filters: Partial<WatchRepoFilters>) =>
      relative(
        '/root',
        watchRepoCursorPath('/root', 'github.com', 'o', 'r', {
          ...NO_FILTERS,
          ...filters,
        }),
      );
    expect(at({})).toBe(name('github.com', 'o', 'r'));
    expect(basename(at({ labels: ['ready'] }))).toMatch(
      /^r@[0-9a-f]{12}\.json$/,
    );
    expect(at({ labels: ['ready'] })).not.toBe(at({ reviewRequested: true }));
    expect(at({ labels: ['Ready', 'b'], authors: ['Alice'] })).toBe(
      at({ labels: ['b', 'ready', 'ready'], authors: ['alice'] }),
    );
  });

  it('keeps a port out of the file name and repositories apart', () => {
    expect(basename(name('ghe.corp:8443', 'o', 'r'))).toBe('r.json');
    expect(name('ghe.corp:8443', 'o', 'r')).not.toContain(':');
    expect(name('ghe.corp:8443', 'o', 'r')).not.toBe(
      name('ghe.corp', 'o', 'r'),
    );
    expect(name('github.com', 'acme', 'web-api')).not.toBe(
      name('github.com', 'acme-web', 'api'),
    );
  });
});

describe('runWatchRepo', () => {
  const args = {
    ...NO_FILTERS,
    repo: 'o/r',
    host: 'github.com',
    limit: 2,
  };
  const path = () => watchRepoCursorPath(mocks.root, 'github.com', 'o', 'r');
  const onDisk = () =>
    JSON.parse(readFileSync(path(), 'utf8')) as WatchRepoCursor;
  const answer = (viewer: string, prs: RepoPr[], hasNextPage: boolean) =>
    mocks.gh.mockReturnValueOnce(
      JSON.stringify({
        data: {
          viewer: { login: viewer },
          repository: {
            pullRequests: { pageInfo: { hasNextPage }, nodes: prs },
          },
        },
      }),
    );

  const printed = () =>
    mocks.stdout.mock.calls.map(
      (call) =>
        JSON.parse(call[0]) as {
          repo: string;
          events: Array<{ type: string; number: number }>;
          deferred?: number;
        },
    );
  let savedHost: string | undefined;

  beforeEach(() => {
    mocks.root = mkdtempSync(join(tmpdir(), 'review-watch-'));
    mocks.gh.mockReset();
    mocks.stdout.mockReset();
    savedHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    setGhHost(undefined);
  });

  afterEach(() => {
    rmSync(mocks.root, { recursive: true, force: true });
    if (savedHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedHost;
    setGhHost(undefined);
  });

  it('asks for the repository it names and prints it with the events', () => {
    answer('me', [pr(1)], false);
    runWatchRepo({ ...args, repo: 'O/R' });
    expect(mocks.gh.mock.calls[0]).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringMatching(
        /reviewRequests[\s\S]*headRefOid|headRefOid[\s\S]*reviewRequests/,
      ),
      '-f',
      'owner=O',
      '-f',
      'name=R',
      '-F',
      'first=2',
    ]);
    answer('me', [pr(1), pr(2)], false);
    runWatchRepo({ ...args, repo: 'O/R' });
    expect(printed()).toEqual([
      {
        repo: 'O/R',
        events: [expect.objectContaining({ type: 'pr_opened', number: 2 })],
      },
    ]);
  });

  it("asks the host it was given and keeps that host's cursor apart", () => {
    answer('me', [pr(1)], false);
    runWatchRepo({ ...args, host: 'ghe.corp:8443' });
    expect(getGhHost()).toBe('ghe.corp:8443');
    expect(
      existsSync(watchRepoCursorPath(mocks.root, 'ghe.corp:8443', 'o', 'r')),
    ).toBe(true);
    expect(existsSync(path())).toBe(false);
  });

  it('refuses a blank --host instead of asking whatever host gh defaults to', () => {
    process.env['GH_HOST'] = 'ghe.corp';
    expect(() => runWatchRepo({ ...args, host: '  ' })).toThrow(TypeError);
    expect(mocks.gh).not.toHaveBeenCalled();
  });

  it('carries PRs past the cut of the list', () => {
    answer('me', [pr(3), pr(2)], false);
    runWatchRepo(args);
    answer('me', [pr(4), pr(3)], true);
    runWatchRepo(args);
    expect(Object.keys(onDisk().heads).sort()).toEqual(['2', '3', '4']);
    expect(
      printed().map((p) => p.events.map((e) => [e.type, e.number])),
    ).toEqual([[['pr_opened', 4]]]);
  });

  it("keeps tasks with different filters from taking each other's transitions", () => {
    const labelled = { ...args, labels: ['ready'] };
    const requested = { ...args, reviewRequested: true };
    answer('me', [pr(7)], false);
    runWatchRepo(labelled);
    answer('me', [pr(7)], false);
    runWatchRepo(requested);
    const pushed = pr(7, { headRefOid: 'f'.repeat(40), requested: ['me'] });
    // The labelled task sees the push first; the PR is not labelled.
    answer('me', [pushed], false);
    runWatchRepo(labelled);
    answer('me', [pushed], false);
    runWatchRepo(requested);
    expect(
      printed().map((p) => p.events.map((e) => [e.type, e.number])),
    ).toEqual([[['pr_pushed', 7]]]);
  });

  it('leaves what does not fit the gate output to the next run', () => {
    const many = (sha: string) =>
      Array.from({ length: 60 }, (_, i) =>
        pr(i + 1, { title: 'x'.repeat(250), headRefOid: sha.repeat(40) }),
      );
    answer('me', many('a'), false);
    runWatchRepo({ ...args, limit: 100 });
    answer('me', many('b'), false);
    runWatchRepo({ ...args, limit: 100 });
    answer('me', many('b'), false);
    runWatchRepo({ ...args, limit: 100 });
    answer('me', many('b'), false);
    runWatchRepo({ ...args, limit: 100 });
    const lines = mocks.stdout.mock.calls.map((call) => call[0]);
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(
        GATE_OUTPUT_BUDGET_BYTES,
      );
    }
    const runs = printed();
    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0]!.deferred).toBe(60 - runs[0]!.events.length);
    expect(runs.at(-1)!.deferred).toBeUndefined();
    const numbers = runs.flatMap((run) => run.events.map((e) => e.number));
    expect(numbers.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
  });

  it('reports new PRs that do not fit on a later run, as opened', () => {
    answer('me', [], false);
    runWatchRepo({ ...args, limit: 100 });
    const many = Array.from({ length: 60 }, (_, i) =>
      pr(i + 1, { title: 'x'.repeat(250) }),
    );
    for (let run = 0; run < 4; run++) {
      answer('me', many, false);
      runWatchRepo({ ...args, limit: 100 });
    }
    const events = printed().flatMap((run) => run.events);
    expect(printed().length).toBeGreaterThan(1);
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['pr_opened']));
    expect(events.map((e) => e.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
  });

  it('maps the command line onto the run, filters included', async () => {
    answer('me', [pr(1), pr(2)], false);
    answer(
      'me',
      [
        pr(1, { headRefOid: 'c'.repeat(40) }),
        pr(2, { headRefOid: 'd'.repeat(40), requested: ['me'] }),
      ],
      false,
    );
    const run = () =>
      yargs()
        .command(watchRepoCommand)
        .parseAsync([
          'watch-repo',
          '--repo',
          'o/r',
          '--limit',
          '2',
          '--review-requested',
        ]);
    await run();
    await run();
    expect(
      printed().map((p) => p.events.map((e) => [e.type, e.number])),
    ).toEqual([[['pr_pushed', 2]]]);
    expect(mocks.gh.mock.calls[0]).toContain('first=2');
  });

  it('records a new viewer even when no PR changed', () => {
    answer('me', [pr(1)], false);
    runWatchRepo(args);
    answer('other', [pr(1)], false);
    runWatchRepo(args);
    expect(onDisk().viewer).toBe('other');
    expect(mocks.stdout).not.toHaveBeenCalled();
  });

  it('drops a closed PR when exactly --limit PRs are open and none is cut', () => {
    answer('me', [pr(1), pr(2)], false);
    runWatchRepo(args);
    expect(Object.keys(onDisk().heads)).toEqual(['1', '2']);

    // #2 closed, #3 opened: still two PRs, the whole list.
    answer('me', [pr(1), pr(3)], false);
    runWatchRepo(args);
    expect(Object.keys(onDisk().heads)).toEqual(['1', '3']);
    // #2 reopened: new to the cursor again.
    answer('me', [pr(2), pr(3)], false);
    runWatchRepo(args);
    const printed = mocks.stdout.mock.calls.map(
      (call) =>
        JSON.parse(call[0]) as {
          events: Array<{ type: string; number: number }>;
        },
    );
    expect(printed.at(-1)!.events.map((e) => [e.type, e.number])).toEqual([
      ['pr_opened', 2],
    ]);
  });
});
