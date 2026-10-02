/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
  SESSION_PR_LIST_LIMIT,
  SESSION_PR_URL_MAX_LENGTH,
  commandRunsGhPrCreate,
  ghPrCreateInlineEnv,
  mergeSessionPrLists,
  moveSessionPrSidecar,
  readSessionPrs,
  replaceSessionPrs,
  updateSessionPrStates,
  upsertSessionPr,
  upsertSessionPrs,
  writeSessionPrs,
  type SessionPr,
  type SessionPrState,
} from './session-pr-service.js';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<typeof import('node:fs/promises').readFile>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: fsMocks.readFile };
});

const entry = (number: number): SessionPr => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  createdAt: '2026-08-20T00:00:00.000Z',
});

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  fsMocks.readFile.mockClear();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-pr-test-'));
  filePath = path.join(tmpDir, 'test.pr.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

type StateUpdate =
  Parameters<typeof updateSessionPrStates>[1] extends ReadonlyMap<
    number,
    infer U
  >
    ? U
    : never;

/** A bind candidate for PR `number`; the url defaults to `entry(number).url`. */
const cand = (
  number: number,
  extra: Partial<Parameters<typeof upsertSessionPr>[1]> = {},
) => ({ number, url: entry(number).url, ...extra });
const bind = (...args: Parameters<typeof cand>) =>
  upsertSessionPr(filePath, cand(...args));
/** `https://github.com/<repo>/pull/<number>`. */
const pull = (repo: string, number: number) =>
  `https://github.com/${repo}/pull/${number}`;
const seed = (...prs: SessionPr[]) => writeSessionPrs(filePath, prs);
const read = () => readSessionPrs(filePath);
const readRaw = () => fs.readFile(filePath, 'utf-8');
const numbers = (prs: readonly SessionPr[] | null | undefined) =>
  prs?.map((p) => p.number);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** An `updateSessionPrStates` map entry `[number, { url, state }]`. */
const stamp = (
  number: number,
  state: SessionPrState,
  url = entry(number).url,
): [number, StateUpdate] => [number, { url, state }];
const update = (...states: Array<[number, StateUpdate]>) =>
  updateSessionPrStates(filePath, new Map(states));
/** A full list of `entry(1)` .. `entry(SESSION_PR_LIST_LIMIT)`. */
const fullList = () =>
  Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) => entry(i + 1));
/** `head`, then enough `review` entries numbered from `from` to fill the cap. */
const headThenReviews = (head: SessionPr, from: number): SessionPr[] => [
  head,
  ...Array.from({ length: SESSION_PR_LIST_LIMIT - 1 }, (_, i) => ({
    ...entry(i + from),
    source: 'review' as const,
  })),
];
/** Asserts the sidecar's bytes are unchanged by `action`. */
async function expectUntouched(action: () => Promise<void>) {
  const before = await readRaw();
  await action();
  expect(await readRaw()).toBe(before);
}

describe('writeSessionPrs / readSessionPrs', () => {
  it('round-trips a PR list', async () => {
    const prs = [entry(9517), entry(9519)];
    await writeSessionPrs(filePath, prs);
    expect(await read()).toEqual(prs);
  });

  it('creates missing parent directories on write', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'test.pr.json');
    await writeSessionPrs(nested, [entry(1)]);
    expect(await readSessionPrs(nested)).toEqual([entry(1)]);
  });
});

describe('readSessionPrs', () => {
  it('returns null when the file does not exist', async () => {
    expect(await read()).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(filePath, '{not json', 'utf-8');
    expect(await read()).toBeNull();
  });

  it.each([
    ['bare object (legacy single shape)', entry(1)],
    ['empty list', { prs: [] }],
    ['entry missing url', { prs: [{ number: 1, createdAt: 'x' }] }],
    ['entry non-integer number', { prs: [{ ...entry(1), number: 1.5 }] }],
    ['entry non-positive number', { prs: [entry(0)] }],
    [
      'entry non-http url',
      { prs: [{ ...entry(1), url: 'javascript:alert(1)' }] },
    ],
    [
      'entry url with a control character',
      { prs: [{ ...entry(1), url: 'https://github.com/o/r/pull/1\nforged' }] },
    ],
    [
      'entry url over 2048 characters',
      { prs: [{ ...entry(1), url: `https://github.com/${'a'.repeat(2048)}` }] },
    ],
    ['entry missing createdAt', { prs: [{ number: 1, url: entry(1).url }] }],
  ])('returns null for a malformed sidecar: %s', async (_label, value) => {
    await fs.writeFile(filePath, JSON.stringify(value), 'utf-8');
    expect(await read()).toBeNull();
  });

  it('propagates the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('pr sidecar read cancelled');
    controller.abort(reason);

    await expect(
      readSessionPrs(filePath, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

describe('upsertSessionPr', () => {
  /** Binds 42 while a foreign holder has the lock; `release` lets it land. */
  async function expectBindWaitsFor(
    release: () => Promise<void>,
    expected: number[],
    whileHeld = () => {},
  ) {
    let resolved = false;
    const pending = bind(42).then((prs) => {
      resolved = true;
      return prs;
    });
    await sleep(60);
    expect(resolved).toBe(false);
    whileHeld();
    await release();
    expect(numbers(await pending)).toEqual(expected);
  }

  it('appends bindings in binding order', async () => {
    await bind(100);
    expect(numbers(await bind(101))).toEqual([100, 101]);
  });

  it('re-binding the same PR refreshes it and moves it to latest', async () => {
    await seed(entry(100), entry(101));
    const prs = await bind(100, {
      url: 'https://github.com/owner/repo/pull/100?updated=1',
    });
    // Same PR, query-string variant: state carries over, but a re-bind is a
    // fresh binding (latest slot, new createdAt): the backfill cap planner
    // needs that to tell a concurrent re-bind from an untouched snapshot entry.
    expect(numbers(prs)).toEqual([101, 100]);
    expect(prs[1]?.url).toContain('updated=1');
    expect(prs[1]?.createdAt).not.toBe(entry(100).createdAt);
  });

  it('re-binding the same number to another repo moves it to latest', async () => {
    await bind(100);
    await bind(101);
    const prs = await bind(100, { url: pull('other/repo', 100) });
    expect(numbers(prs)).toEqual([101, 100]);
  });

  it('caps the list at SESSION_PR_LIST_LIMIT, dropping the oldest', async () => {
    for (let i = 1; i <= SESSION_PR_LIST_LIMIT + 2; i++) await bind(i);
    const prs = await read();
    expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(prs?.[0]?.number).toBe(3);
    expect(prs?.[SESSION_PR_LIST_LIMIT - 1]?.number).toBe(
      SESSION_PR_LIST_LIMIT + 2,
    );
  });

  it('stamps the candidate source on a different-URL re-bind', async () => {
    // The same number in another repository is another PR: no known entry
    // matches, so an explicit `review` must persist as such instead of
    // losing to the absent entry's higher pre-provenance rank.
    await seed({ ...entry(5), url: pull('repo-a/r', 5), source: 'create' });
    const prs = await bind(5, { url: pull('repo-b/r', 5), source: 'review' });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      url: pull('repo-b/r', 5),
      source: 'review',
    });
  });

  it('caps by provenance authority like the batch writer', async () => {
    // Every writer caps the same way: a GitDialog create on a full list must
    // evict the oldest REVIEWED entry, never the created binding at the head.
    const seeded = headThenReviews({ ...entry(1), source: 'create' }, 2);
    await seed(...seeded);
    const prs = await bind(11, { source: 'create' });
    expect(numbers(prs)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(prs[0]).toEqual(seeded[0]);
    expect(await read()).toEqual(prs);
  });

  it('waits for a foreign file-lock holder before mutating', async () => {
    // The lock must reach ACROSS processes: a writer holding the sidecar's
    // proper-lockfile lock (daemon sweep vs. binding session child, either way)
    // delays the mutation until release instead of interleaving with it.
    await bind(41);
    const release = await lockfile.lock(filePath, { retries: 0 });
    await expectBindWaitsFor(release, [41, 42]);
  });

  it('persists a binding when a foreign holder unlinks the sidecar before releasing', async () => {
    // Regression: a holder whose mutation wrote nothing unlinked the empty file
    // the lock had materialized; an acquisition that resolved the realpath
    // before retrying failed ENOENT and lost the queued binding. The lock is
    // path-based now: the file need not exist when the lock lands.
    await bind(41);
    const release = await lockfile.lock(filePath, { retries: 0 });
    const pending = bind(42);
    await sleep(30);
    await fs.unlink(filePath);
    await release();
    const prs = await pending;
    expect(numbers(prs)).toEqual([42]);
    expect(await read()).toEqual(prs);
  });

  it('locks an absent sidecar without materializing it', async () => {
    // The holder locks the canonical path (where a realpath-resolving holder's
    // lock lands too). While the mutation waits no empty file may appear: a
    // session that never binds must not accumulate stray sidecars, and a
    // concurrent reader must see "no bindings", not an empty file.
    const canonical = path.join(
      await fs.realpath(tmpDir),
      path.basename(filePath),
    );
    const release = await lockfile.lock(canonical, {
      realpath: false,
      retries: 0,
    });
    await expectBindWaitsFor(release, [42], () =>
      expect(existsSync(filePath)).toBe(false),
    );
  });

  it('serializes concurrent upserts so no binding is dropped', async () => {
    // Without the per-path queue, interleaved read-modify-write cycles let a
    // later writer overwrite an earlier binding (read [] → read [] → write [A]
    // → write [B]).
    await Promise.all([bind(100), bind(101), bind(102)]);
    expect(numbers(await read())).toEqual([100, 101, 102]);
  });

  it('rejects an over-long URL at the write boundary', async () => {
    // The read side rejects the WHOLE list on one invalid entry, so a poisoned
    // write would erase every earlier binding from the badge and the refresh
    // sweep; the write boundary must decline it.
    await bind(41);
    const poisoned = await bind(42, {
      url: `https://github.com/owner/repo/pull/${'9'.repeat(
        SESSION_PR_URL_MAX_LENGTH,
      )}`,
    });
    expect(numbers(poisoned)).toEqual([41]);
    await bind(43);
    expect(numbers(await read())).toEqual([41, 43]);
  });

  it('rejects a control-character URL at the write boundary', async () => {
    await bind(51);
    const poisoned = await bind(52, {
      url: 'https://github.com/owner/repo/pull/52\u001b[forged',
    });
    expect(numbers(poisoned)).toEqual([51]);
    expect(await read()).not.toBeNull();
  });

  it('lets an explicitly supplied source win over the persisted one', async () => {
    // Backfill binds transcript-mentioned PRs as reviews (authority 0); a
    // later explicit bind of the same number must upgrade the provenance —
    // the persisted source survives only a re-bind that does not name one.
    await seed({ ...entry(10), source: 'review' });
    const prs = await bind(10, { state: 'open', source: 'create' });
    expect(prs[0]?.source).toBe('create');
    expect((await read())?.[0]?.source).toBe('create');
  });

  it('never downgrades the persisted provenance on a weaker explicit source', async () => {
    // The worktree convention binding names the PR the session exists for;
    // a client-driven metadata re-bind stamping 'create' must not drop it
    // into the rank the tail cap evicts first.
    await seed({ ...entry(42), source: 'worktree' });
    const prs = await bind(42, { state: 'open', source: 'create' });
    expect(prs[0]?.source).toBe('worktree');
    expect((await read())?.[0]?.source).toBe('worktree');
  });

  it('re-bind of the same PR moves it to latest with a fresh createdAt', async () => {
    // A re-bind is a fresh binding (latest slot, new createdAt): the backfill
    // cap planner needs that to tell a concurrent re-bind from an untouched
    // snapshot entry. State-only refreshes (updateSessionPrStates) keep order.
    await seed({ ...entry(100), state: 'open' }, entry(101));
    const prs = await bind(100, { state: 'merged' });
    expect(numbers(prs)).toEqual([101, 100]);
    expect(prs[1]?.state).toBe('merged');
    expect(prs[1]?.createdAt).not.toBe(entry(100).createdAt);
    expect(await read()).toEqual(prs);
  });
});

describe('upsertSessionPr failure handling', () => {
  it('surfaces the failure to the caller without leaking an unhandled rejection', async () => {
    // The queue cleanup chain derives from the upsert promise; a derived
    // finally/catch would reject unhandled on every sidecar I/O failure even
    // though callers await the returned promise.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      // filePath does not exist and its would-be parent path component is a
      // regular file once created below, so both the read (ENOTDIR) and any
      // mkdir/write fail.
      await fs.writeFile(filePath, 'blocker', 'utf-8');
      const blockedPath = path.join(filePath, 'nested.pr.json');
      await expect(upsertSessionPr(blockedPath, cand(1))).rejects.toThrow();
      // Give the rejection a turn to be reported as unhandled if the
      // cleanup chain does not absorb it.
      await sleep(20);
      expect(unhandled).toHaveLength(0);
      // A failed predecessor must not wedge the queue: a retry of the same
      // (still blocked) path gets its own rejection instead of hanging behind
      // the dead predecessor, and other paths keep working.
      await expect(upsertSessionPr(blockedPath, cand(2))).rejects.toThrow();
      const recovered = path.join(tmpDir, 'recovered.pr.json');
      await expect(upsertSessionPr(recovered, cand(3))).resolves.toHaveLength(
        1,
      );
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('upsertSessionPr state', () => {
  it('persists an explicit state', async () => {
    const prs = await bind(100, { state: 'open' });
    expect(prs[0]?.state).toBe('open');
    expect(await read()).toEqual(prs);
  });

  it('preserves the known state on a stateless re-bind', async () => {
    await bind(100, { state: 'merged' });
    const prs = await bind(100);
    expect(prs).toHaveLength(1);
    expect(prs[0]?.state).toBe('merged');
  });

  it('does not inherit state across a URL change', async () => {
    // The same number in another repository is another PR: inheriting the
    // previous entry's terminal 'merged' would poison the new binding
    // permanently — the sweep never re-queries merged entries.
    await seed({ ...entry(5), state: 'merged' });
    const prs = await bind(5, { url: pull('other/repo', 5) });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.url).toBe(pull('other/repo', 5));
    expect(prs[0]?.state).toBeUndefined();
    expect((await read())?.[0]?.state).toBeUndefined();
  });
});

describe('upsertSessionPrs', () => {
  const offer = (...candidates: Parameters<typeof upsertSessionPrs>[1]) =>
    upsertSessionPrs(filePath, candidates);
  const offers = (...ns: number[]) => offer(...ns.map((n) => cand(n)));
  /** PR 5 bound in repo-a on 2026-08-01 with `source`. */
  const repoA5 = (source: SessionPr['source']): SessionPr => ({
    number: 5,
    url: pull('repo-a/r', 5),
    createdAt: '2026-08-01T00:00:00.000Z',
    source,
  });

  it('leaves same-URL already-bound numbers untouched (position and createdAt)', async () => {
    await seed(entry(100), entry(101));
    const result = await offers(100, 102);
    expect(result.added).toEqual([102]);
    expect(result.alreadyBound).toEqual([100]);
    const persisted = await read();
    expect(numbers(persisted)).toEqual([100, 101, 102]);
    expect(persisted?.[0]).toEqual(entry(100));
  });

  it('re-binds a number whose persisted entry points at another repository', async () => {
    // Same number, other repo = another PR: a gh-verified create colliding
    // with another repo's binding must replace it (fresh createdAt, source
    // upgrade, no state carry-over), not be dropped on the bare number.
    const foreign = repoA5('review');
    await seed(foreign);
    const result = await offer(
      cand(5, { url: pull('repo-b/r', 5), state: 'open', source: 'create' }),
    );
    expect(result.added).toEqual([5]);
    expect(result.alreadyBound).toEqual([]);
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0]).toMatchObject({
      number: 5,
      url: pull('repo-b/r', 5),
      state: 'open',
      source: 'create',
    });
    expect(result.prs[0]?.createdAt).not.toBe(foreign.createdAt);
    expect(await read()).toEqual(result.prs);
  });

  it('never carries provenance across a URL change', async () => {
    // The replaced entry's source belongs to the PR it named (create over a
    // foreign worktree binding is `create`, review over a foreign create is
    // `review`): the singular upsert's boundary too (match = number AND url).
    await seed(repoA5('worktree'));
    for (const [repo, source] of [
      ['repo-b', 'create'],
      ['repo-c', 'review'],
    ] as const) {
      const url = pull(`${repo}/r`, 5);
      const result = await offer({ number: 5, url, source });
      expect(result.prs[0]).toMatchObject({ url, source });
    }
    const unstamped = await offer(cand(5, { url: pull('repo-d/r', 5) }));
    expect(unstamped.prs[0]?.source).toBeUndefined();
  });

  it('upgrades the source in place when a same-URL re-offer is stronger', async () => {
    // Backfill binds a reviewed number, then finds the session exists for it
    // (worktree convention): the re-offer upgrades the provenance WITHOUT
    // moving the entry or refreshing createdAt, so the badge's binding-time
    // order is never falsified.
    const reviewed: SessionPr = { ...entry(42), source: 'review' };
    await seed(entry(41), reviewed);
    const result = await offer(cand(42, { source: 'worktree' }));
    expect(result.added).toEqual([]);
    expect(result.alreadyBound).toEqual([42]);
    expect(numbers(result.prs)).toEqual([41, 42]);
    expect(result.prs[1]).toEqual({ ...reviewed, source: 'worktree' });
    expect(await read()).toEqual(result.prs);
  });

  it('caps the merged list once, keeping the newest entries', async () => {
    await seed(...fullList());
    const result = await offers(101, 102);
    expect(result.prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    // The single capped write drops the oldest seeded entries; the new
    // bindings survive at the tail.
    expect(numbers(result.prs)).toEqual([
      ...Array.from({ length: SESSION_PR_LIST_LIMIT - 2 }, (_, i) => i + 3),
      101,
      102,
    ]);
    expect(result.added).toEqual([101, 102]);
    // Seeded survivors keep their original createdAt.
    expect(result.prs[0]?.createdAt).toBe(entry(3).createdAt);
    expect(await read()).toEqual(result.prs);
  });

  it('keeps a binding a concurrent writer lands while the batch runs', async () => {
    // The batch reads INSIDE the locked mutation: a concurrently landed
    // binding is part of the read and survives the capped write.
    await seed(...fullList());
    await Promise.all([offers(101, 102), bind(999)]);
    const persisted = await read();
    expect(persisted).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(numbers(persisted)).toContain(999);
    expect(numbers(persisted)).toContain(101);
    expect(numbers(persisted)).toContain(102);
  });

  it('returns no write when every input number is already bound', async () => {
    await seed(entry(100));
    await expectUntouched(async () => {
      const result = await offers(100);
      expect(result.added).toEqual([]);
      expect(result.alreadyBound).toEqual([100]);
    });
  });

  it('evicts the oldest positions first among equally-ranked entries', async () => {
    // Pre-provenance entries all rank equal, so the cap drops the oldest
    // positions: being offered protects nothing, and an already-bound number
    // keeps its entry untouched only while it survives the rank.
    await seed(...fullList());
    const result = await offers(1, 11, 12);
    expect(result.added).toEqual([11, 12]);
    expect(result.alreadyBound).toEqual([1]);
    expect(numbers(result.prs)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.prs[0]).toEqual(entry(3));
    expect(await read()).toEqual(result.prs);
  });

  it('never evicts a created binding under an accumulation of reviewed numbers', async () => {
    // The created PR sits at the head while backfill keeps re-offering
    // reviewed numbers; once the list overflows, eviction by offered-or-not
    // would drop the never-re-offered created binding. Rank must protect it.
    await seed(...headThenReviews({ ...entry(100), source: 'create' }, 1));
    const result = await offer(
      ...Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) =>
        cand(i + 1, { source: 'review' }),
      ),
    );
    expect(result.added).toEqual([10]);
    expect(result.alreadyBound).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(numbers(result.prs)).toEqual([100, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.prs[0]?.source).toBe('create');
    expect(await read()).toEqual(result.prs);
  });

  it('keeps the convention binding when a create lands on a full list', async () => {
    // The shell hook offers a single created candidate; inserting it at the
    // cap must evict the weakest entry, not the head — the head is the
    // worktree convention binding the session exists for.
    const seeded = headThenReviews({ ...entry(7), source: 'worktree' }, 21);
    await seed(...seeded);
    const result = await offer(cand(42, { state: 'open', source: 'create' }));
    expect(result.added).toEqual([42]);
    expect(numbers(result.prs)).toEqual([
      7, 22, 23, 24, 25, 26, 27, 28, 29, 42,
    ]);
    expect(result.prs[0]).toEqual(seeded[0]);
  });

  it('drops a weak candidate instead of displacing strong bindings at the cap', async () => {
    await seed(
      ...fullList().map((pr) => ({ ...pr, source: 'create' as const })),
    );
    const result = await offer(cand(99, { source: 'review' }));
    expect(result.added).toEqual([]);
    expect(numbers(result.prs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('persists candidate source and preserves the source of already-bound numbers', async () => {
    const result = await offer(
      { number: 7, url: entry(7).url, source: 'worktree' },
      { number: 8, url: entry(8).url, source: 'review' },
    );
    expect(result.prs.map((p) => p.source)).toEqual(['worktree', 'review']);
    const reoffered = await offers(7);
    expect(reoffered.alreadyBound).toEqual([7]);
    expect(reoffered.prs[0]?.source).toBe('worktree');
  });

  it('leaves no stray sidecar when a batch writes nothing', async () => {
    // The lock is path-based and never materializes its target; a mutation
    // that ends without a write leaves nothing behind, or a session that
    // never bound a PR would accumulate an empty sidecar.
    const result = await offer({ number: 7 });
    expect(result.unresolved).toEqual([7]);
    expect(result.added).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });

  it('reports url-less candidates as unresolved, counting already-bound ones separately', async () => {
    await seed(entry(100));
    const result = await offer(
      { number: 7 },
      { number: 100 },
      { number: 8, url: entry(8).url },
    );
    expect(result.added).toEqual([8]);
    expect(result.alreadyBound).toEqual([100]);
    expect(result.unresolved).toEqual([7]);
    expect(numbers(result.prs)).toEqual([100, 8]);
    expect(await read()).toEqual(result.prs);
  });

  it('does not carry state onto a same-numbered PR of another repository', async () => {
    await bind(100, { url: pull('repo-a/owner', 100), state: 'merged' });
    const prs = await bind(100, { url: pull('repo-b/owner', 100) });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.url).toBe(pull('repo-b/owner', 100));
    expect(prs[0]?.state).toBeUndefined();
  });

  it('carries state when the re-bind spells the same PR differently', async () => {
    await bind(100, {
      url: 'https://github.com/Owner/Repo/pull/100/',
      state: 'merged',
    });
    const prs = await bind(100, {
      url: 'https://github.com/owner/repo/pull/100?v=2',
    });
    expect(prs[0]?.state).toBe('merged');
  });
});

describe('updateSessionPrStates', () => {
  it('rewrites states in place without touching order or createdAt', async () => {
    await seed(
      { ...entry(100), state: 'open' },
      { ...entry(101), state: 'open' },
    );
    const changed = await update(stamp(100, 'merged'), stamp(101, 'open'));
    // Only the entry whose state actually differs counts as rewritten.
    expect(changed).toBe(1);
    const persisted = await read();
    expect(numbers(persisted)).toEqual([100, 101]);
    expect(persisted?.[0]?.state).toBe('merged');
    expect(persisted?.[0]?.createdAt).toBe(entry(100).createdAt);
    expect(persisted?.[1]?.state).toBe('open');
  });

  it('returns 0 without writing when nothing changes', async () => {
    await seed({ ...entry(100), state: 'merged' });
    await expectUntouched(async () => {
      expect(await update(stamp(100, 'merged'))).toBe(0);
    });
  });

  it('returns 0 when the sidecar is absent', async () => {
    expect(await update(stamp(100, 'merged'))).toBe(0);
  });

  it('skips an entry re-bound to another URL between the sweep read and the stamp', async () => {
    // The sweep reads sidecars before its gh round-trip and writes after it;
    // a same-number re-bind to another repo in that window must not get the
    // stale repo's state. A wrong 'merged' is terminal: merged entries are
    // never re-queried, so the badge would stay wrong.
    await seed({ ...entry(5), state: 'open' });
    await bind(5, {
      url: pull('other/repo', 5),
      state: 'open',
      source: 'create',
    });
    expect(await update(stamp(5, 'merged'))).toBe(0);
    const persisted = await read();
    expect(persisted?.[0]?.url).toBe(pull('other/repo', 5));
    expect(persisted?.[0]?.state).toBe('open');
  });

  it('serializes against a concurrent upsert on the same sidecar', async () => {
    await seed({ ...entry(100), state: 'open' });
    const [changed, prs] = await Promise.all([
      update(stamp(100, 'merged')),
      bind(101),
    ]);
    expect(changed).toBe(1);
    expect(numbers(prs)).toEqual([100, 101]);
    // Whichever ran second read the first's write — nothing was clobbered.
    const persisted = await read();
    expect(persisted?.find((p) => p.number === 100)?.state).toBe('merged');
    expect(persisted?.find((p) => p.number === 101)).toBeDefined();
  });

  it('applies a fetched state only when its url matches the entry', async () => {
    // The map is keyed by number but the metadata route accepts any http(s)
    // url: a binding to another repo must never pick up this repo's
    // same-numbered state (a wrong terminal state is permanent: merged
    // entries leave the sweep).
    await seed({ ...entry(100), state: 'open' });
    const updated = await update(
      stamp(100, 'merged', pull('other-org/other-repo', 100)),
    );
    expect(updated).toBe(0);
    expect((await read())?.[0]?.state).toBe('open');
  });

  it('refreshes a binding whose url is canonical-equivalent to the fetched one', async () => {
    // Binding urls keep the user's remote casing (backfill's remote fallback)
    // or dialog spelling variants while gh returns the canonical spelling;
    // repo paths are case-insensitive, so a byte comparison would skip the
    // entry on every sweep and it would never reach merged.
    await seed({
      ...entry(100),
      url: 'https://github.com/OWNER/REPO/pull/100/?v=2',
      state: 'open',
    });
    expect(await update(stamp(100, 'merged'))).toBe(1);
    expect((await read())?.[0]?.state).toBe('merged');
  });

  it('does not resurrect a sidecar deleted between the queued read and the write commit', async () => {
    // Deletion and archive moves unlink the sidecar outside the queue. Force
    // the race: the deletion lands as the queued read resolves, so only the
    // commit-step guard can still stop the stale write.
    await seed({ ...entry(100), state: 'open' });
    const raw = await readRaw();
    fsMocks.readFile.mockImplementationOnce(async () => {
      await fs.unlink(filePath);
      return raw;
    });
    await expect(
      updateSessionPrStates(filePath, new Map([stamp(100, 'merged')]), {
        assertCanCommit: () => {
          if (!existsSync(filePath)) {
            throw new Error('sidecar vanished during refresh');
          }
        },
      }),
    ).rejects.toThrow('sidecar vanished during refresh');
    expect(existsSync(filePath)).toBe(false);
    // The rejected write must not wedge the queue for later mutations.
    expect(numbers(await bind(101))).toEqual([101]);
  });
});

describe('replaceSessionPrs', () => {
  it('runs the planner against the freshest list inside the queue', async () => {
    // The planner must see the result of mutations queued ahead of it —
    // planning from a stale outer read would clobber a binding that lands
    // between the caller's read and write.
    await seed(entry(100));
    const seen: number[][] = [];
    const upsert = bind(101);
    const replace = replaceSessionPrs(filePath, (existing) => {
      seen.push(existing.map((p) => p.number));
      return [...existing, entry(102)];
    });
    await Promise.all([upsert, replace]);
    expect(seen).toEqual([[100, 101]]);
    expect(numbers(await read())).toEqual([100, 101, 102]);
  });

  it('leaves the file untouched when the planner returns null', async () => {
    await seed(entry(100));
    await expectUntouched(async () => {
      expect(await replaceSessionPrs(filePath, () => null)).toBeNull();
    });
  });

  it('persists the planner result and returns it', async () => {
    await seed(entry(100));
    const persisted = await replaceSessionPrs(filePath, (existing) =>
      existing.filter((p) => p.number !== 100),
    );
    expect(persisted).toEqual([]);
    // An empty list reads back as null (isValidSessionPrList rejects it).
    expect(await read()).toBeNull();
  });

  it('declines entries the reader would reject instead of poisoning the list', async () => {
    // The reader fails the WHOLE list closed on one invalid entry, so a
    // planner that lets a transcript-sourced url through unchecked would
    // erase every other binding on the next read.
    await seed(entry(100));
    const persisted = await replaceSessionPrs(filePath, (existing) => [
      ...existing,
      {
        ...entry(101),
        url: `https://github.com/o/r/pull/${'1'.repeat(SESSION_PR_URL_MAX_LENGTH)}`,
      },
      { ...entry(102), url: 'https://github.com/o/r/pull/102\u0007' },
      entry(103),
    ]);
    expect(numbers(persisted)).toEqual([100, 103]);
    expect(await read()).toEqual(persisted);
    // A plan made only of declined entries leaves the file untouched.
    await expectUntouched(async () => {
      expect(
        await replaceSessionPrs(filePath, () => [
          { ...entry(104), url: 'ftp://x' },
        ]),
      ).toBeNull();
    });
  });
});

describe('mergeSessionPrLists', () => {
  it('keeps the stronger source across a same-PR split-pair merge', () => {
    // The shell binder stamped `create` on one half of a split pair; a later
    // `/review` backfill re-bound the other half as `review` with a fresh
    // createdAt. The freshest entry survives (the badge renders recency) but
    // provenance must not downgrade, or the authority cap would evict the
    // session's own created binding first.
    const created: SessionPr = {
      number: 5,
      url: pull('o/r', 5),
      createdAt: '2026-08-01T00:00:00.000Z',
      source: 'create',
    };
    const reviewed: SessionPr = {
      number: 5,
      url: pull('o/r', 5),
      createdAt: '2026-08-02T00:00:00.000Z',
      source: 'review',
    };
    for (const [base, incoming] of [
      [[created], [reviewed]],
      [[reviewed], [created]],
    ] as const) {
      const merged = mergeSessionPrLists([...base], [...incoming]);
      expect(merged).toEqual([{ ...reviewed, source: 'create' }]);
    }
    // A same-numbered PR of another repository is another PR: nothing
    // carries across the URL change.
    const foreign: SessionPr = { ...reviewed, url: pull('other/r', 5) };
    expect(mergeSessionPrLists([created], [foreign])).toEqual([foreign]);
  });

  it('keeps a split-pair created binding through the authority cap', () => {
    const created: SessionPr = {
      number: 100,
      url: pull('o/r', 100),
      createdAt: '2026-08-01T00:00:00.000Z',
      source: 'create',
    };
    const reviews: SessionPr[] = Array.from(
      { length: SESSION_PR_LIST_LIMIT },
      (_, i) => ({
        number: i + 1,
        url: `https://github.com/o/r/pull/${i + 1}`,
        createdAt: `2026-08-03T00:00:0${i}.000Z`.slice(0, 24),
        source: 'review' as const,
      }),
    );
    const rebound: SessionPr = {
      ...created,
      createdAt: '2026-08-02T00:00:00.000Z',
      source: 'review',
    };
    const merged = mergeSessionPrLists([created, ...reviews], [rebound]);
    expect(merged).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(merged.find((p) => p.number === 100)).toMatchObject({
      source: 'create',
      createdAt: rebound.createdAt,
    });
  });

  /** An entry for `number` bound at `2026-08-20T<time>.000Z`. */
  const at = (number: number, time: string, url?: string): SessionPr => ({
    number,
    url: url ?? `https://github.com/owner/repo/pull/${number}`,
    createdAt: `2026-08-20T${time}.000Z`,
  });

  it('unions disjoint lists in binding-time order', () => {
    const merged = mergeSessionPrLists(
      [at(100, '00:00:00')],
      [at(101, '01:00:00')],
    );
    expect(numbers(merged)).toEqual([100, 101]);
  });

  it('dedupes by number, keeping the freshest entry', () => {
    const merged = mergeSessionPrLists(
      [at(100, '00:00:00', 'https://old.example/100')],
      [at(100, '01:00:00', 'https://new.example/100')],
    );
    expect(merged).toEqual([at(100, '01:00:00', 'https://new.example/100')]);
  });

  it('orders by binding time regardless of which side an entry came from', () => {
    const merged = mergeSessionPrLists(
      [at(102, '02:00:00')],
      [at(101, '01:00:00')],
    );
    expect(numbers(merged)).toEqual([101, 102]);
  });

  it('caps the merged list, dropping the oldest', () => {
    const base = Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) =>
      at(i + 1, `00:00:${String(i).padStart(2, '0')}`),
    );
    const merged = mergeSessionPrLists(base, [
      at(SESSION_PR_LIST_LIMIT + 1, '01:00:00'),
    ]);
    expect(merged).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(merged[0]?.number).toBe(2);
    expect(merged[merged.length - 1]?.number).toBe(SESSION_PR_LIST_LIMIT + 1);
  });
});

describe('commandRunsGhPrCreate', () => {
  const runs = commandRunsGhPrCreate;

  it('matches a bare gh pr create segment', () => {
    expect(runs('gh pr create --title x --body y')).toBe(true);
    expect(runs('cd /w && gh pr create --fill')).toBe(true);
  });

  it('matches wrapped commands, env prefixes, and pipes', () => {
    expect(runs('cd /w && gh.exe pr create --fill')).toBe(true);
    expect(runs('GH_TOKEN=x gh pr create --fill | tee log')).toBe(true);
  });

  it('matches a gh pr create on a later line of a multi-line command', () => {
    expect(runs('git push -u origin HEAD\ngh pr create --fill')).toBe(true);
    expect(runs('git push -u origin HEAD\r\ngh pr create --fill')).toBe(true);
  });

  it('matches wrapper prefixes, path-qualified binaries, and the new alias', () => {
    expect(runs('sudo gh pr create --fill')).toBe(true);
    expect(runs('sudo -u runner gh pr create --fill')).toBe(true);
    expect(runs('env GITHUB_TOKEN=x gh pr create --fill')).toBe(true);
    expect(runs('nohup gh pr create --fill')).toBe(true);
    expect(runs('/usr/bin/gh pr create --fill')).toBe(true);
    expect(runs('~/bin/gh.cmd pr create --fill')).toBe(true);
    expect(runs('gh pr new --fill')).toBe(true);
  });

  it('returns false when the command is not gh pr create', () => {
    expect(runs('gh pr view 1')).toBe(false);
    expect(runs('git commit -m gh')).toBe(false);
    // The phrase as a search argument is not an execution.
    expect(runs(`grep -rn 'gh pr create' .`)).toBe(false);
  });

  it('matches any path-qualified gh spelling', () => {
    expect(runs('./gh pr create --fill')).toBe(true);
    expect(runs('bin/gh pr create --fill')).toBe(true);
    expect(runs('$HOME/bin/gh pr create --fill')).toBe(true);
    expect(runs('C:\\tools\\gh.exe pr create --fill')).toBe(true);
    expect(runs('\\\\srv\\share\\gh.exe pr create --fill')).toBe(true);
    // A path that does not END in gh is not the binary.
    expect(runs('bin/ghx pr create --fill')).toBe(false);
    expect(runs('/usr/bin/git pr create')).toBe(false);
  });

  it('matches nested wrapper chains', () => {
    expect(runs('sudo env GH_TOKEN=x gh pr create')).toBe(true);
    expect(runs('sudo -u runner env -i GH_TOKEN=x nohup gh pr create')).toBe(
      true,
    );
    expect(runs('command env gh pr create --fill')).toBe(true);
  });

  it('fails closed on shapes outside the grammar', () => {
    // Documented limitation: the gate's grammar is a closed set. These
    // creates still run; only the binding is skipped.
    expect(runs('timeout 60 gh pr create --fill')).toBe(false);
    expect(runs('bash -c "gh pr create --fill"')).toBe(false);
    expect(runs('GH_TOKEN="a b" gh pr create --fill')).toBe(false);
    expect(runs('(gh pr create --fill)')).toBe(false);
    expect(runs('gh pr \\\ncreate --fill')).toBe(false);
  });
});

describe('ghPrCreateInlineEnv', () => {
  /** Asserts the env `ghPrCreateInlineEnv` extracts (`toEqual`, or `toBeUndefined`). */
  const expectEnv = (
    command: string,
    expected?: Record<string, string | undefined>,
  ) => {
    if (expected === undefined) {
      expect(ghPrCreateInlineEnv(command)).toBeUndefined();
    } else {
      expect(ghPrCreateInlineEnv(command)).toEqual(expected);
    }
  };
  const withEnv = (name: string, value: string, run: () => void) => {
    process.env[name] = value;
    try {
      run();
    } finally {
      delete process.env[name];
    }
  };

  it('extracts leading GH_* and GITHUB_* assignments', () => {
    expectEnv('GH_TOKEN=x gh pr create --fill', { GH_TOKEN: 'x' });
    expectEnv('env GITHUB_TOKEN=y gh pr create --fill', { GITHUB_TOKEN: 'y' });
  });

  it('skips wrapper flags and their values', () => {
    expectEnv('sudo -u runner GH_TOKEN=x gh pr create --fill', {
      GH_TOKEN: 'x',
    });
  });

  it('reads the segment that runs the create', () => {
    expectEnv('git push\nGH_TOKEN=x gh pr create --fill', { GH_TOKEN: 'x' });
  });

  it('returns undefined when the create carries no gh credentials', () => {
    expectEnv('gh pr create --fill');
    expectEnv('FOO=bar gh pr create --fill');
    expectEnv('git push');
  });

  it('skips non-GH assignments instead of stopping at them', () => {
    expectEnv('FOO=bar GH_TOKEN=x gh pr create --fill', { GH_TOKEN: 'x' });
  });

  it('lets a later gate-matching segment supply the credentials', () => {
    // A non-creating gate-matching segment before the real create must not
    // shadow the later segment's token.
    expectEnv('gh pr create --web; GH_TOKEN=t2 gh pr create --fill', {
      GH_TOKEN: 't2',
    });
  });

  it('collects exported GH_* assignments from earlier segments', () => {
    expectEnv('export GH_TOKEN=ghp_x; gh pr create --fill', {
      GH_TOKEN: 'ghp_x',
    });
    expectEnv('export GH_TOKEN=ghp_x && gh pr create --fill', {
      GH_TOKEN: 'ghp_x',
    });
    expectEnv('export GH_TOKEN=ghp_x\ngit push');
    expectEnv('export FOO=bar GH_TOKEN=x; gh pr create --fill', {
      GH_TOKEN: 'x',
    });
  });

  it('ignores an export that follows the create', () => {
    // `gh pr create --fill; export GH_TOKEN=late` ran the create WITHOUT the
    // token; attributing the later export would authenticate the legs
    // differently from the create.
    expectEnv('gh pr create --fill; export GH_TOKEN=late');
    expectEnv(
      'export GH_TOKEN=early; gh pr create --fill; export GH_TOKEN=late',
      { GH_TOKEN: 'early' },
    );
  });

  it('models the removal side: unset, env -u, env -i', () => {
    // A removal is recorded as `undefined`: the legs must shed the ambient
    // credential the create explicitly shed.
    expectEnv('export GH_TOKEN=x; unset GH_TOKEN; gh pr create', {
      GH_TOKEN: undefined,
    });
    expectEnv('unset GH_TOKEN; gh pr create --fill', { GH_TOKEN: undefined });
    expectEnv('env -u GH_TOKEN gh pr create --fill', { GH_TOKEN: undefined });
    // `env -u` of a non-GH name is not a credential change.
    expectEnv('env -u PAGER gh pr create --fill');
    // `env -i` starts from an empty environment: every ambient GH
    // credential is dropped, and the inline one after it survives.
    withEnv('GH_QWEN_TEST_AMBIENT', 'ambient', () => {
      expect(
        ghPrCreateInlineEnv('env -i GH_TOKEN=x gh pr create --fill'),
      ).toMatchObject({ GH_QWEN_TEST_AMBIENT: undefined, GH_TOKEN: 'x' });
    });
  });

  it('collects through nested wrappers', () => {
    expectEnv('sudo env GH_TOKEN=x nohup gh pr create --fill', {
      GH_TOKEN: 'x',
    });
  });

  it('leaves parameter-expansion operators and substitutions literal', () => {
    // `${VAR:-default}` cannot be evaluated here and a wrong guess must not
    // authenticate the legs: the value stays literal (gh fails the legs and
    // the binding is declined, like `$(…)`).
    withEnv('QWEN_TEST_GH_SECRET', 's3cret', () => {
      expectEnv('GH_TOKEN=${QWEN_TEST_GH_SECRET:-fallback} gh pr create', {
        GH_TOKEN: '${QWEN_TEST_GH_SECRET:-fallback}',
      });
      expectEnv('GH_TOKEN=$(gh auth token) gh pr create');
    });
  });

  it('expands quoted and $VAR values the way the child shell would', () => {
    withEnv('QWEN_TEST_GH_SECRET', 's3cret', () => {
      expectEnv('GH_TOKEN="$QWEN_TEST_GH_SECRET" gh pr create', {
        GH_TOKEN: 's3cret',
      });
      expectEnv('GH_TOKEN=${QWEN_TEST_GH_SECRET} gh pr create', {
        GH_TOKEN: 's3cret',
      });
      // Single quotes suppress expansion in the shell too.
      expectEnv("GH_TOKEN='${QWEN_TEST_GH_SECRET}' gh pr create", {
        GH_TOKEN: '${QWEN_TEST_GH_SECRET}',
      });
    });
  });

  it('ignores assignments after the binary (gh arguments)', () => {
    expectEnv('gh pr create --title GH_TOKEN=x');
  });
});

describe('moveSessionPrSidecar', () => {
  let sourcePath: string;
  let destinationPath: string;

  beforeEach(() => {
    sourcePath = path.join(tmpDir, 'active', 's.pr.json');
    destinationPath = path.join(tmpDir, 'archived', 's.pr.json');
  });

  const expectSourceGone = () => expect(fs.stat(sourcePath)).rejects.toThrow();
  /** Moves while a lock is held: nothing may move until `release`. */
  async function expectMoveWaitsFor(release: () => Promise<void>) {
    const movePromise = moveSessionPrSidecar(sourcePath, destinationPath);
    await sleep(150);
    expect(await readSessionPrs(sourcePath)).toEqual([entry(1)]);
    expect(await readSessionPrs(destinationPath)).toBeNull();
    await release();
    await movePromise;
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expectSourceGone();
  }

  it('renames the sidecar when the destination is free', async () => {
    await writeSessionPrs(sourcePath, [entry(1)]);
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expectSourceGone();
  });

  it('merges a split pair instead of clobbering either half', async () => {
    await writeSessionPrs(sourcePath, [entry(1)]);
    await writeSessionPrs(destinationPath, [entry(2)]);
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(numbers(await readSessionPrs(destinationPath))).toEqual([2, 1]);
    await expectSourceGone();
  });

  it('does nothing when the source is absent', async () => {
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(await readSessionPrs(destinationPath)).toBeNull();
    // Neither endpoint may appear: a no-op move (every archive/restore of a
    // session that never bound a PR) must not materialize an empty sidecar.
    expect(existsSync(destinationPath)).toBe(false);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it('waits for a lock held on the destination before moving', async () => {
    // The move must serialize against pending mutations on BOTH endpoints:
    // a binder write landing on the destination mid-transition must not be
    // clobbered by the merge write.
    await writeSessionPrs(sourcePath, [entry(1)]);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, '', 'utf-8');
    await expectMoveWaitsFor(await lockfile.lock(destinationPath));
  });

  it('waits for a held sidecar lock before moving', async () => {
    // The move runs under the cross-process lock: while another holder
    // keeps the source locked, no binding may be relocated — an unlocked
    // move would merge and unlink the source immediately.
    await writeSessionPrs(sourcePath, [entry(1)]);
    await expectMoveWaitsFor(await lockfile.lock(sourcePath));
  });
});

describe('issue snapshot', () => {
  const issue = (number: number) => ({
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    state: 'open' as const,
  });

  it('round-trips issues on an entry', async () => {
    const prs = [{ ...entry(100), issues: [issue(7)] }];
    await writeSessionPrs(filePath, prs);
    expect(await read()).toEqual(prs);
  });

  it('voids the sidecar on a malformed or oversized issue list', async () => {
    // The issue url is rendered as a link target exactly like the PR url.
    for (const issues of [
      [{ number: 7, url: 'javascript:x' }],
      [{ ...issue(7), state: 'merged' }],
      Array.from({ length: 11 }, (_, index) => issue(index + 1)),
    ]) {
      await fs.writeFile(
        filePath,
        JSON.stringify({ prs: [{ ...entry(100), issues }] }),
      );
      expect(await read()).toBeNull();
    }
  });

  it('keeps the snapshot on a re-bind of the same PR only', async () => {
    await seed({ ...entry(100), state: 'open', issues: [issue(7)] });
    expect((await bind(100))[0]?.issues).toEqual([issue(7)]);
    const other = await bind(100, { url: pull('other/repo', 100) });
    expect(other[0]?.issues).toBeUndefined();
  });

  it('updateSessionPrStates writes issues with or without a state', async () => {
    await seed(
      { ...entry(100), state: 'open' },
      { ...entry(101), state: 'merged' },
    );
    const updated = await update(
      [100, { state: 'merged', url: entry(100).url, issues: [issue(7)] }],
      [101, { url: entry(101).url, issues: [] }],
    );
    expect(updated).toBe(2);
    const persisted = await read();
    expect(persisted?.[0]).toMatchObject({
      state: 'merged',
      issues: [issue(7)],
      createdAt: entry(100).createdAt,
    });
    // An empty snapshot is still a snapshot ("fetched, none").
    expect(persisted?.[1]).toMatchObject({ state: 'merged', issues: [] });
  });

  it('updateSessionPrStates leaves issues alone when unchanged or omitted', async () => {
    await seed({ ...entry(100), state: 'open', issues: [issue(7)] });
    await expectUntouched(async () => {
      expect(
        await update([100, { url: entry(100).url, issues: [issue(7)] }]),
      ).toBe(0);
    });
    expect(await update(stamp(100, 'closed'))).toBe(1);
    expect((await read())?.[0]).toMatchObject({
      state: 'closed',
      issues: [issue(7)],
    });
  });

  it('updateSessionPrStates rewrites a changed issue state', async () => {
    await seed({ ...entry(100), state: 'merged', issues: [issue(7)] });
    expect(
      await update([
        100,
        {
          url: entry(100).url,
          issues: [{ ...issue(7), state: 'completed' as const }],
        },
      ]),
    ).toBe(1);
    expect((await read())?.[0]?.issues?.[0]?.state).toBe('completed');
  });
});
