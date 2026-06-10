/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RcScope } from '../scopes.js';
import { OWNER } from '../scopes.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createSearchRoute } from './search.js';

let server: Server | undefined;
let dir: string;
let audit: AuditRecorder & { calls: AuditEntry[] };
let client: { id: string; scopes: RcScope[] };

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
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = client;
    next();
  });
  app.get('/rc/search', createSearchRoute(resolveDir, audit));
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

  it('200 {hits:[]} when there is no workspace (resolveDir → undefined)', async () => {
    const url = await mount(async () => undefined);
    const res = await fetch(`${url}/rc/search?q=oauth`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(body.hits).toEqual([]);
  });
});
