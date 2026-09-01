/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SESSION_PR_LIST_LIMIT,
  mergeSessionPrLists,
  readSessionPrs,
  replaceSessionPrs,
  updateSessionPrStates,
  upsertSessionPr,
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

  it('does not carry state onto a same-numbered PR of another repository', async () => {
    await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/repo-a/owner/pull/100',
      state: 'merged',
    });
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/repo-b/owner/pull/100',
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.url).toBe('https://github.com/repo-b/owner/pull/100');
    expect(prs[0]?.state).toBeUndefined();
  });

  it('carries state when the re-bind spells the same PR differently', async () => {
    await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/Owner/Repo/pull/100/',
      state: 'merged',
    });
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/owner/repo/pull/100?v=2',
    });
    expect(prs[0]?.state).toBe('merged');
  });
});

describe('updateSessionPrStates', () => {
  const fetched = (
    number: number,
    state: SessionPrState,
    url: string = entry(number).url,
  ): ReadonlyMap<number, { state: SessionPrState; url: string }> =>
    new Map([[number, { state, url }]]);

  it('rewrites states in place without touching order or createdAt', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open' },
      { ...entry(101), state: 'open' },
    ]);
    const updated = await updateSessionPrStates(
      filePath,
      fetched(100, 'merged'),
    );
    expect(updated).toBe(1);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.map((p) => p.number)).toEqual([100, 101]);
    expect(persisted?.[0]?.state).toBe('merged');
    expect(persisted?.[0]?.createdAt).toBe(entry(100).createdAt);
    expect(persisted?.[1]?.state).toBe('open');
  });

  it('returns 0 without writing when nothing changes', async () => {
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'merged' }]);
    const before = await fs.readFile(filePath, 'utf-8');
    expect(await updateSessionPrStates(filePath, fetched(100, 'merged'))).toBe(
      0,
    );
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('returns 0 when the sidecar is absent', async () => {
    expect(await updateSessionPrStates(filePath, fetched(100, 'merged'))).toBe(
      0,
    );
  });

  it('serializes against a concurrent upsert on the same sidecar', async () => {
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'open' }]);
    const [updated, prs] = await Promise.all([
      updateSessionPrStates(filePath, fetched(100, 'merged')),
      upsertSessionPr(filePath, { number: 101, url: entry(101).url }),
    ]);
    expect(updated).toBe(1);
    expect(prs?.map((p) => p.number)).toEqual([100, 101]);
    // Whichever ran second read the first's write — nothing was clobbered.
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.find((p) => p.number === 100)?.state).toBe('merged');
    expect(persisted?.find((p) => p.number === 101)).toBeDefined();
  });

  it('applies a fetched state only when its url matches the entry', async () => {
    // The map is keyed by number, but the metadata route accepts any
    // http(s) url: a binding that points at another repository must never
    // pick up this repo's same-numbered PR state (and a wrong terminal
    // state would be permanent — merged entries leave the sweep).
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'open' }]);
    const updated = await updateSessionPrStates(
      filePath,
      fetched(
        100,
        'merged',
        'https://github.com/other-org/other-repo/pull/100',
      ),
    );
    expect(updated).toBe(0);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]?.state).toBe('open');
  });

  it('refreshes a binding whose url is canonical-equivalent to the fetched one', async () => {
    // Binding urls preserve the user's remote casing (backfill's remote
    // fallback) or carry dialog spelling variants, while gh returns the
    // server-canonical spelling; GitHub repo paths are case-insensitive,
    // so a byte-unequal comparison skips the entry on every sweep — it
    // can never reach the terminal merged state.
    await writeSessionPrs(filePath, [
      {
        ...entry(100),
        url: 'https://github.com/OWNER/REPO/pull/100/?v=2',
        state: 'open',
      },
    ]);
    const updated = await updateSessionPrStates(
      filePath,
      fetched(100, 'merged'),
    );
    expect(updated).toBe(1);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]?.state).toBe('merged');
  });

  it('does not resurrect a sidecar deleted between the queued read and the write commit', async () => {
    // Deletion and archive moves unlink the sidecar outside the mutation
    // queue. Force the race deterministically: the queued read captures the
    // contents, the deletion lands the moment the read resolves, and only
    // the commit-step guard can still stop the stale write.
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'open' }]);
    const raw = await fs.readFile(filePath, 'utf-8');
    fsMocks.readFile.mockImplementationOnce(async () => {
      fsSync.unlinkSync(filePath);
      return raw;
    });
    await expect(
      updateSessionPrStates(filePath, fetched(100, 'merged'), {
        assertCanCommit: () => {
          if (!fsSync.existsSync(filePath)) {
            throw new Error('sidecar vanished during refresh');
          }
        },
      }),
    ).rejects.toThrow('sidecar vanished during refresh');
    expect(fsSync.existsSync(filePath)).toBe(false);
    // The rejected write must not wedge the queue for later mutations.
    const recovered = await upsertSessionPr(filePath, {
      number: 101,
      url: entry(101).url,
    });
    expect(recovered.map((p) => p.number)).toEqual([101]);
  });
});

describe('replaceSessionPrs', () => {
  it('runs the planner against the freshest list inside the queue', async () => {
    // The planner must see the result of mutations queued ahead of it —
    // planning from a stale outer read would clobber a binding that lands
    // between the caller's read and write.
    await writeSessionPrs(filePath, [entry(100)]);
    const seen: number[][] = [];
    const upsert = upsertSessionPr(filePath, {
      number: 101,
      url: entry(101).url,
    });
    const replace = replaceSessionPrs(filePath, (existing) => {
      seen.push(existing.map((p) => p.number));
      return [...existing, entry(102)];
    });
    await Promise.all([upsert, replace]);
    expect(seen).toEqual([[100, 101]]);
    expect((await readSessionPrs(filePath))?.map((p) => p.number)).toEqual([
      100, 101, 102,
    ]);
  });

  it('leaves the file untouched when the planner returns null', async () => {
    await writeSessionPrs(filePath, [entry(100)]);
    const before = await fs.readFile(filePath, 'utf-8');
    expect(await replaceSessionPrs(filePath, () => null)).toBeNull();
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('persists the planner result and returns it', async () => {
    await writeSessionPrs(filePath, [entry(100)]);
    const persisted = await replaceSessionPrs(filePath, (existing) =>
      existing.filter((p) => p.number !== 100),
    );
    expect(persisted).toEqual([]);
    // An empty list reads back as null (isValidSessionPrList rejects it).
    expect(await readSessionPrs(filePath)).toBeNull();
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

describe('issue snapshot', () => {
  const issue = (number: number) => ({
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    state: 'open' as const,
  });

  it('round-trips issues on an entry', async () => {
    const prs = [{ ...entry(100), issues: [issue(7)] }];
    await writeSessionPrs(filePath, prs);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('voids the sidecar on a malformed or oversized issue list', async () => {
    // The issue url is rendered as a link target exactly like the PR url.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        prs: [{ ...entry(100), issues: [{ number: 7, url: 'javascript:x' }] }],
      }),
    );
    expect(await readSessionPrs(filePath)).toBeNull();
    await fs.writeFile(
      filePath,
      JSON.stringify({
        prs: [{ ...entry(100), issues: [{ ...issue(7), state: 'merged' }] }],
      }),
    );
    expect(await readSessionPrs(filePath)).toBeNull();
    await fs.writeFile(
      filePath,
      JSON.stringify({
        prs: [
          {
            ...entry(100),
            issues: Array.from({ length: 11 }, (_, index) => issue(index + 1)),
          },
        ],
      }),
    );
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('keeps the snapshot on a re-bind of the same PR only', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open', issues: [issue(7)] },
    ]);
    const same = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
    });
    expect(same[0]?.issues).toEqual([issue(7)]);
    const other = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/other/repo/pull/100',
    });
    expect(other[0]?.issues).toBeUndefined();
  });

  it('updateSessionPrStates writes issues with or without a state', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open' },
      { ...entry(101), state: 'merged' },
    ]);
    const updated = await updateSessionPrStates(
      filePath,
      new Map([
        [
          100,
          { state: 'merged' as const, url: entry(100).url, issues: [issue(7)] },
        ],
        [101, { url: entry(101).url, issues: [] }],
      ]),
    );
    expect(updated).toBe(2);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]).toMatchObject({
      state: 'merged',
      issues: [issue(7)],
      createdAt: entry(100).createdAt,
    });
    // An empty snapshot is still a snapshot ("fetched, none").
    expect(persisted?.[1]).toMatchObject({ state: 'merged', issues: [] });
  });

  it('updateSessionPrStates leaves issues alone when unchanged or omitted', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open', issues: [issue(7)] },
    ]);
    const before = await fs.readFile(filePath, 'utf-8');
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, { url: entry(100).url, issues: [issue(7)] }]]),
      ),
    ).toBe(0);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, { state: 'closed' as const, url: entry(100).url }]]),
      ),
    ).toBe(1);
    expect((await readSessionPrs(filePath))?.[0]).toMatchObject({
      state: 'closed',
      issues: [issue(7)],
    });
  });

  it('updateSessionPrStates rewrites a changed issue state', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'merged', issues: [issue(7)] },
    ]);
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([
          [
            100,
            {
              url: entry(100).url,
              issues: [{ ...issue(7), state: 'completed' as const }],
            },
          ],
        ]),
      ),
    ).toBe(1);
    expect((await readSessionPrs(filePath))?.[0]?.issues?.[0]?.state).toBe(
      'completed',
    );
  });
});
