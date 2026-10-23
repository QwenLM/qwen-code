/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrData } from './snapshot.js';

const mocks = vi.hoisted(() => ({
  ghWithInput: vi.fn((_input: string, ..._args: string[]) => ''),
  fetchPrData: vi.fn(),
}));
vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  ghWithInput: mocks.ghWithInput,
  setGhHost: () => {},
  ensureAuthenticated: () => {},
}));
vi.mock('./snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./snapshot.js')>()),
  fetchPrData: mocks.fetchPrData,
}));

import { runRerun } from './rerun.js';
import {
  autofixPrPaths,
  readState,
  writeState,
  type AutofixPrState,
} from './state.js';

const HEAD = 'a'.repeat(40);

function failedRun(
  databaseId: number,
  name: string,
  runId: number,
  workflow = 1,
  status = 'COMPLETED',
) {
  return {
    __typename: 'CheckRun' as const,
    databaseId,
    name,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/${databaseId}`,
    checkSuite: {
      status,
      app: { databaseId: 15368 },
      workflowRun: {
        event: 'pull_request',
        workflow: { databaseId: workflow },
      },
    },
  };
}

let contexts: Array<Record<string, unknown>>;

function prData(headRefOid = HEAD): PrData {
  return {
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/7',
    headRefOid,
    mergeable: 'MERGEABLE',
    commits: {
      nodes: [
        {
          commit: {
            oid: headRefOid,
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: contexts as never,
              },
            },
          },
        },
      ],
    },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
  };
}

describe('runRerun', () => {
  let repo: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let paths: ReturnType<typeof autofixPrPaths>;

  const state = () => readState(paths.statePath)!;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-rerun-')));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    paths = autofixPrPaths(repo, 7);
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    const initial: AutofixPrState = {
      version: 1,
      sessionId: 'session-a',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: paths.branch,
      worktreePath: paths.worktreePath,
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
    };
    writeState(paths.statePath, initial);
    contexts = [
      failedRun(5, 'Test ubuntu', 50),
      failedRun(6, 'Test macos', 50),
      failedRun(7, 'Lint', 60),
    ];
    mocks.ghWithInput.mockReset();
    mocks.fetchPrData.mockReset();
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData(),
      viewer: 'me',
    }));
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
    rmSync(repo, { recursive: true, force: true });
  });

  it("re-runs a run's failed jobs once and records every failed check of it", () => {
    expect(runRerun(7, 50)).toEqual({
      rerun: true,
      runId: 50,
      checks: ['Test ubuntu', 'Test macos'],
    });
    expect(mocks.ghWithInput).toHaveBeenCalledWith(
      '',
      'run',
      'rerun',
      '50',
      '--failed',
      '-R',
      'o/r',
    );
    expect(state()).toMatchObject({
      rerunChecks: [
        `run:15368:1:pull_request:Test ubuntu@${HEAD}`,
        `run:15368:1:pull_request:Test macos@${HEAD}`,
      ],
      handledChecks: [`Test ubuntu@${HEAD}@#5`, `Test macos@${HEAD}@#6`],
    });
  });

  it('treats the next failure of a re-run check on the same head as real', () => {
    runRerun(7, 50);
    expect(runRerun(7, 50)).toMatchObject({
      rerun: false,
      reason: expect.stringMatching(/re-run on this head already/),
    });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(1);
    // Another check of another run still has its re-run.
    expect(runRerun(7, 60)).toMatchObject({ rerun: true, checks: ['Lint'] });
  });

  it('gives each workflow its own re-run, even for jobs of the same name', () => {
    contexts = [failedRun(5, 'Test', 50, 100), failedRun(6, 'Test', 60, 200)];
    expect(runRerun(7, 50)).toMatchObject({ rerun: true, checks: ['Test'] });
    expect(runRerun(7, 60)).toMatchObject({ rerun: true, checks: ['Test'] });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(2);
  });

  it('re-runs only GitHub Actions runs of this repository', () => {
    contexts = [
      // A commit status whose link happens to look like an Actions run.
      {
        __typename: 'StatusContext',
        context: 'ci/external',
        state: 'FAILURE',
        createdAt: '2026-10-21T00:00:00Z',
        targetUrl: 'https://github.com/o/r/actions/runs/70/job/1',
      },
      // A check run of another repository's Actions.
      {
        ...failedRun(8, 'Build', 80),
        detailsUrl: 'https://github.com/elsewhere/r/actions/runs/80/job/8',
      },
    ];
    expect(() => runRerun(7, 70)).toThrow(
      /no failed GitHub Actions run of o\/r/,
    );
    expect(() => runRerun(7, 80)).toThrow(
      /no failed GitHub Actions run of o\/r/,
    );
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('defers a run still in progress, and re-runs it once it has ended', () => {
    contexts = [failedRun(5, 'Lint', 50, 1, 'IN_PROGRESS')];
    expect(runRerun(7, 50)).toMatchObject({
      rerun: false,
      deferred: true,
      checks: ['Lint'],
    });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ deferredRuns: [50] });
    expect(state().rerunChecks).toBeUndefined();

    contexts = [failedRun(5, 'Lint', 50)];
    expect(runRerun(7, 50)).toMatchObject({ rerun: true });
    expect(state()).toMatchObject({ deferredRuns: [] });
  });

  it('counts a re-run before asking GitHub, so a lost answer is not re-run twice', () => {
    mocks.ghWithInput.mockImplementationOnce(() => {
      throw new Error('HTTP 502');
    });
    expect(() => runRerun(7, 50)).toThrow(/or its answer was lost/);
    expect(state().rerunChecks).toHaveLength(2);
    // Not marked handled: a human answers them if no re-run happened.
    expect(state().handledChecks).toBeUndefined();
    expect(runRerun(7, 50)).toMatchObject({ rerun: false });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(1);
  });

  it('gives the re-run back when GitHub refuses it, and never hides the failure', () => {
    mocks.ghWithInput.mockImplementationOnce(() => {
      throw new Error('HTTP 403: Resource not accessible by integration');
    });
    expect(() => runRerun(7, 50)).toThrow(
      /GitHub did not re-run run 50: .*answer its failures as needing a human/,
    );
    // Nothing re-ran: the failures stay reported, the budget stays unspent.
    expect(state().rerunChecks).toBeUndefined();
    expect(state().handledChecks).toBeUndefined();
    expect(runRerun(7, 50)).toMatchObject({ rerun: true });
  });

  it('asks for a resync when the PR head moved, and re-runs nothing', () => {
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData('b'.repeat(40)),
      viewer: 'me',
    }));
    expect(runRerun(7, 50)).toMatchObject({ rerun: false, action: 'resync' });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('refuses a run with no failed check on the head', () => {
    expect(() => runRerun(7, 99)).toThrow(
      /run 99 is no failed GitHub Actions run/,
    );
    expect(() => runRerun(7, 0)).toThrow(/run id must be a positive integer/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });
});
