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
        `run:15368:1:pull_request:Test ubuntu@${HEAD}@5`,
        `run:15368:1:pull_request:Test macos@${HEAD}@6`,
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

  it("re-runs a run of the repository's current name, under whatever name the watch was prepared", () => {
    // The repository was renamed: the watch knows it as o/r, GitHub as
    // o/r2, and the job's URL carries the new name.
    contexts = [
      {
        ...failedRun(9, 'Test', 90),
        detailsUrl: 'https://github.com/o/r2/actions/runs/90/job/9',
      },
    ];
    mocks.fetchPrData.mockImplementation(() => ({
      pr: { ...prData(), url: 'https://github.com/o/r2/pull/7' },
      viewer: 'me',
    }));
    expect(runRerun(7, 90)).toMatchObject({ rerun: true });
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
    // The deferral holds the check's re-run for the run deferred, apart
    // from the spent ones.
    expect(state()).toMatchObject({
      deferredRuns: [50],
      heldChecks: [`50:run:15368:1:pull_request:Lint@${HEAD}@5`],
    });
    expect(state().rerunChecks).toBeUndefined();

    contexts = [failedRun(5, 'Lint', 50)];
    expect(runRerun(7, 50)).toMatchObject({ rerun: true });
    expect(state()).toMatchObject({
      deferredRuns: [],
      heldChecks: [],
      rerunChecks: [`run:15368:1:pull_request:Lint@${HEAD}@5`],
    });
  });

  it('counts every failed job the re-run re-runs, one a later run took the place of included', () => {
    // Run 50 failed Lint and Test; a later run (51) of Test took its place
    // on the PR. An earlier attempt of Build failed, and its latest passed.
    contexts = [
      { ...failedRun(3, 'Build', 50), conclusion: 'FAILURE' },
      { ...failedRun(4, 'Build', 50), conclusion: 'SUCCESS' },
      failedRun(5, 'Lint', 50),
      failedRun(6, 'Test', 50),
      failedRun(8, 'Test', 51),
    ];
    expect(runRerun(7, 50)).toMatchObject({
      rerun: true,
      checks: ['Lint', 'Test'],
    });
    expect(state().rerunChecks).toEqual([
      `run:15368:1:pull_request:Lint@${HEAD}@5`,
      // Run 51's Test is there already: a later one answers the re-run.
      `run:15368:1:pull_request:Test@${HEAD}@8`,
    ]);
    // Test was re-run with it: run 51's failure is real.
    expect(runRerun(7, 51)).toMatchObject({
      rerun: false,
      reason: expect.stringMatching(/re-run on this head already/),
    });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(1);
  });

  it('counts a job the run cancelled, which `--failed` re-runs too', () => {
    contexts = [
      failedRun(5, 'Test 1', 50),
      { ...failedRun(6, 'Test 2', 50), conclusion: 'CANCELLED' },
    ];
    expect(runRerun(7, 50)).toMatchObject({
      rerun: true,
      checks: ['Test 1', 'Test 2'],
    });
    expect(state().rerunChecks).toEqual([
      `run:15368:1:pull_request:Test 1@${HEAD}@5`,
      `run:15368:1:pull_request:Test 2@${HEAD}@6`,
    ]);
  });

  it('lets a later run of a held check answer for the deferred one', () => {
    contexts = [
      failedRun(5, 'Lint', 50, 1, 'IN_PROGRESS'),
      failedRun(6, 'Test', 50, 1, 'IN_PROGRESS'),
    ];
    expect(runRerun(7, 50)).toMatchObject({ deferred: true });
    // Run 51 of Lint failed before run 50 ended: it answered the re-run.
    contexts = [
      failedRun(5, 'Lint', 50),
      failedRun(6, 'Test', 50),
      failedRun(8, 'Lint', 51),
    ];
    expect(runRerun(7, 50)).toMatchObject({
      rerun: false,
      reason: expect.stringMatching(/Lint was re-run on this head already/),
    });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('spends a hold of a check that no longer fails in the run', () => {
    contexts = [
      failedRun(5, 'Lint', 50, 1, 'IN_PROGRESS'),
      failedRun(6, 'Test', 50, 1, 'IN_PROGRESS'),
    ];
    expect(runRerun(7, 50)).toMatchObject({ deferred: true });
    // Someone re-ran Test on its own before the run ended, and it passed.
    contexts = [
      failedRun(5, 'Lint', 50),
      failedRun(6, 'Test', 50),
      { ...failedRun(7, 'Test', 50), conclusion: 'SUCCESS' },
    ];
    expect(runRerun(7, 50)).toMatchObject({ rerun: true, checks: ['Lint'] });
    // Test's re-run was had: a later failure of it is the re-run's answer.
    expect(state()).toMatchObject({ heldChecks: [] });
    expect(state().rerunChecks).toEqual(
      expect.arrayContaining([
        `run:15368:1:pull_request:Lint@${HEAD}@5`,
        `run:15368:1:pull_request:Test@${HEAD}@6`,
      ]),
    );
  });

  it('tells a re-run another run spent from one a deferral holds', () => {
    // Run 49 failed K and had J cancelled; run 50 failed A, J still going.
    const going = {
      ...failedRun(9, 'J', 50, 1, 'IN_PROGRESS'),
      status: 'IN_PROGRESS',
      conclusion: null,
    };
    contexts = [
      failedRun(2, 'K', 49),
      { ...failedRun(3, 'J', 49), conclusion: 'CANCELLED' },
      failedRun(8, 'A', 50, 1, 'IN_PROGRESS'),
      going,
    ];
    // Run 49's re-run spends J, past its latest run on the PR (run 50's).
    expect(runRerun(7, 49)).toMatchObject({ rerun: true });
    expect(state().rerunChecks).toContain(
      `run:15368:1:pull_request:J@${HEAD}@9`,
    );
    expect(runRerun(7, 50)).toMatchObject({ deferred: true });
    expect(state().heldChecks).toEqual([
      `50:run:15368:1:pull_request:A@${HEAD}@8`,
    ]);
    // J fails in run 50 too: its re-run was spent by run 49, not held.
    contexts = [
      failedRun(2, 'K', 49),
      { ...failedRun(3, 'J', 49), conclusion: 'CANCELLED' },
      failedRun(8, 'A', 50),
      failedRun(9, 'J', 50),
    ];
    expect(runRerun(7, 50)).toMatchObject({
      rerun: false,
      reason: expect.stringMatching(/J was re-run on this head already/),
    });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(1);
  });

  it('counts a later run of a deferred check as its re-run', () => {
    contexts = [failedRun(5, 'Lint', 50, 1, 'IN_PROGRESS')];
    expect(runRerun(7, 50)).toMatchObject({ deferred: true });
    // Another run of the workflow took its place before it ended — a
    // review started it, say — and failed as well.
    contexts = [failedRun(5, 'Lint', 50), failedRun(8, 'Lint', 51)];
    expect(runRerun(7, 51)).toMatchObject({
      rerun: false,
      reason: expect.stringMatching(/re-run on this head already/),
    });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
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
      // gh's own wording for a 403 from the re-run endpoint.
      throw new Error(
        'run 50 cannot be rerun; Resource not accessible by integration',
      );
    });
    expect(() => runRerun(7, 50)).toThrow(
      /GitHub did not re-run run 50: .*answer its failures as needing a human/,
    );
    // Nothing re-ran: the failures stay reported, the budget stays unspent.
    expect(state().rerunChecks).toBeUndefined();
    expect(state().handledChecks).toBeUndefined();
    expect(runRerun(7, 50)).toMatchObject({ rerun: true });
  });

  it('gives back the re-run a deferral held when GitHub refuses it', () => {
    contexts = [failedRun(5, 'Lint', 50, 1, 'IN_PROGRESS')];
    expect(runRerun(7, 50)).toMatchObject({ deferred: true });
    contexts = [failedRun(5, 'Lint', 50)];
    mocks.ghWithInput.mockImplementationOnce(() => {
      throw new Error('HTTP 403: Resource not accessible by integration');
    });
    expect(() => runRerun(7, 50)).toThrow(/GitHub did not re-run run 50: /);
    expect(state().heldChecks).toEqual([]);
    expect(state().rerunChecks ?? []).toEqual([]);
    // Lint fails again on the head: its re-run was never spent.
    contexts = [failedRun(5, 'Lint', 50), failedRun(9, 'Lint', 52)];
    expect(runRerun(7, 52)).toMatchObject({ rerun: true });
  });

  it('re-runs nothing on a PR that was merged or closed', () => {
    mocks.fetchPrData.mockImplementation(() => ({
      pr: { ...prData(), state: 'MERGED' },
      viewer: 'me',
    }));
    expect(() => runRerun(7, 50)).toThrow(/is merged; nothing is re-run/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('asks for a resync when the PR head moved, and re-runs nothing', () => {
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData('b'.repeat(40)),
      viewer: 'me',
    }));
    expect(runRerun(7, 50)).toMatchObject({ rerun: false, action: 'resync' });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('re-runs nothing for a round its task no longer drives', () => {
    writeState(paths.statePath, {
      ...state(),
      watch: { every: 2, reply: true, instructions: '', task: 'bbbbbbbbbbbb' },
    });
    expect(() => runRerun(7, 50, 'aaaaaaaaaaaa')).toThrow(/no longer drives/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('re-runs nothing for a watch cleanup ended', () => {
    writeState(paths.statePath, {
      ...state(),
      ended: { at: '2026-10-25T00:00:00.000Z', reason: 'kept' },
    });
    expect(() => runRerun(7, 50)).toThrow(/watch was stopped/);
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
