/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  diffRepoWatch,
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
