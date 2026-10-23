/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrData } from './snapshot.js';

const mocks = vi.hoisted(() => ({
  ghWithInput: vi.fn((_input: string, ..._args: string[]) => ''),
  fetchPrData: vi.fn(),
}));
vi.mock('../review/lib/gh.js', () => ({
  ghWithInput: mocks.ghWithInput,
  setGhHost: () => {},
  ensureAuthenticated: () => {},
}));
vi.mock('./snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./snapshot.js')>()),
  fetchPrData: mocks.fetchPrData,
}));

import { parsePlan, runReply, type ReplyPlan } from './reply.js';
import {
  REPLY_MARKER,
  autofixPrPaths,
  readState,
  writeState,
  type AutofixPrState,
} from './state.js';

const HEAD = 'a'.repeat(40);

function comment(id: string, login: string, association: string) {
  return {
    id,
    databaseId: Number(id.replace(/\D/g, '')) || undefined,
    author: { __typename: 'User', login },
    authorAssociation: association,
    body: `please fix ${id}`,
    url: `https://github.com/o/r/pull/7#${id}`,
  };
}

function thread(id: string, comments: Array<ReturnType<typeof comment>>) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 3,
    root: { nodes: [{ databaseId: comments[0].databaseId ?? 0 }] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: comments },
  };
}

function prData(overrides: Partial<PrData> = {}): PrData {
  return {
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/7',
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
    commits: {
      nodes: [
        {
          commit: {
            oid: HEAD,
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    __typename: 'CheckRun',
                    databaseId: 5,
                    name: 'Test',
                    status: 'COMPLETED',
                    conclusion: 'FAILURE',
                    detailsUrl: 'https://github.com/o/r/actions/runs/50/job/1',
                  },
                ],
              },
            },
          },
        },
      ],
    },
    reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: [
        thread('T1', [comment('PRRC_101', 'alice', 'COLLABORATOR')]),
        thread('T2', [comment('PRRC_201', 'stranger', 'NONE')]),
      ],
    },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        comment('IC_1', 'bob', 'MEMBER'),
        comment('IC_2', 'stranger', 'NONE'),
      ],
    },
    ...overrides,
  };
}

describe('runReply', () => {
  let repo: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let paths: ReturnType<typeof autofixPrPaths>;
  let planPath: string;
  let nextId: number;

  const state = () => readState(paths.statePath)!;
  const posts = () =>
    mocks.ghWithInput.mock.calls.map(([input, ...args]) => ({
      path: args[3],
      body: (JSON.parse(input) as { body: string }).body,
    }));
  const reply = (plan: ReplyPlan, post = true) => {
    writeFileSync(planPath, JSON.stringify(plan));
    return runReply({ pr: 7, planPath, post });
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-reply-')));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    paths = autofixPrPaths(repo, 7);
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
    execFileSync('mkdir', ['-p', join(repo, '.qwen', 'tmp')]);
    writeState(paths.statePath, initial);
    planPath = join(repo, '.qwen', 'tmp', 'autofix-pr-7-plan.json');
    nextId = 1;
    mocks.ghWithInput.mockReset();
    mocks.ghWithInput.mockImplementation(() => {
      const id = nextId++;
      return JSON.stringify({
        node_id: `POSTED_${id}`,
        html_url: `https://github.com/o/r/pull/7#posted-${id}`,
      });
    });
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

  it('posts thread replies and the summary with the marker, and records every id', () => {
    const outcome = reply({
      replies: [
        {
          replyTo: 101,
          body: 'Fixed in abc1234: renamed.',
          handled: ['PRRC_101'],
        },
      ],
      summary: { body: 'Pushed abc1234: fixed Test.', handled: ['IC_1'] },
      handledChecks: [`Test@${HEAD}@#5`],
    });
    expect(posts()).toEqual([
      {
        path: 'repos/o/r/pulls/7/comments/101/replies',
        body: `Fixed in abc1234: renamed.\n\n${REPLY_MARKER}`,
      },
      {
        path: 'repos/o/r/issues/7/comments',
        body: `Pushed abc1234: fixed Test.\n\n${REPLY_MARKER}`,
      },
    ]);
    expect(outcome).toMatchObject({
      skipped: 0,
      handledCommentIds: 2,
      handledChecks: 1,
    });
    expect(outcome.posted.map((p) => p.kind)).toEqual(['thread', 'summary']);
    expect(state()).toMatchObject({
      postedCommentIds: ['POSTED_1', 'POSTED_2'],
      handledCommentIds: ['PRRC_101', 'IC_1'],
      handledChecks: [`Test@${HEAD}@#5`],
      summarizedSha: HEAD,
    });
  });

  it('keeps a single marker on a body that already ends with it', () => {
    reply({
      replies: [
        {
          replyTo: 101,
          body: `Not changed: by design.\n\n${REPLY_MARKER}\n`,
          handled: ['PRRC_101'],
        },
      ],
    });
    expect(posts()[0].body).toBe(`Not changed: by design.\n\n${REPLY_MARKER}`);
  });

  it('replies only to threads with a new trusted comment, and posts nothing when one is refused', () => {
    // A thread whose only comment is from an untrusted author.
    expect(() =>
      reply({
        replies: [
          { replyTo: 101, body: 'Fixed.', handled: ['PRRC_101'] },
          { replyTo: 201, body: 'Fixed.', handled: ['PRRC_201'] },
        ],
      }),
    ).toThrow(/thread 201 has no new comment from a trusted author/);
    // A thread that does not exist.
    expect(() =>
      reply({ replies: [{ replyTo: 999, body: 'Fixed.', handled: ['X'] }] }),
    ).toThrow(/thread 999/);
    // A comment that is not in the thread named.
    expect(() =>
      reply({ replies: [{ replyTo: 101, body: 'Fixed.', handled: ['IC_1'] }] }),
    ).toThrow(/outside it or not actionable: IC_1/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    expect(state().handledCommentIds).toEqual([]);
  });

  it('refuses to mark an untrusted comment, an unknown failure or an absent conflict as handled', () => {
    expect(() => reply({ handled: ['IC_2'] })).toThrow(/does not act on/);
    expect(() => reply({ summary: { body: 'x', handled: ['IC_9'] } })).toThrow(
      /not a new comment from a trusted author/,
    );
    expect(() => reply({ handledChecks: [`Test@${HEAD}@#4`] })).toThrow(
      /not a failure snapshot reports/,
    );
    expect(() => reply({ handledConflict: true })).toThrow(/no merge conflict/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('records a conflict left for a human against the head', () => {
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ mergeable: 'CONFLICTING' }),
      viewer: 'me',
    }));
    reply({ handledConflict: true });
    expect(state().handledConflictSha).toBe(HEAD);
  });

  it('with --no-post records what was handled and posts nothing', () => {
    const outcome = reply(
      {
        replies: [{ replyTo: 101, body: 'Fixed.', handled: ['PRRC_101'] }],
        summary: { body: 'Pushed.', handled: ['IC_1'] },
      },
      false,
    );
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    expect(outcome.posted).toEqual([]);
    expect(state()).toMatchObject({
      handledCommentIds: ['PRRC_101', 'IC_1'],
      postedCommentIds: [],
    });
  });

  it('after a failed post, a retry of the same plan posts only what is missing', () => {
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            thread('T1', [comment('PRRC_101', 'alice', 'COLLABORATOR')]),
            thread('T3', [comment('PRRC_301', 'carol', 'OWNER')]),
          ],
        },
      }),
      viewer: 'me',
    }));
    const plan: ReplyPlan = {
      replies: [
        { replyTo: 101, body: 'Fixed in abc: one.', handled: ['PRRC_101'] },
        { replyTo: 301, body: 'Fixed in abc: two.', handled: ['PRRC_301'] },
      ],
      summary: { body: 'Pushed abc.' },
    };
    let calls = 0;
    mocks.ghWithInput.mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw new Error('HTTP 502');
      return JSON.stringify({ node_id: `POSTED_${calls}`, html_url: '' });
    });
    expect(() => reply(plan)).toThrow(/HTTP 502/);
    expect(state()).toMatchObject({
      postedCommentIds: ['POSTED_1'],
      handledCommentIds: ['PRRC_101'],
    });

    const retry = reply(plan);
    expect(retry.skipped).toBe(1);
    expect(posts().map((p) => p.path)).toEqual([
      'repos/o/r/pulls/7/comments/101/replies',
      'repos/o/r/pulls/7/comments/301/replies',
      'repos/o/r/pulls/7/comments/301/replies',
      'repos/o/r/issues/7/comments',
    ]);
    // A third run finds everything posted.
    const third = reply(plan);
    expect(third).toMatchObject({ posted: [], skipped: 3 });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(4);
  });

  it('refuses to post on a PR that is no longer open', () => {
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ state: 'MERGED' }),
      viewer: 'me',
    }));
    expect(() =>
      reply({
        replies: [{ replyTo: 101, body: 'Fixed.', handled: ['PRRC_101'] }],
      }),
    ).toThrow(/is merged/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });
});

describe('parsePlan', () => {
  it('refuses malformed plans before anything is read from GitHub', () => {
    expect(() => parsePlan([])).toThrow(/JSON object/);
    expect(() => parsePlan({ resolve: true })).toThrow(
      /unknown reply plan field/,
    );
    expect(() =>
      parsePlan({ replies: [{ replyTo: 0, body: 'x', handled: ['a'] }] }),
    ).toThrow(/replyTo must be a positive integer/);
    expect(() =>
      parsePlan({ replies: [{ replyTo: 1, body: 'x', handled: [] }] }),
    ).toThrow(/must name the thread comments/);
    expect(() =>
      parsePlan({ replies: [{ replyTo: 1, body: '  ', handled: ['a'] }] }),
    ).toThrow(/body must be a non-empty string/);
    expect(() => parsePlan({ summary: { body: 'x'.repeat(65_536) } })).toThrow(
      /GitHub takes at most/,
    );
    expect(parsePlan({})).toEqual({
      replies: [],
      summary: null,
      handled: [],
      handledChecks: [],
      handledConflict: false,
    });
  });
});
