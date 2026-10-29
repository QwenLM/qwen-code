/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CRON_GATE_OUTPUT_CAP_BYTES } from '@qwen-code/qwen-code-core/services/cron-gate.js';
import { GATE_OUTPUT_BUDGET_BYTES } from '../review/lib/gate-budget.js';
import { getGhHost, setGhHost } from '../review/lib/gh.js';
import {
  GATE_READ_BUDGET_MS,
  buildGateSnapshot,
  checkEvents,
  fetchPrData,
  runSnapshot,
  withAbandonedFix,
  type PrData,
} from './snapshot.js';
import {
  REPLY_MARKER,
  autofixPrPaths,
  writeState,
  type AutofixPrGateCursor,
  type AutofixPrState,
} from './state.js';

const mockGh = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  root: '',
  stdout: vi.fn((_line: string) => {}),
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

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

function cursor(
  overrides: Partial<AutofixPrGateCursor> = {},
): AutofixPrGateCursor {
  return {
    version: 1,
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    viewer: 'me',
    prAuthor: 'me',
    headSha: HEAD,
    reportedCommentIds: [],
    reportedChecks: [],
    conflictSha: null,
    stopped: null,
    reportedTruncated: [],
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

function failed(name: string, attempt = 1): Contexts[number] {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: `https://github.com/o/r/actions/runs/123/job/${attempt}`,
    databaseId: attempt,
    checkSuite: {
      status: 'COMPLETED',
      app: { databaseId: 15368 },
      workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
    },
  };
}

function thread(id: string, comments: Array<ReturnType<typeof comment>>) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 3,
    root: { nodes: [{ databaseId: 1 }] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: comments },
  };
}

function comment(
  id: string,
  login: string,
  association = 'NONE',
  body = `please fix ${id}`,
) {
  return {
    id,
    author: { __typename: 'User', login },
    authorAssociation: association,
    body,
    url: `https://github.com/o/r/pull/7#${id}`,
  };
}

describe('buildGateSnapshot', () => {
  it('is quiet when nothing changed and keeps the cursor', () => {
    const before = cursor();
    const result = buildGateSnapshot(pr(), before);
    expect(result.snapshot).toBeNull();
    expect(result.cursor).toEqual(before);
  });

  it('treats a pending check as nothing to report', () => {
    const result = buildGateSnapshot(
      pr({}, [
        {
          __typename: 'CheckRun',
          name: 'Build',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: null,
          databaseId: 1,
        },
      ]),
      cursor(),
    );
    expect(result.snapshot).toBeNull();
  });

  it('neither wakes nor forgets on a run its time budget cut short', () => {
    const cut = pr({}, [failed('Test', 1)]);
    cut.commits.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo = {
      hasNextPage: true,
      endCursor: 'c1',
    };
    const full = buildGateSnapshot(
      pr({}, [failed('Test', 1), failed('Lint', 2)]),
      cursor(),
    );
    expect(full.cursor.reportedChecks).toHaveLength(2);
    // GitHub was slow: the run read the first page only.
    const partial = buildGateSnapshot(cut, full.cursor, {
      knownHeads: [],
      seenCommentIds: [],
      partial: 'checks',
    });
    expect(partial.snapshot).toBeNull();
    expect(partial.cursor.reportedChecks).toEqual(full.cursor.reportedChecks);
    expect(partial.cursor.reportedTruncated).toEqual([]);
    // The next run reads it all, and has nothing new.
    expect(
      buildGateSnapshot(
        pr({}, [failed('Test', 1), failed('Lint', 2)]),
        partial.cursor,
      ).snapshot,
    ).toBeNull();
  });

  it('reports a page cap on a run its time budget cut in the threads', () => {
    const capped = pr({}, [failed('Test', 1)]);
    capped.commits.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo = {
      hasNextPage: true,
      endCursor: 'c10',
    };
    // Test was reported: the cap is all there is to wake for.
    const before = cursor({ reportedChecks: [`Test@${HEAD}@#1`] });
    const result = buildGateSnapshot(capped, before, {
      knownHeads: [],
      seenCommentIds: [],
      partial: 'threads',
    });
    expect(result.snapshot).toMatchObject({ action: 'wait', events: [] });
    expect(result.snapshot?.truncated).toContain('checks');
    expect(result.cursor.reportedTruncated).toEqual(['checks']);
    // Its cut is kept by the next run the time cuts in the checks.
    const slower = buildGateSnapshot(capped, result.cursor, {
      knownHeads: [],
      seenCommentIds: [],
      partial: 'checks',
    });
    expect(slower.snapshot).toBeNull();
    expect(slower.cursor.reportedTruncated).toEqual(['checks']);
  });

  it('reports a check run page cap on a run its time budget cut in the suites', () => {
    const startup = `CI@${HEAD}@#startup:9:pull_request`;
    const capped = pr({}, [failed('Test', 1)]);
    const commit = capped.commits.nodes[0]!.commit;
    commit.statusCheckRollup!.contexts.pageInfo = {
      hasNextPage: true,
      endCursor: 'c10',
    };
    commit.checkSuites = {
      pageInfo: { hasPreviousPage: true, startCursor: 's1' },
      nodes: [],
    };
    const watch = {
      knownHeads: [],
      seenCommentIds: [],
      partial: 'suites' as const,
    };
    const result = buildGateSnapshot(
      capped,
      cursor({ reportedChecks: [`Test@${HEAD}@#1`, startup] }),
      watch,
    );
    expect(result.snapshot).toMatchObject({ action: 'wait', events: [] });
    expect(result.cursor.reportedTruncated).toEqual(['checks']);
    // A failure to start on a suite page it did not read stays reported.
    expect(result.cursor.reportedChecks).toEqual(
      expect.arrayContaining([`Test@${HEAD}@#1`, startup]),
    );
    // With every check run read, the suites' cut is the time's alone.
    const whole = pr({}, [failed('Test', 1)]);
    whole.commits.nodes[0]!.commit.checkSuites = commit.checkSuites;
    const quiet = buildGateSnapshot(
      whole,
      cursor({ reportedChecks: [`Test@${HEAD}@#1`] }),
      watch,
    );
    expect(quiet.snapshot).toBeNull();
    expect(quiet.cursor.reportedTruncated).toEqual([]);
  });

  it('leaves out what a deferral holds until its run ends, and reports the rest', () => {
    const job = (
      databaseId: number,
      runId: number,
      status: string,
      name = 'B',
    ): Contexts[number] => ({
      __typename: 'CheckRun',
      name,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/${databaseId}`,
      databaseId,
      checkSuite: {
        status,
        app: { databaseId: 1 },
        workflowRun: {
          event: 'pull_request_review',
          workflow: { databaseId: 9 },
        },
      },
    });
    // The round deferred run 456's re-run, holding B's check run 5.
    const watch = {
      knownHeads: [],
      seenCommentIds: [],
      deferredRuns: [456],
      heldChecks: [`456:run:1:9:pull_request_review:B@${HEAD}@5`],
    };
    const going = buildGateSnapshot(
      pr({}, [job(5, 456, 'IN_PROGRESS')]),
      cursor(),
      watch,
    );
    expect(going.snapshot).toBeNull();
    expect(going.cursor.reportedChecks).toEqual([]);
    // C failed in the run after the deferral, which held nothing of it.
    const late = buildGateSnapshot(
      pr({}, [job(5, 456, 'IN_PROGRESS'), job(6, 456, 'IN_PROGRESS', 'C')]),
      going.cursor,
      watch,
    );
    expect(late.snapshot).toMatchObject({
      events: [{ type: 'ci_failed', check: 'C', runId: 456 }],
    });
    // A review started the workflow again before the run ended. C failed in
    // it under the key a run of C on this head carries: a run of its own,
    // and the round has not answered the key, so it is reported again; B's
    // later run is the deferral's answer.
    const later = buildGateSnapshot(
      pr({}, [
        job(5, 456, 'IN_PROGRESS'),
        job(6, 456, 'IN_PROGRESS', 'C'),
        job(8, 457, 'COMPLETED'),
        job(9, 457, 'COMPLETED', 'C'),
      ]),
      late.cursor,
      watch,
    );
    expect(
      later.snapshot?.events.map((event) =>
        event.type === 'ci_failed' ? `${event.check}:${event.runId}` : '',
      ),
    ).toEqual(['B:457', 'C:457']);
    // Answered, C stays quiet in the next run.
    const answered = buildGateSnapshot(
      pr({}, [job(10, 458, 'COMPLETED', 'C')]),
      later.cursor,
      {
        ...watch,
        handledChecks: [`C@${HEAD}@#on:9:pull_request_review`],
      },
    );
    expect(answered.snapshot).toBeNull();
  });

  it('reports no end of a deferred run whose failure a round has answered', () => {
    const ended = pr({}, [failed('Test', 1)]);
    const key = `Test@${HEAD}@#1`;
    const watch = {
      knownHeads: [],
      seenCommentIds: [],
      deferredRuns: [123],
      handledChecks: [key],
    };
    const result = buildGateSnapshot(ended, cursor(), watch);
    expect(result.snapshot).toBeNull();
    // Not answered, its end is reported, once.
    const open = buildGateSnapshot(ended, cursor({ reportedChecks: [key] }), {
      ...watch,
      handledChecks: [],
    });
    expect(open.snapshot).toMatchObject({
      events: [{ type: 'ci_failed', check: 'Test' }],
    });
    expect(open.cursor.reportedChecks).toEqual([key, `${key}@ended~1`]);
    // A job of the run re-run in it (check run 7): the run went again, the
    // round deferred it again, and its end is reported once more.
    const rerunJob = {
      ...(failed('Build', 7) as Extract<
        Contexts[number],
        { __typename: 'CheckRun' }
      >),
      conclusion: 'SUCCESS',
    };
    const again = buildGateSnapshot(
      pr({}, [failed('Test', 1), rerunJob]),
      open.cursor,
      { ...watch, handledChecks: [] },
    );
    expect(again.snapshot).toMatchObject({
      events: [{ type: 'ci_failed', check: 'Test' }],
    });
    expect(again.cursor.reportedChecks).toEqual([key, `${key}@ended~7`]);
  });

  it('takes a read that lists only an earlier run of a check for no new failure', () => {
    const gate = (databaseId: number): Contexts[number] => ({
      __typename: 'CheckRun',
      name: 'Gate',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: `https://github.com/o/r/actions/runs/${databaseId}/job/1`,
      databaseId,
      checkSuite: {
        status: 'COMPLETED',
        app: { databaseId: 1 },
        workflowRun: {
          event: 'pull_request_review',
          workflow: { databaseId: 9 },
        },
      },
    });
    const watch = { knownHeads: [], seenCommentIds: [] };
    const whole = buildGateSnapshot(
      pr({}, [gate(1), gate(5)]),
      cursor(),
      watch,
    );
    expect(whole.cursor.reportedChecks).toEqual([
      `Gate@${HEAD}@#on:9:pull_request_review~5`,
    ]);
    // GitHub was slow: the read listed run 1 only.
    const cut = buildGateSnapshot(pr({}, [gate(1)]), whole.cursor, {
      ...watch,
      partial: 'checks',
    });
    expect(cut.snapshot).toBeNull();
  });

  it('takes no earlier run a read the time cut lists for a new failure', () => {
    const gate = (
      databaseId: number,
      conclusion: string,
    ): Contexts[number] => ({
      __typename: 'CheckRun',
      name: 'Gate',
      status: 'COMPLETED',
      conclusion,
      detailsUrl: `https://github.com/o/r/actions/runs/${databaseId}/job/1`,
      databaseId,
      checkSuite: {
        status: 'COMPLETED',
        app: { databaseId: 1 },
        workflowRun: { event: 'pull_request', workflow: { databaseId: 9 } },
      },
    });
    const watch = { knownHeads: [], seenCommentIds: [] };
    const red = buildGateSnapshot(
      pr({}, [gate(100, 'FAILURE')]),
      cursor(),
      watch,
    );
    expect(red.snapshot).not.toBeNull();
    // The author re-ran it, green: a whole read forgets the failure.
    const green = buildGateSnapshot(
      pr({}, [gate(100, 'FAILURE'), gate(105, 'SUCCESS')]),
      red.cursor,
      watch,
    );
    expect(green.snapshot).toBeNull();
    // GitHub was slow: the read listed the old run only.
    for (let fire = 0; fire < 3; fire++) {
      const cut = buildGateSnapshot(
        pr({}, [gate(100, 'FAILURE')]),
        green.cursor,
        {
          ...watch,
          partial: 'checks',
        },
      );
      expect(cut.snapshot).toBeNull();
    }
  });

  it('waits for a whole read to report the end of a deferred run', () => {
    const watch = {
      knownHeads: [],
      seenCommentIds: [],
      deferredRuns: [123],
    };
    const key = `Test@${HEAD}@#1`;
    const before = cursor({ reportedChecks: [key] });
    // The read the time cut lists Test, not the run's later job.
    const cut = buildGateSnapshot(pr({}, [failed('Test', 1)]), before, {
      ...watch,
      partial: 'checks',
    });
    expect(cut.snapshot).toBeNull();
    const laterJob = {
      ...(failed('Slow', 5) as Extract<
        Contexts[number],
        { __typename: 'CheckRun' }
      >),
      conclusion: 'SUCCESS',
    };
    const whole = buildGateSnapshot(
      pr({}, [failed('Test', 1), laterJob]),
      cut.cursor,
      watch,
    );
    expect(whole.snapshot).toMatchObject({
      events: [{ type: 'ci_failed', check: 'Test' }],
    });
    expect(
      buildGateSnapshot(
        pr({}, [failed('Test', 1), laterJob]),
        whole.cursor,
        watch,
      ).snapshot,
    ).toBeNull();
    // The held failure left the cursor while its run went: a cut read does
    // not report it on its own, and the whole read reports it once, end
    // and all.
    const fresh = buildGateSnapshot(pr({}, [failed('Test', 1)]), cursor(), {
      ...watch,
      partial: 'checks',
    });
    expect(fresh.snapshot).toBeNull();
    const once = buildGateSnapshot(
      pr({}, [failed('Test', 1), laterJob]),
      fresh.cursor,
      watch,
    );
    expect(once.snapshot).toMatchObject({
      events: [{ type: 'ci_failed', check: 'Test' }],
    });
    expect(once.cursor.reportedChecks).toEqual([key, `${key}@ended~5`]);
  });

  it('forgets a check gone green on a run its time budget cut in the threads', () => {
    const red = buildGateSnapshot(pr({}, [failed('Test', 1)]), cursor());
    expect(red.cursor.reportedChecks).toHaveLength(1);
    // Every check was read, and Test is green: only the threads were cut.
    const green = buildGateSnapshot(pr(), red.cursor, {
      knownHeads: [],
      seenCommentIds: [],
      partial: 'threads',
    });
    expect(green.snapshot).toBeNull();
    expect(green.cursor.reportedChecks).toEqual([]);
  });

  it('reports a failed check once per head and again after it was re-run', () => {
    const first = buildGateSnapshot(pr({}, [failed('Test')]), cursor());
    expect(first.snapshot).toMatchObject({
      action: 'fix',
      events: [{ type: 'ci_failed', check: 'Test', runId: 123 }],
    });
    expect(first.cursor.reportedChecks).toEqual([`Test@${HEAD}@#1`]);

    // Still failing on the same head: quiet.
    const second = buildGateSnapshot(pr({}, [failed('Test')]), first.cursor);
    expect(second.snapshot).toBeNull();

    // Re-run in progress: the failure leaves the cursor…
    const rerun = buildGateSnapshot(
      pr({}, [
        failed('Test', 1),
        {
          __typename: 'CheckRun',
          name: 'Test',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: null,
          databaseId: 2,
          checkSuite: {
            status: 'IN_PROGRESS',
            app: { databaseId: 15368 },
            workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
          },
        },
      ]),
      second.cursor,
    );
    expect(rerun.snapshot).toBeNull();
    expect(rerun.cursor.reportedChecks).toEqual([]);
    // …so a second failure is a new event.
    expect(
      buildGateSnapshot(
        pr({}, [failed('Test', 1), failed('Test', 2)]),
        rerun.cursor,
      ).snapshot,
    ).not.toBeNull();

    // A new head starts over.
    const moved = buildGateSnapshot(
      pr({ headRefOid: NEXT_HEAD, commits: { nodes: [] } }, []),
      second.cursor,
    );
    expect(moved.snapshot).toMatchObject({
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: NEXT_HEAD }],
    });
    expect(moved.cursor.headSha).toBe(NEXT_HEAD);
  });

  it('reports a re-run that failed again between two polls', () => {
    // No poll saw the re-run in progress: the run's id tells the failures
    // apart.
    const first = buildGateSnapshot(pr({}, [failed('Test', 100)]), cursor());
    expect(first.snapshot?.events).toEqual([
      expect.objectContaining({ type: 'ci_failed', check: 'Test' }),
    ]);
    const again = buildGateSnapshot(
      pr({}, [failed('Test', 100), failed('Test', 200)]),
      first.cursor,
    );
    expect(again.snapshot?.events).toEqual([
      expect.objectContaining({
        type: 'ci_failed',
        check: 'Test',
        url: 'https://github.com/o/r/actions/runs/123/job/200',
      }),
    ]);
    expect(again.cursor.reportedChecks).toEqual([`Test@${HEAD}@#200`]);
    expect(
      buildGateSnapshot(pr({}, [failed('Test', 200)]), again.cursor).snapshot,
    ).toBeNull();
  });

  it('is quiet about a failure that a re-run turned green', () => {
    const green: Contexts[number] = {
      ...failed('Test', 2),
      conclusion: 'SUCCESS',
    } as Contexts[number];
    expect(
      buildGateSnapshot(pr({}, [failed('Test', 1), green]), cursor()).snapshot,
    ).toBeNull();
  });

  it('tells two failures of a commit status apart without a URL', () => {
    const status = (createdAt: string): Contexts[number] => ({
      __typename: 'StatusContext',
      context: 'ci/external',
      state: 'FAILURE',
      targetUrl: null,
      createdAt,
    });
    const first = buildGateSnapshot(
      pr({}, [status('2026-10-21T00:00:01Z')]),
      cursor(),
    );
    expect(first.snapshot?.events).toHaveLength(1);
    expect(
      buildGateSnapshot(pr({}, [status('2026-10-21T00:00:01Z')]), first.cursor)
        .snapshot,
    ).toBeNull();
    // Re-run and failed again between two polls: a new post.
    expect(
      buildGateSnapshot(pr({}, [status('2026-10-21T00:05:00Z')]), first.cursor)
        .snapshot?.events,
    ).toEqual([
      { type: 'ci_failed', check: 'ci/external', url: null, runId: null },
    ]);
  });

  it('keeps every reported id the query still returns, and bounds only the rest', () => {
    // 21 unresolved threads of 100 reportable comments: more ids than the
    // off-page bound, all still on the page on the next identical poll.
    const nodes = Array.from({ length: 21 }, (_, t) =>
      thread(
        `T${t}`,
        Array.from({ length: 100 }, (_, c) =>
          comment(`T${t}C${c}`, 'alice', 'MEMBER'),
        ),
      ),
    );
    const data = pr({
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes },
    });
    const all = nodes.flatMap((t) => t.comments.nodes.map((c) => c.id));
    const second = buildGateSnapshot(data, cursor({ reportedCommentIds: all }));
    expect(second.snapshot).toBeNull();
    expect(second.cursor.reportedCommentIds).toHaveLength(2100);

    // Ids that left the page keep only their newest 2000.
    const stale = cursor({
      reportedCommentIds: [
        ...Array.from({ length: 2500 }, (_, i) => `old${i}`),
        ...all,
      ],
    });
    const third = buildGateSnapshot(data, stale);
    expect(third.cursor.reportedCommentIds).toHaveLength(2000 + 2100);
    expect(third.cursor.reportedCommentIds[0]).toBe('old500');
  });

  it('fits the output a Managed gate sanitizes, where each < grows to &lt;', () => {
    const angled = '<'.repeat(900);
    const nodes = Array.from({ length: 30 }, (_, t) =>
      thread(`T${t}`, [comment(`T${t}C`, 'alice', 'MEMBER', angled)]),
    );
    const data = pr({
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes },
    });
    let current = cursor();
    const seen: string[] = [];
    for (let run = 0; run < 30; run++) {
      const result = buildGateSnapshot(data, current);
      current = result.cursor;
      if (!result.snapshot) break;
      const sanitized = JSON.stringify(result.snapshot).replace(/</g, '&lt;');
      expect(Buffer.byteLength(sanitized)).toBeLessThanOrEqual(
        GATE_OUTPUT_BUDGET_BYTES,
      );
      for (const event of result.snapshot.events) {
        if (event.type === 'review_thread') {
          seen.push(...event.comments.map((c) => c.id));
        }
      }
    }
    expect(new Set(seen).size).toBe(30);
  });

  it('spreads what does not fit the gate output over later runs, none twice', () => {
    expect(GATE_OUTPUT_BUDGET_BYTES).toBeLessThan(CRON_GATE_OUTPUT_CAP_BYTES);
    const nodes = Array.from({ length: 21 }, (_, t) =>
      thread(
        `T${t}`,
        Array.from({ length: 100 }, (_, c) =>
          comment(`T${t}C${c}`, 'alice', 'MEMBER'),
        ),
      ),
    );
    const data = pr(
      { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } },
      [failed('Test')],
    );
    let current = cursor();
    const seen: string[] = [];
    const sizes: number[] = [];
    let last = null as ReturnType<typeof buildGateSnapshot>['snapshot'];
    for (let run = 0; run < 100; run++) {
      const result = buildGateSnapshot(data, current);
      current = result.cursor;
      if (!result.snapshot) break;
      last = result.snapshot;
      sizes.push(Buffer.byteLength(JSON.stringify(result.snapshot)));
      for (const event of result.snapshot.events) {
        if (event.type === 'review_thread') {
          seen.push(...event.comments.map((c) => c.id));
        }
      }
      if (run === 0) {
        // The failure goes first; the comments that do not fit wait.
        expect(result.snapshot.events[0]).toMatchObject({ type: 'ci_failed' });
        expect(result.snapshot.deferred).toBeGreaterThan(0);
      }
    }
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(GATE_OUTPUT_BUDGET_BYTES);
    expect(last!.deferred).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(2100);
    expect(current.reportedChecks).toHaveLength(1);
  });

  it('shows one event or comment per run even when the line alone is over the budget', () => {
    const data = pr({
      url: `https://github.com/o/r/pull/${'7'.repeat(GATE_OUTPUT_BUDGET_BYTES)}`,
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [
          thread('T1', [
            comment('C1', 'alice', 'MEMBER'),
            comment('C2', 'alice', 'MEMBER'),
          ]),
        ],
      },
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [comment('I1', 'alice', 'MEMBER')],
      },
    });
    const shown: Array<[string[], number | undefined]> = [];
    let current = cursor();
    for (let run = 0; run < 5; run++) {
      const result = buildGateSnapshot(data, current);
      current = result.cursor;
      if (!result.snapshot) break;
      shown.push([
        result.snapshot.events.flatMap((e) =>
          e.type === 'review_thread'
            ? e.comments.map((c) => c.id)
            : e.type === 'issue_comment'
              ? [e.id]
              : [],
        ),
        result.snapshot.deferred,
      ]);
    }
    expect(shown).toEqual([
      [['C1'], 2],
      [['C2'], 1],
      [['I1'], undefined],
    ]);
  });

  it('cuts long bodies in the gate output, never inside a character', () => {
    const long = 'a'.repeat(999) + '😀' + 'b'.repeat(5000);
    const data = pr({
      reviews: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          { ...comment('R1', 'alice', 'MEMBER', long), state: 'COMMENTED' },
        ],
      },
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [comment('I1', 'alice', 'MEMBER', 'short')],
      },
    });
    const events = buildGateSnapshot(data, cursor()).snapshot!.events;
    expect(events).toEqual([
      expect.objectContaining({
        type: 'review',
        body: 'a'.repeat(999),
        bodyTruncated: true,
      }),
      expect.not.objectContaining({ bodyTruncated: expect.anything() }),
    ]);
  });

  it('does not wake for a cut of comments or reviews, which are read newest first', () => {
    const data = pr({
      comments: {
        pageInfo: { hasPreviousPage: true },
        nodes: [comment('I1', 'alice', 'MEMBER')],
      },
      reviews: { pageInfo: { hasPreviousPage: true }, nodes: [] },
    });
    const first = buildGateSnapshot(data, cursor());
    expect(first.snapshot).toMatchObject({
      events: [{ type: 'issue_comment', id: 'I1' }],
      truncated: ['reviews', 'comments'],
    });
    const quiet = buildGateSnapshot(
      data,
      cursor({ reportedCommentIds: ['I1'], reportedTruncated: [] }),
    );
    expect(quiet.snapshot).toBeNull();
  });

  it("keeps a bot's reply as seen, so it never turns into a request", () => {
    const thread9 = (nodes: unknown[]) =>
      pr({
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: 'T9',
              isResolved: false,
              isOutdated: false,
              path: 'src/a.ts',
              line: 3,
              root: {
                nodes: [
                  {
                    databaseId: (nodes[0] as { databaseId: number }).databaseId,
                  },
                ],
              },
              comments: { pageInfo: { hasPreviousPage: false }, nodes },
            },
          ],
        },
      } as Partial<PrData>);
    const stranger = { ...comment('C1', 'mallory'), databaseId: 1 };
    const bot = {
      ...comment('C2', 'review-bot', 'NONE'),
      author: { __typename: 'Bot', login: 'review-bot' },
      databaseId: 2,
    };
    const first = buildGateSnapshot(thread9([stranger, bot]), cursor());
    expect(first.cursor.reportedCommentIds).toContain('C2');
    // The stranger deletes their comment; the bot's reply is not new.
    expect(buildGateSnapshot(thread9([bot]), first.cursor).snapshot).toBeNull();
  });

  it('does not report a dismissed review', () => {
    const data = pr({
      reviews: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          { ...comment('R1', 'alice', 'MEMBER'), state: 'DISMISSED' },
          { ...comment('R2', 'alice', 'MEMBER'), state: 'CHANGES_REQUESTED' },
        ],
      },
    });
    expect(buildGateSnapshot(data, cursor()).snapshot?.events).toEqual([
      expect.objectContaining({ type: 'review', id: 'R2' }),
    ]);
  });

  it('does not report a head move on the first run', () => {
    const result = buildGateSnapshot(pr(), cursor({ headSha: null }));
    expect(result.snapshot).toBeNull();
    expect(result.cursor.headSha).toBe(HEAD);
  });

  it('reports a conflict once per head and again when it comes back', () => {
    const first = buildGateSnapshot(pr({ mergeable: 'CONFLICTING' }), cursor());
    expect(first.snapshot).toMatchObject({ events: [{ type: 'conflict' }] });
    expect(
      buildGateSnapshot(pr({ mergeable: 'CONFLICTING' }), first.cursor)
        .snapshot,
    ).toBeNull();
    // Unknown keeps the mark; mergeable clears it.
    const unknown = buildGateSnapshot(
      pr({ mergeable: 'UNKNOWN' }),
      first.cursor,
    );
    expect(unknown.cursor.conflictSha).toBe(HEAD);
    const resolved = buildGateSnapshot(pr(), unknown.cursor);
    expect(resolved.cursor.conflictSha).toBeNull();
    expect(
      buildGateSnapshot(pr({ mergeable: 'CONFLICTING' }), resolved.cursor)
        .snapshot,
    ).not.toBeNull();
  });

  it('reports a trusted comment once, the viewer’s own included, but never the tool’s replies', () => {
    // Replies are the viewer's comments ending with the marker: a marker in
    // anyone else's comment is a quote and hides nothing, and the viewer's
    // own words — an answer to "Needs a human decision" — are a request.
    const data = pr({
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          comment('I1', 'alice', 'MEMBER'),
          comment('I2', 'me', 'OWNER'),
          comment('I3', 'bob', 'OWNER', `done\n${REPLY_MARKER}`),
          comment('I4', 'stranger'),
          comment('I5', 'me', 'OWNER', `Fixed in abc.\n\n${REPLY_MARKER}`),
        ],
      },
    });
    const first = buildGateSnapshot(data, cursor());
    expect(first.snapshot?.events).toEqual([
      {
        type: 'issue_comment',
        id: 'I1',
        author: 'alice',
        trust: 'member',
        body: 'please fix I1',
        url: 'https://github.com/o/r/pull/7#I1',
      },
      {
        type: 'issue_comment',
        id: 'I2',
        author: 'me',
        trust: 'owner',
        body: 'please fix I2',
        url: 'https://github.com/o/r/pull/7#I2',
      },
      {
        type: 'issue_comment',
        id: 'I3',
        author: 'bob',
        trust: 'owner',
        body: `done\n${REPLY_MARKER}`,
        url: 'https://github.com/o/r/pull/7#I3',
      },
      {
        type: 'untrusted_comment',
        id: 'I4',
        author: 'stranger',
        url: 'https://github.com/o/r/pull/7#I4',
      },
    ]);
    expect(first.cursor.reportedCommentIds).toEqual(['I1', 'I2', 'I3', 'I4']);
    expect(buildGateSnapshot(data, first.cursor).snapshot).toBeNull();
  });

  it('wakes for an untrusted comment alone, as a notice', () => {
    const result = buildGateSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'stranger')],
        },
      }),
      cursor(),
    );
    expect(result.snapshot?.action).toBe('wait');
  });

  it('reports a merge once, then stays quiet, and watches a reopened PR again', () => {
    const merged = buildGateSnapshot(pr({ state: 'MERGED' }), cursor());
    expect(merged.snapshot).toMatchObject({
      action: 'stop',
      events: [{ type: 'merged' }],
    });
    expect(merged.cursor.stopped).toBe('merged');
    expect(
      buildGateSnapshot(pr({ state: 'MERGED' }), merged.cursor).snapshot,
    ).toBeNull();

    const closed = buildGateSnapshot(pr({ state: 'CLOSED' }), cursor());
    expect(closed.snapshot).toMatchObject({
      action: 'stop',
      events: [{ type: 'closed' }],
    });
    expect(closed.cursor.stopped).toBe('closed');
    expect(
      buildGateSnapshot(pr({ state: 'CLOSED' }), closed.cursor).snapshot,
    ).toBeNull();
    const reopened = buildGateSnapshot(
      pr({ mergeable: 'CONFLICTING' }),
      closed.cursor,
    );
    expect(reopened.cursor.stopped).toBeNull();
    expect(reopened.snapshot?.events).toEqual([{ type: 'conflict' }]);
  });

  it('flags a cut connection', () => {
    const data = pr({}, [failed('Test')]);
    data.commits.nodes[0].commit.statusCheckRollup!.contexts.pageInfo.hasNextPage = true;
    expect(buildGateSnapshot(data, cursor()).snapshot?.truncated).toEqual([
      'checks',
    ]);
  });

  it('reports a cut once even when nothing else changed', () => {
    // Past the last page of threads, a new request leaves no trace but the cut.
    const data = pr();
    data.reviewThreads.pageInfo.hasNextPage = true;
    const first = buildGateSnapshot(data, cursor());
    expect(first.snapshot).toMatchObject({
      action: 'wait',
      events: [],
      truncated: ['reviewThreads'],
    });
    expect(first.cursor.reportedTruncated).toEqual(['reviewThreads']);
    expect(buildGateSnapshot(data, first.cursor).snapshot).toBeNull();
    // Once the cut is gone, a later one is new again.
    const whole = buildGateSnapshot(pr(), first.cursor);
    expect(whole.snapshot).toBeNull();
    expect(whole.cursor.reportedTruncated).toEqual([]);
    expect(buildGateSnapshot(data, whole.cursor).snapshot).not.toBeNull();
  });

  it('does not take a head the watch pushed for a foreign push', () => {
    const result = buildGateSnapshot(
      pr({ headRefOid: NEXT_HEAD, commits: { nodes: [] } }, []),
      cursor(),
      { knownHeads: [HEAD, NEXT_HEAD], seenCommentIds: [] },
    );
    expect(result.snapshot).toBeNull();
    expect(result.cursor.headSha).toBe(NEXT_HEAD);

    // A failure on the pushed head is still a fix, not a resync.
    const data = pr({ headRefOid: NEXT_HEAD }, [failed('Test')]);
    data.commits.nodes[0].commit.oid = NEXT_HEAD;
    expect(
      buildGateSnapshot(data, cursor(), {
        knownHeads: [NEXT_HEAD],
        seenCommentIds: [],
      }).snapshot,
    ).toMatchObject({ action: 'fix', events: [{ type: 'ci_failed' }] });
  });

  it('does not report comments the prepared watch already handled, nor once it is gone', () => {
    const data = pr({
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [thread('T1', [comment('C1', 'alice', 'MEMBER')])],
      },
    });
    const result = buildGateSnapshot(data, cursor({ headSha: null }), {
      knownHeads: [],
      seenCommentIds: ['C1', 'C1', 'C9'],
    });
    expect(result.snapshot).toBeNull();
    // Adopted while on the page; an id off the page cannot be an event.
    expect(result.cursor.reportedCommentIds).toEqual(['C1']);
    // `cleanup` removed the state; the cursor alone keeps the gate quiet.
    expect(buildGateSnapshot(data, result.cursor)).toEqual({
      snapshot: null,
      cursor: result.cursor,
    });
  });

  it('does not report a failure or a conflict a round left for a human', () => {
    const data = pr({ mergeable: 'CONFLICTING' }, [failed('Test', 5)]);
    const result = buildGateSnapshot(data, cursor(), {
      knownHeads: [],
      seenCommentIds: [],
      handledChecks: [`Test@${HEAD}@#5`],
      handledConflictSha: HEAD,
    });
    expect(result.snapshot).toBeNull();
    // Remembered, so the gate stays quiet once the state file is gone.
    expect(result.cursor).toMatchObject({
      reportedChecks: [`Test@${HEAD}@#5`],
      conflictSha: HEAD,
    });
  });

  it('reports the failures of a deferred re-run once more when their run has ended', () => {
    const lint = (status: string): Contexts[number] => ({
      __typename: 'CheckRun',
      name: 'Lint',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/o/r/actions/runs/123/job/5',
      databaseId: 5,
      checkSuite: {
        status,
        app: { databaseId: 1 },
        workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
      },
    });
    const running = lint('IN_PROGRESS');
    const first = buildGateSnapshot(pr({}, [running]), cursor());
    expect(first.snapshot).toMatchObject({ action: 'fix' });
    const watch = { knownHeads: [], seenCommentIds: [], deferredRuns: [123] };
    // Still running: nothing new.
    expect(
      buildGateSnapshot(pr({}, [running]), first.cursor, watch).snapshot,
    ).toBeNull();
    const ended = lint('COMPLETED');
    const second = buildGateSnapshot(pr({}, [ended]), first.cursor, watch);
    expect(second.snapshot).toMatchObject({
      action: 'fix',
      events: [{ type: 'ci_failed', check: 'Lint', runId: 123 }],
    });
    // Once.
    expect(
      buildGateSnapshot(pr({}, [ended]), second.cursor, watch).snapshot,
    ).toBeNull();
    // A run nobody deferred is not reported again when it ends.
    expect(
      buildGateSnapshot(pr({}, [ended]), first.cursor).snapshot,
    ).toBeNull();
  });
});

describe('withAbandonedFix', () => {
  const cursor: AutofixPrGateCursor = {
    version: 1,
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    viewer: 'me',
    prAuthor: 'me',
    headSha: HEAD,
    reportedCommentIds: [],
    reportedChecks: [],
    conflictSha: null,
    stopped: null,
    reportedTruncated: [],
  };
  const base = { headSha: HEAD, isDraft: false, url: 'https://x/pull/7' };
  const marker = {
    attempt: {
      version: 1 as const,
      attempt: '0123456789ab',
      task: 't',
      head: HEAD,
      startedAt: '2026-10-26T00:00:00.000Z',
    },
    mtimeMs: 1,
  };

  it('keeps an action that says more than fix, and wakes a quiet one', () => {
    const stop = {
      ...base,
      action: 'stop' as const,
      events: [{ type: 'merged' as const }],
      truncated: [],
    };
    expect(
      withAbandonedFix({ snapshot: stop, cursor }, marker, base).snapshot
        ?.action,
    ).toBe('stop');
    expect(
      withAbandonedFix(
        { snapshot: { ...stop, action: 'wait', events: [] }, cursor },
        marker,
        base,
      ).snapshot,
    ).toMatchObject({ action: 'fix', events: [{ type: 'abandoned_fix' }] });
  });

  it('reports an unreadable marker once, by its time, and nothing without one', () => {
    const unreadable = { attempt: null, mtimeMs: 42 };
    const first = withAbandonedFix(
      { snapshot: null, cursor },
      unreadable,
      base,
    );
    expect(first.snapshot).toEqual({
      ...base,
      action: 'fix',
      events: [{ type: 'abandoned_fix', startedAt: null }],
      truncated: [],
    });
    expect(first.cursor.reportedAbandonedFix).toBe('unreadable@42');
    expect(
      withAbandonedFix({ snapshot: null, cursor: first.cursor }, unreadable)
        .snapshot,
    ).toBeNull();
    expect(
      withAbandonedFix({ snapshot: null, cursor }, null).snapshot,
    ).toBeNull();
  });
});

describe('fetchPrData', () => {
  beforeEach(() => {
    mockGh.mockReset();
  });

  function page(nodes: Contexts, next: string | null, oid = HEAD) {
    return {
      commits: {
        nodes: [
          {
            commit: {
              oid,
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: next !== null, endCursor: next },
                  nodes,
                },
              },
            },
          },
        ],
      },
    };
  }

  it("asks REST whether a bot's comment that opens a thread answers a deleted one", () => {
    // GraphQL drops `replyTo` once the parent is deleted, and lists the
    // reply as the thread's first comment; REST keeps `in_reply_to_id`.
    const botThread = (id: string, databaseId: number) => ({
      id: `T${databaseId}`,
      isResolved: false,
      isOutdated: false,
      path: 'src/a.ts',
      line: 3,
      root: { nodes: [{ databaseId }] },
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          {
            ...comment(id, 'review-bot', 'NONE'),
            author: { __typename: 'Bot', login: 'review-bot' },
            databaseId,
            replyTo: null,
          },
        ],
      },
    });
    const data = pr({
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [
          botThread('ORPHAN', 3764221067),
          botThread('REAL', 11),
          botThread('SEEN', 12),
        ],
      },
    } as Partial<PrData>);
    const resolved = botThread('RESOLVED', 13);
    resolved.isResolved = true;
    data.reviewThreads.nodes.push(resolved as never);
    const respondWith = (...answers: Array<() => string>) => {
      mockGh.mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: structuredClone(data) },
          },
        }),
      );
      for (const answer of answers) mockGh.mockImplementationOnce(answer);
    };
    const target = { owner: 'o', repo: 'r', prNumber: 7 };
    const cacheDir = mkdtempSync(join(tmpdir(), 'autofix-replies-'));
    let caches = 0;
    const check = (strict = true, cachePath?: string) => ({
      known: (id: string) => id === 'SEEN',
      strict,
      cachePath: cachePath ?? join(cacheDir, `replies-${caches++}.json`),
    });
    const kept = join(cacheDir, 'kept.json');
    respondWith(
      () => '3763973590\n',
      () => 'null\n',
    );
    const { pr: fetched } = fetchPrData(target, check(true, kept));
    // The two not known yet, each asked about on its own; not the seen
    // one, nor the resolved thread.
    expect(mockGh).toHaveBeenCalledTimes(3);
    expect(mockGh.mock.calls[1]).toContain(
      'repos/o/r/pulls/comments/3764221067',
    );
    expect(mockGh.mock.calls[2]).toContain('repos/o/r/pulls/comments/11');
    const replyTo = fetched.reviewThreads.nodes.map(
      (t) => t.comments.nodes[0]!.replyTo,
    );
    expect(replyTo).toEqual([{ id: '#3763973590' }, null, null, null]);
    const ids = buildGateSnapshot(fetched, cursor()).snapshot!.events.flatMap(
      (event) =>
        event.type === 'review_thread' ? event.comments.map((c) => c.id) : [],
    );
    expect(ids).toEqual(['REAL', 'SEEN']);
    // The answers are kept: never asked about again.
    expect(JSON.parse(readFileSync(kept, 'utf8'))).toEqual({
      ORPHAN: '3763973590',
      REAL: null,
    });
    mockGh.mockReset();
    respondWith();
    const { pr: again } = fetchPrData(target, check(true, kept));
    expect(mockGh).toHaveBeenCalledTimes(1);
    expect(again.reviewThreads.nodes[0]!.comments.nodes[0]!.replyTo).toEqual({
      id: '#3763973590',
    });

    // A comment deleted between the two reads is no request, and fails
    // nothing.
    mockGh.mockReset();
    respondWith(
      () => {
        throw Object.assign(
          new Error(
            'Command failed: gh api repos/o/r/pulls/comments/3764221067',
          ),
          { stderr: 'gh: Not Found (HTTP 404)\n' },
        );
      },
      () => 'null\n',
    );
    const { pr: gone } = fetchPrData(target, check());
    expect(gone.reviewThreads.nodes[0]!.comments.nodes[0]!.replyUnknown).toBe(
      true,
    );

    // GitHub does not answer. A round fails rather than drop a request the
    // gate reported; the gate goes on, with the bot comments neither
    // requests nor seen, asked about at its next fire.
    const refuse = () => {
      throw new Error('HTTP 403: API rate limit exceeded');
    };
    mockGh.mockReset();
    respondWith(refuse);
    expect(() => fetchPrData(target, check())).toThrow(/rate limit/);
    mockGh.mockReset();
    respondWith(refuse, refuse);
    const { pr: unanswered } = fetchPrData(target, check(false));
    // The gate stops asking at the first failure.
    expect(mockGh).toHaveBeenCalledTimes(2);
    const quiet = buildGateSnapshot(unanswered, cursor());
    expect(
      quiet.snapshot!.events.flatMap((event) =>
        event.type === 'review_thread' ? event.comments.map((c) => c.id) : [],
      ),
    ).toEqual(['SEEN']);
    expect(quiet.cursor.reportedCommentIds).not.toContain('ORPHAN');
    expect(quiet.cursor.reportedCommentIds).not.toContain('REAL');

    // A merged PR asks nothing over REST: its stop must get through.
    mockGh.mockReset();
    mockGh.mockReturnValueOnce(
      JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: {
            pullRequest: { ...structuredClone(data), state: 'MERGED' },
          },
        },
      }),
    );
    fetchPrData(target, check());
    expect(mockGh).toHaveBeenCalledTimes(1);

    // Nor does a resolved thread, which no round reads.
    mockGh.mockReset();
    mockGh.mockReturnValueOnce(
      JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: {
            pullRequest: {
              ...structuredClone(data),
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: [structuredClone(resolved)],
              },
            },
          },
        },
      }),
    );
    fetchPrData(target, check());
    expect(mockGh).toHaveBeenCalledTimes(1);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("keeps each answer as it comes, tells a missing comment by gh's words only, and gives the gate a time budget", () => {
    const botThread = (id: string, databaseId: number) => ({
      id: `T${databaseId}`,
      isResolved: false,
      isOutdated: false,
      path: 'src/a.ts',
      line: 3,
      root: { nodes: [{ databaseId }] },
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          {
            ...comment(id, 'review-bot', 'NONE'),
            author: { __typename: 'Bot', login: 'review-bot' },
            databaseId,
            replyTo: null,
          },
        ],
      },
    });
    const data = pr({
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [botThread('A', 404), botThread('B', 2)],
      },
    } as Partial<PrData>);
    const cacheDir = mkdtempSync(join(tmpdir(), 'autofix-replies-'));
    const cachePath = join(cacheDir, 'replies.json');
    const respond = (...answers: Array<() => string>) => {
      mockGh.mockReset();
      mockGh.mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: structuredClone(data) },
          },
        }),
      );
      for (const answer of answers) mockGh.mockImplementationOnce(answer);
    };
    const rateLimited = () => {
      throw Object.assign(
        new Error('Command failed: gh api repos/o/404/pulls/comments/404'),
        { stderr: 'gh: API rate limit exceeded (HTTP 403)\n' },
      );
    };
    // A repository and a comment named 404 do not make a refusal a
    // deleted comment; what was learned before it stays.
    respond(() => 'null\n', rateLimited);
    const strict = { known: () => false, strict: true, cachePath };
    expect(() =>
      fetchPrData({ owner: 'o', repo: '404', prNumber: 7 }, strict),
    ).toThrow(/repos\/o\/404\/pulls\/comments\/404/);
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual({ A: null });

    // A round over its time stops with the answers kept, saying so.
    rmSync(cachePath);
    const roundNow = vi.spyOn(Date, 'now');
    let roundClock = 1_000_000;
    roundNow.mockImplementation(() => roundClock);
    respond(() => {
      roundClock += 9 * 60_000;
      return 'null\n';
    });
    expect(() =>
      fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 }, strict),
    ).toThrow(/asked GitHub about 1 bot comments .* run snapshot again/);
    roundNow.mockRestore();
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual({ A: null });

    // The gate stops asking once its time is spent, and keeps answers
    // where no `.qwen/tmp` was made yet.
    rmSync(cacheDir, { recursive: true, force: true });
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    respond(() => {
      clock += 31_000;
      return 'null\n';
    });
    const { pr: gated } = fetchPrData(
      { owner: 'o', repo: 'r', prNumber: 7 },
      { known: () => false, strict: false, cachePath },
    );
    now.mockRestore();
    expect(mockGh).toHaveBeenCalledTimes(2);
    expect(
      gated.reviewThreads.nodes.map((t) => t.comments.nodes[0]!.replyUnknown),
    ).toEqual([undefined, true]);
    mockGh.mockReset();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('has the gate ask about 20 bot threads a fire at most, and a round about all', () => {
    const threads = Array.from({ length: 21 }, (_, index) => ({
      id: `T${index}`,
      isResolved: false,
      isOutdated: false,
      path: 'src/a.ts',
      line: 3,
      root: { nodes: [{ databaseId: 100 + index }] },
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          {
            ...comment(`B${index}`, 'review-bot', 'NONE'),
            author: { __typename: 'Bot', login: 'review-bot' },
            databaseId: 100 + index,
            replyTo: null,
          },
        ],
      },
    }));
    const data = pr({
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads },
    } as Partial<PrData>);
    const respond21 = () => {
      mockGh.mockReset();
      mockGh.mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: structuredClone(data) },
          },
        }),
      );
      mockGh.mockImplementation(() => 'null\n');
    };
    const cacheDir = mkdtempSync(join(tmpdir(), 'autofix-replies-'));
    const check = (strict: boolean, name: string) => ({
      known: () => false,
      strict,
      cachePath: join(cacheDir, name),
    });
    respond21();
    const { pr: fetched } = fetchPrData(
      { owner: 'o', repo: 'r', prNumber: 7 },
      check(false, 'gate.json'),
    );
    expect(mockGh).toHaveBeenCalledTimes(21);
    expect(
      fetched.reviewThreads.nodes.filter(
        (t) => t.comments.nodes[0]!.replyUnknown,
      ),
    ).toHaveLength(1);
    // The next fire asks about the one left, the others being kept.
    respond21();
    fetchPrData(
      { owner: 'o', repo: 'r', prNumber: 7 },
      check(false, 'gate.json'),
    );
    expect(mockGh).toHaveBeenCalledTimes(2);
    // A round asks about every one it does not know.
    respond21();
    const { pr: round } = fetchPrData(
      { owner: 'o', repo: 'r', prNumber: 7 },
      check(true, 'round.json'),
    );
    expect(mockGh).toHaveBeenCalledTimes(22);
    expect(
      round.reviewThreads.nodes.filter(
        (t) => t.comments.nodes[0]!.replyUnknown,
      ),
    ).toHaveLength(0);
    mockGh.mockReset();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('stops paging past its time, leaving what it did not read cut', () => {
    const open = pr();
    open.commits.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo = {
      hasNextPage: true,
      endCursor: 'c1',
    };
    mockGh.mockReset();
    mockGh.mockReturnValueOnce(
      JSON.stringify({
        data: { viewer: { login: 'me' }, repository: { pullRequest: open } },
      }),
    );
    const { pr: data, partial } = fetchPrData(
      { owner: 'o', repo: 'r', prNumber: 7 },
      undefined,
      Date.now() - 1,
    );
    expect(mockGh).toHaveBeenCalledTimes(1);
    expect(checkEvents(data).truncated).toBe(true);
    expect(partial).toBe('checks');
    expect(GATE_READ_BUDGET_MS).toBeLessThan(20_000);
    mockGh.mockReset();
  });

  it('tells time that ran out in the threads, or a page cap, from time that ran out in the checks', () => {
    const threaded = pr();
    threaded.reviewThreads = {
      pageInfo: { hasNextPage: true, endCursor: 't1' },
      nodes: [],
    };
    mockGh.mockReset();
    mockGh.mockReturnValueOnce(
      JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: { pullRequest: threaded },
        },
      }),
    );
    expect(
      fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 }, undefined, 0).partial,
    ).toBe('threads');

    // Every page the cap allows was read before the time ran out: the cut
    // is the cap's, which every run meets alike.
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000;
    now.mockImplementation(() => clock);
    mockGh.mockReset();
    mockGh.mockImplementation((...args: string[]) => {
      clock += 1;
      const first = !args.some((arg) => arg.startsWith('after='));
      return JSON.stringify({
        data: first
          ? {
              viewer: { login: 'me' },
              repository: {
                pullRequest: { ...pr(), ...page([failed('A')], 'c1') },
              },
            }
          : { repository: { pullRequest: page([failed('B')], 'cN') } },
      });
    });
    try {
      const capped = fetchPrData(
        { owner: 'o', repo: 'r', prNumber: 7 },
        undefined,
        clock + 9.5,
      );
      expect(mockGh).toHaveBeenCalledTimes(10);
      expect(Date.now()).toBeGreaterThan(1_009.5);
      expect(checkEvents(capped.pr).truncated).toBe(true);
      expect(capped.partial).toBeUndefined();

      // The same, with suites left to read when the time ran out.
      clock = 1_000;
      mockGh.mockClear();
      const suited: PrData = { ...pr(), ...page([failed('A')], 'c1') };
      suited.commits.nodes[0]!.commit.checkSuites = {
        pageInfo: { hasPreviousPage: true, startCursor: 's1' },
        nodes: [],
      };
      const answer = mockGh.getMockImplementation()!;
      mockGh.mockImplementation((...args: string[]) =>
        args.some((arg) => arg.startsWith('after='))
          ? answer(...args)
          : (clock++,
            JSON.stringify({
              data: {
                viewer: { login: 'me' },
                repository: { pullRequest: suited },
              },
            })),
      );
      expect(
        fetchPrData(
          { owner: 'o', repo: 'r', prNumber: 7 },
          undefined,
          clock + 9.5,
        ).partial,
      ).toBe('suites');
    } finally {
      now.mockRestore();
      mockGh.mockReset();
    }
  });

  it('reads a merged or closed PR with one call, however much its first page leaves', () => {
    const merged = pr({ state: 'MERGED' });
    merged.commits.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo = {
      hasNextPage: true,
      endCursor: 'c1',
    };
    merged.commits.nodes[0]!.commit.checkSuites = {
      pageInfo: { hasPreviousPage: true, startCursor: 's1' },
      nodes: [],
    };
    merged.reviewThreads = {
      pageInfo: { hasNextPage: true, endCursor: 't1' },
      nodes: [],
    };
    for (const state of ['MERGED', 'CLOSED'] as const) {
      mockGh.mockReset();
      mockGh.mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: { ...structuredClone(merged), state } },
          },
        }),
      );
      const { pr: data } = fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 });
      expect(data.state).toBe(state);
      expect(mockGh).toHaveBeenCalledTimes(1);
    }
    mockGh.mockReset();
  });

  it('pages check suites back to the oldest, where a push put the code triggered ones', () => {
    const suite = (databaseId: number, conclusion: string, event: string) => ({
      databaseId,
      conclusion,
      app: { databaseId: 15368 },
      workflowRun: {
        databaseId,
        url: `https://github.com/o/r/actions/runs/${databaseId}`,
        event,
        workflow: { databaseId: 9, name: 'CI' },
      },
    });
    const firstPage = pr();
    firstPage.commits.nodes[0]!.commit.checkSuites = {
      pageInfo: { hasPreviousPage: true, startCursor: 's1' },
      // The newest: one per review comment.
      nodes: [suite(200, 'SUCCESS', 'pull_request_review_comment')],
    };
    mockGh
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: firstPage },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: HEAD,
                        checkSuites: {
                          pageInfo: {
                            hasPreviousPage: false,
                            startCursor: null,
                          },
                          nodes: [suite(1, 'STARTUP_FAILURE', 'pull_request')],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      );
    const { pr: data } = fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 });
    expect(mockGh.mock.calls[1]).toContain('before=s1');
    expect(
      data.commits.nodes[0]!.commit.checkSuites!.nodes.map((n) => n.databaseId),
    ).toEqual([1, 200]);
    expect(checkEvents(data)).toMatchObject({
      failed: [{ event: { check: 'CI', startupFailure: true } }],
      truncated: false,
    });
  });

  it('pages the check rollup past the first 100 contexts', () => {
    const firstPage = {
      ...pr(),
      ...page([failed('A')], 'c1'),
    };
    mockGh
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: firstPage },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: { repository: { pullRequest: page([failed('B')], 'c2') } },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: { repository: { pullRequest: page([failed('C')], null) } },
        }),
      );
    const { pr: data, viewer } = fetchPrData({
      owner: 'o',
      repo: 'r',
      prNumber: 7,
    });
    expect(viewer).toBe('me');
    const contexts = data.commits.nodes[0]!.commit.statusCheckRollup!.contexts;
    expect(
      contexts.nodes.map((c) => (c.__typename === 'CheckRun' ? c.name : '')),
    ).toEqual(['A', 'B', 'C']);
    expect(contexts.pageInfo.hasNextPage).toBe(false);
    expect(mockGh).toHaveBeenCalledTimes(3);
    expect(mockGh.mock.calls[1]).toContain('after=c1');
    expect(mockGh.mock.calls[2]).toContain('after=c2');
  });

  it('stops paging when the head moved between calls and leaves the cut flagged', () => {
    mockGh
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: {
              pullRequest: { ...pr(), ...page([failed('A')], 'c1') },
            },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            repository: { pullRequest: page([failed('B')], null, NEXT_HEAD) },
          },
        }),
      );
    const { pr: data } = fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 });
    const contexts = data.commits.nodes[0]!.commit.statusCheckRollup!.contexts;
    expect(contexts.nodes).toHaveLength(1);
    expect(contexts.pageInfo.hasNextPage).toBe(true);
  });

  it('pages review threads past the first 100', () => {
    const firstPage = pr({
      reviewThreads: {
        pageInfo: { hasNextPage: true, endCursor: 't1' },
        nodes: [thread('T1', [comment('C1', 'alice', 'MEMBER')])],
      },
    });
    mockGh
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: firstPage },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [thread('T2', [comment('C2', 'alice', 'MEMBER')])],
                },
              },
            },
          },
        }),
      );
    const { pr: data } = fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 });
    expect(data.reviewThreads.nodes.map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(data.reviewThreads.pageInfo.hasNextPage).toBe(false);
    expect(mockGh.mock.calls[1]).toContain('after=t1');
  });

  it('reads the newest 100 comments of each thread, and its root apart', () => {
    mockGh
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: {
              pullRequest: pr({
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: 't1' },
                  nodes: [],
                },
              }),
            },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        }),
      );
    fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 });
    // A reply past the 100th comment of a thread is the one that can be new.
    for (const call of mockGh.mock.calls) {
      const query = (call as string[]).find((arg) => arg.startsWith('query='));
      expect(query).toMatch(/root: comments\(first: 1\)/);
      expect(query).toMatch(
        /\n\s*comments\(last: 100\) \{\s*pageInfo \{ hasPreviousPage \}/,
      );
      expect(query).not.toMatch(/comments\(first: 100/);
    }
    expect(mockGh).toHaveBeenCalledTimes(2);
  });

  it('fails clearly when the PR does not exist', () => {
    mockGh.mockReturnValueOnce(
      JSON.stringify({
        data: { viewer: { login: 'me' }, repository: { pullRequest: null } },
      }),
    );
    expect(() => fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 })).toThrow(
      'PR #7 not found in o/r',
    );
  });
});

describe('runSnapshot --gate', () => {
  let savedHost: string | undefined;
  const gatePath = () => autofixPrPaths(mocks.root, 7).gatePath;
  const respond = (data: PrData) =>
    mockGh.mockReturnValueOnce(
      JSON.stringify({
        data: { viewer: { login: 'me' }, repository: { pullRequest: data } },
      }),
    );
  const withComments = (...ids: string[]) =>
    pr({
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: ids.map((id) => comment(id, 'alice', 'MEMBER')),
      },
    });
  const printedIds = () =>
    mocks.stdout.mock.calls.map((call) =>
      (JSON.parse(call[0]) as { events: Array<{ id?: string }> }).events.map(
        (event) => event.id,
      ),
    );

  beforeEach(() => {
    mocks.root = mkdtempSync(join(tmpdir(), 'autofix-gate-'));
    mockGh.mockReset();
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

  it('prints each transition once and leaves the cursor alone while quiet', () => {
    respond(withComments('I1'));
    runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    expect(printedIds()).toEqual([['I1']]);
    const written = readFileSync(gatePath(), 'utf8');

    // Later fires name no repository: the cursor does.
    respond(withComments('I1'));
    runSnapshot({ pr: 7, gate: true });
    expect(printedIds()).toEqual([['I1']]);
    expect(readFileSync(gatePath(), 'utf8')).toBe(written);

    respond(withComments('I1', 'I2'));
    runSnapshot({ pr: 7, gate: true });
    respond(withComments('I1', 'I2'));
    runSnapshot({ pr: 7, gate: true });
    expect(printedIds()).toEqual([['I1'], ['I2']]);
  });

  it('records when a run that printed began to read the PR, and no quiet run', () => {
    const reportedAt = () =>
      (JSON.parse(readFileSync(gatePath(), 'utf8')) as { reportedAt?: string })
        .reportedAt;
    // When it finished reading: GitHub answers ten seconds after it asked.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    const answer = JSON.stringify({
      data: {
        viewer: { login: 'me' },
        repository: { pullRequest: withComments('I1') },
      },
    });
    mockGh.mockImplementationOnce(() => {
      vi.setSystemTime(new Date('2026-10-26T10:00:10.000Z'));
      return answer;
    });
    try {
      runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    } finally {
      vi.useRealTimers();
    }
    const first = reportedAt()!;
    expect(first).toBe('2026-10-26T10:00:10.000Z');
    // Quiet, though the cursor moves: a check run queued since.
    respond(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'alice', 'MEMBER')],
        },
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
                        status: 'QUEUED',
                        conclusion: null,
                        detailsUrl:
                          'https://github.com/o/r/actions/runs/1/job/5',
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      } as never),
    );
    runSnapshot({ pr: 7, gate: true });
    expect(mocks.stdout).toHaveBeenCalledTimes(1);
    const cursor = JSON.parse(readFileSync(gatePath(), 'utf8')) as {
      latestChecks?: string[];
    };
    expect(cursor.latestChecks).toEqual([
      expect.stringMatching(/^run::::Test@.*~5$/),
    ]);
    expect(reportedAt()).toBe(first);
  });

  it("marks every check by the watch's own gate, for `status`, and none by a gate of no session", () => {
    const paths = autofixPrPaths(mocks.root, 7);
    respond(withComments('I1'));
    runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    expect(existsSync(paths.checkedPath)).toBe(false);
    writeState(paths.statePath, {
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
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(paths.statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
      watch: { every: 2, reply: true, instructions: '', task: 'aaaaaaaaaaaa' },
    });
    const own = () =>
      runSnapshot({
        pr: 7,
        gate: true,
        session: 'session-a',
        task: 'aaaaaaaaaaaa',
      });
    respond(withComments('I1'));
    own();
    expect(existsSync(paths.checkedPath)).toBe(true);
    const old = new Date('2026-10-01T00:00:00.000Z');
    utimesSync(paths.checkedPath, old, old);
    // A quiet run counts: the cursor stays as it was.
    const written = readFileSync(gatePath(), 'utf8');
    respond(withComments('I1'));
    own();
    expect(readFileSync(gatePath(), 'utf8')).toBe(written);
    expect(statSync(paths.checkedPath).mtimeMs).toBeGreaterThan(old.getTime());
    // A Managed automation's gate, or a probe run by hand, is no sign that
    // the watch is running, though it moves the cursor.
    utimesSync(paths.checkedPath, old, old);
    respond(withComments('I1', 'I2'));
    runSnapshot({ pr: 7, gate: true });
    expect(statSync(paths.checkedPath).mtimeMs).toBe(old.getTime());
  });

  it('stays quiet while a background fix works, keeping its cursor, and reports one its session left behind once', () => {
    const paths = autofixPrPaths(mocks.root, 7);
    mkdirSync(dirname(paths.statePath), { recursive: true });
    writeState(paths.statePath, {
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
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(paths.statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
      watch: { every: 2, reply: true, instructions: '', task: 'aaaaaaaaaaaa' },
    });
    const own = () =>
      runSnapshot({
        pr: 7,
        gate: true,
        session: 'session-a',
        task: 'aaaaaaaaaaaa',
      });
    respond(withComments('I1'));
    own();
    expect(printedIds()).toEqual([['I1']]);
    const written = readFileSync(gatePath(), 'utf8');
    const startedAt = new Date().toISOString();
    writeFileSync(
      paths.fixPath,
      JSON.stringify({
        version: 1,
        attempt: '0123456789ab',
        task: 'aaaaaaaaaaaa',
        head: HEAD,
        startedAt,
      }),
    );
    // Fresh: GitHub is not asked, nothing prints, the cursor stays; the
    // check is marked all the same, for `status`.
    mockGh.mockClear();
    const before = new Date('2026-10-01T00:00:00.000Z');
    utimesSync(paths.checkedPath, before, before);
    own();
    expect(mockGh).not.toHaveBeenCalled();
    expect(mocks.stdout).toHaveBeenCalledTimes(1);
    expect(readFileSync(gatePath(), 'utf8')).toBe(written);
    expect(statSync(paths.checkedPath).mtimeMs).toBeGreaterThan(
      before.getTime(),
    );
    // Its session stopped refreshing it: one round, though nothing changed.
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(paths.fixPath, old, old);
    respond(withComments('I1'));
    own();
    expect(JSON.parse(mocks.stdout.mock.calls.at(-1)![0])).toMatchObject({
      action: 'fix',
      events: [{ type: 'abandoned_fix', startedAt }],
    });
    respond(withComments('I1'));
    own();
    expect(mocks.stdout).toHaveBeenCalledTimes(2);
    // Beside what changed, and a later attempt's again.
    writeFileSync(
      paths.fixPath,
      JSON.stringify({
        version: 1,
        attempt: 'ba9876543210',
        task: 'aaaaaaaaaaaa',
        head: HEAD,
        startedAt,
      }),
    );
    utimesSync(paths.fixPath, old, old);
    respond(withComments('I1', 'I2'));
    own();
    expect(JSON.parse(mocks.stdout.mock.calls.at(-1)![0])).toMatchObject({
      action: 'fix',
      events: [
        expect.objectContaining({ id: 'I2' }),
        { type: 'abandoned_fix', startedAt },
      ],
    });
  });

  describe("a fix attempt's marker", () => {
    const paths = () => autofixPrPaths(mocks.root, 7);
    const watchOf = (owner: string, repo: string) => {
      mkdirSync(dirname(paths().statePath), { recursive: true });
      writeState(paths().statePath, {
        version: 1,
        sessionId: 'session-a',
        host: 'github.com',
        owner,
        repo,
        prNumber: 7,
        remote: 'origin',
        pushTarget: 'origin',
        headRefName: 'feat',
        baseRefName: 'main',
        branch: 'qwen-autofix/pr-7',
        worktreePath: join(dirname(paths().statePath), 'autofix-pr-7'),
        viewer: 'me',
        prAuthor: 'me',
        lastKnownHeadSha: HEAD,
        pushedShas: [],
        handledCommentIds: [],
        postedCommentIds: [],
        watch: {
          every: 2,
          reply: true,
          instructions: '',
          task: 'aaaaaaaaaaaa',
        },
      });
    };
    const plantMarker = (ageMs = 0) => {
      mkdirSync(dirname(paths().fixPath), { recursive: true });
      writeFileSync(
        paths().fixPath,
        JSON.stringify({
          version: 1,
          attempt: '0123456789ab',
          task: 'aaaaaaaaaaaa',
          head: HEAD,
          startedAt: new Date(Date.now() - ageMs).toISOString(),
        }),
      );
      const at = new Date(Date.now() - ageMs);
      utimesSync(paths().fixPath, at, at);
    };
    const own = () =>
      runSnapshot({
        pr: 7,
        gate: true,
        session: 'session-a',
        task: 'aaaaaaaaaaaa',
      });

    it("is another clone's when no watch here names this repository: the gate reads and prints", () => {
      // The marker's path names the PR number alone.
      plantMarker();
      respond(withComments('I1'));
      runSnapshot({ pr: 7, repo: 'o/r', gate: true });
      expect(printedIds()).toEqual([['I1']]);

      watchOf('x', 'y');
      respond(withComments('I1', 'I2'));
      runSnapshot({ pr: 7, repo: 'o/r', gate: true });
      expect(printedIds()).toEqual([['I1'], ['I2']]);
      expect(existsSync(paths().checkedPath)).toBe(false);
    });

    it('keeps a gate of no session quiet, marking no check of the watch', () => {
      watchOf('o', 'r');
      plantMarker();
      runSnapshot({ pr: 7, repo: 'o/r', gate: true });
      expect(mockGh).not.toHaveBeenCalled();
      expect(mocks.stdout).not.toHaveBeenCalled();
      expect(existsSync(paths().checkedPath)).toBe(false);
    });

    it('keeps the gate quiet when the attempt opened while GitHub was asked', () => {
      watchOf('o', 'r');
      respond(withComments('I1'));
      own();
      const written = readFileSync(gatePath(), 'utf8');
      const old = new Date('2026-10-01T00:00:00.000Z');
      utimesSync(paths().checkedPath, old, old);
      mockGh.mockClear();
      const answer = JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: { pullRequest: withComments('I1', 'I2') },
        },
      });
      mockGh.mockImplementationOnce(() => {
        plantMarker();
        return answer;
      });
      own();
      expect(mockGh).toHaveBeenCalledTimes(1);
      expect(mocks.stdout).toHaveBeenCalledTimes(1);
      // What changed meanwhile is the next round's.
      expect(readFileSync(gatePath(), 'utf8')).toBe(written);
      expect(statSync(paths().checkedPath).mtimeMs).toBeGreaterThan(
        old.getTime(),
      );
    });

    it("leaves the one report of an abandoned attempt to the watch's own gate", () => {
      watchOf('o', 'r');
      respond(withComments('I1'));
      own();
      plantMarker(5 * 60_000);
      // A probe run by hand: it wakes no round.
      respond(withComments('I1'));
      runSnapshot({ pr: 7, gate: true });
      expect(mocks.stdout).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(readFileSync(gatePath(), 'utf8')) as object,
      ).not.toHaveProperty('reportedAbandonedFix');
      respond(withComments('I1'));
      own();
      expect(JSON.parse(mocks.stdout.mock.calls.at(-1)![0])).toMatchObject({
        action: 'fix',
        events: [{ type: 'abandoned_fix' }],
      });
    });
  });

  it('stops a task from before task ids once one is recorded, and any task of a watch cleanup ended', () => {
    const paths = autofixPrPaths(mocks.root, 7);
    mkdirSync(dirname(paths.statePath), { recursive: true });
    const state: AutofixPrState = {
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
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(paths.statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
      watch: { every: 2, reply: true, instructions: '', task: 'aaaaaaaaaaaa' },
    };
    writeState(paths.statePath, state);
    const out = () => JSON.parse(mocks.stdout.mock.calls.at(-1)![0]);
    runSnapshot({ pr: 7, repo: 'o/r', gate: true, session: 'session-a' });
    expect(out()).toEqual({
      action: 'stop',
      events: [
        {
          type: 'watched_elsewhere',
          session: 'session-a',
          gateSession: 'session-a',
        },
      ],
    });
    // A cleanup that kept the worktree ended the watch.
    const { watch: _w, ...kept } = state;
    writeState(paths.statePath, {
      ...kept,
      ended: { at: '2026-10-25T00:00:00.000Z', reason: 'kept' },
    });
    for (const task of ['aaaaaaaaaaaa', undefined]) {
      runSnapshot({
        pr: 7,
        repo: 'o/r',
        gate: true,
        session: 'session-a',
        task,
      });
      expect(out()).toMatchObject({
        action: 'stop',
        events: [{ type: 'watch_ended', gateSession: 'session-a' }],
      });
    }
    // A task made by schedule, of a watch that no longer records one.
    writeState(paths.statePath, kept);
    runSnapshot({
      pr: 7,
      repo: 'o/r',
      gate: true,
      session: 'session-a',
      task: 'aaaaaaaaaaaa',
    });
    expect(out()).toMatchObject({ events: [{ type: 'watch_ended' }] });
    // A state of another repository's PR of the number is no watch of it.
    writeState(paths.statePath, { ...state, owner: 'fork' });
    runSnapshot({
      pr: 7,
      repo: 'o/r',
      gate: true,
      session: 'session-a',
      task: 'aaaaaaaaaaaa',
    });
    expect(out()).toMatchObject({ events: [{ type: 'watch_ended' }] });
    expect(mockGh).not.toHaveBeenCalled();
    expect(() =>
      runSnapshot({ pr: 7, repo: 'o/r', gate: true, task: 'aaaaaaaaaaaa' }),
    ).toThrow(/--task names a task of a watch/);
  });

  // FIFOs are POSIX only.
  it.skipIf(process.platform === 'win32')(
    'never blocks on a cursor or a reply cache that is not a regular file',
    () => {
      const paths = autofixPrPaths(mocks.root, 7);
      mkdirSync(dirname(paths.gatePath), { recursive: true });
      // A cache in the way is asked again, not read.
      execFileSync('mkfifo', [paths.repliesPath]);
      respond(withComments('I1'));
      runSnapshot({ pr: 7, repo: 'o/r', gate: true });
      expect(printedIds()).toEqual([['I1']]);
      // A cursor in the way fails the gate, which the scheduler reports.
      rmSync(paths.gatePath);
      execFileSync('mkfifo', [paths.gatePath]);
      expect(() => runSnapshot({ pr: 7, repo: 'o/r', gate: true })).toThrow(
        /not a regular file/,
      );
    },
  );

  it('stores the cursor before printing, so a failed print is not repeated', () => {
    mocks.stdout.mockImplementationOnce(() => {
      throw new Error('EPIPE');
    });
    respond(withComments('I1'));
    expect(() => runSnapshot({ pr: 7, repo: 'o/r', gate: true })).toThrow(
      'EPIPE',
    );
    expect(existsSync(gatePath())).toBe(true);
    respond(withComments('I1'));
    runSnapshot({ pr: 7, gate: true });
    expect(mocks.stdout).toHaveBeenCalledTimes(1);
  });

  it('refuses another repository for the same PR number, but not another spelling', () => {
    respond(withComments());
    runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    expect(() => runSnapshot({ pr: 7, repo: 'x/r', gate: true })).toThrow(
      /gate on github.com\/o\/r, not github.com\/x\/r; pass --host/,
    );
    respond(withComments());
    expect(() => runSnapshot({ pr: 7, repo: 'O/R', gate: true })).not.toThrow();
  });

  it('tells apart Enterprise instances on different ports', () => {
    respond(withComments());
    runSnapshot({ pr: 7, repo: 'o/r', host: 'ghe.corp:8443', gate: true });
    expect(() =>
      runSnapshot({ pr: 7, repo: 'o/r', host: 'ghe.corp:9443', gate: true }),
    ).toThrow(/gate on ghe\.corp:8443\/o\/r, not ghe\.corp:9443\/o\/r/);
    expect(mockGh).toHaveBeenCalledTimes(1);
    respond(withComments());
    runSnapshot({ pr: 7, repo: 'o/r', host: 'GHE.corp:8443', gate: true });
    expect(mockGh).toHaveBeenCalledTimes(2);

    // The default port is no port at all.
    rmSync(gatePath());
    respond(withComments());
    runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    respond(withComments());
    expect(() =>
      runSnapshot({ pr: 7, repo: 'o/r', host: 'github.com:443', gate: true }),
    ).not.toThrow();
  });

  it('refuses a blank --host instead of recording an empty host', () => {
    process.env['GH_HOST'] = 'ghe.corp';
    expect(() =>
      runSnapshot({ pr: 7, repo: 'o/r', host: ' ', gate: true }),
    ).toThrow(TypeError);
    expect(mockGh).not.toHaveBeenCalled();
    expect(existsSync(gatePath())).toBe(false);
  });

  it('asks for --repo on a first run with nothing prepared', () => {
    expect(() => runSnapshot({ pr: 7, gate: true })).toThrow(/pass --repo/);
    expect(mockGh).not.toHaveBeenCalled();
  });

  it('writes a prepared snapshot whole to a file, and prints a line without the bodies', () => {
    const paths = autofixPrPaths(mocks.root, 7);
    mkdirSync(dirname(paths.statePath), { recursive: true });
    writeState(paths.statePath, {
      version: 1,
      sessionId: '',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: 'qwen-autofix/pr-7',
      worktreePath: paths.worktreePath,
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
    });
    const long = 'x'.repeat(40_000);
    const data = pr({
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [{ ...comment('I1', 'alice', 'MEMBER'), body: long }],
      },
    });
    respond(data);
    const saved = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    try {
      runSnapshot({ pr: 7 });
    } finally {
      if (saved !== undefined) process.env['QWEN_CODE_SESSION_ID'] = saved;
    }
    const line = mocks.stdout.mock.calls[0]![0] as string;
    expect(line.length).toBeLessThan(1_000);
    expect(JSON.parse(line)).toMatchObject({
      action: 'fix',
      events: 1,
      eventTypes: ['issue_comment'],
      snapshot: paths.snapshotPath,
    });
    const whole = readFileSync(paths.snapshotPath, 'utf8');
    // Every line within what `read_file` shows of one: the body is its
    // lines, the long one folded.
    expect(Math.max(...whole.split('\n').map((l) => l.length))).toBeLessThan(
      2_100,
    );
    const written = JSON.parse(whole) as {
      action: string;
      events: Array<{ id: string; body: Array<string | string[]> }>;
    };
    expect(written).toMatchObject({
      action: 'fix',
      events: [{ type: 'issue_comment', id: 'I1' }],
    });
    // The long line is one entry: the array of its pieces.
    expect(written.events[0]!.body).toHaveLength(1);
    expect((written.events[0]!.body[0] as string[]).join('')).toBe(long);
    // No task's round: no background fix starts from it.
    expect(written).not.toHaveProperty('task');
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    writeState(paths.statePath, {
      ...state,
      watch: { every: 2, reply: true, instructions: '', task: 'aaaaaaaaaaaa' },
    });
    // GitHub answers ten seconds after it was asked.
    const answer = JSON.stringify({
      data: { viewer: { login: 'me' }, repository: { pullRequest: data } },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    mockGh.mockImplementationOnce(() => {
      vi.setSystemTime(new Date('2026-10-26T10:00:10.000Z'));
      return answer;
    });
    delete process.env['QWEN_CODE_SESSION_ID'];
    try {
      runSnapshot({ pr: 7, task: 'aaaaaaaaaaaa' });
    } finally {
      vi.useRealTimers();
      if (saved !== undefined) process.env['QWEN_CODE_SESSION_ID'] = saved;
    }
    expect(JSON.parse(readFileSync(paths.snapshotPath, 'utf8'))).toMatchObject({
      task: 'aaaaaaaaaaaa',
      // When it began to read the PR, not when GitHub answered.
      readAt: '2026-10-26T10:00:00.000Z',
    });
  });

  it('wakes the session a watch was taken from, and moves no cursor for it', () => {
    const statePath = autofixPrPaths(mocks.root, 7).statePath;
    mkdirSync(dirname(statePath), { recursive: true });
    writeState(statePath, {
      version: 1,
      sessionId: 'session-b',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
    });
    // The task of session-a names its session; the watch is session-b's.
    runSnapshot({ pr: 7, repo: 'o/r', gate: true, session: 'session-a' });
    expect(JSON.parse(mocks.stdout.mock.calls[0]![0])).toEqual({
      action: 'stop',
      events: [
        {
          type: 'watched_elsewhere',
          session: 'session-b',
          gateSession: 'session-a',
        },
      ],
    });
    expect(mockGh).not.toHaveBeenCalled();
    expect(existsSync(gatePath())).toBe(false);

    // A gate that names no session — a Managed automation's, run as a
    // session of its own — asks nothing of the owner.
    const saved = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'derived-runtime-session';
    try {
      respond(pr());
      runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    } finally {
      if (saved === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = saved;
    }
    expect(mocks.stdout).toHaveBeenCalledTimes(1);
    expect(existsSync(gatePath())).toBe(true);
  });

  it('writes no cursor when the watch is taken over while GitHub is asked', () => {
    const statePath = autofixPrPaths(mocks.root, 7).statePath;
    mkdirSync(dirname(statePath), { recursive: true });
    const owned = {
      version: 1 as const,
      sessionId: 'session-a',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
    };
    writeState(statePath, owned);
    mockGh.mockImplementationOnce(() => {
      writeState(statePath, { ...owned, sessionId: 'session-b' });
      return JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: { pullRequest: withComments('I1') },
        },
      });
    });
    runSnapshot({ pr: 7, repo: 'o/r', gate: true, session: 'session-a' });
    expect(JSON.parse(mocks.stdout.mock.calls[0]![0])).toMatchObject({
      events: [
        {
          type: 'watched_elsewhere',
          session: 'session-b',
          gateSession: 'session-a',
        },
      ],
    });
    expect(existsSync(gatePath())).toBe(false);
  });

  it('stops a task a later schedule replaced, and one whose watch ended, moving no cursor', () => {
    const statePath = autofixPrPaths(mocks.root, 7).statePath;
    mkdirSync(dirname(statePath), { recursive: true });
    writeState(statePath, {
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
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
      watch: { every: 2, reply: true, instructions: '', task: 'aaaaaaaaaaaa' },
    });
    const gate = (task: string) =>
      runSnapshot({
        pr: 7,
        repo: 'o/r',
        gate: true,
        session: 'session-a',
        task,
      });
    // The watch's own task reads the PR.
    respond(pr());
    gate('aaaaaaaaaaaa');
    expect(mockGh).toHaveBeenCalledTimes(1);
    const old = new Date('2026-10-01T00:00:00.000Z');
    utimesSync(gatePath(), old, old);
    // A task the watch's latest schedule replaced — one in a second
    // process of the same session, say — stops without asking GitHub, and
    // leaves the cursor's time to the gate that drives the watch.
    mocks.stdout.mockClear();
    gate('bbbbbbbbbbbb');
    expect(JSON.parse(mocks.stdout.mock.calls[0]![0])).toEqual({
      action: 'stop',
      events: [
        {
          type: 'watched_elsewhere',
          session: 'session-a',
          gateSession: 'session-a',
          gateTask: 'bbbbbbbbbbbb',
        },
      ],
    });
    expect(mockGh).toHaveBeenCalledTimes(1);
    expect(statSync(gatePath()).mtimeMs).toBe(old.getTime());
    // Once cleanup removed the watch, its task stops too.
    rmSync(statePath);
    mocks.stdout.mockClear();
    gate('aaaaaaaaaaaa');
    expect(JSON.parse(mocks.stdout.mock.calls[0]![0])).toEqual({
      action: 'stop',
      events: [
        {
          type: 'watch_ended',
          gateSession: 'session-a',
          gateTask: 'aaaaaaaaaaaa',
        },
      ],
    });
    expect(mockGh).toHaveBeenCalledTimes(1);
  });

  it('leaves out what a prepared watch handled: failures, a conflict, and a deferred run until it ends', () => {
    const statePath = autofixPrPaths(mocks.root, 7).statePath;
    mkdirSync(dirname(statePath), { recursive: true });
    writeState(statePath, {
      version: 1,
      sessionId: '',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
      handledChecks: [`Test@${HEAD}@#5`],
      handledConflictSha: HEAD,
      deferredRuns: [456],
      heldChecks: [`456:run:1:2:pull_request:Lint@${HEAD}@6`],
    });
    const lint = (status: string): Contexts[number] => ({
      __typename: 'CheckRun',
      name: 'Lint',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/o/r/actions/runs/456/job/6',
      databaseId: 6,
      checkSuite: {
        status,
        app: { databaseId: 1 },
        workflowRun: { event: 'pull_request', workflow: { databaseId: 2 } },
      },
    });
    const printed = () =>
      mocks.stdout.mock.calls.map((call) =>
        (JSON.parse(call[0]) as { events: Array<{ type: string }> }).events.map(
          (event) => event.type,
        ),
      );
    // The round saw Lint fail and deferred its re-run.
    respond(pr({ mergeable: 'CONFLICTING' }, [failed('Test', 5)]));
    runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    expect(mocks.stdout).not.toHaveBeenCalled();
    respond(
      pr({ mergeable: 'CONFLICTING' }, [
        failed('Test', 5),
        lint('IN_PROGRESS'),
      ]),
    );
    // Its run is still going: the round has nothing to do with it yet.
    runSnapshot({ pr: 7, gate: true });
    expect(mocks.stdout).not.toHaveBeenCalled();
    // Its run ended: reported once more, from the state file's deferredRuns.
    respond(
      pr({ mergeable: 'CONFLICTING' }, [failed('Test', 5), lint('COMPLETED')]),
    );
    runSnapshot({ pr: 7, gate: true });
    expect(printed()).toEqual([['ci_failed']]);
  });

  it('uses what a prepared watch of the PR knows: its host, pushes and handled comments', () => {
    const statePath = autofixPrPaths(mocks.root, 7).statePath;
    mkdirSync(dirname(statePath), { recursive: true });
    writeState(statePath, {
      version: 1,
      sessionId: '',
      host: 'ghe.corp',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: 'qwen-autofix/pr-7',
      worktreePath: join(dirname(statePath), 'autofix-pr-7'),
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: HEAD,
      pushedShas: [NEXT_HEAD],
      handledCommentIds: ['I1'],
      postedCommentIds: [],
    });
    respond(withComments('I1'));
    runSnapshot({ pr: 7, repo: 'o/r', gate: true });
    // The documented gate command carries no --host.
    expect(getGhHost()).toBe('ghe.corp');
    expect(mocks.stdout).not.toHaveBeenCalled();
    const stored = JSON.parse(readFileSync(gatePath(), 'utf8'));
    expect(stored).toMatchObject({ host: 'ghe.corp', headSha: HEAD });

    // The watch's own push is not someone else's.
    const pushed = withComments('I1');
    pushed.headRefOid = NEXT_HEAD;
    pushed.commits = { nodes: [] };
    respond(pushed);
    runSnapshot({ pr: 7, gate: true });
    expect(mocks.stdout).not.toHaveBeenCalled();

    // `cleanup` removes the state and keeps the cursor: the handled comment
    // stays handled, and the recorded host is still the one asked.
    rmSync(statePath);
    setGhHost(undefined);
    respond(pushed);
    runSnapshot({ pr: 7, gate: true });
    expect(mocks.stdout).not.toHaveBeenCalled();
    expect(getGhHost()).toBe('ghe.corp');
  });
});
