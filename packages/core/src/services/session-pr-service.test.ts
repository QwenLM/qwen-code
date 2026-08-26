/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
  SESSION_PR_LIST_LIMIT,
  SESSION_PR_URL_MAX_LENGTH,
  commandRunsGhPrCreate,
  mergeSessionPrLists,
  moveSessionPrSidecar,
  readSessionPrs,
  updateSessionPrStates,
  upsertSessionPr,
  upsertSessionPrs,
  writeSessionPrs,
  type SessionPr,
} from './session-pr-service.js';

const entry = (number: number): SessionPr => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  createdAt: '2026-08-20T00:00:00.000Z',
});

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-pr-test-'));
  filePath = path.join(tmpDir, 'test.pr.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('writeSessionPrs / readSessionPrs', () => {
  it('round-trips a PR list', async () => {
    const prs = [entry(9517), entry(9519)];
    await writeSessionPrs(filePath, prs);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('creates missing parent directories on write', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'test.pr.json');
    await writeSessionPrs(nested, [entry(1)]);
    expect(await readSessionPrs(nested)).toEqual([entry(1)]);
  });
});

describe('readSessionPrs', () => {
  it('returns null when the file does not exist', async () => {
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(filePath, '{not json', 'utf-8');
    expect(await readSessionPrs(filePath)).toBeNull();
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
    expect(await readSessionPrs(filePath)).toBeNull();
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
  it('appends bindings in binding order', async () => {
    await upsertSessionPr(filePath, { number: 100, url: entry(100).url });
    const prs = await upsertSessionPr(filePath, {
      number: 101,
      url: entry(101).url,
    });
    expect(prs.map((p) => p.number)).toEqual([100, 101]);
  });

  it('re-binding the same number refreshes it and moves it to latest', async () => {
    await upsertSessionPr(filePath, { number: 100, url: entry(100).url });
    await upsertSessionPr(filePath, { number: 101, url: entry(101).url });
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/owner/repo/pull/100?updated=1',
    });
    expect(prs.map((p) => p.number)).toEqual([101, 100]);
    expect(prs[1]?.url).toContain('updated=1');
  });

  it('caps the list at SESSION_PR_LIST_LIMIT, dropping the oldest', async () => {
    for (let i = 1; i <= SESSION_PR_LIST_LIMIT + 2; i++) {
      await upsertSessionPr(filePath, {
        number: i,
        url: `https://github.com/owner/repo/pull/${i}`,
      });
    }
    const prs = await readSessionPrs(filePath);
    expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(prs?.[0]?.number).toBe(3);
    expect(prs?.[SESSION_PR_LIST_LIMIT - 1]?.number).toBe(
      SESSION_PR_LIST_LIMIT + 2,
    );
  });

  it('waits for a foreign file-lock holder before mutating', async () => {
    // The lock must reach ACROSS processes: another writer holding the
    // sidecar's proper-lockfile lock (the daemon sweep while the session
    // child binds, or vice versa) delays the mutation until release
    // instead of interleaving with it.
    await upsertSessionPr(filePath, { number: 41, url: entry(41).url });
    const release = await lockfile.lock(filePath, { retries: 0 });
    let resolved = false;
    const pending = upsertSessionPr(filePath, {
      number: 42,
      url: entry(42).url,
    }).then((prs) => {
      resolved = true;
      return prs;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resolved).toBe(false);
    await release();
    const prs = await pending;
    expect(prs.map((p) => p.number)).toEqual([41, 42]);
  });

  it('serializes concurrent upserts so no binding is dropped', async () => {
    // Without the per-path queue, interleaved read-modify-write cycles would
    // let a later writer overwrite an earlier binding (read [] → read [] →
    // write [A] → write [B]).
    await Promise.all([
      upsertSessionPr(filePath, { number: 100, url: entry(100).url }),
      upsertSessionPr(filePath, { number: 101, url: entry(101).url }),
      upsertSessionPr(filePath, { number: 102, url: entry(102).url }),
    ]);
    const prs = await readSessionPrs(filePath);
    expect(prs?.map((p) => p.number)).toEqual([100, 101, 102]);
  });

  it('rejects an over-long URL at the write boundary', async () => {
    // The read side rejects the WHOLE list when one entry is invalid, so a
    // poisoned write would erase every earlier binding from the badge and
    // the refresh sweep. The write boundary must decline it instead.
    await upsertSessionPr(filePath, { number: 41, url: entry(41).url });
    const poisoned = await upsertSessionPr(filePath, {
      number: 42,
      url: `https://github.com/owner/repo/pull/${'9'.repeat(
        SESSION_PR_URL_MAX_LENGTH,
      )}`,
    });
    expect(poisoned.map((p) => p.number)).toEqual([41]);
    await upsertSessionPr(filePath, { number: 43, url: entry(43).url });
    const prs = await readSessionPrs(filePath);
    expect(prs?.map((p) => p.number)).toEqual([41, 43]);
  });

  it('rejects a control-character URL at the write boundary', async () => {
    await upsertSessionPr(filePath, { number: 51, url: entry(51).url });
    const poisoned = await upsertSessionPr(filePath, {
      number: 52,
      url: 'https://github.com/owner/repo/pull/52\u001b[forged',
    });
    expect(poisoned.map((p) => p.number)).toEqual([51]);
    expect(await readSessionPrs(filePath)).not.toBeNull();
  });

  it('lets an explicitly supplied source win over the persisted one', async () => {
    // Backfill binds transcript-mentioned PRs as reviews (authority 0); a
    // later explicit bind of the same number must upgrade the provenance —
    // the persisted source survives only a re-bind that does not name one.
    await writeSessionPrs(filePath, [{ ...entry(10), source: 'review' }]);
    const prs = await upsertSessionPr(filePath, {
      number: 10,
      url: entry(10).url,
      state: 'open',
      source: 'create',
    });
    expect(prs[0]?.source).toBe('create');
    expect((await readSessionPrs(filePath))?.[0]?.source).toBe('create');
  });

  it('never downgrades the persisted provenance on a weaker explicit source', async () => {
    // The worktree convention binding names the PR the session exists for;
    // a client-driven metadata re-bind stamping 'create' must not drop it
    // into the rank the tail cap evicts first.
    await writeSessionPrs(filePath, [{ ...entry(42), source: 'worktree' }]);
    const prs = await upsertSessionPr(filePath, {
      number: 42,
      url: entry(42).url,
      state: 'open',
      source: 'create',
    });
    expect(prs[0]?.source).toBe('worktree');
    expect((await readSessionPrs(filePath))?.[0]?.source).toBe('worktree');
  });

  it('rewrites a same-URL refresh in place, keeping position and createdAt', async () => {
    // A state-only refresh of an existing binding is not a re-bind: moving
    // it to the tail with a fresh createdAt falsifies the binding-time
    // order the badge and archive merges render by.
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open' },
      entry(101),
    ]);
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
      state: 'merged',
    });
    expect(prs.map((p) => p.number)).toEqual([100, 101]);
    expect(prs[0]?.state).toBe('merged');
    expect(prs[0]?.createdAt).toBe(entry(100).createdAt);
    expect(await readSessionPrs(filePath)).toEqual(prs);
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
      await expect(
        upsertSessionPr(blockedPath, { number: 1, url: entry(1).url }),
      ).rejects.toThrow();
      // Give the rejection a turn to be reported as unhandled if the
      // cleanup chain does not absorb it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
      // A failed predecessor must not wedge the queue entry: the same path
      // can be retried (still failing here — the path is still blocked —
      // but with its own rejection, not hung behind the dead predecessor),
      // and other paths keep working.
      await expect(
        upsertSessionPr(blockedPath, { number: 2, url: entry(2).url }),
      ).rejects.toThrow();
      const recovered = path.join(tmpDir, 'recovered.pr.json');
      await expect(
        upsertSessionPr(recovered, { number: 3, url: entry(3).url }),
      ).resolves.toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('upsertSessionPr state', () => {
  it('persists an explicit state', async () => {
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
      state: 'open',
    });
    expect(prs[0]?.state).toBe('open');
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('preserves the known state on a stateless re-bind', async () => {
    await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
      state: 'merged',
    });
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.state).toBe('merged');
  });

  it('does not inherit state across a URL change', async () => {
    // The same number in another repository is another PR: inheriting the
    // previous entry's terminal 'merged' would poison the new binding
    // permanently — the sweep never re-queries merged entries.
    await writeSessionPrs(filePath, [{ ...entry(5), state: 'merged' }]);
    const prs = await upsertSessionPr(filePath, {
      number: 5,
      url: 'https://github.com/other/repo/pull/5',
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.url).toBe('https://github.com/other/repo/pull/5');
    expect(prs[0]?.state).toBeUndefined();
    expect((await readSessionPrs(filePath))?.[0]?.state).toBeUndefined();
  });
});

describe('upsertSessionPrs', () => {
  it('leaves already-bound numbers untouched (position and createdAt)', async () => {
    await writeSessionPrs(filePath, [entry(100), entry(101)]);
    const result = await upsertSessionPrs(filePath, [
      { number: 100, url: 'https://github.com/owner/repo/pull/100?v=2' },
      { number: 102, url: entry(102).url },
    ]);
    expect(result.added).toEqual([102]);
    expect(result.alreadyBound).toEqual([100]);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.map((p) => p.number)).toEqual([100, 101, 102]);
    expect(persisted?.[0]).toEqual(entry(100));
  });

  it('caps the merged list once, keeping the newest entries', async () => {
    const seeded = Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) =>
      entry(i + 1),
    );
    await writeSessionPrs(filePath, seeded);
    const result = await upsertSessionPrs(filePath, [
      { number: 101, url: entry(101).url },
      { number: 102, url: entry(102).url },
    ]);
    expect(result.prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    // The single capped write drops the oldest seeded entries; the new
    // bindings survive at the tail.
    expect(result.prs.map((p) => p.number)).toEqual([
      ...Array.from({ length: SESSION_PR_LIST_LIMIT - 2 }, (_, i) => i + 3),
      101,
      102,
    ]);
    expect(result.added).toEqual([101, 102]);
    // Seeded survivors keep their original createdAt.
    expect(result.prs[0]?.createdAt).toBe(entry(3).createdAt);
    expect(await readSessionPrs(filePath)).toEqual(result.prs);
  });

  it('keeps a binding a concurrent writer lands while the batch runs', async () => {
    // The batch reads INSIDE the locked mutation: a concurrently landed
    // binding is part of the read and survives the capped write.
    const seeded = Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) =>
      entry(i + 1),
    );
    await writeSessionPrs(filePath, seeded);
    await Promise.all([
      upsertSessionPrs(filePath, [
        { number: 101, url: entry(101).url },
        { number: 102, url: entry(102).url },
      ]),
      upsertSessionPr(filePath, { number: 999, url: entry(999).url }),
    ]);
    const persisted = await readSessionPrs(filePath);
    expect(persisted).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(persisted?.map((p) => p.number)).toContain(999);
    expect(persisted?.map((p) => p.number)).toContain(101);
    expect(persisted?.map((p) => p.number)).toContain(102);
  });

  it('returns no write when every input number is already bound', async () => {
    await writeSessionPrs(filePath, [entry(100)]);
    const before = await fs.readFile(filePath, 'utf-8');
    const result = await upsertSessionPrs(filePath, [
      { number: 100, url: entry(100).url },
    ]);
    expect(result.added).toEqual([]);
    expect(result.alreadyBound).toEqual([100]);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('evicts the oldest positions first among equally-ranked entries', async () => {
    // Entries persisted before provenance was recorded all rank equal, so
    // the cap drops the oldest positions — offered-or-not no longer
    // protects anything, and an already-bound number keeps its entry
    // untouched only while it survives the rank.
    const seeded = Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) =>
      entry(i + 1),
    );
    await writeSessionPrs(filePath, seeded);
    const result = await upsertSessionPrs(filePath, [
      { number: 1, url: entry(1).url },
      { number: 11, url: entry(11).url },
      { number: 12, url: entry(12).url },
    ]);
    expect(result.added).toEqual([11, 12]);
    expect(result.alreadyBound).toEqual([1]);
    expect(result.prs.map((p) => p.number)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(result.prs[0]).toEqual(entry(3));
    expect(await readSessionPrs(filePath)).toEqual(result.prs);
  });

  it('never evicts a created binding under an accumulation of reviewed numbers', async () => {
    // The session's created PR sits at the head while backfill runs keep
    // re-offering reviewed numbers; once the merged list overflows the
    // cap, eviction ranked by offered-or-not would drop the
    // never-re-offered created binding. Provenance rank must protect it.
    const seeded: SessionPr[] = [
      { ...entry(100), source: 'create' },
      ...Array.from({ length: SESSION_PR_LIST_LIMIT - 1 }, (_, i) => ({
        ...entry(i + 1),
        source: 'review' as const,
      })),
    ];
    await writeSessionPrs(filePath, seeded);
    const result = await upsertSessionPrs(
      filePath,
      Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) => ({
        number: i + 1,
        url: entry(i + 1).url,
        source: 'review' as const,
      })),
    );
    expect(result.added).toEqual([10]);
    expect(result.alreadyBound).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.prs.map((p) => p.number)).toEqual([
      100, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(result.prs[0]?.source).toBe('create');
    expect(await readSessionPrs(filePath)).toEqual(result.prs);
  });

  it('keeps the convention binding when a create lands on a full list', async () => {
    // The shell hook offers a single created candidate; inserting it at
    // the cap must evict the weakest entry, not the head — the head is
    // the worktree convention binding the session exists for.
    const seeded: SessionPr[] = [
      { ...entry(7), source: 'worktree' },
      ...Array.from({ length: SESSION_PR_LIST_LIMIT - 1 }, (_, i) => ({
        ...entry(i + 21),
        source: 'review' as const,
      })),
    ];
    await writeSessionPrs(filePath, seeded);
    const result = await upsertSessionPrs(filePath, [
      { number: 42, url: entry(42).url, state: 'open', source: 'create' },
    ]);
    expect(result.added).toEqual([42]);
    expect(result.prs.map((p) => p.number)).toEqual([
      7, 22, 23, 24, 25, 26, 27, 28, 29, 42,
    ]);
    expect(result.prs[0]).toEqual(seeded[0]);
  });

  it('drops a weak candidate instead of displacing strong bindings at the cap', async () => {
    const seeded: SessionPr[] = Array.from(
      { length: SESSION_PR_LIST_LIMIT },
      (_, i) => ({ ...entry(i + 1), source: 'create' as const }),
    );
    await writeSessionPrs(filePath, seeded);
    const result = await upsertSessionPrs(filePath, [
      { number: 99, url: entry(99).url, source: 'review' },
    ]);
    expect(result.added).toEqual([]);
    expect(result.prs.map((p) => p.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('persists candidate source and preserves the source of already-bound numbers', async () => {
    const result = await upsertSessionPrs(filePath, [
      { number: 7, url: entry(7).url, source: 'worktree' },
      { number: 8, url: entry(8).url, source: 'review' },
    ]);
    expect(result.prs.map((p) => p.source)).toEqual(['worktree', 'review']);
    const reoffered = await upsertSessionPrs(filePath, [
      { number: 7, url: entry(7).url },
    ]);
    expect(reoffered.alreadyBound).toEqual([7]);
    expect(reoffered.prs[0]?.source).toBe('worktree');
  });

  it('reports url-less candidates as unresolved, counting already-bound ones separately', async () => {
    await writeSessionPrs(filePath, [entry(100)]);
    const result = await upsertSessionPrs(filePath, [
      { number: 7 },
      { number: 100 },
      { number: 8, url: entry(8).url },
    ]);
    expect(result.added).toEqual([8]);
    expect(result.alreadyBound).toEqual([100]);
    expect(result.unresolved).toEqual([7]);
    expect(result.prs.map((p) => p.number)).toEqual([100, 8]);
    expect(await readSessionPrs(filePath)).toEqual(result.prs);
  });
});

describe('updateSessionPrStates', () => {
  const stamp = (number: number, state: 'open' | 'merged' | 'closed') => ({
    url: entry(number).url,
    state,
  });

  it('rewrites states in place without touching order or createdAt', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open' },
      { ...entry(101), state: 'open' },
    ]);
    const changed = await updateSessionPrStates(
      filePath,
      new Map([
        [100, stamp(100, 'merged')],
        [101, stamp(101, 'open')],
      ]),
    );
    // Only the entry whose state actually differs counts as rewritten.
    expect(changed).toBe(1);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.map((p) => p.number)).toEqual([100, 101]);
    expect(persisted?.[0]?.state).toBe('merged');
    expect(persisted?.[0]?.createdAt).toBe(entry(100).createdAt);
    expect(persisted?.[1]?.state).toBe('open');
  });

  it('returns 0 without writing when nothing changes', async () => {
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'merged' }]);
    const before = await fs.readFile(filePath, 'utf-8');
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, stamp(100, 'merged')]]),
      ),
    ).toBe(0);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('returns 0 when the sidecar is absent', async () => {
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, stamp(100, 'merged')]]),
      ),
    ).toBe(0);
  });

  it('skips an entry re-bound to another URL between the sweep read and the stamp', async () => {
    // The sweep reads sidecars before its gh round-trip and writes after
    // it. A concurrent re-bind of the same number to another repository
    // during that window must not receive the stale repo's state — a
    // wrong 'merged' stamp is terminal: merged entries are never queried
    // again, so the badge stays wrong permanently.
    await writeSessionPrs(filePath, [{ ...entry(5), state: 'open' }]);
    await upsertSessionPr(filePath, {
      number: 5,
      url: 'https://github.com/other/repo/pull/5',
      state: 'open',
      source: 'create',
    });
    const changed = await updateSessionPrStates(
      filePath,
      new Map([[5, stamp(5, 'merged')]]),
    );
    expect(changed).toBe(0);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]?.url).toBe('https://github.com/other/repo/pull/5');
    expect(persisted?.[0]?.state).toBe('open');
  });

  it('serializes against a concurrent upsert on the same sidecar', async () => {
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'open' }]);
    const [changed, prs] = await Promise.all([
      updateSessionPrStates(filePath, new Map([[100, stamp(100, 'merged')]])),
      upsertSessionPr(filePath, { number: 101, url: entry(101).url }),
    ]);
    expect(changed).toBe(1);
    expect(prs?.map((p) => p.number)).toEqual([100, 101]);
    // Whichever ran second read the first's write — nothing was clobbered.
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.find((p) => p.number === 100)?.state).toBe('merged');
    expect(persisted?.find((p) => p.number === 101)).toBeDefined();
  });
});

describe('mergeSessionPrLists', () => {
  const at = (number: number, createdAt: string, url?: string): SessionPr => ({
    number,
    url: url ?? `https://github.com/owner/repo/pull/${number}`,
    createdAt,
  });

  it('unions disjoint lists in binding-time order', () => {
    const merged = mergeSessionPrLists(
      [at(100, '2026-08-20T00:00:00.000Z')],
      [at(101, '2026-08-20T01:00:00.000Z')],
    );
    expect(merged.map((p) => p.number)).toEqual([100, 101]);
  });

  it('dedupes by number, keeping the freshest entry', () => {
    const merged = mergeSessionPrLists(
      [at(100, '2026-08-20T00:00:00.000Z', 'https://old.example/100')],
      [at(100, '2026-08-20T01:00:00.000Z', 'https://new.example/100')],
    );
    expect(merged).toEqual([
      at(100, '2026-08-20T01:00:00.000Z', 'https://new.example/100'),
    ]);
  });

  it('orders by binding time regardless of which side an entry came from', () => {
    const merged = mergeSessionPrLists(
      [at(102, '2026-08-20T02:00:00.000Z')],
      [at(101, '2026-08-20T01:00:00.000Z')],
    );
    expect(merged.map((p) => p.number)).toEqual([101, 102]);
  });

  it('caps the merged list, dropping the oldest', () => {
    const base = Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) =>
      at(i + 1, `2026-08-20T00:00:${String(i).padStart(2, '0')}.000Z`),
    );
    const incoming = [
      at(SESSION_PR_LIST_LIMIT + 1, '2026-08-20T01:00:00.000Z'),
    ];
    const merged = mergeSessionPrLists(base, incoming);
    expect(merged).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(merged[0]?.number).toBe(2);
    expect(merged[merged.length - 1]?.number).toBe(SESSION_PR_LIST_LIMIT + 1);
  });
});

describe('commandRunsGhPrCreate', () => {
  it('matches a bare gh pr create segment', () => {
    expect(commandRunsGhPrCreate('gh pr create --title x --body y')).toBe(true);
    expect(commandRunsGhPrCreate('cd /w && gh pr create --fill')).toBe(true);
  });

  it('matches wrapped commands, env prefixes, and pipes', () => {
    expect(commandRunsGhPrCreate('cd /w && gh.exe pr create --fill')).toBe(
      true,
    );
    expect(
      commandRunsGhPrCreate('GH_TOKEN=x gh pr create --fill | tee log'),
    ).toBe(true);
  });

  it('matches a gh pr create on a later line of a multi-line command', () => {
    expect(
      commandRunsGhPrCreate('git push -u origin HEAD\ngh pr create --fill'),
    ).toBe(true);
    expect(
      commandRunsGhPrCreate('git push -u origin HEAD\r\ngh pr create --fill'),
    ).toBe(true);
  });

  it('matches wrapper prefixes, path-qualified binaries, and the new alias', () => {
    expect(commandRunsGhPrCreate('sudo gh pr create --fill')).toBe(true);
    expect(commandRunsGhPrCreate('sudo -u runner gh pr create --fill')).toBe(
      true,
    );
    expect(
      commandRunsGhPrCreate('env GITHUB_TOKEN=x gh pr create --fill'),
    ).toBe(true);
    expect(commandRunsGhPrCreate('nohup gh pr create --fill')).toBe(true);
    expect(commandRunsGhPrCreate('/usr/bin/gh pr create --fill')).toBe(true);
    expect(commandRunsGhPrCreate('~/bin/gh.cmd pr create --fill')).toBe(true);
    expect(commandRunsGhPrCreate('gh pr new --fill')).toBe(true);
  });

  it('returns false when the command is not gh pr create', () => {
    expect(commandRunsGhPrCreate('gh pr view 1')).toBe(false);
    expect(commandRunsGhPrCreate('git commit -m gh')).toBe(false);
    // The phrase as a search argument is not an execution.
    expect(commandRunsGhPrCreate(`grep -rn 'gh pr create' .`)).toBe(false);
  });
});

describe('moveSessionPrSidecar', () => {
  let sourcePath: string;
  let destinationPath: string;

  beforeEach(() => {
    sourcePath = path.join(tmpDir, 'active', 's.pr.json');
    destinationPath = path.join(tmpDir, 'archived', 's.pr.json');
  });

  it('renames the sidecar when the destination is free', async () => {
    await writeSessionPrs(sourcePath, [entry(1)]);
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('merges a split pair instead of clobbering either half', async () => {
    await writeSessionPrs(sourcePath, [entry(1)]);
    await writeSessionPrs(destinationPath, [entry(2)]);
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(
      (await readSessionPrs(destinationPath))?.map((p) => p.number),
    ).toEqual([2, 1]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('does nothing when the source is absent', async () => {
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(await readSessionPrs(destinationPath)).toBeNull();
  });

  it('waits for a lock held on the destination before moving', async () => {
    // The move must serialize against pending mutations on BOTH endpoints:
    // a binder write landing on the destination mid-transition must not be
    // clobbered by the merge write.
    await writeSessionPrs(sourcePath, [entry(1)]);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, '', 'utf-8');
    const release = await lockfile.lock(destinationPath);
    const movePromise = moveSessionPrSidecar(sourcePath, destinationPath);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readSessionPrs(sourcePath)).toEqual([entry(1)]);
    expect(await readSessionPrs(destinationPath)).toBeNull();
    await release();
    await movePromise;
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('waits for a held sidecar lock before moving', async () => {
    // The move runs under the cross-process lock: while another holder
    // keeps the source locked, no binding may be relocated — an unlocked
    // move would merge and unlink the source immediately.
    await writeSessionPrs(sourcePath, [entry(1)]);
    const release = await lockfile.lock(sourcePath);
    const movePromise = moveSessionPrSidecar(sourcePath, destinationPath);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readSessionPrs(sourcePath)).toEqual([entry(1)]);
    expect(await readSessionPrs(destinationPath)).toBeNull();
    await release();
    await movePromise;
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });
});
