/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore, type UsageRowInput } from './usageStore.js';

let dir: string;
let store: UsageStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-usage-'));
  store = UsageStore.open(join(dir, 'usage.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 1 cent = 1_000_000 microcents */
const MICRO = 1_000_000;

const row = (over: Partial<UsageRowInput> = {}): UsageRowInput => ({
  sessionId: 'sess_1',
  ts: 1000,
  tokensIn: 1000,
  tokensOut: 500,
  tokensCached: 0,
  costMicrocents: 0.6 * MICRO,
  modelServiceId: 'qwen',
  modelId: 'qwen3-coder-plus',
  attributionTokenId: 'tkn_abc',
  subActor: null,
  stage: 'stage1',
  ...over,
});

describe('UsageStore record + sessionTotals (microcents)', () => {
  it('accumulates a session running total in microcents', () => {
    store.record(row({ costMicrocents: 12 * MICRO }));
    store.record(row({ costMicrocents: 3 * MICRO, ts: 2000 }));
    expect(store.sessionTotals('sess_1')).toEqual({
      costMicrocentsSesTotal: 15 * MICRO,
      tokensInTotal: 2000,
      tokensOutTotal: 1000,
      tokensCachedTotal: 0,
    });
  });

  it('counts a NULL cost (rate-table miss) as 0 cost but keeps tokens', () => {
    store.record(row({ costMicrocents: null, tokensIn: 10, tokensOut: 5 }));
    expect(store.sessionTotals('sess_1')).toMatchObject({
      costMicrocentsSesTotal: 0,
      tokensInTotal: 10,
      tokensOutTotal: 5,
    });
  });

  it('isolates totals per session', () => {
    store.record(row({ sessionId: 'a', costMicrocents: 5 * MICRO }));
    store.record(row({ sessionId: 'b', costMicrocents: 9 * MICRO }));
    expect(store.sessionTotals('a').costMicrocentsSesTotal).toBe(5 * MICRO);
    expect(store.sessionTotals('b').costMicrocentsSesTotal).toBe(9 * MICRO);
  });

  it('stores as INTEGER — fractional microcents are rounded', () => {
    // 0.6 microcents fractional part (sub-microcent) is rounded away
    store.record(row({ costMicrocents: 1.7 }));
    // We don't care about the exact value, only that it stored something
    const totals = store.sessionTotals('sess_1');
    expect(Number.isInteger(totals.costMicrocentsSesTotal)).toBe(true);
  });
});

describe('UsageStore aggregate (microcents)', () => {
  beforeEach(() => {
    store.record(
      row({
        sessionId: 's1',
        attributionTokenId: 't1',
        costMicrocents: 5 * MICRO,
      }),
    );
    store.record(
      row({
        sessionId: 's2',
        attributionTokenId: 't1',
        costMicrocents: 3 * MICRO,
      }),
    );
    store.record(
      row({
        sessionId: 's3',
        attributionTokenId: 't2',
        subActor: 'telegram:42',
        modelId: 'qwen3-coder-flash',
        costMicrocents: 10 * MICRO,
      }),
    );
  });

  it('groups by session (one row per session, summed cost in microcents)', () => {
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'session',
    });
    expect(rows).toHaveLength(3);
    const byKey = Object.fromEntries(
      rows.map((r) => [r.key, r.costMicrocents]),
    );
    expect(byKey).toEqual({ s1: 5 * MICRO, s2: 3 * MICRO, s3: 10 * MICRO });
  });

  it('groups by client (attribution token id)', () => {
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'client',
    });
    const byKey = Object.fromEntries(
      rows.map((r) => [r.key, r.costMicrocents]),
    );
    expect(byKey).toEqual({ t1: 8 * MICRO, t2: 10 * MICRO });
  });

  it('groups by model as service/model', () => {
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'model',
    });
    const byKey = Object.fromEntries(
      rows.map((r) => [r.key, r.costMicrocents]),
    );
    expect(byKey).toEqual({
      'qwen/qwen3-coder-plus': 8 * MICRO,
      'qwen/qwen3-coder-flash': 10 * MICRO,
    });
  });

  it('groups by sub_actor (NULL collapses to empty key)', () => {
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'sub_actor',
    });
    const byKey = Object.fromEntries(
      rows.map((r) => [r.key, r.costMicrocents]),
    );
    expect(byKey).toEqual({ '': 8 * MICRO, 'telegram:42': 10 * MICRO });
  });

  it('orders rows by descending cost', () => {
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'session',
    });
    expect(rows[0].key).toBe('s3'); // highest cost first
  });

  it('honors the time window', () => {
    store.record(row({ sessionId: 'old', ts: 50, costMicrocents: 99 * MICRO }));
    const rows = store.aggregate({
      sinceMs: 100,
      untilMs: 9999,
      groupBy: 'session',
    });
    expect(rows.find((r) => r.key === 'old')).toBeUndefined();
  });

  it('scope-filters by attribution token id', () => {
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'session',
      attributionTokenId: 't2',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('s3');
  });
});

describe('UsageStore prune', () => {
  it('deletes rows older than the cutoff and returns the count', () => {
    for (let i = 0; i < 5; i++) store.record(row({ ts: 100 + i }));
    store.record(row({ ts: 5000 }));
    const removed = store.prune(1000);
    expect(removed).toBe(5);
    expect(
      store.aggregate({ sinceMs: 0, untilMs: 9999, groupBy: 'session' })[0]
        .tokensIn,
    ).toBe(1000); // only the ts=5000 row remains
  });
});
