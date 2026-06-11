/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  QuotaStore,
  MemoryQuotaWal,
  quotaLimitsFromPolicy,
  type QuotaLimit,
} from './quotas.js';
import type { Policy } from './loader.js';

/** limitsFor over a fixed map; unknown ids → undefined (untracked). */
const limitsFrom =
  (m: Record<string, QuotaLimit>) =>
  (ruleId: string): QuotaLimit | undefined =>
    m[ruleId];

const T0 = 1_000_000; // arbitrary fixed epoch-ms base

describe('QuotaStore window math', () => {
  it('reports room under the cap and exhausted at the cap', async () => {
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(
      wal,
      limitsFrom({ a: { count: 2, windowSec: 60 } }),
    );
    expect(store.state('a', T0)).toBe('room');
    expect(store.remaining('a', T0)).toBe(2);
    await store.consume('a', T0);
    expect(store.state('a', T0)).toBe('room');
    expect(store.remaining('a', T0)).toBe(1);
    await store.consume('a', T0 + 1);
    expect(store.state('a', T0 + 1)).toBe('exhausted');
    expect(store.remaining('a', T0 + 1)).toBe(0);
  });

  it('frees a slot once an instant ages out of the window', async () => {
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(
      wal,
      limitsFrom({ a: { count: 1, windowSec: 60 } }),
    );
    await store.consume('a', T0);
    expect(store.state('a', T0)).toBe('exhausted');
    // 60s + 1ms later the lone instant has aged out.
    expect(store.state('a', T0 + 60_000 + 1)).toBe('room');
  });

  it('treats an unknown rule id as untracked', async () => {
    const store = await QuotaStore.create(new MemoryQuotaWal(), limitsFrom({}));
    expect(store.state('nope', T0)).toBe('untracked');
    expect(store.remaining('nope', T0)).toBeUndefined();
  });

  it('treats a count:0 rule as always exhausted', async () => {
    const store = await QuotaStore.create(
      new MemoryQuotaWal(),
      limitsFrom({ a: { count: 0, windowSec: 60 } }),
    );
    expect(store.state('a', T0)).toBe('exhausted');
    expect(store.remaining('a', T0)).toBe(0);
  });
});

describe('QuotaStore persistence (restart survival)', () => {
  it('resumes the count when a new store loads the same WAL (spec scenario)', async () => {
    const wal = new MemoryQuotaWal();
    const limits = limitsFrom({ a: { count: 5, windowSec: 600 } });
    const first = await QuotaStore.create(wal, limits);
    await first.consume('a', T0);
    await first.consume('a', T0 + 1);
    await first.consume('a', T0 + 2); // 3 of 5 used

    // "Daemon restart": a fresh store over the same WAL.
    const second = await QuotaStore.create(wal, limits);
    expect(second.remaining('a', T0 + 3)).toBe(2); // resumes at 3 of 5
    await second.consume('a', T0 + 3);
    await second.consume('a', T0 + 4);
    expect(second.state('a', T0 + 4)).toBe('exhausted');
  });
});

describe('QuotaStore compaction', () => {
  it('keeps live records and drops records for an unknown (deleted) rule', async () => {
    const wal = new MemoryQuotaWal();
    // Seed the WAL directly with a live rule + a now-unknown rule.
    await wal.append({ ruleId: 'a', ms: T0 });
    await wal.append({ ruleId: 'a', ms: T0 + 1 });
    await wal.append({ ruleId: 'gone', ms: T0 });

    const store = await QuotaStore.create(
      wal,
      limitsFrom({ a: { count: 5, windowSec: 600 } }), // 'gone' is untracked
    );
    await store.compact(T0 + 2);

    const persisted = await wal.load();
    expect(persisted.map((r) => r.ruleId).sort()).toEqual(['a', 'a']); // live kept
    expect(persisted.some((r) => r.ruleId === 'gone')).toBe(false); // unknown dropped

    // A reloaded store still sees the 2 live consumes.
    const reloaded = await QuotaStore.create(
      wal,
      limitsFrom({ a: { count: 5, windowSec: 600 } }),
    );
    expect(reloaded.remaining('a', T0 + 3)).toBe(3);
  });

  it('drops instants that have aged out of the window on compaction', async () => {
    const wal = new MemoryQuotaWal();
    const limits = limitsFrom({ a: { count: 5, windowSec: 60 } });
    const store = await QuotaStore.create(wal, limits);
    await store.consume('a', T0);
    // Compact well past the window → the instant is pruned out of the WAL.
    await store.compact(T0 + 60_000 + 1);
    expect(await wal.load()).toEqual([]);
  });

  it('still increments memory and never throws when the WAL append fails', async () => {
    // A WAL whose append always rejects (e.g. disk full) must not break consume.
    const failingWal: import('./quotas.js').QuotaWal = {
      append: () => Promise.reject(new Error('disk full')),
      load: () => Promise.resolve([]),
      rewrite: () => Promise.resolve(),
    };
    const store = await QuotaStore.create(
      failingWal,
      limitsFrom({ a: { count: 2, windowSec: 60 } }),
    );
    await expect(store.consume('a', T0)).resolves.toBeUndefined();
    // The in-memory counter advanced even though persistence failed.
    expect(store.remaining('a', T0)).toBe(1);
  });

  it('auto-compacts once the WAL exceeds the floor, and stays correct', async () => {
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(
      wal,
      limitsFrom({ a: { count: 100, windowSec: 600 } }),
      { compactionFloor: 2 },
    );
    await store.consume('a', T0);
    await store.consume('a', T0 + 1);
    await store.consume('a', T0 + 2); // walLines 3 > floor 2 → auto-compact
    // All 3 are still live (within 600s) → compaction keeps them.
    expect((await wal.load()).length).toBe(3);
    const reloaded = await QuotaStore.create(
      wal,
      limitsFrom({ a: { count: 100, windowSec: 600 } }),
    );
    expect(reloaded.remaining('a', T0 + 3)).toBe(97);
  });
});

describe('quotaLimitsFromPolicy', () => {
  const policy = (rules: Policy['rules']): Policy => ({
    defaults: { action: 'prompt', requireScope: 'approve' },
    rules,
  });

  it('maps id → maxPerWindow, skipping id-less and non-quota rules', () => {
    const m = quotaLimitsFromPolicy(
      policy([
        {
          id: 'q',
          match: { tool: 'bash' },
          action: 'allow',
          maxPerWindow: { count: 2, windowSec: 60 },
        },
        { id: 'plain', match: { tool: 'git' }, action: 'allow' },
        {
          match: { tool: 'rm' },
          action: 'deny',
          maxPerWindow: { count: 1, windowSec: 10 },
        },
      ]),
    );
    expect([...m.keys()]).toEqual(['q']);
    expect(m.get('q')).toEqual({ count: 2, windowSec: 60 });
  });

  it('first id wins on a (defensive) duplicate', () => {
    const m = quotaLimitsFromPolicy(
      policy([
        {
          id: 'q',
          match: { tool: 'a' },
          action: 'allow',
          maxPerWindow: { count: 1, windowSec: 1 },
        },
        {
          id: 'q',
          match: { tool: 'b' },
          action: 'allow',
          maxPerWindow: { count: 9, windowSec: 9 },
        },
      ]),
    );
    expect(m.get('q')).toEqual({ count: 1, windowSec: 1 });
  });

  it('CONTRACT: a QuotaStore whose limitsFor closes over a Map reflects a later in-place mutation (the cli hot-reload rebuild)', async () => {
    // This pins the mechanism cli.ts relies on: rebuild limits by mutating the
    // SAME map the store's limitsFor closure captured at boot.
    const limits = new Map<string, QuotaLimit>();
    const store = await QuotaStore.create(new MemoryQuotaWal(), (id) =>
      limits.get(id),
    );
    // Initially untracked → no limit.
    expect(store.state('q', T0)).toBe('untracked');
    expect(store.remaining('q', T0)).toBeUndefined();

    // Simulate a reload that adds a quota for 'q' by mutating in place.
    const next = quotaLimitsFromPolicy({
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [
        {
          id: 'q',
          match: { tool: 'bash' },
          action: 'allow',
          maxPerWindow: { count: 2, windowSec: 60 },
        },
      ],
    });
    limits.clear();
    for (const [k, v] of next) limits.set(k, v);

    // The SAME store now sees the new limit without being rebuilt.
    expect(store.state('q', T0)).toBe('room');
    expect(store.remaining('q', T0)).toBe(2);

    // A subsequent reload that drops the rule → untracked again.
    limits.clear();
    expect(store.state('q', T0)).toBe('untracked');
  });
});
