/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWatch,
  judgeCleanApproval,
  observeWatches,
  readObserved,
  readWatches,
  removeWatch,
  watchKey,
  type ApprovalFacts,
  type ReviewVerifyWatch,
} from './review-verify-observe.js';
import {
  readPendingReviewEvents,
  readSpawnedKeys,
  recordSpawnedKey,
  reviewEventDedupeKey,
  reviewEventsDir,
} from './review-events.js';

let home: string;
let root: string;

const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);

const watch: ReviewVerifyWatch = {
  platform: 'github',
  host: 'github.com',
  ownerRepo: 'QwenLM/qwen-code',
  number: 15846,
  addedAt: '2026-10-29T00:00:00.000Z',
};

/** An approved, blocker-free PR at `head` — the clean baseline every negative
 *  case below mutates exactly one field of. */
function approved(overrides: Partial<ApprovalFacts> = {}): ApprovalFacts {
  return {
    state: 'OPEN',
    isDraft: false,
    headRefOid: head,
    reviewDecision: 'APPROVED',
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: {
      nodes: [
        {
          state: 'APPROVED',
          author: { login: 'reviewer-1' },
          commit: { oid: head },
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'observe-home-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'observe-root-')));
  vi.stubEnv('QWEN_HOME', join(home, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('judgeCleanApproval', () => {
  it('accepts an approved PR with no unresolved thread, and names the approvers at this head', () => {
    expect(judgeCleanApproval(approved())).toEqual({
      clean: true,
      headSha: head,
      approvers: ['reviewer-1'],
    });
  });

  it('reads reviewDecision, not a review body — a dismissed approval is not an approval', () => {
    // The trap: the review's own state still says APPROVED and its body still
    // says "Approving", but a new head dismissed it, so GitHub's aggregate is
    // no longer APPROVED.
    expect(
      judgeCleanApproval(
        approved({
          reviewDecision: 'REVIEW_REQUIRED',
          reviews: {
            nodes: [
              {
                state: 'APPROVED',
                author: { login: 'reviewer-1' },
                commit: { oid: otherHead },
              },
            ],
          },
        }),
      ),
    ).toEqual({ clean: false, reason: 'not-approved' });
  });

  it.each([
    ['not-open', approved({ state: 'MERGED' })],
    ['draft', approved({ isDraft: true })],
    ['not-approved', approved({ reviewDecision: 'CHANGES_REQUESTED' })],
    ['no-head', approved({ headRefOid: 'nonsense' })],
    ['unreadable', null],
    [
      'threads-unreadable',
      approved({ reviewThreads: { pageInfo: { hasNextPage: false } } }),
    ],
  ])('refuses with %s', (reason, facts) => {
    expect(judgeCleanApproval(facts as ApprovalFacts | null)).toEqual({
      clean: false,
      reason,
    });
  });

  it('refuses an unresolved, non-outdated thread', () => {
    expect(
      judgeCleanApproval(
        approved({
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [{ isResolved: false, isOutdated: false }],
          },
        }),
      ),
    ).toEqual({ clean: false, reason: 'open-blocker' });
  });

  it('a resolved or outdated thread is not a blocker', () => {
    for (const thread of [
      { isResolved: true, isOutdated: false },
      { isResolved: false, isOutdated: true },
    ]) {
      expect(
        judgeCleanApproval(
          approved({
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [thread],
            },
          }),
        ).clean,
      ).toBe(true);
    }
  });

  it('fails closed when the thread connection was cut — an unread page may hold the blocker', () => {
    expect(
      judgeCleanApproval(
        approved({
          reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] },
        }),
      ),
    ).toEqual({ clean: false, reason: 'threads-truncated' });
  });

  it('does not attribute an approval of an earlier commit to this head', () => {
    const judgement = judgeCleanApproval(
      approved({
        reviews: {
          nodes: [
            {
              state: 'APPROVED',
              author: { login: 'stale-reviewer' },
              commit: { oid: otherHead },
            },
            {
              state: 'APPROVED',
              author: { login: 'current-reviewer' },
              commit: { oid: head },
            },
          ],
        },
      }),
    );
    expect(judgement).toEqual({
      clean: true,
      headSha: head,
      approvers: ['current-reviewer'],
    });
  });
});

describe('the watch list', () => {
  it('starts empty, adds, replaces the same coordinates, and removes', () => {
    expect(readWatches(root)).toEqual([]);
    addWatch(root, watch);
    addWatch(root, { ...watch, addedAt: '2026-10-30T00:00:00.000Z' });
    expect(readWatches(root)).toHaveLength(1);
    expect(readWatches(root)[0]?.addedAt).toBe('2026-10-30T00:00:00.000Z');
    expect(removeWatch(root, watchKey(watch))).toBe(true);
    expect(removeWatch(root, watchKey(watch))).toBe(false);
    expect(readWatches(root)).toEqual([]);
  });

  it('lives outside the repository, beside the events', () => {
    addWatch(root, watch);
    const path = join(reviewEventsDir(root), 'watches.json');
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(root)).toBe(false);
    expect(path.startsWith(join(home, '.qwen'))).toBe(true);
  });

  it('refuses a corrupt list rather than silently watching nothing', () => {
    mkdirSync(reviewEventsDir(root), { recursive: true });
    writeFileSync(join(reviewEventsDir(root), 'watches.json'), '{"v":2}');
    expect(() => readWatches(root)).toThrow(/v1 watch list/);
  });
});

describe('observeWatches', () => {
  const fetchClean = async () => approved();

  it('hands off a clean approval exactly once per head', async () => {
    addWatch(root, watch);
    const first = await observeWatches(root, { fetch: fetchClean });
    expect(first).toEqual([
      {
        key: watchKey(watch),
        action: 'emitted',
        reason: 'approved',
        headSha: head,
      },
    ]);
    const { events } = readPendingReviewEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.target.headSha).toBe(head);
    expect(events[0]?.event.reviewedBy).toBe('github:reviewer-1');
    expect(events[0]?.event.sessionId).toBeUndefined();
    expect(readObserved(root)[watchKey(watch)]).toBe(head);

    const second = await observeWatches(root, { fetch: fetchClean });
    expect(second[0]).toMatchObject({
      action: 'skipped',
      reason: 'already-handed-off',
    });
    expect(readPendingReviewEvents(root).events).toHaveLength(1);
  });

  it('hands off a NEW head of the same watch', async () => {
    addWatch(root, watch);
    await observeWatches(root, { fetch: fetchClean });
    const next = await observeWatches(root, {
      fetch: async () => approved({ headRefOid: otherHead }),
    });
    expect(next[0]).toMatchObject({ action: 'emitted', headSha: otherHead });
    expect(readPendingReviewEvents(root).events).toHaveLength(2);
  });

  it('does not re-hand-off a head another producer already verified', async () => {
    addWatch(root, watch);
    recordSpawnedKey(
      root,
      reviewEventDedupeKey({
        platform: 'github',
        host: 'github.com',
        ownerRepo: watch.ownerRepo,
        number: watch.number,
        headSha: head,
      }),
    );
    const outcomes = await observeWatches(root, { fetch: fetchClean });
    expect(outcomes[0]).toMatchObject({
      action: 'skipped',
      reason: 'already-verified',
    });
    expect(readPendingReviewEvents(root).events).toEqual([]);
    // Adopted, so the next poll does not re-read it as a candidate.
    expect(readObserved(root)[watchKey(watch)]).toBe(head);
    expect(readSpawnedKeys(root).size).toBe(1);
  });

  it('emits nothing for a PR that is not cleanly approved', async () => {
    addWatch(root, watch);
    const outcomes = await observeWatches(root, {
      fetch: async () => approved({ reviewDecision: 'REVIEW_REQUIRED' }),
    });
    expect(outcomes[0]).toMatchObject({
      action: 'skipped',
      reason: 'not-approved',
    });
    expect(readPendingReviewEvents(root).events).toEqual([]);
    expect(readObserved(root)).toEqual({});
  });

  it('declines a platform it cannot read, without fetching', async () => {
    addWatch(root, {
      ...watch,
      platform: 'aone',
      host: 'code.alibaba-inc.com',
    });
    const fetch = vi.fn(async () => approved());
    const outcomes = await observeWatches(root, { fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({
      action: 'declined',
      reason: 'unsupported-platform',
    });
  });

  it('reports a failed read and keeps watching', async () => {
    addWatch(root, watch);
    const outcomes = await observeWatches(root, {
      fetch: async () => {
        throw new Error('gh: authentication required');
      },
    });
    expect(outcomes[0]).toMatchObject({
      action: 'failed',
      reason: 'gh: authentication required',
    });
    expect(readWatches(root)).toHaveLength(1);
    expect(readPendingReviewEvents(root).events).toEqual([]);
  });

  it('one failing watch does not stop the others', async () => {
    addWatch(root, watch);
    addWatch(root, { ...watch, number: 15847 });
    const outcomes = await observeWatches(root, {
      fetch: async (w) => {
        if (w.number === 15846) throw new Error('boom');
        return approved();
      },
    });
    expect(outcomes.map((o) => o.action)).toEqual(['failed', 'emitted']);
    expect(readPendingReviewEvents(root).events).toHaveLength(1);
  });

  it('reads nothing and writes nothing when no watch is registered', async () => {
    const fetch = vi.fn(async () => approved());
    expect(await observeWatches(root, { fetch })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(reviewEventsDir(root), 'observed.json'))).toBe(
      false,
    );
  });

  it('a lost observation cursor costs a re-read, never a second spawn', async () => {
    addWatch(root, watch);
    await observeWatches(root, { fetch: fetchClean });
    // Simulate the consumer having verified it, then lose the cursor.
    const { events } = readPendingReviewEvents(root);
    const event = events[0]?.event;
    expect(event).toBeDefined();
    if (!event) return;
    recordSpawnedKey(root, reviewEventDedupeKey(event.target));
    writeFileSync(join(reviewEventsDir(root), 'observed.json'), 'corrupt');
    const outcomes = await observeWatches(root, { fetch: fetchClean });
    expect(outcomes[0]).toMatchObject({ reason: 'already-verified' });
    expect(
      JSON.parse(
        readFileSync(join(reviewEventsDir(root), 'observed.json'), 'utf8'),
      ).heads,
    ).toBeDefined();
  });
});
