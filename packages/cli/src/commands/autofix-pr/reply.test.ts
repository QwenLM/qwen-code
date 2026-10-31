/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  it('refuses to mark an untrusted comment, or an unknown failure of the head, as handled', () => {
    expect(() => reply({ handled: ['IC_2'] })).toThrow(/does not act on/);
    expect(() => reply({ summary: { body: 'x', handled: ['IC_9'] } })).toThrow(
      /not a new comment from a trusted author/,
    );
    // No failure snapshot reported, earlier or later than the one it does.
    for (const key of [
      `Test@${HEAD}@#4`,
      `Test@${HEAD}@#6`,
      `Lint@${HEAD}@#on:1:pull_request_review`,
    ]) {
      expect(() => reply({ handledChecks: [key] })).toThrow(
        /not a failure snapshot reports/,
      );
    }
    // Not a key at all, rather than one of another head.
    for (const key of ['Test@#5', `Test@${HEAD}@#5@ended`]) {
      expect(() => reply({ handledChecks: [key] })).toThrow(
        /is not the `key` of a ci_failed event/,
      );
    }
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    expect(state().handledChecks).toBeUndefined();
  });

  it("records a failure the round's snapshot reported, though the head moved on from it since", () => {
    const gate = `Gate@${HEAD}@#on:9:pull_request_review`;
    const startup = `CI@${HEAD}@#startup:3:pull_request`;
    const earlier = `Test@${HEAD}@#4`;
    const deferred = `Build@${HEAD}@#7`;
    writeFileSync(
      paths.snapshotPath,
      JSON.stringify({
        events: [
          { type: 'ci_failed', check: 'Gate', key: gate, runId: 90 },
          { type: 'ci_failed', check: 'CI', key: startup, runId: null },
          { type: 'ci_failed', check: 'Test', key: earlier, runId: 40 },
          { type: 'ci_failed', check: 'Build', key: deferred, runId: 70 },
        ],
      }),
    );
    // The round deferred Build's run: it is answered once the run ends.
    writeState(paths.statePath, {
      ...state(),
      deferredRuns: [70],
      heldChecks: [`70:run:15368:2:pull_request:Build@${HEAD}@7`],
    });
    // A stranger's review started Gate again while the round ran; CI
    // started this time; Test ran again (#5).
    const moved = prData();
    moved.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
      __typename: 'CheckRun',
      databaseId: 9,
      name: 'Gate',
      status: 'QUEUED',
      conclusion: null,
      detailsUrl: 'https://github.com/o/r/actions/runs/90/job/9',
    });
    const build = (databaseId: number, run: number, suite: string) => ({
      __typename: 'CheckRun' as const,
      databaseId,
      name: 'Build',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: `https://github.com/o/r/actions/runs/${run}/job/${databaseId}`,
      checkSuite: {
        status: suite,
        app: { databaseId: 15368 },
        workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
      },
    });
    const contexts = moved.commits.nodes[0]!.commit.statusCheckRollup!.contexts;
    contexts.nodes.push(build(7, 70, 'IN_PROGRESS'));
    mocks.fetchPrData.mockImplementation(() => ({ pr: moved, viewer: 'me' }));
    expect(
      reply({ handledChecks: [gate, startup, earlier, deferred] }),
    ).toMatchObject({
      handledChecks: 3,
      ignoredChecks: 1,
    });
    // Gate's next failure on this head carries the key: it stays handled.
    expect(state().handledChecks).toEqual([gate, startup, earlier]);
    // Lint failed in run 70 after the deferral, which held nothing of it:
    // the round answered it, and a review started its workflow again since.
    const lint = `Lint@${HEAD}@#on:3:pull_request_review`;
    writeFileSync(
      paths.snapshotPath,
      JSON.stringify({
        events: [
          { type: 'ci_failed', check: 'Lint', key: lint, runId: 70 },
          { type: 'ci_failed', check: 'Build', key: deferred, runId: 70 },
        ],
      }),
    );
    const job = (databaseId: number, run: number, status: string) => ({
      __typename: 'CheckRun' as const,
      databaseId,
      name: 'Lint',
      status,
      conclusion: status === 'COMPLETED' ? 'FAILURE' : null,
      detailsUrl: `https://github.com/o/r/actions/runs/${run}/job/${databaseId}`,
      checkSuite: {
        status: 'IN_PROGRESS',
        app: { databaseId: 15368 },
        workflowRun: {
          event: 'pull_request_review',
          workflow: { databaseId: 3 },
        },
      },
    });
    contexts.nodes.push(job(8, 70, 'COMPLETED'), job(12, 90, 'QUEUED'));
    expect(reply({ handledChecks: [lint] })).toMatchObject({
      handledChecks: 1,
      ignoredChecks: 0,
    });
    // A later run of Build took the place of the deferred one, which the
    // gate will not report again: the round's answer stands.
    contexts.nodes.push(build(9, 71, 'IN_PROGRESS'));
    expect(reply({ handledChecks: [deferred] })).toMatchObject({
      handledChecks: 1,
      ignoredChecks: 0,
    });
    // A failure neither the file nor the head reports is still refused.
    expect(() => reply({ handledChecks: [`Test@${HEAD}@#3`] })).toThrow(
      /not a failure snapshot reports/,
    );
  });

  it("reads the round's snapshot a background fix claimed, until a round prepares another", () => {
    const gate = `Gate@${HEAD}@#on:9:pull_request_review`;
    const claimed = join(
      dirname(paths.statePath),
      'autofix-pr-7-fix-snapshot.json',
    );
    writeFileSync(
      claimed,
      JSON.stringify({
        events: [{ type: 'ci_failed', check: 'Gate', key: gate, runId: 90 }],
      }),
    );
    // Started again while the fix ran: the head no longer reports it.
    const moved = prData();
    moved.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
      __typename: 'CheckRun',
      databaseId: 9,
      name: 'Gate',
      status: 'QUEUED',
      conclusion: null,
      detailsUrl: 'https://github.com/o/r/actions/runs/90/job/9',
    });
    mocks.fetchPrData.mockImplementation(() => ({ pr: moved, viewer: 'me' }));
    // A round prepared its own snapshot since: the claimed one says nothing.
    writeFileSync(paths.snapshotPath, JSON.stringify({ events: [] }));
    expect(() => reply({ handledChecks: [gate] })).toThrow(
      /not a failure snapshot reports/,
    );
    rmSync(paths.snapshotPath);
    expect(reply({ handledChecks: [gate] })).toMatchObject({
      handledChecks: 1,
    });
  });

  it("checks bot threads opened since the snapshot leniently: they are not the plan's", () => {
    reply({ handled: ['IC_1'] });
    expect(mocks.fetchPrData.mock.calls[0]![1]).toMatchObject({
      strict: false,
    });
  });

  it('records the comments a plan handled without a reply of their own, once', () => {
    expect(reply({ handled: ['IC_1'] })).toMatchObject({
      posted: [],
      handledCommentIds: 1,
    });
    expect(state().handledCommentIds).toEqual(['IC_1']);
    expect(reply({ handled: ['IC_1'] })).toMatchObject({
      handledCommentIds: 0,
    });
    expect(state().handledCommentIds).toEqual(['IC_1']);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('after a push, judges the plan by the head the watch pushed, even while the API lags', () => {
    const pushed = 'b'.repeat(40);
    // `push` recorded the new head; the API still shows the old one.
    writeState(paths.statePath, {
      ...state(),
      lastKnownHeadSha: pushed,
      pushedShas: [pushed],
      summarizedSha: HEAD,
    });
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ mergeable: 'UNKNOWN' }),
      viewer: 'me',
    }));
    const outcome = reply({
      replies: [{ replyTo: 101, body: 'Fixed in bbb.', handled: ['PRRC_101'] }],
      summary: { body: 'Pushed bbb.' },
      handledChecks: [`Test@${HEAD}@#5`],
      handledConflict: true,
    });
    // The old head's failure is history; the push's summary is due.
    expect(outcome).toMatchObject({
      handledChecks: 0,
      ignoredChecks: 1,
      summarySkipped: false,
    });
    expect(posts().map((p) => p.path)).toEqual([
      'repos/o/r/pulls/7/comments/101/replies',
      'repos/o/r/issues/7/comments',
    ]);
    // GitHub reports UNKNOWN until it has recomputed the merge: the
    // conflict left for a human is recorded against the pushed head.
    expect(state()).toMatchObject({
      handledChecks: [],
      handledConflictSha: pushed,
      summarizedSha: pushed,
    });
  });

  it("ignores failures of the round's head when someone else pushed while it ran", () => {
    const theirs = 'c'.repeat(40);
    // The round declined Test on HEAD; the author pushed meanwhile.
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ headRefOid: theirs }),
      viewer: 'me',
    }));
    const outcome = reply({
      replies: [{ replyTo: 101, body: 'Not changed.', handled: ['PRRC_101'] }],
      handledChecks: [`Test@${HEAD}@#5`],
    });
    expect(outcome).toMatchObject({ ignoredChecks: 1, handledChecks: 0 });
    expect(posts()).toHaveLength(1);
  });

  it('records a conflict left for a human unless the head merges cleanly', () => {
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ mergeable: 'CONFLICTING' }),
      viewer: 'me',
    }));
    reply({ handledConflict: true });
    expect(state().handledConflictSha).toBe(HEAD);

    writeState(paths.statePath, { ...state(), handledConflictSha: null });
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ mergeable: 'MERGEABLE' }),
      viewer: 'me',
    }));
    reply({ handledConflict: true });
    expect(state().handledConflictSha).toBeNull();

    // UNKNOWN on a head the watch did not push says nothing of a conflict.
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ mergeable: 'UNKNOWN' }),
      viewer: 'me',
    }));
    reply({ handledConflict: true });
    expect(state().handledConflictSha).toBeNull();
  });

  it('answers the comments of a reply that are still open, not the ones answered already', () => {
    writeState(paths.statePath, {
      ...state(),
      handledCommentIds: ['PRRC_101'],
    });
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            thread('T1', [
              comment('PRRC_101', 'alice', 'COLLABORATOR'),
              comment('PRRC_102', 'alice', 'COLLABORATOR'),
            ]),
          ],
        },
      }),
      viewer: 'me',
    }));
    const outcome = reply({
      replies: [
        { replyTo: 101, body: 'Fixed.', handled: ['PRRC_101', 'PRRC_102'] },
      ],
    });
    // A comment that arrived while the round ran is not left unanswered.
    expect(outcome).toMatchObject({ skipped: 0, handledCommentIds: 1 });
    expect(posts()).toHaveLength(1);
    expect(state().handledCommentIds).toEqual(['PRRC_101', 'PRRC_102']);
  });

  it('with --no-post records the summary as given, so a later run does not post it', () => {
    reply({ summary: { body: 'Pushed.' } }, false);
    expect(state().summarizedSha).toBe(HEAD);
    expect(reply({ summary: { body: 'Pushed.' } })).toMatchObject({
      posted: [],
      skipped: 0,
      summarySkipped: true,
    });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
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

  it('lists what the round left for a person on its head, once, newest last', () => {
    const plan: ReplyPlan = {
      handledChecks: [`Test@${HEAD}@#5`],
      needsHuman: [
        'Test:   fails\u202e again\n after\u001b[2J its re-run',
        `${'😀'.repeat(400)}`,
      ],
    };
    reply(plan);
    const first = state().needsHuman!;
    expect(first.map(({ sha, text }) => ({ sha, text }))).toEqual([
      // Control and format characters do not reach the list.
      { sha: HEAD, text: 'Test: fails again after [2J its re-run' },
      // Cut by code point: no half of a surrogate pair is kept.
      { sha: HEAD, text: `${'😀'.repeat(299)}…` },
    ]);
    expect(Date.parse(first[0].at)).not.toBeNaN();
    // The same plan run again lists nothing twice.
    reply(plan);
    expect(state().needsHuman).toEqual(first);
    reply({ needsHuman: ['IC_9: a design call'] }, false);
    expect(state().needsHuman!.map(({ text }) => text)).toEqual([
      'Test: fails again after [2J its re-run',
      `${'😀'.repeat(299)}…`,
      'IC_9: a design call',
    ]);
  });

  // FIFOs are POSIX only.
  it.skipIf(process.platform === 'win32')(
    'never blocks on a snapshot that is not a regular file',
    () => {
      execFileSync('mkfifo', [paths.snapshotPath]);
      expect(reply({ handled: [] })).toMatchObject({ posted: [], skipped: 0 });
    },
  );

  it('posts nothing for a round its task no longer drives', () => {
    writeState(paths.statePath, {
      ...state(),
      watch: { every: 2, reply: false, instructions: '', task: 'bbbbbbbbbbbb' },
    });
    writeFileSync(
      planPath,
      JSON.stringify({
        replies: [{ replyTo: 101, body: 'x', handled: ['PRRC_101'] }],
      }),
    );
    // A later start turned replies off: the old task's round is not heard.
    expect(() =>
      runReply({ pr: 7, planPath, post: true, task: 'aaaaaaaaaaaa' }),
    ).toThrow(/task aaaaaaaaaaaa no longer drives/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('posts nothing on a watch started with --no-reply, whatever the round passes', () => {
    writeState(paths.statePath, {
      ...state(),
      watch: { every: 2, reply: false, instructions: '', task: 'aaaaaaaaaaaa' },
    });
    writeFileSync(
      planPath,
      JSON.stringify({
        replies: [{ replyTo: 101, body: 'x', handled: ['PRRC_101'] }],
      }),
    );
    expect(() =>
      runReply({ pr: 7, planPath, post: true, task: 'aaaaaaaaaaaa' }),
    ).toThrow(/started with --no-reply: run reply with --no-post/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    expect(() =>
      runReply({ pr: 7, planPath, post: false, task: 'aaaaaaaaaaaa' }),
    ).not.toThrow();
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    // A `--once` round, with no task, has options of its own.
    expect(() => runReply({ pr: 7, planPath, post: true })).not.toThrow(
      /--no-reply/,
    );
  });

  it('posts nothing for a watch cleanup ended', () => {
    writeState(paths.statePath, {
      ...state(),
      ended: { at: '2026-10-25T00:00:00.000Z', reason: 'kept' },
    });
    expect(() =>
      reply({ replies: [{ replyTo: 101, body: 'x', handled: ['PRRC_101'] }] }),
    ).toThrow(/watch was stopped/);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('keeps only the newest items a person has to look at', () => {
    reply({
      needsHuman: Array.from({ length: 25 }, (_, i) => `item ${i}`),
    });
    const texts = state().needsHuman!.map(({ text }) => text);
    expect(texts).toHaveLength(20);
    expect(texts[0]).toBe('item 5');
    expect(texts.at(-1)).toBe('item 24');
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
    expect(third).toMatchObject({
      posted: [],
      skipped: 2,
      summarySkipped: true,
    });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(4);
  });

  it('keeps what a round left for a person when a later post fails', () => {
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
    let calls = 0;
    mocks.ghWithInput.mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw new Error('HTTP 502');
      return JSON.stringify({ node_id: `POSTED_${calls}`, html_url: '' });
    });
    const second = {
      replyTo: 301,
      body: 'Fixed in abc: two.',
      handled: ['PRRC_301'],
    };
    expect(() =>
      reply({
        replies: [
          {
            replyTo: 101,
            body: 'Needs a human decision: the API.',
            handled: ['PRRC_101'],
          },
          second,
        ],
        needsHuman: ['PRRC_101: whether to keep the API'],
      }),
    ).toThrow(/HTTP 502/);
    // The first reply marked its comment handled: the next round answers
    // only the second, and has nothing to say about the first.
    expect(state()).toMatchObject({ handledCommentIds: ['PRRC_101'] });
    reply({ replies: [second] });
    expect(state().handledCommentIds).toEqual(['PRRC_101', 'PRRC_301']);
    expect(state().needsHuman!.map(({ text }) => text)).toEqual([
      'PRRC_101: whether to keep the API',
    ]);
  });

  it('recognizes a reply whose answer was lost by what it was posted for, not by the next plan', () => {
    // The POST reaches GitHub; its answer does not.
    mocks.ghWithInput.mockImplementation(() => {
      throw new Error('HTTP 502');
    });
    expect(() =>
      reply({
        replies: [
          { replyTo: 101, body: 'Fixed in abc.', handled: ['PRRC_101'] },
        ],
      }),
    ).toThrow(/HTTP 502/);
    expect(state().pendingPosts).toHaveLength(1);
    const landed = {
      ...comment('PRRC_150', 'me', 'OWNER'),
      body: `Fixed in abc.\n\n${REPLY_MARKER}`,
    };
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            thread('T1', [
              comment('PRRC_101', 'alice', 'COLLABORATOR'),
              landed,
            ]),
          ],
        },
      }),
      viewer: 'me',
    }));
    mocks.ghWithInput.mockReset();
    // The next round words its answer differently.
    const outcome = reply({
      replies: [
        { replyTo: 101, body: 'Renamed as asked.', handled: ['PRRC_101'] },
      ],
    });
    expect(outcome).toMatchObject({ adopted: 1, skipped: 1, posted: [] });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      postedCommentIds: ['PRRC_150'],
      handledCommentIds: ['PRRC_101'],
      pendingPosts: [],
    });
  });

  it("counts an adopted summary for the head it reported, not a later push's", () => {
    // Round N's push summary on HEAD landed; its answer was lost.
    mocks.ghWithInput.mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    expect(() => reply({ summary: { body: 'Pushed aaa.' } })).toThrow(
      /connection reset/,
    );
    const landed = {
      ...comment('IC_50', 'me', 'OWNER'),
      body: `Pushed aaa.\n\n${REPLY_MARKER}`,
    };
    // Round N+1 pushed bbb and reports it.
    const pushed = 'b'.repeat(40);
    writeState(paths.statePath, {
      ...state(),
      lastKnownHeadSha: pushed,
      pushedShas: [pushed],
    });
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({
        headRefOid: pushed,
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [landed],
        },
      }),
      viewer: 'me',
    }));
    const outcome = reply({ summary: { body: 'Pushed bbb.' } });
    expect(outcome).toMatchObject({ adopted: 1, summarySkipped: false });
    expect(outcome.posted.map((p) => p.kind)).toEqual(['summary']);
    expect(state().summarizedSha).toBe(pushed);
  });

  it("still summarizes a push when the summary's comments were answered meanwhile", () => {
    const pushed = 'b'.repeat(40);
    writeState(paths.statePath, {
      ...state(),
      lastKnownHeadSha: pushed,
      pushedShas: [pushed],
      summarizedSha: HEAD,
      handledCommentIds: ['IC_1'],
    });
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({ headRefOid: pushed }),
      viewer: 'me',
    }));
    const outcome = reply({
      summary: { body: 'Pushed bbb: renamed.', handled: ['IC_1'] },
    });
    expect(outcome).toMatchObject({ summarySkipped: false });
    expect(posts().map((p) => p.path)).toEqual(['repos/o/r/issues/7/comments']);
    expect(state().summarizedSha).toBe(pushed);
    // Once.
    expect(
      reply({ summary: { body: 'Pushed bbb: renamed.', handled: ['IC_1'] } }),
    ).toMatchObject({
      summarySkipped: true,
    });
  });

  it('reports a blocked round even on a head an earlier round already summarized', () => {
    writeState(paths.statePath, { ...state(), summarizedSha: HEAD });
    const plan: ReplyPlan = {
      summary: { body: 'Needs a human: Test fails outside the PR.' },
      needsHuman: ['Test: whether the runner image is ours to fix'],
    };
    expect(reply(plan)).toMatchObject({ summarySkipped: false });
    expect(posts().map((p) => p.path)).toEqual(['repos/o/r/issues/7/comments']);
    // The same items never post it twice.
    expect(reply(plan)).toMatchObject({ summarySkipped: true });
    expect(posts()).toHaveLength(1);
    // Nothing new for a person on a head already summarized: quiet.
    expect(reply({ summary: { body: 'Still blocked.' } })).toMatchObject({
      summarySkipped: true,
    });
    // A new item on that same head is reported.
    expect(
      reply({
        summary: { body: 'Needs a human: the API change.' },
        needsHuman: ['PRRC_101: whether to keep the API'],
      }),
    ).toMatchObject({ summarySkipped: false });
    expect(posts()).toHaveLength(2);
  });

  it('with --no-post records a blocked summary and posts nothing', () => {
    const plan: ReplyPlan = {
      summary: { body: 'Needs a human: Test.' },
      needsHuman: ['Test: the runner image'],
    };
    expect(reply(plan, false).posted).toEqual([]);
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
    expect(state().summarizedSha).toBe(HEAD);
    expect(reply(plan)).toMatchObject({ summarySkipped: true });
    expect(mocks.ghWithInput).not.toHaveBeenCalled();
  });

  it('posts again when the reply an earlier run announced never reached the PR', () => {
    mocks.ghWithInput.mockImplementationOnce(() => {
      throw new Error('connection refused');
    });
    expect(() =>
      reply({
        replies: [{ replyTo: 101, body: 'Fixed.', handled: ['PRRC_101'] }],
      }),
    ).toThrow(/connection refused/);
    // An older reply of the tool's sits in the thread, unrecorded: it is
    // not the announced one, whatever comes after.
    const older = {
      ...comment('PRRC_140', 'me', 'OWNER'),
      body: `Not changed: earlier.\n\n${REPLY_MARKER}`,
    };
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            thread('T1', [comment('PRRC_101', 'alice', 'COLLABORATOR'), older]),
          ],
        },
      }),
      viewer: 'me',
    }));
    const outcome = reply({
      replies: [{ replyTo: 101, body: 'Fixed.', handled: ['PRRC_101'] }],
    });
    expect(outcome).toMatchObject({ adopted: 0 });
    expect(outcome.posted).toHaveLength(1);
    expect(state().pendingPosts).toEqual([]);
  });

  it('never takes an unannounced reply of the tool for the answer to other comments', () => {
    // The tool's own reply to PRRC_101 with a generic body, unrecorded and
    // not announced (posted before this state existed).
    const generic = {
      ...comment('PRRC_150', 'me', 'OWNER'),
      body: `Needs a human decision: which name?\n\n${REPLY_MARKER}`,
    };
    mocks.fetchPrData.mockImplementation(() => ({
      pr: prData({
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            thread('T1', [
              comment('PRRC_101', 'alice', 'COLLABORATOR'),
              comment('PRRC_102', 'alice', 'COLLABORATOR'),
              generic,
            ]),
          ],
        },
      }),
      viewer: 'me',
    }));
    const outcome = reply({
      replies: [
        {
          replyTo: 101,
          body: 'Needs a human decision: which name?',
          handled: ['PRRC_101', 'PRRC_102'],
        },
      ],
    });
    expect(outcome).toMatchObject({ adopted: 0 });
    expect(posts()).toHaveLength(1);
  });

  it('holds the watch lock, so a second helper cannot interleave its write', () => {
    mocks.ghWithInput.mockImplementation(() => {
      // The model issued another helper call in parallel.
      expect(() => reply({ handled: ['IC_1'] })).toThrow(
        /another autofix-pr helper is working on PR #7/,
      );
      return JSON.stringify({ node_id: 'POSTED_1', html_url: '' });
    });
    reply({
      replies: [{ replyTo: 101, body: 'Fixed.', handled: ['PRRC_101'] }],
    });
    expect(mocks.ghWithInput).toHaveBeenCalledTimes(1);
    expect(state().handledCommentIds).toEqual(['PRRC_101']);
    // Released afterwards.
    expect(existsSync(join(repo, '.qwen', 'tmp', 'autofix-pr-7.lock'))).toBe(
      false,
    );
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
    expect(() =>
      parsePlan({
        replies: [
          { replyTo: 1, body: 'x', handled: ['a'] },
          { replyTo: 1, body: 'y', handled: ['b'] },
        ],
      }),
    ).toThrow(/thread 1 has more than one reply/);
    expect(() =>
      parsePlan({
        replies: [{ replyTo: 1, body: 'x', handled: ['a'] }],
        summary: { body: 'y', handled: ['a'] },
      }),
    ).toThrow(/handled more than once in the plan: a/);
    expect(() => parsePlan({ needsHuman: ['ok', 3] })).toThrow(
      /needsHuman must be an array of non-empty strings/,
    );
    expect(parsePlan({})).toEqual({
      replies: [],
      summary: null,
      handled: [],
      handledChecks: [],
      handledConflict: false,
      needsHuman: [],
    });
  });
});
