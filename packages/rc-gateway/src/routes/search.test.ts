/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RcScope } from '../scopes.js';
import { OWNER, SESSION_READ, SHARE } from '../scopes.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createSearchRoute } from './search.js';

let server: Server | undefined;
let dir: string;
let audit: AuditRecorder & { calls: AuditEntry[] };
let client: {
  id: string;
  scopes: RcScope[];
  sessionLockId?: string;
  shareId?: string;
  shareLabel?: string;
};

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-search-route-'));
  // A fixture matching the query "oauth flow".
  const rec = {
    uuid: 'evt-1',
    sessionId: 'sess-1',
    timestamp: '2026-06-01T00:00:00.000Z',
    type: 'assistant',
    cwd: '/w',
    message: { role: 'assistant', parts: [{ text: 'the oauth flow is fine' }] },
  };
  writeFileSync(join(dir, 'sess-1.jsonl'), JSON.stringify(rec) + '\n');
  audit = fakeAudit();
  client = { id: 'owner1', scopes: [OWNER] };
});

async function mount(
  resolveDir: () => Promise<string | undefined>,
  opts?: Parameters<typeof createSearchRoute>[2],
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = client;
    next();
  });
  app.get('/rc/search', createSearchRoute(resolveDir, audit, opts));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('search route', () => {
  it('returns 200 {hits} for a matching query and audits count only', async () => {
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=oauth+flow`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ eventId: string }> };
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].eventId).toBe('evt-1');

    const a = audit.calls.find((c) => c.action === 'search_performed');
    expect(a).toBeDefined();
    expect(a!.detail).toEqual({ kind: 'all', resultCount: 1 });
  });

  it('NEVER records the query text in the audit entry', async () => {
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=oauth+flow`);
    expect(res.status).toBe(200);
    // The serialized audit must not leak the query terms.
    const blob = JSON.stringify(audit.calls);
    expect(blob).not.toContain('oauth');
    expect(blob).not.toContain('flow');
  });

  it('400 invalid_query for a missing q', async () => {
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_query');
  });

  it('400 invalid_query for a whitespace-only q', async () => {
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=%20%20`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_query');
  });

  it('400 query_too_long for a q over 1024 chars; 1024 is allowed', async () => {
    const url = await mount(async () => dir);
    const tooLong = 'a'.repeat(1025);
    const res = await fetch(`${url}/rc/search?q=${tooLong}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'query_too_long',
    );
    // Exactly 1024 chars is accepted (does not hit the cap).
    const ok = await fetch(`${url}/rc/search?q=${'a'.repeat(1024)}`);
    expect(ok.status).toBe(200);
  });

  it('400 invalid_kind for an unknown kind', async () => {
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=oauth&kind=bogus`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_kind');
  });

  it('200 {hits:[],truncated:false,elapsedMs:0} when there is no workspace (resolveDir → undefined)', async () => {
    const url = await mount(async () => undefined);
    const res = await fetch(`${url}/rc/search?q=oauth`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: unknown[];
      truncated: boolean;
      elapsedMs: number;
      mode: string;
    };
    // Uniform 200 shape with the scanned path (cycle 37; +mode in slice 2).
    expect(body).toEqual({
      hits: [],
      truncated: false,
      elapsedMs: 0,
      mode: 'scan',
    });
  });

  it('rank=bm25: uses the ranked provider and reports mode:"bm25" (skips the scan)', async () => {
    const ranked = vi.fn(async () => ({
      hits: [
        {
          sessionId: 'sess-1',
          eventId: 'ranked-1',
          kind: 'assistant',
          ts: '2026-06-01T00:00:00.000Z',
          snippet: 'ranked hit',
        },
      ],
      truncated: false,
    }));
    const url = await mount(async () => dir, { ranked });
    const res = await fetch(`${url}/rc/search?q=oauth&rank=bm25`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ eventId: string }>;
      mode: string;
    };
    expect(body.mode).toBe('bm25');
    expect(body.hits.map((h) => h.eventId)).toEqual(['ranked-1']); // ranked, not the scan's evt-1
    expect(ranked).toHaveBeenCalledTimes(1);
    // The bm25 run records rank:'bm25' in the audit; scan path stays unchanged.
    const a = audit.calls.find((c) => c.action === 'search_performed');
    expect(a!.detail).toEqual({ kind: 'all', resultCount: 1, rank: 'bm25' });
  });

  it('rank=bm25 falls back to the scan (mode:"scan") when the provider returns null', async () => {
    const ranked = vi.fn(async () => null);
    const url = await mount(async () => dir, { ranked });
    const res = await fetch(`${url}/rc/search?q=oauth+flow&rank=bm25`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ eventId: string }>;
      mode: string;
    };
    expect(body.mode).toBe('scan');
    expect(body.hits[0].eventId).toBe('evt-1'); // the live scan answered
    // scan-path audit detail is byte-identical (no rank key).
    const a = audit.calls.find((c) => c.action === 'search_performed');
    expect(a!.detail).toEqual({ kind: 'all', resultCount: 1 });
  });

  it('rank=bm25 falls back to the scan when the provider throws', async () => {
    const ranked = vi.fn(async () => {
      throw new Error('native blew up');
    });
    const url = await mount(async () => dir, { ranked });
    const res = await fetch(`${url}/rc/search?q=oauth+flow&rank=bm25`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ eventId: string }>;
      mode: string;
    };
    expect(body.mode).toBe('scan');
    expect(body.hits[0].eventId).toBe('evt-1');
  });

  it('a plain query (no rank) never invokes the ranked provider and reports mode:"scan"', async () => {
    const ranked = vi.fn(async () => null);
    const url = await mount(async () => dir, { ranked });
    const res = await fetch(`${url}/rc/search?q=oauth+flow`);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe('scan');
    expect(ranked).not.toHaveBeenCalled();
  });

  it('503 search_timeout when the scan exceeds the per-query budget', async () => {
    // Inject a tiny budget + a clock that jumps past the deadline so the real
    // scanner throws SearchTimeoutError, which the route maps to 503.
    // The route reads the clock once for the elapsedMs start (cycle 37) before
    // the scanner; the first TWO reads (start + scanner deadline) return 0, then
    // the file-loop check jumps past the deadline.
    let calls = 0;
    const now = () => (calls++ <= 1 ? 0 : 1_000_000);
    const url = await mount(async () => dir, { timeoutMs: 1, now });
    const res = await fetch(`${url}/rc/search?q=oauth`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      'search_timeout',
    );
    // Audited as a timeout — count-free, and never the query text.
    const a = audit.calls.find((c) => c.action === 'search_performed');
    expect(a!.detail).toEqual({ kind: 'all', timedOut: true });
    expect(JSON.stringify(audit.calls)).not.toContain('oauth');
  });

  it('200 body carries truncated:false + an integer elapsedMs >= 0 (cycle 37)', async () => {
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=oauth+flow`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: unknown[];
      truncated: boolean;
      elapsedMs: number;
    };
    expect(body.hits).toHaveLength(1);
    expect(body.truncated).toBe(false);
    expect(Number.isInteger(body.elapsedMs)).toBe(true);
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('elapsedMs is 0 under a constant injected clock (cycle 37)', async () => {
    // A constant clock: the scanner reads it repeatedly (deadline 2000ms out,
    // never hit → no throw) and the route's elapsed = const - const = 0.
    const url = await mount(async () => dir, { now: () => 5000 });
    const res = await fetch(`${url}/rc/search?q=oauth+flow`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      elapsedMs: number;
      truncated: boolean;
    };
    expect(body.elapsedMs).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it('truncated:true when matches exceed the limit (cycle 37)', async () => {
    // Three more matching records (+ the beforeEach fixture = 4 matches),
    // limit=2 → 2 hits returned + truncated.
    const recs = [0, 1, 2].map((i) => ({
      uuid: `m${i}`,
      sessionId: 'sess-1',
      timestamp: `2026-06-01T00:00:0${i}.000Z`,
      type: 'assistant',
      cwd: '/w',
      message: { role: 'assistant', parts: [{ text: `oauth token ${i}` }] },
    }));
    writeFileSync(
      join(dir, 'many.jsonl'),
      recs.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=oauth&limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: unknown[];
      truncated: boolean;
    };
    expect(body.hits).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });

  // --- cycle 79: since/until time filter ---

  it('?since narrows results to records at/after the bound', async () => {
    // A second, older record that also matches the query.
    writeFileSync(
      join(dir, 'old.jsonl'),
      JSON.stringify({
        uuid: 'evt-old',
        sessionId: 'sess-1',
        timestamp: '2026-05-01T00:00:00.000Z',
        type: 'assistant',
        cwd: '/w',
        message: { role: 'assistant', parts: [{ text: 'the oauth flow old' }] },
      }) + '\n',
    );
    // No bound → both match (evt-1 is dated 2026-06-01 in the fixture).
    const all = await fetch(
      `${await mount(async () => dir)}/rc/search?q=oauth`,
    );
    expect(((await all.json()) as { hits: unknown[] }).hits).toHaveLength(2);
    // since 2026-05-15 → only the newer fixture record.
    const res = await fetch(
      `${await mount(async () => dir)}/rc/search?q=oauth&since=2026-05-15T00:00:00.000Z`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ eventId: string }> };
    expect(body.hits.map((h) => h.eventId)).toEqual(['evt-1']);
  });

  it('400 invalid_since / invalid_until for an unparseable bound', async () => {
    const url = await mount(async () => dir);
    const a = await fetch(`${url}/rc/search?q=oauth&since=not-a-date`);
    expect(a.status).toBe(400);
    expect(((await a.json()) as { code: string }).code).toBe('invalid_since');
    const b = await fetch(`${url}/rc/search?q=oauth&until=nope`);
    expect(b.status).toBe(400);
    expect(((await b.json()) as { code: string }).code).toBe('invalid_until');
  });

  // --- cycle 76: session-scoped search authorization ---

  it('SECURITY: a session-locked share forces sessionId=lock and ignores ?sessionId', async () => {
    // A second session whose transcript also matches the query.
    writeFileSync(
      join(dir, 'sess-2.jsonl'),
      JSON.stringify({
        uuid: 'evt-2',
        sessionId: 'sess-2',
        timestamp: '2026-06-02T00:00:00.000Z',
        type: 'assistant',
        cwd: '/w',
        message: { role: 'assistant', parts: [{ text: 'oauth secret two' }] },
      }) + '\n',
    );
    client = {
      id: 'share1',
      scopes: [SHARE, SESSION_READ],
      sessionLockId: 'sess-1',
      shareId: 'share1',
      shareLabel: 'guest',
    };
    const url = await mount(async () => dir);
    // Attempt to read the OTHER session via ?sessionId — must be ignored.
    const res = await fetch(`${url}/rc/search?q=oauth&sessionId=sess-2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ eventId: string }> };
    // Only the locked session's hit comes back; sess-2 is never surfaced.
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].eventId).toBe('evt-1');
    // The guest search row is share-attributable + flagged session-scoped.
    const a = audit.calls.find((c) => c.action === 'search_performed');
    expect(a!.shareId).toBe('share1');
    expect(a!.shareLabel).toBe('guest');
    expect(a!.detail).toEqual({
      kind: 'all',
      resultCount: 1,
      sessionScoped: true,
    });
  });

  it('SECURITY: a session-locked token with a blank lock is denied (no unfiltered leak)', async () => {
    // Unreachable via share creation (it rejects an empty sessionId), but the
    // handler must not force sessionId='' (= "no filter" → full-workspace leak).
    client = { id: 'bad', scopes: [SHARE, SESSION_READ], sessionLockId: '' };
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=oauth&sessionId=sess-1`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      'insufficient_scope',
    );
  });

  it('a non-owner, non-locked token is denied (403 scope_denied)', async () => {
    client = { id: 'reader', scopes: [SESSION_READ] };
    const url = await mount(async () => dir);
    const res = await fetch(`${url}/rc/search?q=oauth`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      'insufficient_scope',
    );
    const a = audit.calls.find((c) => c.action === 'scope_denied');
    expect(a).toBeDefined();
    expect(a!.detail).toEqual({ required: OWNER });
  });

  it('an owner still honours ?sessionId (unrestricted search)', async () => {
    // Owner scoping to a session with no records → empty, proving the query
    // sessionId is honoured (not ignored) for an owner.
    const url = await mount(async () => dir);
    const res = await fetch(
      `${url}/rc/search?q=oauth&sessionId=does-not-exist`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(body.hits).toHaveLength(0);
  });
});
