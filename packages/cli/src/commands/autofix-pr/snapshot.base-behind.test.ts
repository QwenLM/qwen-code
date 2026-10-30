/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setGhHost } from '../review/lib/gh.js';
import { baseIsBehind, runSnapshot, type PrData } from './snapshot.js';
import { autofixPrPaths, writeState, type AutofixPrState } from './state.js';

const mockGh = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  root: '',
  stdout: vi.fn((_line: string) => {}),
  remoteRef: vi.fn((): string | null => null),
}));
vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  gh: mockGh,
  ensureAuthenticated: () => {},
}));
vi.mock('./state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state.js')>()),
  watchRoot: () => mocks.root,
  resolveWatchRoot: () => mocks.root,
}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLineSafe: () => {},
}));
vi.mock('./worktree.js', () => ({
  remoteRef: mocks.remoteRef,
}));

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const COMPARE_PATH = `repos/o/r/compare/main...${HEAD}`;

function state(overrides: Partial<AutofixPrState> = {}): AutofixPrState {
  return {
    version: 1,
    sessionId: 's1',
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    remote: 'origin',
    pushTarget: 'origin',
    headRefName: 'feat',
    baseRefName: 'main',
    branch: 'qwen-autofix/pr-7',
    worktreePath: '/repo/.qwen/tmp/autofix-pr-7',
    viewer: 'me',
    prAuthor: 'me',
    lastKnownHeadSha: HEAD,
    pushedShas: [],
    handledCommentIds: [],
    postedCommentIds: [],
    ...overrides,
  };
}

type Contexts = NonNullable<
  PrData['commits']['nodes'][number]['commit']['statusCheckRollup']
>['contexts']['nodes'];

function pr(overrides: Partial<PrData> = {}, contexts: Contexts = []): PrData {
  return {
    state: 'OPEN',
    isDraft: false,
    title: 'A PR',
    url: 'https://github.com/o/r/pull/7',
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
    author: { login: 'me' },
    commits: {
      nodes: [
        {
          commit: {
            oid: HEAD,
            statusCheckRollup: {
              contexts: { pageInfo: { hasNextPage: false }, nodes: contexts },
            },
          },
        },
      ],
    },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    ...overrides,
  };
}

function failed(name: string): Contexts[number] {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/o/r/actions/runs/123/job/1',
    databaseId: 1,
    checkSuite: {
      status: 'COMPLETED',
      app: { databaseId: 15368 },
      workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
    },
  };
}

/** A workflow GitHub could not start: a failure with no job and no log. */
function startupFailurePr(): PrData {
  const data = pr();
  data.commits.nodes[0]!.commit.checkSuites = {
    pageInfo: { hasPreviousPage: false, startCursor: null },
    nodes: [
      {
        databaseId: 1,
        conclusion: 'STARTUP_FAILURE',
        app: { databaseId: 15368 },
        workflowRun: {
          databaseId: 1,
          url: 'https://github.com/o/r/actions/runs/1',
          event: 'pull_request',
          workflow: { databaseId: 9, name: 'CI' },
        },
      },
    ],
  };
  return data;
}

const respond = (data: PrData) =>
  mockGh.mockReturnValueOnce(
    JSON.stringify({
      data: { viewer: { login: 'me' }, repository: { pullRequest: data } },
    }),
  );

const compareCalls = () =>
  mockGh.mock.calls.filter((call) =>
    (call as string[]).some((arg) => arg.includes('/compare/')),
  );

describe('baseIsBehind', () => {
  beforeEach(() => {
    mockGh.mockReset();
  });

  it('asks compare for the base against the head, and trusts behind/diverged', () => {
    for (const status of ['behind', 'diverged']) {
      mockGh.mockReturnValueOnce(`${status}\n`);
      expect(baseIsBehind(state(), HEAD)).toBe(true);
      expect(mockGh).toHaveBeenLastCalledWith(
        'api',
        COMPARE_PATH,
        '--jq',
        '.status',
      );
    }
  });

  it('answers false for a head that contains its base', () => {
    for (const status of ['ahead', 'identical']) {
      mockGh.mockReturnValueOnce(status);
      expect(baseIsBehind(state(), HEAD)).toBe(false);
    }
  });

  it('answers false when GitHub does not answer: a hint never fails a round', () => {
    mockGh.mockImplementationOnce(() => {
      throw new Error('gh: network timeout');
    });
    expect(baseIsBehind(state(), HEAD)).toBe(false);
  });
});

describe('runSnapshot: the stale-base hint', () => {
  let savedHost: string | undefined;
  let savedSession: string | undefined;
  const paths = () => autofixPrPaths(mocks.root, 7);
  const written = () =>
    JSON.parse(readFileSync(paths().snapshotPath, 'utf8')) as {
      baseBehind?: boolean;
      action: string;
    };
  const printed = () =>
    JSON.parse(mocks.stdout.mock.calls[0]![0] as string) as {
      baseBehind?: boolean;
    };

  beforeEach(() => {
    mocks.root = mkdtempSync(join(tmpdir(), 'autofix-base-behind-'));
    mockGh.mockReset();
    mocks.stdout.mockReset();
    mocks.remoteRef.mockReset();
    mocks.remoteRef.mockReturnValue(null);
    savedHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    setGhHost(undefined);
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 's1';
    mkdirSync(dirname(paths().statePath), { recursive: true });
    writeState(paths().statePath, state());
  });

  afterEach(() => {
    rmSync(mocks.root, { recursive: true, force: true });
    if (savedHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedHost;
    setGhHost(undefined);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
  });

  it('flags a failed check on a behind branch, in the file and on the line', () => {
    respond(pr({}, [failed('Test')]));
    mockGh.mockReturnValueOnce('diverged');
    runSnapshot({ pr: 7 });
    expect(compareCalls()).toHaveLength(1);
    expect(mockGh).toHaveBeenLastCalledWith(
      'api',
      COMPARE_PATH,
      '--jq',
      '.status',
    );
    expect(written().baseBehind).toBe(true);
    expect(printed().baseBehind).toBe(true);
  });

  it('leaves a head that contains its base unflagged', () => {
    respond(pr({}, [failed('Test')]));
    mockGh.mockReturnValueOnce('ahead');
    runSnapshot({ pr: 7 });
    expect(compareCalls()).toHaveLength(1);
    expect(written().baseBehind).toBeUndefined();
    expect(printed().baseBehind).toBeUndefined();
  });

  it('writes the snapshot without the flag when compare fails', () => {
    respond(pr({}, [failed('Test')]));
    mockGh.mockImplementationOnce(() => {
      throw new Error('gh: network timeout');
    });
    runSnapshot({ pr: 7 });
    expect(written().action).toBe('fix');
    expect(written().baseBehind).toBeUndefined();
    expect(printed().baseBehind).toBeUndefined();
  });

  it('does not ask compare when no check failed', () => {
    respond(pr());
    runSnapshot({ pr: 7 });
    expect(compareCalls()).toHaveLength(0);
    expect(written().baseBehind).toBeUndefined();
  });

  it('does not ask compare for a workflow that never started', () => {
    respond(startupFailurePr());
    runSnapshot({ pr: 7 });
    // The failure is really there — only its kind keeps compare away.
    const events = (
      JSON.parse(readFileSync(paths().snapshotPath, 'utf8')) as {
        events: Array<{ type: string; startupFailure?: boolean }>;
      }
    ).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'ci_failed', startupFailure: true }),
    ]);
    expect(compareCalls()).toHaveLength(0);
    expect(written().baseBehind).toBeUndefined();
  });

  it('does not ask compare while the API lags the branch', () => {
    mocks.remoteRef.mockReturnValue(HEAD);
    // The checks describe the new head, so only `lagging` keeps them out:
    // without it this snapshot would carry a failed check.
    const laggingPr = pr({ headRefOid: NEXT_HEAD }, [failed('Test')]);
    laggingPr.commits.nodes[0]!.commit.oid = NEXT_HEAD;
    respond(laggingPr);
    runSnapshot({ pr: 7 });
    expect(written().action).toBe('wait');
    expect(compareCalls()).toHaveLength(0);
    expect(written().baseBehind).toBeUndefined();
  });

  it('never asks compare in gate mode', () => {
    respond(pr({}, [failed('Test')]));
    runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    // The gate really reported the failure — the hint is the round's to
    // compute, not a silence that would pass this test vacuously.
    const line = JSON.parse(mocks.stdout.mock.calls[0]![0] as string) as {
      events: Array<{ type: string }>;
      baseBehind?: boolean;
    };
    expect(line.events.map((event) => event.type)).toContain('ci_failed');
    expect(line.baseBehind).toBeUndefined();
    expect(compareCalls()).toHaveLength(0);
  });
});
