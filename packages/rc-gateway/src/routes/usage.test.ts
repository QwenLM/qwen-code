/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TokenStore } from '../tokenStore.js';
import { bearerResolve } from '../auth.js';
import { OWNER, WRITE, expandScopes } from '../scopes.js';
import { UsageStore, type UsageRowInput } from '../cost/usageStore.js';
import { createUsageRoute } from './usage.js';

let server: Server | undefined;
let store: TokenStore;
let usage: UsageStore;
let dir: string;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  usage?.close();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rc-usage-route-'));
  store = await TokenStore.open(join(dir, 'tokens.json'));
  usage = UsageStore.open(join(dir, 'usage.db'));
});

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
  attributionTokenId: 'tkn_x',
  subActor: null,
  stage: null,
  ...over,
}); // ts is overridden per-test to fall inside the window

async function mount(): Promise<string> {
  const app = express();
  app.use(bearerResolve(store));
  app.get('/rc/usage', createUsageRoute({ store: usage, now: () => 5000 }));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function tokenWith(
  scopes: string[],
): Promise<{ id: string; token: string }> {
  return store.issue(expandScopes(scopes), 'test');
}

describe('GET /rc/usage', () => {
  it('401s without a token', async () => {
    const base = await mount();
    const r = await fetch(`${base}/rc/usage`);
    expect(r.status).toBe(401);
  });

  it('owner sees all rows grouped by session', async () => {
    const owner = await tokenWith([OWNER]);
    usage.record(row({ sessionId: 's1', ts: 4000, costMicrocents: 5 * MICRO }));
    usage.record(row({ sessionId: 's2', ts: 4000, costMicrocents: 3 * MICRO }));
    const base = await mount();
    const r = await fetch(`${base}/rc/usage?group_by=session`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rows: Array<{ key: string }> };
    expect(body.rows.map((x) => x.key).sort()).toEqual(['s1', 's2']);
  });

  it('response rows carry costMicrocents + costCents + efficiency', async () => {
    const owner = await tokenWith([OWNER]);
    // 500 output tokens, 5 cents = 5_000_000 microcents
    usage.record(
      row({
        sessionId: 's1',
        ts: 4000,
        costMicrocents: 5 * MICRO,
        tokensOut: 500,
      }),
    );
    const base = await mount();
    const r = await fetch(`${base}/rc/usage?group_by=session`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const body = (await r.json()) as {
      rows: Array<{
        key: string;
        costMicrocents: number;
        costCents: number;
        efficiency: {
          costCentsPer1kOutputTokens: number | null;
          tokensPerDollar: number | null;
        };
      }>;
    };
    const s1 = body.rows.find((x) => x.key === 's1')!;
    expect(s1.costMicrocents).toBe(5 * MICRO);
    expect(s1.costCents).toBeCloseTo(5, 5);
    // 5 cents / 500 out * 1000 = 10 cents per 1k output tokens
    expect(s1.efficiency.costCentsPer1kOutputTokens).toBeCloseTo(10, 5);
    // 500 out / (5 / 100) dollars = 500 / 0.05 = 10000 tokens/dollar
    expect(s1.efficiency.tokensPerDollar).toBeCloseTo(10000, 0);
  });

  it('a write-scope token sees only its own attributed rows', async () => {
    const mine = await tokenWith([WRITE]);
    const other = await tokenWith([WRITE]);
    usage.record(
      row({ sessionId: 's1', ts: 4000, attributionTokenId: mine.id }),
    );
    usage.record(
      row({ sessionId: 's2', ts: 4000, attributionTokenId: other.id }),
    );
    const base = await mount();
    const r = await fetch(`${base}/rc/usage?group_by=session`, {
      headers: { Authorization: `Bearer ${mine.token}` },
    });
    const body = (await r.json()) as { rows: Array<{ key: string }> };
    expect(body.rows.map((x) => x.key)).toEqual(['s1']);
  });

  it('honors the since window (default 24h excludes ancient rows)', async () => {
    const owner = await tokenWith([OWNER]);
    usage.record(row({ sessionId: 'old', ts: 1, costMicrocents: 9 * MICRO })); // before now-24h? now=5000
    usage.record(
      row({ sessionId: 'new', ts: 4000, costMicrocents: 1 * MICRO }),
    );
    const base = await mount();
    // since=1s → window [4000,5000]; the ts=1 row is excluded.
    const r = await fetch(`${base}/rc/usage?group_by=session&since=1s`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const body = (await r.json()) as { rows: Array<{ key: string }> };
    expect(body.rows.map((x) => x.key)).toEqual(['new']);
  });

  it('exports CSV with the spec header and content-type', async () => {
    const owner = await tokenWith([OWNER]);
    usage.record(row({ sessionId: 's1', ts: 4000, costMicrocents: 5 * MICRO }));
    const base = await mount();
    const r = await fetch(`${base}/rc/usage?group_by=session&format=csv`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(r.headers.get('content-type')).toContain('text/csv');
    const text = await r.text();
    expect(text.split('\n')[0]).toBe(
      'key,displayLabel,tokensIn,tokensOut,tokensCached,costMicrocents,costCents,costCentsPer1kOutputTokens,tokensPerDollar',
    );
  });

  it('400s an invalid group_by', async () => {
    const owner = await tokenWith([OWNER]);
    const base = await mount();
    const r = await fetch(`${base}/rc/usage?group_by=region`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(r.status).toBe(400);
  });
});
