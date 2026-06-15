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

const row = (over: Partial<UsageRowInput> = {}): UsageRowInput => ({
  sessionId: 'sess_1',
  ts: 1000,
  tokensIn: 1000,
  tokensOut: 500,
  tokensCached: 0,
  costCents: 0.6,
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
    usage.record(row({ sessionId: 's1', ts: 4000, costCents: 5 }));
    usage.record(row({ sessionId: 's2', ts: 4000, costCents: 3 }));
    const base = await mount();
    const r = await fetch(`${base}/rc/usage?group_by=session`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rows: Array<{ key: string }> };
    expect(body.rows.map((x) => x.key).sort()).toEqual(['s1', 's2']);
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
    usage.record(row({ sessionId: 'old', ts: 1, costCents: 9 })); // before now-24h? now=5000
    usage.record(row({ sessionId: 'new', ts: 4000, costCents: 1 }));
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
    usage.record(row({ sessionId: 's1', ts: 4000, costCents: 5 }));
    const base = await mount();
    const r = await fetch(`${base}/rc/usage?group_by=session&format=csv`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(r.headers.get('content-type')).toContain('text/csv');
    const text = await r.text();
    expect(text.split('\n')[0]).toBe(
      'key,displayLabel,tokensIn,tokensOut,tokensCached,costCents',
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
