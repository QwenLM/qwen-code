/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setGhHost } from '../review/lib/gh.js';
import {
  MAX_CHECK_LOOKUPS,
  buildSnapshot,
  commitCheckResults,
  runSnapshot,
  trackFailingChecks,
  type CheckResult,
  type CheckResults,
  type PrData,
} from './snapshot.js';
import {
  MAX_CHECK_FIX_PUSHES,
  MAX_FAILING_CHECKS,
  MAX_PUSHES,
  autofixPrPaths,
  readState,
  withKnownHead,
  writeState,
  type AutofixPrState,
  type FailingCheck,
} from './state.js';

const mockGh = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  root: '',
  stdout: vi.fn((_line: string) => {}),
  remoteRef: vi.fn((): string | null | undefined => null),
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

const sha = (c: string) => c.repeat(40);
const H0 = sha('a');
const H1 = sha('b');
const H2 = sha('c');
const H3 = sha('d');
const H4 = sha('e');
const TEST = 'run:15368:2:pull_request:Test';

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
    lastKnownHeadSha: H0,
    pushedShas: [],
    handledCommentIds: [],
    postedCommentIds: [],
    ...overrides,
  };
}

type Contexts = NonNullable<
  PrData['commits']['nodes'][number]['commit']['statusCheckRollup']
>['contexts']['nodes'];

function pr(head: string, contexts: Contexts = []): PrData {
  return {
    state: 'OPEN',
    isDraft: false,
    title: 'A PR',
    url: 'https://github.com/o/r/pull/7',
    headRefOid: head,
    mergeable: 'MERGEABLE',
    author: { login: 'me' },
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
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
  };
}

function checkRun(
  conclusion: string | null,
  extra: {
    name?: string;
    workflow?: number;
    id?: number;
    status?: string;
  } = {},
): Contexts[number] {
  const id = extra.id ?? 100;
  return {
    __typename: 'CheckRun',
    name: extra.name ?? 'Test',
    status: extra.status ?? 'COMPLETED',
    conclusion,
    detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    databaseId: id,
    checkSuite: {
      status: 'COMPLETED',
      app: { databaseId: 15368 },
      workflowRun: {
        event: 'pull_request',
        workflow: { databaseId: extra.workflow ?? 2 },
      },
    },
  };
}

function status(state: string): Contexts[number] {
  return {
    __typename: 'StatusContext',
    context: 'ci/jenkins',
    state,
    targetUrl: 'https://ci.example/1',
    createdAt: '2026-10-31T00:00:00Z',
  };
}

const record = (
  head: string,
  pushes: number,
  lastPush?: string,
): FailingCheck => ({
  identity: TEST,
  check: 'Test',
  head,
  pushes,
  ...(lastPush === undefined ? {} : { lastPush }),
});

describe('trackFailingChecks', () => {
  it('records a check the first time a round sees it fail, spending nothing', () => {
    expect(trackFailingChecks(pr(H0, [checkRun('FAILURE')]), state())).toEqual([
      record(H0, 0),
    ]);
  });

  it("spends one push per head of the watch's own pushes the check fails on again", () => {
    let watch = state({ failingChecks: [record(H0, 0)] });
    for (const [head, pushes] of [
      [H1, 1],
      [H2, 2],
      [H3, 3],
    ] as const) {
      watch = {
        ...watch,
        lastKnownHeadSha: head,
        pushedShas: [...watch.pushedShas, head],
      };
      const next = trackFailingChecks(pr(head, [checkRun('FAILURE')]), watch);
      expect(next).toEqual([record(head, pushes, head)]);
      // A second read of the same head spends nothing more.
      expect(
        trackFailingChecks(pr(head, [checkRun('FAILURE', { id: 101 })]), {
          ...watch,
          failingChecks: next,
        }),
      ).toEqual(next);
      watch = { ...watch, failingChecks: next };
    }
  });

  it('gives a check its pushes back on a head someone else pushed', () => {
    // With heads it had no result for, which have nothing left to give.
    const spent = {
      ...record(H1, 2, H1),
      unanswered: [{ sha: H0, pushes: 1 }],
    };
    // Failing there: recorded afresh, counted from the watch's latest push.
    expect(
      trackFailingChecks(
        pr(H2, [checkRun('TIMED_OUT')]),
        state({ pushedShas: [H0, H1], failingChecks: [spent] }),
      ),
    ).toEqual([record(H2, 0, H1)]);
    // No result there yet: the record stays, with its pushes back.
    expect(
      trackFailingChecks(
        pr(H2, [checkRun(null, { status: 'IN_PROGRESS' })]),
        state({ pushedShas: [H0, H1], failingChecks: [spent] }),
      ),
    ).toEqual([record(H1, 0, H1)]);
  });

  it('changes nothing on a rollup cut at the page limit', () => {
    const watch = state({
      pushedShas: [H1, H2, H3],
      failingChecks: [record(H2, 2, H2)],
    });
    // A later run of a check may be on the pages not read.
    const cut = (contexts: Contexts) => {
      const read = pr(H3, contexts);
      read.commits.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo = {
        hasNextPage: true,
        endCursor: 'next',
      };
      return read;
    };
    for (const contexts of [
      [checkRun('FAILURE')],
      [checkRun('SUCCESS')],
      [checkRun('FAILURE', { name: 'Lint', id: 200 })],
    ]) {
      expect(trackFailingChecks(cut(contexts), watch)).toEqual([
        record(H2, 2, H2),
      ]);
    }
  });

  it('spends nothing again on a rollback to a head the watch pushed before', () => {
    const pushes = { pushedShas: [H1, H2] };
    // Pushed H1 and H2, both still failing; the author resets to H1.
    const back = trackFailingChecks(
      pr(H1, [checkRun('FAILURE')]),
      state({ ...pushes, failingChecks: [record(H2, 2, H2)] }),
    );
    expect(back).toEqual([record(H1, 2, H2)]);
    // To and fro between them spends nothing either.
    const forth = trackFailingChecks(
      pr(H2, [checkRun('FAILURE')]),
      state({ ...pushes, failingChecks: back }),
    );
    expect(forth).toEqual([record(H2, 2, H2)]);
    // The watch's next push still counts.
    expect(
      trackFailingChecks(
        pr(H3, [checkRun('FAILURE')]),
        state({ pushedShas: [H1, H2, H3], failingChecks: back }),
      ),
    ).toEqual([record(H3, 3, H3)]);
  });

  /** Answers for the commits `trackFailingChecks` asks about, and the asks. */
  const answers = (by: Record<string, CheckResults | null>) => {
    const asked: string[] = [];
    return {
      asked,
      resultsOn: (sha: string) => {
        asked.push(sha);
        return by[sha] ?? null;
      },
    };
  };
  const results = (result: CheckResult) =>
    new Map([[TEST, result]]) as CheckResults;

  it("asks what the check ended in on the watch's pushes in between", () => {
    // Pushed H2 to fix it, then H3 for a comment before H2's checks ended.
    const watch = state({
      pushedShas: [H1, H2, H3],
      failingChecks: [record(H1, 1, H1)],
    });
    const read = (on: CheckResults | null) => {
      const ask = answers({ [H2]: on });
      const next = trackFailingChecks(
        pr(H3, [checkRun('FAILURE')]),
        watch,
        ask.resultsOn,
      );
      expect(ask.asked).toEqual([H2]);
      return next;
    };
    // The fix passed there: that ended the record, so H3 is a first
    // failure again.
    expect(read(results('passed'))).toEqual([record(H3, 0, H3)]);
    // It failed there: both pushes spent.
    expect(read(results('failed'))).toEqual([record(H3, 3, H3)]);
    // Still running there, or GitHub not answering: only H3 spends, and
    // H2 is asked about again later.
    for (const on of [results('pending'), null]) {
      expect(read(on)).toEqual([
        { ...record(H3, 2, H3), unanswered: [{ sha: H2, pushes: 2 }] },
      ]);
    }
    // Not listed while other checks there still run: it may yet come.
    expect(
      read(Object.assign(new Map() as CheckResults, { running: true })),
    ).toEqual([{ ...record(H3, 2, H3), unanswered: [{ sha: H2, pushes: 2 }] }]);
    // Cancelled by the next push, or not run there: nothing to come.
    expect(read(new Map())).toEqual([record(H3, 2, H3)]);
  });

  it('asks nothing when the push follows the one it last failed on', () => {
    const ask = answers({});
    expect(
      trackFailingChecks(
        pr(H3, [checkRun('FAILURE')]),
        state({ pushedShas: [H1, H2, H3], failingChecks: [record(H2, 2, H2)] }),
        ask.resultsOn,
      ),
    ).toEqual([record(H3, 3, H3)]);
    // Nor for a check that has no result on the head, or passes there.
    trackFailingChecks(
      pr(H3, [checkRun(null, { status: 'IN_PROGRESS' })]),
      state({ pushedShas: [H1, H2, H3], failingChecks: [record(H1, 1, H1)] }),
      ask.resultsOn,
    );
    expect(ask.asked).toEqual([]);
  });

  it('asks about the pushes in between newest first, and none past a pass', () => {
    const between = ['1', '2', '3', '4', '5'].map(sha);
    const watch = state({
      pushedShas: [H1, ...between, H3],
      failingChecks: [record(H1, 0, H1)],
    });
    const failing = Object.fromEntries(
      between.map((s) => [s, results('failed')]),
    );
    let ask = answers(failing);
    expect(
      trackFailingChecks(pr(H3, [checkRun('FAILURE')]), watch, ask.resultsOn),
    ).toEqual([record(H3, 6, H3)]);
    expect(ask.asked).toEqual([...between].reverse());
    ask = answers({ ...failing, [between[3]!]: results('passed') });
    expect(
      trackFailingChecks(pr(H3, [checkRun('FAILURE')]), watch, ask.resultsOn),
    ).toEqual([record(H3, 0, H3)]);
    expect(ask.asked).toEqual([between[4], between[3]]);
  });

  it(`keeps the newest ${MAX_PUSHES} heads it had no result for`, () => {
    const between = Array.from({ length: 11 }, (_, i) => sha(i.toString(16)));
    expect(
      trackFailingChecks(
        pr(H3, [checkRun('FAILURE')]),
        state({
          pushedShas: [H1, ...between, H3],
          failingChecks: [record(H1, 0, H1)],
        }),
      ),
    ).toEqual([
      {
        ...record(H3, 1, H3),
        unanswered: between.slice(-10).map((s) => ({ sha: s, pushes: 1 })),
      },
    ]);
  });

  it('asks about a re-run on the head it last failed on before the pushes in between', () => {
    const ask = answers({});
    trackFailingChecks(
      pr(H4, [checkRun('FAILURE')]),
      state({
        pushedShas: [H1, H2, H3, H4],
        rerunChecks: [`${TEST}@${H1}@100`],
        failingChecks: [record(H1, 1, H1)],
      }),
      ask.resultsOn,
    );
    expect(ask.asked).toEqual([H1, H3, H2]);
  });

  it("asks about every record's recent heads before the ones asked about again", () => {
    const [s1, s2, s3, s4, s5] = ['1', '2', '3', '4', '5'].map(sha);
    const other = { ...record(s3, 1, s3), identity: 'status:ci/jenkins' };
    const ask = answers({});
    trackFailingChecks(
      pr(H3, [checkRun('FAILURE'), status('FAILURE')]),
      state({
        pushedShas: [s1, s2, s3, s4, s5, H3],
        failingChecks: [
          { ...record(s5, 1, s5), unanswered: [{ sha: s1, pushes: 1 }] },
          other,
        ],
      }),
      ask.resultsOn,
    );
    expect(ask.asked).toEqual([s5, s4, s1]);
  });

  it('asks whether a re-run on the head it last failed on passed since', () => {
    const watch = (extra: Partial<AutofixPrState>) =>
      state({
        pushedShas: [H1, H2, H3],
        failingChecks: [record(H2, 2, H2)],
        ...extra,
      });
    const read = (extra: Partial<AutofixPrState>, on: CheckResults | null) => {
      const ask = answers({ [H2]: on });
      return {
        next: trackFailingChecks(
          pr(H3, [checkRun('FAILURE')]),
          watch(extra),
          ask.resultsOn,
        ),
        asked: ask.asked,
      };
    };
    // Re-run on H2 before the push to H3, and passed after the round moved on.
    for (const extra of [
      { rerunChecks: [`${TEST}@${H2}@100`] },
      { rerunChecks: [`${TEST}@${H2}`] },
    ]) {
      expect(read(extra, results('passed'))).toEqual({
        next: [record(H3, 0, H3)],
        asked: [H2],
      });
      expect(read(extra, results('failed')).next).toEqual([record(H3, 3, H3)]);
    }
    // Not re-run there, or only held for a run still going — which starts
    // on its own head only, and the watch has pushed since: nothing to ask.
    for (const extra of [
      { rerunChecks: [`${TEST}@${H1}@100`] },
      { heldChecks: [`123:${TEST}@${H2}@100`] },
    ]) {
      expect(read(extra, results('passed'))).toEqual({
        next: [record(H3, 3, H3)],
        asked: [],
      });
    }
  });

  it('asks again on the next push about a re-run that had not ended', () => {
    const rerun = { rerunChecks: [`${TEST}@${H2}@100`] };
    // H2's re-run is still going (or GitHub does not answer) when H3 fails.
    for (const on of [results('pending'), null]) {
      const ask = answers({ [H2]: on });
      expect(
        trackFailingChecks(
          pr(H3, [checkRun('FAILURE')]),
          state({
            ...rerun,
            pushedShas: [H1, H2, H3],
            failingChecks: [record(H2, 2, H2)],
          }),
          ask.resultsOn,
        ),
      ).toEqual([
        { ...record(H3, 3, H3), unanswered: [{ sha: H2, pushes: 3 }] },
      ]);
    }
    const spent = {
      ...record(H3, 3, H3),
      unanswered: [{ sha: H2, pushes: 3 }],
    };
    const next = (on: CheckResults | null) => {
      const ask = answers({ [H2]: on });
      const read = trackFailingChecks(
        pr(H4, [checkRun('FAILURE')]),
        state({ pushedShas: [H1, H2, H3, H4], failingChecks: [spent] }),
        ask.resultsOn,
      );
      expect(ask.asked).toEqual([H2]);
      return read;
    };
    // It passed later: H3 was a first failure again, and H4 spends one.
    expect(next(results('passed'))).toEqual([record(H4, 1, H4)]);
    // It failed again, or ended with no result: spent already, nothing
    // more.
    for (const on of [results('failed'), new Map() as CheckResults]) {
      expect(next(on)).toEqual([record(H4, 4, H4)]);
    }
    // Still no result: asked again on the push after.
    for (const on of [results('pending'), null]) {
      expect(next(on)).toEqual([
        { ...record(H4, 4, H4), unanswered: [{ sha: H2, pushes: 3 }] },
      ]);
    }
  });

  it('counts from the newest head a late pass was found on', () => {
    // A fix pushed as H1 had no result when H2 failed, nor did a re-run
    // on H2 when H3 failed; H1 passed after all.
    const ask = answers({ [H1]: results('passed'), [H2]: results('pending') });
    expect(
      trackFailingChecks(
        pr(H4, [checkRun('FAILURE')]),
        state({
          pushedShas: [H0, H1, H2, H3, H4],
          failingChecks: [
            {
              ...record(H3, 2, H3),
              unanswered: [
                { sha: H1, pushes: 1 },
                { sha: H2, pushes: 2 },
              ],
            },
          ],
        }),
        ask.resultsOn,
      ),
    ).toEqual([
      // H2 a first failure again, H3 and H4 one each; H2's re-run counts
      // from H3 should it pass.
      { ...record(H4, 2, H4), unanswered: [{ sha: H2, pushes: 1 }] },
    ]);
    expect(ask.asked).toEqual([H2, H1]);
    // H2's re-run passed: H3 was a first failure again, and nothing older
    // is asked about or kept.
    const later = answers({ [H2]: results('passed') });
    expect(
      trackFailingChecks(
        pr(H4, [checkRun('FAILURE')]),
        state({
          pushedShas: [H0, H1, H2, H3, H4],
          failingChecks: [
            {
              ...record(H3, 2, H3),
              unanswered: [
                { sha: H1, pushes: 1 },
                { sha: H2, pushes: 2 },
              ],
            },
          ],
        }),
        later.resultsOn,
      ),
    ).toEqual([record(H4, 1, H4)]);
    expect(later.asked).toEqual([H2]);
  });

  it('counts a late pass after a rollback as an answer at once would', () => {
    // H1 had no result when H2 failed; the branch goes back to H1, and a
    // round sees it fail there: H1 has its answer.
    const pushed = { pushedShas: [H0, H1, H2] };
    const back = trackFailingChecks(
      pr(H1, [checkRun('FAILURE')]),
      state({
        ...pushed,
        failingChecks: [
          { ...record(H2, 1, H2), unanswered: [{ sha: H1, pushes: 1 }] },
        ],
      }),
    );
    expect(back).toEqual([record(H1, 1, H2)]);
    // The round re-runs it on H1, and H3 fails before that re-run ends.
    const rerun = { rerunChecks: [`${TEST}@${H1}@100`] };
    const after = trackFailingChecks(
      pr(H3, [checkRun('FAILURE')]),
      state({
        ...rerun,
        pushedShas: [H0, H1, H2, H3],
        failingChecks: back,
      }),
      answers({ [H1]: results('pending') }).resultsOn,
    );
    expect(after).toEqual([
      { ...record(H3, 2, H3), unanswered: [{ sha: H1, pushes: 2 }] },
    ]);
    // It passed: H3 was a first failure again, and H4 spends one — as had
    // the pass been known at H3.
    expect(
      trackFailingChecks(
        pr(H4, [checkRun('FAILURE')]),
        state({ pushedShas: [H0, H1, H2, H3, H4], failingChecks: after }),
        answers({ [H1]: results('passed') }).resultsOn,
      ),
    ).toEqual([record(H4, 1, H4)]);
    expect(
      trackFailingChecks(
        pr(H3, [checkRun('FAILURE')]),
        state({ ...rerun, pushedShas: [H0, H1, H2, H3], failingChecks: back }),
        answers({ [H1]: results('passed') }).resultsOn,
      ),
    ).toEqual([record(H3, 0, H3)]);
  });

  it("gives a spent check back after someone else's push", () => {
    const watch = state({
      pushedShas: [H1, H2, H3],
      failingChecks: [record(H3, MAX_CHECK_FIX_PUSHES, H3)],
    });
    // The author pushes; a round reads it while CI runs.
    const read = trackFailingChecks(pr(sha('f'), []), watch);
    expect(read).toEqual([record(H3, 0, H3)]);
    // Failing on the watch's next push spends one push, not the fourth.
    expect(
      trackFailingChecks(pr(H4, [checkRun('FAILURE')]), {
        ...watch,
        pushedShas: [H1, H2, H3, H4],
        failingChecks: read,
      }),
    ).toEqual([record(H4, 1, H4)]);
  });

  it("counts a check first seen on someone else's head from the watch's latest push", () => {
    const watch = state({ pushedShas: [H1] });
    const first = trackFailingChecks(pr(H2, [checkRun('FAILURE')]), watch);
    expect(first).toEqual([record(H2, 0, H1)]);
    // A return to that push is no new one.
    expect(
      trackFailingChecks(pr(H1, [checkRun('FAILURE')]), {
        ...watch,
        failingChecks: first,
      }),
    ).toEqual([record(H1, 0, H1)]);
  });

  it("starts a check first seen on the watch's own push from that push", () => {
    const first = trackFailingChecks(
      pr(H1, [checkRun('FAILURE')]),
      state({ pushedShas: [H1] }),
    );
    expect(first).toEqual([record(H1, 0, H1)]);
    expect(
      trackFailingChecks(
        pr(H2, [checkRun('FAILURE')]),
        state({ pushedShas: [H1, H2], failingChecks: first }),
      ),
    ).toEqual([record(H2, 1, H2)]);
  });

  it('ends the record on a pass, and only on a pass', () => {
    const watch = state({
      lastKnownHeadSha: H1,
      pushedShas: [H1],
      failingChecks: [record(H0, 2)],
    });
    for (const conclusion of ['SUCCESS', 'NEUTRAL']) {
      expect(trackFailingChecks(pr(H1, [checkRun(conclusion)]), watch)).toEqual(
        [],
      );
    }
    // Still running, cancelled, skipped or absent: nothing is known of it.
    for (const contexts of [
      [checkRun(null, { status: 'IN_PROGRESS' })],
      [checkRun('CANCELLED')],
      [checkRun('SKIPPED')],
      [],
    ]) {
      expect(trackFailingChecks(pr(H1, contexts), watch)).toEqual([
        record(H0, 2),
      ]);
    }
    // On the head it last failed on, a re-run still going changes nothing.
    expect(
      trackFailingChecks(
        pr(H1, [checkRun(null, { status: 'QUEUED' })]),
        state({ pushedShas: [H1], failingChecks: [record(H1, 2, H1)] }),
      ),
    ).toEqual([record(H1, 2, H1)]);
  });

  it('follows the latest run of a check, so a re-run that passed ends it', () => {
    expect(
      trackFailingChecks(
        pr(H1, [
          checkRun('FAILURE', { id: 100 }),
          checkRun('SUCCESS', { id: 101 }),
        ]),
        state({ pushedShas: [H1], failingChecks: [record(H0, 2)] }),
      ),
    ).toEqual([]);
  });

  it('keeps checks of the same name in two workflows apart', () => {
    const next = trackFailingChecks(
      pr(H1, [
        checkRun('FAILURE', { workflow: 2 }),
        checkRun('SUCCESS', { workflow: 3, id: 200 }),
      ]),
      state({
        pushedShas: [H1],
        failingChecks: [
          record(H0, 1),
          { ...record(H0, 1), identity: 'run:15368:3:pull_request:Test' },
        ],
      }),
    );
    expect(next).toEqual([record(H1, 2, H1)]);
  });

  it('counts a commit status by its context', () => {
    const watch = state({
      pushedShas: [H1],
      failingChecks: [
        {
          identity: 'status:ci/jenkins',
          check: 'ci/jenkins',
          head: H0,
          pushes: 0,
        },
      ],
    });
    for (const failing of ['FAILURE', 'ERROR']) {
      expect(trackFailingChecks(pr(H1, [status(failing)]), watch)).toEqual([
        {
          identity: 'status:ci/jenkins',
          check: 'ci/jenkins',
          head: H1,
          pushes: 1,
          lastPush: H1,
        },
      ]);
    }
    expect(trackFailingChecks(pr(H1, [status('PENDING')]), watch)).toEqual(
      watch.failingChecks,
    );
    expect(trackFailingChecks(pr(H1, [status('SUCCESS')]), watch)).toEqual([]);
  });

  it('changes nothing for a closed PR or a rollup of another commit', () => {
    const watch = state({ pushedShas: [H1], failingChecks: [record(H0, 1)] });
    const merged = {
      ...pr(H1, [checkRun('FAILURE')]),
      state: 'MERGED' as const,
    };
    expect(trackFailingChecks(merged, watch)).toEqual([record(H0, 1)]);
    const stale = pr(H1, [checkRun('SUCCESS')]);
    stale.commits.nodes[0]!.commit.oid = H0;
    expect(trackFailingChecks(stale, watch)).toEqual([record(H0, 1)]);
  });

  it('drops the records no read changed for longest', () => {
    const many = [
      record(H0, 1),
      ...Array.from({ length: MAX_FAILING_CHECKS - 1 }, (_, i) => ({
        ...record(H0, 0),
        identity: `status:old-${i}`,
        check: `old-${i}`,
      })),
    ];
    const next = trackFailingChecks(
      pr(H1, [checkRun('FAILURE'), status('FAILURE')]),
      state({ pushedShas: [H1], failingChecks: many }),
    );
    expect(next).toHaveLength(MAX_FAILING_CHECKS);
    // The check failing now, spent again, outlives the oldest stale one.
    expect(next.at(-2)).toEqual(record(H1, 2, H1));
    expect(next.at(-1)).toMatchObject({
      identity: 'status:ci/jenkins',
      pushes: 0,
    });
    expect(next.some((r) => r.identity === 'status:old-0')).toBe(false);
  });

  it('keeps a record a read leaves as it was in its place', () => {
    // Test fails again on the head it last failed on; ci/jenkins, later in
    // the list, is still running there.
    const watch = state({
      pushedShas: [H1],
      failingChecks: [
        record(H1, 1, H1),
        {
          identity: 'status:ci/jenkins',
          check: 'ci/jenkins',
          head: H0,
          pushes: 0,
        },
      ],
    });
    expect(
      trackFailingChecks(
        pr(H1, [checkRun('FAILURE'), status('PENDING')]),
        watch,
      ),
    ).toEqual(watch.failingChecks);
  });

  it('keeps the most recently added checks', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...record(H0, 0),
      identity: `status:old-${i}`,
      check: `old-${i}`,
    }));
    const next = trackFailingChecks(
      pr(H0, [checkRun('FAILURE')]),
      state({ failingChecks: many }),
    );
    expect(next).toHaveLength(100);
    expect(next[0]!.identity).toBe('status:old-1');
    expect(next.at(-1)).toEqual(record(H0, 0));
  });
});

describe('buildSnapshot: the fix budget of a check', () => {
  it(`offers a check for a fix until ${MAX_CHECK_FIX_PUSHES} pushes left it red, then as spent`, () => {
    const at = (pushes: number) =>
      buildSnapshot(
        pr(H3, [checkRun('FAILURE')]),
        state({
          lastKnownHeadSha: H3,
          pushedShas: [H1, H2, H3],
          failingChecks: [record(H3, pushes)],
        }),
      ).events;
    expect(at(MAX_CHECK_FIX_PUSHES - 1)).toEqual([
      expect.not.objectContaining({ exhausted: expect.anything() }),
    ]);
    expect(at(MAX_CHECK_FIX_PUSHES)).toEqual([
      expect.objectContaining({
        type: 'ci_failed',
        check: 'Test',
        key: `Test@${H3}@#100`,
        exhausted: true,
      }),
    ]);
  });

  it('marks only the spent check of a round with two failing', () => {
    const events = buildSnapshot(
      pr(H3, [
        checkRun('FAILURE'),
        checkRun('FAILURE', { name: 'Lint', id: 200 }),
      ]),
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        failingChecks: [
          record(H3, MAX_CHECK_FIX_PUSHES, H3),
          {
            ...record(H3, 1, H3),
            identity: 'run:15368:2:pull_request:Lint',
            check: 'Lint',
          },
        ],
      }),
    ).events;
    expect(events).toEqual([
      expect.objectContaining({ check: 'Test', exhausted: true }),
      expect.not.objectContaining({ exhausted: expect.anything() }),
    ]);
    expect(events[1]).toMatchObject({ check: 'Lint' });
  });

  it('never marks a workflow GitHub could not start, which has no fix to spend', () => {
    const data = pr(H3);
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
    const events = buildSnapshot(
      data,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H3],
        // Its identity, as a record of one would name it.
        failingChecks: [
          {
            identity: 'run:15368:9:pull_request:',
            check: 'CI',
            head: H3,
            pushes: MAX_CHECK_FIX_PUSHES,
          },
        ],
      }),
    ).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'ci_failed', startupFailure: true }),
    ]);
    expect(events[0]).not.toHaveProperty('exhausted');
  });

  it('still answers a spent check once per head: a handled key is quiet', () => {
    const snapshot = buildSnapshot(
      pr(H3, [checkRun('FAILURE')]),
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H3],
        handledChecks: [`Test@${H3}@#100`],
        failingChecks: [record(H3, MAX_CHECK_FIX_PUSHES)],
      }),
    );
    expect(snapshot.action).toBe('wait');
    expect(snapshot.events).toEqual([]);
  });
});

describe('runSnapshot: recording the fix budget', () => {
  let savedHost: string | undefined;
  let savedSession: string | undefined;
  const paths = () => autofixPrPaths(mocks.root, 7);
  const stored = () => readState(paths().statePath)!;
  const written = () =>
    JSON.parse(readFileSync(paths().snapshotPath, 'utf8')) as {
      action: string;
      baseBehind?: boolean;
      truncated?: string[];
      events: Array<{ type: string; exhausted?: boolean }>;
    };
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
  /** What `push` records of a push to `head`. */
  const pushTo = (head: string) => {
    const now = stored();
    writeState(paths().statePath, {
      ...now,
      lastKnownHeadSha: head,
      pushedShas: [...now.pushedShas, head],
      pushCount: (now.pushCount ?? 0) + 1,
    });
  };

  beforeEach(() => {
    mocks.root = mkdtempSync(join(tmpdir(), 'autofix-fix-budget-'));
    mockGh.mockReset();
    // The compare of the stale-base hint: the branch contains its base.
    mockGh.mockReturnValue('ahead');
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

  it(`leaves a check for a person once ${MAX_CHECK_FIX_PUSHES} of the watch's pushes left it red`, () => {
    respond(pr(H0, [checkRun('FAILURE')]));
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([record(H0, 0)]);
    expect(written().events[0]).not.toHaveProperty('exhausted');

    for (const [head, pushes] of [
      [H1, 1],
      [H2, 2],
    ] as const) {
      pushTo(head);
      respond(pr(head, [checkRun('FAILURE')]));
      runSnapshot({ pr: 7 });
      expect(stored().failingChecks).toEqual([record(head, pushes, head)]);
      expect(written().action).toBe('fix');
      expect(written().events[0]).not.toHaveProperty('exhausted');
    }

    pushTo(H3);
    respond(pr(H3, [checkRun('FAILURE')]));
    mockGh.mockClear();
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([
      record(H3, MAX_CHECK_FIX_PUSHES, H3),
    ]);
    expect(written().action).toBe('fix');
    expect(written().events).toEqual([
      expect.objectContaining({ type: 'ci_failed', exhausted: true }),
    ]);
    // A spent check is not fixed this round: no stale-base hint for it.
    expect(compareCalls()).toHaveLength(0);
    expect(written().baseBehind).toBeUndefined();

    // A pass ends the record; failing again later starts a new one.
    pushTo(H4);
    respond(pr(H4, [checkRun('SUCCESS')]));
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([]);
    pushTo(H0.replace(/a/g, '9'));
    respond(pr(H0.replace(/a/g, '9'), [checkRun('FAILURE', { id: 300 })]));
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([
      record(H0.replace(/a/g, '9'), 0, H0.replace(/a/g, '9')),
    ]);
    expect(written().events[0]).not.toHaveProperty('exhausted');
  });

  it('writes nothing for a read that changes no record', () => {
    respond(pr(H0, [checkRun('SUCCESS')]));
    runSnapshot({ pr: 7 });
    expect(stored()).not.toHaveProperty('failingChecks');
  });

  it('records nothing while the API has not caught up with the branch', () => {
    pushTo(H1);
    // The API still shows the head before the push; the branch is at it.
    mocks.remoteRef.mockReturnValue(H1);
    respond(pr(H0, [checkRun('FAILURE')]));
    runSnapshot({ pr: 7 });
    expect(stored()).not.toHaveProperty('failingChecks');
    expect(written()).toMatchObject({ action: 'wait', events: [] });
  });

  /** Held by a live helper: this very process, under another token. */
  const holdLock = () => {
    const lock = paths().lockPath;
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, ns: null, at: Date.now(), id: 'x' }),
    );
  };

  it('records nothing from a read of another head than the one the watch knows', () => {
    // The watch pushed H1, the API still shows H0, and the branch could not
    // be read: the round is not lagging, but H0 is no push of anyone's now.
    pushTo(H1);
    mocks.remoteRef.mockReturnValue(undefined);
    writeState(paths().statePath, {
      ...stored(),
      failingChecks: [record(H1, 1, H1)],
    });
    respond(pr(H0, [checkRun('FAILURE')]));
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([record(H1, 1, H1)]);
    // Nor does it wait for the lock another helper holds.
    holdLock();
    respond(pr(H0, [checkRun('FAILURE')]));
    runSnapshot({ pr: 7 });
    expect(written().action).toBe('resync');
  });

  it('records nothing once a sync during the read moved the head the watch knows', () => {
    writeState(paths().statePath, state({ failingChecks: [record(H0, 0)] }));
    mockGh.mockImplementationOnce(() => {
      // `sync` adopts someone else's push while the PR is being read.
      writeState(paths().statePath, { ...stored(), lastKnownHeadSha: H2 });
      return JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: { pullRequest: pr(H0, [checkRun('SUCCESS')]) },
        },
      });
    });
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([record(H0, 0)]);
    // The round is built from the state re-read under the lock.
    expect(written().action).toBe('resync');
  });

  it('builds the round from the state re-read under the lock when that read changes nothing', () => {
    mockGh.mockImplementationOnce(() => {
      // A helper answers the failure, and a read records it, while the PR
      // is being read.
      writeState(paths().statePath, {
        ...stored(),
        handledChecks: [`Test@${H0}@#100`],
        failingChecks: [record(H0, 0)],
      });
      return JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: { pullRequest: pr(H0, [checkRun('FAILURE')]) },
        },
      });
    });
    runSnapshot({ pr: 7 });
    expect(written()).toMatchObject({ action: 'wait', events: [] });
  });

  it('takes a rollup cut at the page limit for no answer', () => {
    // Every page says there is another.
    mockGh.mockImplementation(() =>
      JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: true, endCursor: 'next' },
                  nodes: [checkRun('FAILURE')],
                },
              },
            },
          },
        },
      }),
    );
    expect(commitCheckResults({ owner: 'o', repo: 'r' }, H2)).toBeNull();
    // Two pages, the second the last: both read, the latest run counts.
    mockGh.mockReset();
    const page = (nodes: Contexts, next: string | null) =>
      JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: next !== null, endCursor: next },
                  nodes,
                },
              },
            },
          },
        },
      });
    mockGh
      .mockReturnValueOnce(page([checkRun('FAILURE', { id: 1 })], 'p2'))
      .mockReturnValueOnce(page([checkRun('SUCCESS', { id: 2 })], null));
    expect(commitCheckResults({ owner: 'o', repo: 'r' }, H2)).toEqual(
      new Map([[TEST, 'passed']]),
    );
    expect(mockGh.mock.calls[1]).toContain('after=p2');
    // Not a commit, or no rollup: no result for anything.
    mockGh.mockReset();
    mockGh.mockReturnValueOnce(
      JSON.stringify({ data: { repository: { object: {} } } }),
    );
    expect(commitCheckResults({ owner: 'o', repo: 'r' }, H2)).toEqual(
      new Map(),
    );
  });

  it('refuses, writing nothing, while another helper holds the lock', () => {
    holdLock();
    respond(pr(H0, [checkRun('FAILURE')]));
    expect(() => runSnapshot({ pr: 7 })).toThrow(/another autofix-pr helper/);
    expect(stored()).not.toHaveProperty('failingChecks');
  });

  it('leaves the lock alone for a read that changes no record', () => {
    holdLock();
    // Merged, or green: answered as before, whoever holds the lock.
    respond({ ...pr(H0, [checkRun('FAILURE')]), state: 'MERGED' });
    runSnapshot({ pr: 7 });
    expect(written().action).toBe('stop');
    respond(pr(H0, [checkRun('SUCCESS')]));
    runSnapshot({ pr: 7 });
    expect(written().action).toBe('wait');
  });

  it('recomputes under the lock from the state re-read there', () => {
    // The head is known; that the watch pushed it is recorded during the
    // read (by a helper another process of the session ran).
    writeState(
      paths().statePath,
      state({ lastKnownHeadSha: H1, failingChecks: [record(H0, 0)] }),
    );
    mockGh.mockImplementationOnce(() => {
      writeState(paths().statePath, { ...stored(), pushedShas: [H1] });
      return JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: { pullRequest: pr(H1, [checkRun('FAILURE')]) },
        },
      });
    });
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([record(H1, 1, H1)]);
  });

  /** Answers the PR query with `data`, and a commit's checks from `commits`. */
  const github = (data: PrData, commits: Record<string, Contexts | Error>) =>
    mockGh.mockImplementation((...args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (!query.includes('object(oid:')) {
        if (args.includes('graphql')) {
          return JSON.stringify({
            data: {
              viewer: { login: 'me' },
              repository: { pullRequest: data },
            },
          });
        }
        return 'ahead';
      }
      const oid = args.find((arg) => arg.startsWith('oid='))!.slice(4);
      const answer = commits[oid];
      if (answer instanceof Error) throw answer;
      return JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: false },
                  nodes: answer ?? [],
                },
              },
            },
          },
        },
      });
    });
  const commitQueries = () =>
    mockGh.mock.calls
      .filter((call) =>
        (call as string[]).some((arg) => arg.includes('object(oid:')),
      )
      .map((call) =>
        (call as string[]).find((arg) => arg.startsWith('oid='))!.slice(4),
      );

  it("asks GitHub once about the watch's push in between, and counts what it says", () => {
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        failingChecks: [record(H1, 1, H1)],
      }),
    );
    github(pr(H3, [checkRun('FAILURE', { id: 300 })]), {
      [H2]: [checkRun('SUCCESS', { id: 200 })],
    });
    runSnapshot({ pr: 7 });
    // Asked before the lock, and the answer reused under it.
    expect(commitQueries()).toEqual([H2]);
    expect(stored().failingChecks).toEqual([record(H3, 0, H3)]);
    expect(written().events[0]).not.toHaveProperty('exhausted');
  });

  it(`asks GitHub about ${MAX_CHECK_LOOKUPS} commits a read at most`, () => {
    const [s1, s2, s3, s4, s5] = ['1', '2', '3', '4', '5'].map(sha);
    const other = (id: string, head: string): FailingCheck => ({
      identity: `run:15368:2:pull_request:${id}`,
      check: id,
      head,
      pushes: 1,
      lastPush: head,
    });
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, s1, s2, s3, s4, s5, H3],
        // Re-run on the heads they last failed on.
        rerunChecks: [
          `run:15368:2:pull_request:B@${s2}@1`,
          `run:15368:2:pull_request:C@${s1}@1`,
        ],
        failingChecks: [record(H1, 0, H1), other('B', s2), other('C', s1)],
      }),
    );
    github(
      pr(H3, [
        checkRun('FAILURE', { id: 300 }),
        checkRun('FAILURE', { name: 'B', id: 301 }),
        checkRun('FAILURE', { name: 'C', id: 302 }),
      ]),
      {},
    );
    runSnapshot({ pr: 7 });
    // Test asks about s5 back to s2, which also answer B's pushes in
    // between and its re-run on s2 (none of them ran there); s1 is past the
    // budget, for Test and for C's re-run there: asked about on the next
    // push.
    expect(commitQueries()).toEqual([s5, s4, s3, s2]);
    expect(stored().failingChecks).toEqual([
      { ...record(H3, 1, H3), unanswered: [{ sha: s1, pushes: 1 }] },
      { ...other('B', H3), pushes: 2 },
      { ...other('C', H3), pushes: 2, unanswered: [{ sha: s1, pushes: 2 }] },
    ]);
  });

  it('takes no answer about a commit for no result, and still writes the round', () => {
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        failingChecks: [record(H1, 1, H1)],
      }),
    );
    github(pr(H3, [checkRun('FAILURE', { id: 300 })]), {
      [H2]: new Error('gh: HTTP 502'),
    });
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([
      { ...record(H3, 2, H3), unanswered: [{ sha: H2, pushes: 2 }] },
    ]);
    expect(written().action).toBe('fix');
  });

  it('asks again on the next push about a re-run that had not ended', () => {
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        rerunChecks: [`${TEST}@${H2}@100`],
        failingChecks: [record(H2, 2, H2)],
      }),
    );
    github(pr(H3, [checkRun('FAILURE', { id: 300 })]), {
      [H2]: [checkRun(null, { id: 101, status: 'IN_PROGRESS' })],
    });
    runSnapshot({ pr: 7 });
    expect(written().events[0]).toMatchObject({ exhausted: true });
    // The re-run passes after the round moved on; the watch pushes H4 for
    // a comment, and the check fails there.
    pushTo(H4);
    mockGh.mockReset();
    github(pr(H4, [checkRun('FAILURE', { id: 400 })]), {
      [H2]: [checkRun('SUCCESS', { id: 101 })],
    });
    runSnapshot({ pr: 7 });
    expect(commitQueries()).toEqual([H2]);
    expect(stored().failingChecks).toEqual([record(H4, 1, H4)]);
    expect(written().events[0]).not.toHaveProperty('exhausted');
  });

  it('records nothing from a head rollup cut at the page limit', () => {
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        failingChecks: [record(H2, 2, H2)],
      }),
    );
    for (const conclusion of ['FAILURE', 'SUCCESS']) {
      // Every page of the head's checks says there is another.
      const read = pr(H3, [checkRun(conclusion, { id: 300 })]);
      read.commits.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo = {
        hasNextPage: true,
        endCursor: 'next',
      };
      mockGh.mockReset();
      github(read, {});
      runSnapshot({ pr: 7 });
      expect(written().truncated).toContain('checks');
      expect(stored().failingChecks).toEqual([record(H2, 2, H2)]);
      expect(commitQueries()).toEqual([]);
    }
  });

  it('takes a re-run GitHub has not listed yet for one still to come', () => {
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        // Re-run on H2 after its check run 150.
        rerunChecks: [`${TEST}@${H2}@150`],
        failingChecks: [record(H2, 2, H2)],
      }),
    );
    // GitHub still lists the run that was re-run as the latest.
    github(pr(H3, [checkRun('FAILURE', { id: 300 })]), {
      [H2]: [checkRun('FAILURE', { id: 150 })],
    });
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([
      { ...record(H3, 3, H3), unanswered: [{ sha: H2, pushes: 3 }] },
    ]);
    // The re-run passed.
    pushTo(H4);
    mockGh.mockReset();
    github(pr(H4, [checkRun('FAILURE', { id: 400 })]), {
      [H2]: [
        checkRun('FAILURE', { id: 150 }),
        checkRun('SUCCESS', { id: 151 }),
      ],
    });
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([record(H4, 1, H4)]);
  });

  it('takes no floor from a re-run only held, which a push has left behind', () => {
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        // Held on H2 for a run still going after its check run 150; the
        // watch pushed H3 before it started.
        heldChecks: [`5:${TEST}@${H2}@150`],
        failingChecks: [record(H1, 1, H1)],
      }),
    );
    github(pr(H3, [checkRun('FAILURE', { id: 300 })]), {
      [H2]: [checkRun('FAILURE', { id: 150 })],
    });
    runSnapshot({ pr: 7 });
    expect(stored().failingChecks).toEqual([record(H3, 3, H3)]);
  });

  it('tells a commit whose check still runs from one where it ended with no result', () => {
    const answer = (nodes: Contexts) => {
      mockGh.mockReset();
      mockGh.mockReturnValueOnce(
        JSON.stringify({
          data: {
            repository: {
              object: {
                statusCheckRollup: {
                  contexts: { pageInfo: { hasNextPage: false }, nodes },
                },
              },
            },
          },
        }),
      );
      return commitCheckResults({ owner: 'o', repo: 'r' }, H2);
    };
    expect(answer([checkRun(null, { status: 'QUEUED' })])).toEqual(
      new Map([[TEST, 'pending']]),
    );
    // Another check still runs there: one not listed may yet come.
    const running = answer([
      checkRun('SUCCESS', { name: 'Lint', id: 4 }),
      checkRun(null, { name: 'Build', id: 5, status: 'IN_PROGRESS' }),
    ]);
    expect(running?.get(TEST)).toBeUndefined();
    expect(running?.running).toBe(true);
    expect(
      answer([checkRun('SUCCESS', { name: 'Lint', id: 4 })])?.running,
    ).toBe(false);
    expect(answer([status('PENDING')])).toEqual(
      new Map([['status:ci/jenkins', 'pending']]),
    );
    for (const ended of ['CANCELLED', 'SKIPPED', 'STALE']) {
      expect(answer([checkRun(ended)])).toEqual(new Map());
    }
  });

  it('still hints a stale base for a fresh failure beside a spent check', () => {
    writeState(
      paths().statePath,
      state({
        lastKnownHeadSha: H3,
        pushedShas: [H1, H2, H3],
        failingChecks: [record(H2, MAX_CHECK_FIX_PUSHES - 1, H2)],
      }),
    );
    respond(
      pr(H3, [
        checkRun('FAILURE', { id: 300 }),
        checkRun('FAILURE', { name: 'Lint', id: 301 }),
      ]),
    );
    // The compare: the branch is behind its base.
    mockGh.mockReturnValue('behind');
    runSnapshot({ pr: 7 });
    expect(written().events).toEqual([
      expect.objectContaining({ check: 'Test', exhausted: true }),
      expect.not.objectContaining({ exhausted: expect.anything() }),
    ]);
    expect(compareCalls()).toHaveLength(1);
    expect(written().baseBehind).toBe(true);
  });

  it('keeps what another helper wrote while the PR was being read', () => {
    const key = `Other@${H0}@#5`;
    mockGh.mockImplementationOnce(() => {
      // A helper records a handled check between this read and the lock.
      writeState(paths().statePath, { ...stored(), handledChecks: [key] });
      return JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: { pullRequest: pr(H0, [checkRun('FAILURE')]) },
        },
      });
    });
    runSnapshot({ pr: 7 });
    expect(stored()).toMatchObject({
      handledChecks: [key],
      failingChecks: [record(H0, 0)],
    });
  });
});

describe('readState: failingChecks', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autofix-fix-budget-state-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the known fields of each record and refuses a malformed one', () => {
    const path = join(root, 'state.json');
    writeState(path, {
      ...state(),
      failingChecks: [
        { ...record(H0, 2), extra: 'x' } as FailingCheck,
        {
          ...record(H1, 1, H1),
          unanswered: [{ sha: H0, pushes: 1, extra: 'x' }],
        } as unknown as FailingCheck,
      ],
    });
    expect(readState(path)!.failingChecks).toEqual([
      record(H0, 2),
      { ...record(H1, 1, H1), unanswered: [{ sha: H0, pushes: 1 }] },
    ]);
    for (const bad of [
      [{ ...record(H0, 1), pushes: -1 }],
      [{ ...record(H0, 1), pushes: 1.5 }],
      [{ ...record(H0, 1), head: 7 }],
      [{ ...record(H0, 1), lastPush: 7 }],
      [{ ...record(H0, 1), head: 'main' }],
      [{ ...record(H0, 1), lastPush: '-x' }],
      [{ ...record(H0, 1), unanswered: 'x' }],
      [{ ...record(H0, 1), unanswered: [null] }],
      [{ ...record(H0, 1), unanswered: [{ sha: 'main', pushes: 1 }] }],
      [{ ...record(H0, 1), unanswered: [{ sha: H1, pushes: -1 }] }],
      [{ ...record(H0, 1), unanswered: [{ sha: H1 }] }],
      'x',
    ]) {
      writeState(path, {
        ...state(),
        failingChecks: bad as unknown as FailingCheck[],
      });
      expect(() => readState(path)).toThrow(/invalid failingChecks/);
    }
  });
});

describe('withKnownHead', () => {
  const spent = {
    ...record(H2, 2, H2),
    unanswered: [{ sha: H1, pushes: 1 }],
  };
  it("gives every check its pushes back on someone else's head", () => {
    expect(
      withKnownHead(
        state({ pushedShas: [H1, H2], failingChecks: [spent] }),
        H3,
      ),
    ).toMatchObject({
      lastKnownHeadSha: H3,
      failingChecks: [record(H2, 0, H2)],
    });
  });

  it("keeps the count on the watch's own push", () => {
    expect(
      withKnownHead(
        state({ pushedShas: [H1, H2], failingChecks: [spent] }),
        H2,
      ),
    ).toMatchObject({ lastKnownHeadSha: H2, failingChecks: [spent] });
  });
});
