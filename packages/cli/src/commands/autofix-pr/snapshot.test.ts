/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  bodyLines,
  buildSnapshot,
  rerunFrom,
  type PrData,
} from './snapshot.js';
import { REPLY_MARKER, type AutofixPrState } from './state.js';

const HEAD = 'a'.repeat(40);

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
    url: 'https://github.com/o/r/pull/7',
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
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

function comment(
  id: string,
  login: string,
  association = 'NONE',
  extra: {
    bot?: boolean;
    body?: string;
    databaseId?: number;
    state?: string;
  } = {},
) {
  return {
    id,
    databaseId: extra.databaseId,
    author: { __typename: extra.bot ? 'Bot' : 'User', login },
    authorAssociation: association,
    body: extra.body ?? `please fix ${id}`,
    url: `https://github.com/o/r/pull/7#${id}`,
    state: extra.state,
  };
}

function thread(
  id: string,
  comments: Array<ReturnType<typeof comment>>,
  extra: { isResolved?: boolean; isOutdated?: boolean } = {},
) {
  return {
    id,
    isResolved: extra.isResolved ?? false,
    isOutdated: extra.isOutdated ?? false,
    path: 'src/a.ts',
    line: 3,
    root: {
      nodes: comments
        .slice(0, 1)
        .map(({ databaseId }) => ({ databaseId: databaseId ?? 0 })),
    },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: comments },
  };
}

function threads(...nodes: Array<ReturnType<typeof thread>>) {
  return { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } };
}

describe('buildSnapshot', () => {
  it('stops on a merged or closed PR', () => {
    expect(buildSnapshot(pr({ state: 'MERGED' }), state())).toMatchObject({
      action: 'stop',
      events: [{ type: 'merged' }],
    });
    expect(buildSnapshot(pr({ state: 'CLOSED' }), state())).toMatchObject({
      action: 'stop',
      events: [{ type: 'closed' }],
    });
  });

  it('reports a workflow GitHub could not start, which leaves no check run', () => {
    const data = pr();
    data.commits.nodes[0]!.commit.checkSuites = {
      nodes: [
        {
          databaseId: 89354937468,
          conclusion: 'STARTUP_FAILURE',
          app: { databaseId: 15368 },
          workflowRun: {
            databaseId: 32985578813,
            url: 'https://github.com/o/r/actions/runs/32985578813',
            event: 'pull_request',
            workflow: { databaseId: 176254679, name: 'Qwen Code CI' },
          },
        },
        {
          databaseId: 2,
          conclusion: 'SUCCESS',
          app: { databaseId: 15368 },
          workflowRun: {
            databaseId: 3,
            url: 'https://github.com/o/r/actions/runs/3',
            event: 'pull_request',
            workflow: { databaseId: 4, name: 'Lint' },
          },
        },
      ],
    };
    expect(buildSnapshot(data, state())).toMatchObject({
      action: 'fix',
      events: [
        {
          type: 'ci_failed',
          check: 'Qwen Code CI',
          runId: 32985578813,
          startupFailure: true,
          key: `Qwen Code CI@${HEAD}@#startup:176254679:pull_request`,
        },
      ],
    });
    // Once handled, it is not offered again on the head.
    expect(
      buildSnapshot(
        data,
        state({
          handledChecks: [
            `Qwen Code CI@${HEAD}@#startup:176254679:pull_request`,
          ],
        }),
      ).action,
    ).toBe('wait');
  });

  it('writes a body as its lines, folding a long one without cutting a character', () => {
    const emoji = '😀';
    const long = `${'x'.repeat(1_999)}${emoji}${'y'.repeat(10)}`;
    const lines = bodyLines(`first\n${long}\nlast`);
    expect(lines[0]).toBe('first');
    expect(lines[2]).toBe('last');
    const pieces = lines[1] as string[];
    expect(Array.isArray(pieces)).toBe(true);
    expect(pieces.join('')).toBe(long);
    // The emoji is whole in one piece.
    expect(pieces.some((piece) => piece.includes(emoji))).toBe(true);
    // Two bodies that differ by a line break stay apart.
    expect(bodyLines(`${'a'.repeat(2_000)}b`)).not.toEqual(
      bodyLines(`${'a'.repeat(2_000)}\nb`),
    );
  });

  it('counts only the latest run of each workflow the code triggered, once, with no rollup at all', () => {
    const suite = (
      databaseId: number,
      conclusion: string,
      event: string,
      workflow = 176254679,
    ) => ({
      databaseId,
      conclusion,
      app: { databaseId: 15368 },
      workflowRun: {
        databaseId: databaseId * 10,
        url: `https://github.com/o/r/actions/runs/${databaseId * 10}`,
        event,
        workflow: { databaseId: workflow, name: `wf-${workflow}` },
      },
    });
    const data = pr();
    // The only workflow cannot start: no check run, no status, no rollup.
    data.commits.nodes[0]!.commit.statusCheckRollup = null;
    data.commits.nodes[0]!.commit.checkSuites = {
      nodes: [
        suite(1, 'STARTUP_FAILURE', 'pull_request'),
        suite(2, 'STARTUP_FAILURE', 'pull_request'),
        // Superseded by a later run of the same workflow that started.
        suite(3, 'STARTUP_FAILURE', 'push', 7),
        suite(4, 'SUCCESS', 'push', 7),
        // A run for a review comment says nothing of the code.
        suite(5, 'STARTUP_FAILURE', 'pull_request_review_comment', 8),
      ],
    };
    const snap = buildSnapshot(data, state());
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'ci_failed',
        check: 'wf-176254679',
        url: 'https://github.com/o/r/actions/runs/20',
        runId: 20,
        startupFailure: true,
        key: `wf-176254679@${HEAD}@#startup:176254679:pull_request`,
      },
    ]);
  });

  it("takes a bot's comment that answers another for a reply, even as a thread's first", () => {
    // `replyTo` as GraphQL gives it while the parent exists, or as
    // `fetchPrData` sets it from REST once the parent is deleted.
    const reply = {
      ...comment('PRRC_9', 'review-bot', 'NONE', { bot: true, databaseId: 9 }),
      replyTo: { id: 'PRRC_gone' },
    };
    const snap = buildSnapshot(pr(threads(thread('T9', [reply]))), state());
    expect(snap).toMatchObject({ action: 'wait', events: [] });
  });

  it('leaves out draft review comments, and every reply of a bot in a thread', () => {
    const own = {
      ...comment('PRRC_2', 'me', 'OWNER', { databaseId: 2 }),
      body: `Not changed: kept on purpose.\n\n${REPLY_MARKER}`,
    };
    const snap = buildSnapshot(
      pr(
        threads(
          // The viewer's draft of a review not submitted yet.
          thread('T1', [
            comment('PRRC_1', 'me', 'OWNER', {
              databaseId: 1,
              state: 'PENDING',
            }),
          ]),
          // A review bot that answers every reply in its threads.
          thread('T2', [
            comment('PRRC_3', 'review-bot', 'NONE', {
              bot: true,
              databaseId: 3,
            }),
            own,
            comment('PRRC_4', 'review-bot', 'NONE', {
              bot: true,
              databaseId: 4,
            }),
          ]),
          // An untrusted commenter asking the bot to speak for them.
          thread('T3', [
            comment('PRRC_5', 'stranger', 'NONE', { databaseId: 5 }),
            comment('PRRC_6', 'review-bot', 'NONE', {
              bot: true,
              databaseId: 6,
            }),
          ]),
        ),
      ),
      state({ postedCommentIds: [], handledCommentIds: ['PRRC_3'] }),
    );
    const ids = snap.events.flatMap((event) =>
      event.type === 'review_thread'
        ? event.comments.map((c) => c.id)
        : 'id' in event
          ? [event.id]
          : [],
    );
    expect(ids).toEqual(['PRRC_5']);
    // A bot's reply answers someone, even a person; only the comment that
    // opens a thread asks.
    const followUp = buildSnapshot(
      pr(
        threads(
          thread('T4', [
            comment('PRRC_7', 'alice', 'MEMBER', { databaseId: 7 }),
            comment('PRRC_8', 'review-bot', 'NONE', {
              bot: true,
              databaseId: 8,
            }),
          ]),
        ),
      ),
      state(),
    );
    expect(followUp.events).toMatchObject([
      { type: 'review_thread', comments: [{ id: 'PRRC_7' }] },
    ]);
    expect(
      (followUp.events[0] as { comments: unknown[] }).comments,
    ).toHaveLength(1);
  });

  it("carries the PR's title, the language the summary is written in", () => {
    expect(buildSnapshot(pr({ title: '修复登录超时' }), state())).toMatchObject(
      { title: '修复登录超时' },
    );
  });

  it('waits when nothing changed', () => {
    expect(buildSnapshot(pr(), state())).toEqual({
      action: 'wait',
      headSha: HEAD,
      isDraft: false,
      url: 'https://github.com/o/r/pull/7',
      events: [],
      truncated: [],
    });
  });

  it('resyncs when someone else moved the head, and still lists the rest', () => {
    const moved = 'b'.repeat(40);
    const snap = buildSnapshot(
      pr({
        headRefOid: moved,
        mergeable: 'CONFLICTING',
        commits: { nodes: [] },
      }),
      state(),
    );
    expect(snap.action).toBe('resync');
    expect(snap.events).toEqual([
      { type: 'head_moved_externally', sha: moved },
      { type: 'conflict' },
    ]);
  });

  it('does not treat its own push as an external move', () => {
    const pushed = 'c'.repeat(40);
    const snap = buildSnapshot(
      pr({ headRefOid: pushed, commits: { nodes: [] } }),
      state({ pushedShas: [pushed] }),
    );
    expect(snap.action).toBe('wait');
  });

  it('asks for a fix on a merge conflict', () => {
    expect(
      buildSnapshot(pr({ mergeable: 'CONFLICTING' }), state()),
    ).toMatchObject({
      action: 'fix',
      events: [{ type: 'conflict' }],
    });
  });

  it('reads a re-run entry whatever its job name holds', () => {
    for (const name of ['Build', 'Build\nlinux', 'Build\u2028linux', 'B@12']) {
      const key = `run:15368:9:pull_request_review:${name}@${HEAD}`;
      expect(rerunFrom([`${key}@101`])).toEqual(new Map([[key, 101]]));
    }
  });

  it('reports a failure of a workflow a review starts once per head, however many reviews start it', () => {
    const run = (databaseId: number, event: string): Contexts[number] => ({
      __typename: 'CheckRun',
      databaseId,
      name: 'Gate',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: `https://github.com/o/r/actions/runs/${databaseId}/job/1`,
      checkSuite: {
        status: 'COMPLETED',
        app: { databaseId: 15368 },
        workflowRun: { event, workflow: { databaseId: 9 } },
      },
    });
    const key = `Gate@${HEAD}@#on:9:pull_request_review`;
    expect(
      buildSnapshot(pr({}, [run(100, 'pull_request_review')]), state()),
    ).toMatchObject({
      events: [{ type: 'ci_failed', key }],
    });
    // Handled; a stranger's review then starts it again.
    const handled = state({ handledChecks: [key] });
    expect(
      buildSnapshot(
        pr({}, [
          run(100, 'pull_request_review'),
          run(101, 'pull_request_review'),
        ]),
        handled,
      ).action,
    ).toBe('wait');
    // Re-run on this head from run 101: a failure of a later run is the
    // re-run's answer, reported once more, then quiet like the first.
    const reran = [`run:15368:9:pull_request_review:Gate@${HEAD}@101`];
    const again = `Gate@${HEAD}@#rerun:9:pull_request_review`;
    const rerun = state({ handledChecks: [key], rerunChecks: reran });
    expect(
      buildSnapshot(pr({}, [run(102, 'pull_request_review')]), rerun).events,
    ).toMatchObject([{ type: 'ci_failed', key: again }]);
    expect(
      buildSnapshot(
        pr({}, [run(103, 'pull_request_review')]),
        state({ handledChecks: [key, again], rerunChecks: reran }),
      ).action,
    ).toBe('wait');
    // The run re-run keeps its key until GitHub lists the re-run: it is
    // neither reported again nor taken for the re-run's answer.
    expect(
      buildSnapshot(pr({}, [run(101, 'pull_request_review')]), rerun).action,
    ).toBe('wait');
    // A re-run whose answer was lost leaves it unhandled, under the key
    // the round answers it by.
    expect(
      buildSnapshot(
        pr({}, [run(101, 'pull_request_review')]),
        state({ rerunChecks: reran }),
      ).events,
    ).toMatchObject([{ type: 'ci_failed', key }]);
    // A run the code started is still a new attempt each time.
    expect(
      buildSnapshot(
        pr({}, [run(200, 'pull_request')]),
        state({ handledChecks: [`Gate@${HEAD}@#199`] }),
      ).events,
    ).toMatchObject([{ type: 'ci_failed', key: `Gate@${HEAD}@#200` }]);
  });

  it("gives a run id only to a GitHub Actions job of the PR's repository", () => {
    const check = (
      detailsUrl: string,
      workflowRun: boolean,
      databaseId: number,
    ): Contexts[number] => ({
      __typename: 'CheckRun',
      databaseId,
      name: `C${databaseId}`,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl,
      checkSuite: {
        status: 'COMPLETED',
        app: { databaseId: workflowRun ? 15368 : 99 },
        workflowRun: workflowRun
          ? { event: 'pull_request', workflow: { databaseId: 2 } }
          : null,
      },
    });
    const snap = buildSnapshot(
      pr({}, [
        check('https://github.com/o/r/actions/runs/1/job/9', true, 1),
        // Another app's check, another repository's run, a lookalike.
        check('https://github.com/o/r/actions/runs/2/job/9', false, 2),
        check('https://github.com/x/r/actions/runs/3/job/9', true, 3),
        check('https://ci.example/o/r/actions/runs/4/job/9', true, 4),
        {
          __typename: 'StatusContext',
          createdAt: '2026-10-21T00:00:06Z',
          context: 'ci/spoof',
          state: 'FAILURE',
          targetUrl: 'https://github.com/o/r/actions/runs/5/details',
        },
      ]),
      state(),
    );
    expect(
      snap.events.flatMap((event) =>
        event.type === 'ci_failed' ? [[event.check, event.runId]] : [],
      ),
    ).toEqual([
      ['C1', 1],
      ['C2', null],
      ['C3', null],
      ['C4', null],
      ['ci/spoof', null],
    ]);
  });

  it('reports failed checks with their run id and waits on pending ones', () => {
    const snap = buildSnapshot(
      pr({}, [
        {
          __typename: 'CheckRun',
          databaseId: 1,
          name: 'Test ubuntu',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/o/r/actions/runs/123/job/456',
          checkSuite: {
            status: 'COMPLETED',
            app: { databaseId: 15368 },
            workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
          },
        },
        {
          __typename: 'CheckRun',
          databaseId: 2,
          name: 'Lint',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          detailsUrl: null,
        },
        {
          __typename: 'CheckRun',
          databaseId: 3,
          name: 'Build',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: null,
        },
        {
          __typename: 'StatusContext',
          createdAt: '2026-10-21T00:00:06Z',
          context: 'ci/external',
          state: 'ERROR',
          targetUrl: 'https://ci.example.com/1',
        },
        {
          __typename: 'StatusContext',
          createdAt: '2026-10-21T00:00:07Z',
          context: 'ci/slow',
          state: 'PENDING',
          targetUrl: null,
        },
      ]),
      state(),
    );
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'ci_failed',
        check: 'Test ubuntu',
        url: 'https://github.com/o/r/actions/runs/123/job/456',
        runId: 123,
        key: `Test ubuntu@${HEAD}@#1`,
      },
      {
        type: 'ci_failed',
        check: 'ci/external',
        url: 'https://ci.example.com/1',
        runId: null,
        key: `ci/external@${HEAD}@2026-10-21T00:00:06Z`,
      },
      { type: 'ci_pending', checks: ['Build', 'ci/slow'] },
    ]);
  });

  it('skips a failed attempt a round handled without a push, but not a re-run that fails again', () => {
    const run = (databaseId: number): Contexts[number] => ({
      __typename: 'CheckRun',
      databaseId,
      name: 'Test ubuntu',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: `https://github.com/o/r/actions/runs/${databaseId}/job/1`,
      checkSuite: {
        status: 'COMPLETED',
        app: { databaseId: 15368 },
        workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
      },
    });
    const handled = state({ handledChecks: [`Test ubuntu@${HEAD}@#5`] });
    expect(buildSnapshot(pr({}, [run(5)]), handled)).toMatchObject({
      action: 'wait',
      events: [],
    });
    expect(buildSnapshot(pr({}, [run(5), run(6)]), handled)).toMatchObject({
      action: 'fix',
      events: [{ type: 'ci_failed', runId: 6, key: `Test ubuntu@${HEAD}@#6` }],
    });
    // The same attempt key on another head says nothing about this one.
    const otherHead = state({
      handledChecks: [`Test ubuntu@${'b'.repeat(40)}@#5`],
    });
    expect(buildSnapshot(pr({}, [run(5)]), otherHead).action).toBe('fix');
  });

  it('takes no skipped job for the latest run of its check', () => {
    const gate = (
      databaseId: number,
      conclusion: string,
    ): Contexts[number] => ({
      __typename: 'CheckRun',
      databaseId,
      name: 'Gate',
      status: 'COMPLETED',
      conclusion,
      detailsUrl: `https://github.com/o/r/actions/runs/${databaseId}/job/1`,
      checkSuite: {
        status: 'COMPLETED',
        app: { databaseId: 1 },
        workflowRun: {
          event: 'pull_request_review',
          workflow: { databaseId: 9 },
        },
      },
    });
    // A comment review started the workflow again; the job runs on
    // approvals only, so it skipped: the failure before it stands.
    expect(
      buildSnapshot(
        pr({}, [gate(100, 'FAILURE'), gate(101, 'SKIPPED')]),
        state(),
      ).events,
    ).toMatchObject([{ type: 'ci_failed', check: 'Gate', runId: 100 }]);
    // Whatever order the rollup lists them in.
    expect(
      buildSnapshot(
        pr({}, [gate(101, 'SKIPPED'), gate(100, 'FAILURE')]),
        state(),
      ).events,
    ).toMatchObject([{ type: 'ci_failed', check: 'Gate', runId: 100 }]);
    // A run that did run answers it.
    expect(
      buildSnapshot(
        pr({}, [
          gate(100, 'FAILURE'),
          gate(101, 'SKIPPED'),
          gate(102, 'SUCCESS'),
        ]),
        state(),
      ).action,
    ).toBe('wait');
  });

  it('leaves out the failures of a deferred re-run until their run has ended', () => {
    const lint = (status: string): Contexts[number] => ({
      __typename: 'CheckRun',
      databaseId: 5,
      name: 'Lint',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/o/r/actions/runs/123/job/5',
      checkSuite: {
        status,
        app: { databaseId: 1 },
        workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
      },
    });
    // `rerun` deferred it, holding Lint's run 5.
    const deferred = state({
      deferredRuns: [123],
      heldChecks: [`123:run:1:2:pull_request:Lint@${HEAD}@5`],
    });
    expect(
      buildSnapshot(pr({}, [lint('IN_PROGRESS')]), deferred),
    ).toMatchObject({ action: 'wait', events: [] });
    // A job of the run that failed after the deferral is the round's now.
    expect(
      buildSnapshot(
        pr({}, [
          lint('IN_PROGRESS'),
          {
            ...(lint('IN_PROGRESS') as Extract<
              Contexts[number],
              { __typename: 'CheckRun' }
            >),
            databaseId: 6,
            name: 'Test',
          },
        ]),
        deferred,
      ).events,
    ).toMatchObject([{ type: 'ci_failed', check: 'Test' }]);
    expect(buildSnapshot(pr({}, [lint('IN_PROGRESS')]), state()).action).toBe(
      'fix',
    );
    expect(buildSnapshot(pr({}, [lint('COMPLETED')]), deferred)).toMatchObject({
      action: 'fix',
      events: [{ type: 'ci_failed', check: 'Lint', runId: 123 }],
    });
  });

  it('reads an API that has not caught up with the branch as lag, not a push', () => {
    const pushed = 'b'.repeat(40);
    const failing: Contexts[number] = {
      __typename: 'CheckRun',
      databaseId: 5,
      name: 'Test',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/o/r/actions/runs/5/job/1',
    };
    // The watch pushed (or synced to) `pushed`; the API still shows HEAD.
    const watch = state({ lastKnownHeadSha: pushed, pushedShas: [pushed] });
    const stale = pr(
      {
        mergeable: 'CONFLICTING',
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('IC_1', 'bob', 'MEMBER')],
        },
      },
      [failing],
    );
    expect(buildSnapshot(stale, watch, pushed)).toMatchObject({
      action: 'fix',
      headSha: pushed,
      lagging: true,
      events: [{ type: 'issue_comment', id: 'IC_1' }],
    });
    // The branch did move since: someone else pushed.
    expect(buildSnapshot(stale, watch, 'c'.repeat(40)).action).toBe('resync');
    // Even back to a head the watch once pushed: the author rolled back.
    const rolledBack = state({
      lastKnownHeadSha: pushed,
      pushedShas: [HEAD, pushed],
    });
    expect(buildSnapshot(pr(), rolledBack, HEAD).action).toBe('resync');
  });

  it('reports a conflict until a round leaves it for a human on this head', () => {
    const conflicting = pr({ mergeable: 'CONFLICTING' });
    expect(buildSnapshot(conflicting, state()).events).toEqual([
      { type: 'conflict' },
    ]);
    expect(
      buildSnapshot(conflicting, state({ handledConflictSha: HEAD })),
    ).toMatchObject({ action: 'wait', events: [] });
    expect(
      buildSnapshot(conflicting, state({ handledConflictSha: 'b'.repeat(40) }))
        .events,
    ).toEqual([{ type: 'conflict' }]);
  });

  it('judges each check by its latest run only', () => {
    const run = (
      databaseId: number,
      conclusion: string | null,
      workflow = 1,
      event = 'pull_request',
    ): Contexts[number] => ({
      __typename: 'CheckRun',
      name: 'Test ubuntu',
      status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion,
      detailsUrl: `https://github.com/o/r/actions/runs/${databaseId}/job/1`,
      databaseId,
      checkSuite: {
        app: { databaseId: 15368 },
        workflowRun: { event, workflow: { databaseId: workflow } },
      },
    });
    const failures = (contexts: Contexts) =>
      buildSnapshot(pr({}, contexts), state())
        .events.filter((e) => e.type === 'ci_failed')
        .map((e) => (e.type === 'ci_failed' ? e.runId : null));
    // A failure that a re-run turned green, in either order of the rollup.
    expect(failures([run(1, 'FAILURE'), run(2, 'SUCCESS')])).toEqual([]);
    expect(failures([run(2, 'SUCCESS'), run(1, 'FAILURE')])).toEqual([]);
    // A green run that a re-run turned red.
    expect(failures([run(1, 'SUCCESS'), run(2, 'FAILURE')])).toEqual([2]);
    // A re-run still going: pending, not failed.
    expect(
      buildSnapshot(pr({}, [run(1, 'FAILURE'), run(2, null)]), state()).events,
    ).toEqual([{ type: 'ci_pending', checks: ['Test ubuntu'] }]);
    // The same job name in another workflow (even one with the same display
    // name), or on another trigger, is another check.
    expect(failures([run(1, 'FAILURE'), run(2, 'SUCCESS', 2)])).toEqual([1]);
    expect(
      failures([
        run(1, 'FAILURE'),
        run(2, 'SKIPPED', 1, 'pull_request_review'),
      ]),
    ).toEqual([1]);
  });

  it('keeps apart checks of the same name from different apps', () => {
    const external = (
      databaseId: number,
      app: number,
      conclusion: string,
    ): Contexts[number] => ({
      __typename: 'CheckRun',
      name: 'build',
      status: 'COMPLETED',
      conclusion,
      detailsUrl: `https://ci.example.com/${databaseId}`,
      databaseId,
      checkSuite: { app: { databaseId: app }, workflowRun: null },
    });
    const snap = buildSnapshot(
      pr({}, [external(101, 1, 'FAILURE'), external(102, 2, 'SUCCESS')]),
      state(),
    );
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'ci_failed',
        check: 'build',
        url: 'https://ci.example.com/101',
        runId: null,
        key: `build@${HEAD}@#101`,
      },
    ]);
    // A later run of the same app's check does replace it.
    expect(
      buildSnapshot(
        pr({}, [external(101, 1, 'FAILURE'), external(103, 1, 'SUCCESS')]),
        state(),
      ).events,
    ).toEqual([]);
  });

  it('judges a commit status by its latest post', () => {
    const status = (createdAt: string, state: string): Contexts[number] => ({
      __typename: 'StatusContext',
      context: 'ci/external',
      state,
      targetUrl: null,
      createdAt,
    });
    expect(
      buildSnapshot(
        pr({}, [
          status('2026-10-21T00:00:01Z', 'FAILURE'),
          status('2026-10-21T00:00:02Z', 'SUCCESS'),
        ]),
        state(),
      ).events,
    ).toEqual([]);
  });

  it('waits while checks are only pending', () => {
    const snap = buildSnapshot(
      pr({}, [
        {
          __typename: 'CheckRun',
          databaseId: 4,
          name: 'Build',
          status: 'QUEUED',
          conclusion: null,
          detailsUrl: null,
        },
      ]),
      state(),
    );
    expect(snap.action).toBe('wait');
    expect(snap.events).toEqual([{ type: 'ci_pending', checks: ['Build'] }]);
  });

  it('ignores a rollup that belongs to an older commit', () => {
    const data = pr({}, [
      {
        __typename: 'CheckRun',
        databaseId: 5,
        name: 'Test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: null,
      },
    ]);
    data.commits.nodes[0].commit.oid = 'd'.repeat(40);
    expect(buildSnapshot(data, state()).events).toEqual([]);
  });

  it('groups trusted thread comments and replies to the top-level comment', () => {
    const snap = buildSnapshot(
      pr(
        threads(
          thread('T1', [
            comment('C1', 'alice', 'COLLABORATOR', { databaseId: 11 }),
            comment('C2', 'me', 'NONE', { databaseId: 12 }),
            comment('C3', 'stranger', 'CONTRIBUTOR', { databaseId: 13 }),
          ]),
        ),
      ),
      state({ handledCommentIds: ['C1'] }),
    );
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'untrusted_comment',
        id: 'C3',
        author: 'stranger',
        url: 'https://github.com/o/r/pull/7#C3',
      },
      {
        type: 'review_thread',
        threadId: 'T1',
        replyTo: 11,
        path: 'src/a.ts',
        line: 3,
        outdated: false,
        comments: [
          {
            id: 'C2',
            author: 'me',
            trust: 'pr_author',
            body: 'please fix C2',
            url: 'https://github.com/o/r/pull/7#C2',
          },
        ],
      },
    ]);
  });

  it('maps each trusted association', () => {
    const snap = buildSnapshot(
      pr(
        threads(
          thread('T1', [comment('C1', 'a', 'OWNER')]),
          thread('T2', [comment('C2', 'b', 'MEMBER')]),
          thread('T3', [comment('C3', 'c', 'COLLABORATOR')]),
          thread('T4', [
            comment('C4', 'review-bot', 'NONE', { bot: true, databaseId: 4 }),
          ]),
        ),
      ),
      state(),
    );
    expect(
      snap.events.map((e) =>
        e.type === 'review_thread' ? e.comments[0].trust : e.type,
      ),
    ).toEqual(['owner', 'member', 'collaborator', 'bot']);
  });

  it('waits on untrusted comments alone', () => {
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'stranger', 'CONTRIBUTOR')],
        },
      }),
      state(),
    );
    expect(snap.action).toBe('wait');
    expect(snap.events).toEqual([
      {
        type: 'untrusted_comment',
        id: 'I1',
        author: 'stranger',
        url: 'https://github.com/o/r/pull/7#I1',
      },
    ]);
  });

  it('trusts the PR author GitHub names now, not the login recorded at prepare', () => {
    // The author renamed their account, and someone took the old login.
    const comments = {
      pageInfo: { hasPreviousPage: false },
      nodes: [comment('I1', 'old-login'), comment('I2', 'new-login')],
    };
    const snap = buildSnapshot(
      pr({ author: { login: 'new-login' }, comments }),
      state({ prAuthor: 'old-login' }),
    );
    expect(snap.events).toMatchObject([
      { type: 'untrusted_comment', id: 'I1', author: 'old-login' },
      { type: 'issue_comment', id: 'I2', trust: 'pr_author' },
    ]);
  });

  it('treats a deleted author as untrusted', () => {
    const ghost = { ...comment('I1', 'x', 'OWNER'), author: null };
    const snap = buildSnapshot(
      pr({
        comments: { pageInfo: { hasPreviousPage: false }, nodes: [ghost] },
      }),
      state(),
    );
    expect(snap.events).toEqual([
      {
        type: 'untrusted_comment',
        id: 'I1',
        author: 'ghost',
        url: 'https://github.com/o/r/pull/7#I1',
      },
    ]);
  });

  it('drops bot conversation comments entirely', () => {
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'coverage', 'NONE', { bot: true })],
        },
      }),
      state(),
    );
    expect(snap).toMatchObject({ action: 'wait', events: [] });
  });

  it('takes a comment quoting a reply for a new comment', () => {
    // GitHub's quote-reply carries the quoted body, marker included.
    const quoted = `> Fixed in abc\n> ${REPLY_MARKER}\n\nnot fixed yet`;
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            comment('I1', 'alice', 'MEMBER', { body: quoted }),
            // Only the viewer posts replies, so the marker alone proves nothing.
            comment('I2', 'bob', 'MEMBER', { body: `ok\n${REPLY_MARKER}` }),
          ],
        },
      }),
      state(),
    );
    expect(snap.action).toBe('fix');
    expect(
      snap.events.map((e) => (e.type === 'issue_comment' ? e.id : e.type)),
    ).toEqual(['I1', 'I2']);
  });

  it('replies to the thread root even when only the newest replies were read', () => {
    const data = pr(
      threads(
        thread('T1', [comment('C150', 'alice', 'MEMBER', { databaseId: 150 })]),
      ),
    );
    data.reviewThreads.nodes[0].root = { nodes: [{ databaseId: 11 }] };
    data.reviewThreads.nodes[0].comments.pageInfo.hasPreviousPage = true;
    const snap = buildSnapshot(data, state());
    expect(snap.events).toMatchObject([
      { type: 'review_thread', replyTo: 11, comments: [{ id: 'C150' }] },
    ]);
    expect(snap.truncated).toEqual(['reviewThreadComments']);
  });

  it('never answers itself: marker, posted ids and handled ids are skipped', () => {
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            comment('I1', 'me', 'OWNER', {
              body: `Fixed in abc\n${REPLY_MARKER}\n\n`,
            }),
            comment('I2', 'me', 'OWNER'),
            comment('I3', 'me', 'OWNER'),
          ],
        },
      }),
      state({ postedCommentIds: ['I2'], handledCommentIds: ['I3'] }),
    );
    expect(snap).toMatchObject({ action: 'wait', events: [] });
  });

  it("takes the viewer's own quote of a reply for a new comment", () => {
    // The viewer quote-replies the tool's reply and adds a request after it.
    const quoted = `> Fixed in abc\n> ${REPLY_MARKER}\n\nstill fails`;
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'me', 'OWNER', { body: quoted })],
        },
      }),
      state(),
    );
    expect(snap).toMatchObject({
      action: 'fix',
      events: [{ type: 'issue_comment', id: 'I1' }],
    });
  });

  it('does not act on a dismissed review', () => {
    const snap = buildSnapshot(
      pr({
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            comment('R1', 'alice', 'MEMBER', {
              body: 'please refactor',
              state: 'DISMISSED',
            }),
          ],
        },
      }),
      state(),
    );
    expect(snap).toMatchObject({ action: 'wait', events: [] });
  });

  it('skips resolved threads and keeps outdated ones', () => {
    const snap = buildSnapshot(
      pr(
        threads(
          thread('T1', [comment('C1', 'a', 'OWNER')], { isResolved: true }),
          thread('T2', [comment('C2', 'a', 'OWNER')], { isOutdated: true }),
        ),
      ),
      state(),
    );
    expect(snap.events).toMatchObject([
      { type: 'review_thread', threadId: 'T2', outdated: true },
    ]);
  });

  it('reports reviews with a body and skips empty, pending or approving ones', () => {
    const snap = buildSnapshot(
      pr({
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            comment('R1', 'a', 'MEMBER', { body: '', state: 'COMMENTED' }),
            comment('R4', 'a', 'MEMBER', {
              body: 'LGTM, thanks!',
              state: 'APPROVED',
            }),
            comment('R2', 'a', 'MEMBER', { state: 'PENDING' }),
            comment('R3', 'review-bot', 'NONE', {
              bot: true,
              state: 'CHANGES_REQUESTED',
            }),
          ],
        },
      }),
      state(),
    );
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'review',
        state: 'CHANGES_REQUESTED',
        id: 'R3',
        author: 'review-bot',
        trust: 'bot',
        body: 'please fix R3',
        url: 'https://github.com/o/r/pull/7#R3',
      },
    ]);
  });

  it('flags connections cut at the page size', () => {
    const data = pr();
    data.commits.nodes[0].commit.statusCheckRollup!.contexts.pageInfo.hasNextPage = true;
    data.reviewThreads.pageInfo.hasNextPage = true;
    data.reviewThreads.nodes = [
      thread('T1', [comment('C1', 'alice', 'MEMBER')]),
      thread('T2', [comment('C2', 'alice', 'MEMBER')]),
    ];
    for (const node of data.reviewThreads.nodes) {
      node.comments.pageInfo.hasPreviousPage = true;
    }
    data.reviews.pageInfo.hasPreviousPage = true;
    data.comments.pageInfo.hasPreviousPage = true;
    expect(buildSnapshot(data, state()).truncated).toEqual([
      'checks',
      'reviewThreadComments',
      'reviewThreads',
      'reviews',
      'comments',
    ]);
  });
});
