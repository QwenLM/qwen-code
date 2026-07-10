/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TokenStore } from '../tokenStore.js';
import { CorsAllowlist } from '../cors.js';
import { bearerResolve, requireScope } from '../auth.js';
import { OWNER } from '../scopes.js';
import {
  createListCorsOriginsRoute,
  createAddCorsOriginRoute,
  createRemoveCorsOriginRoute,
} from './cors.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

let server: Server | undefined;
let store: TokenStore;
let allowlist: CorsAllowlist;
let audit: AuditRecorder & { calls: AuditEntry[] };
let ownerToken: string;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-cors-'));
  store = await TokenStore.open(join(dir, 'tokens.json'));
  allowlist = new CorsAllowlist();
  audit = fakeAudit();
  const result = await store.issue(['owner'], 'owner');
  ownerToken = result.token;
});

async function mount(configOrigins: readonly string[] = []): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(bearerResolve(store, audit));
  app.get(
    '/rc/cors',
    requireScope(OWNER, audit),
    createListCorsOriginsRoute({ store, allowlist, audit, configOrigins }),
  );
  app.post(
    '/rc/cors',
    requireScope(OWNER, audit),
    createAddCorsOriginRoute({ store, allowlist, audit, configOrigins }),
  );
  app.delete(
    '/rc/cors/:origin',
    requireScope(OWNER, audit),
    createRemoveCorsOriginRoute({ store, allowlist, audit, configOrigins }),
  );

  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// GET /rc/cors — list origins
// ---------------------------------------------------------------------------

describe('GET /rc/cors', () => {
  it('returns empty list when no origins admitted', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/cors`, {
      headers: authHeader(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { origins: unknown[] };
    expect(body.origins).toEqual([]);
  });

  it('returns admitted origins with source db', async () => {
    const url = await mount();
    await store.admitOrigin('https://app.example.com', 'tok1');
    const res = await fetch(`${url}/rc/cors`, {
      headers: authHeader(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      origins: Array<{ origin: string; source: string }>;
    };
    expect(body.origins).toHaveLength(1);
    expect(body.origins[0]?.origin).toBe('https://app.example.com');
    expect(body.origins[0]?.source).toBe('db');
  });

  it('merges config origins with source config', async () => {
    const url = await mount(['https://config.example.com']);
    const res = await fetch(`${url}/rc/cors`, {
      headers: authHeader(ownerToken),
    });
    const body = (await res.json()) as {
      origins: Array<{ origin: string; source: string }>;
    };
    const cfg = body.origins.find(
      (o) => o.origin === 'https://config.example.com',
    );
    expect(cfg?.source).toBe('config');
  });

  it('requires owner scope — session:read token gets 403', async () => {
    const url = await mount();
    const { token: readToken } = await store.issue(['session:read'], 'read');
    const res = await fetch(`${url}/rc/cors`, {
      headers: authHeader(readToken),
    });
    expect(res.status).toBe(403);
  });

  it('requires auth — unauthenticated gets 401', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/cors`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /rc/cors — add origin
// ---------------------------------------------------------------------------

describe('POST /rc/cors', () => {
  it('admits a valid https origin', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/cors`, {
      method: 'POST',
      headers: {
        ...authHeader(ownerToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ origin: 'https://app.example.com' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      origin: { origin: string; source: string };
    };
    expect(body.origin.origin).toBe('https://app.example.com');
    expect(body.origin.source).toBe('db');
  });

  it('adds origin to the in-memory allowlist', async () => {
    const url = await mount();
    await fetch(`${url}/rc/cors`, {
      method: 'POST',
      headers: {
        ...authHeader(ownerToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ origin: 'https://app.example.com' }),
    });
    expect(allowlist.isAllowed('https://app.example.com')).toBe(true);
  });

  it('returns 400 for an invalid origin', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/cors`, {
      method: 'POST',
      headers: {
        ...authHeader(ownerToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ origin: 'http://not-loopback.example.com' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_origin');
  });

  it('returns 400 for a missing origin', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/cors`, {
      method: 'POST',
      headers: {
        ...authHeader(ownerToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('accepts http-loopback origins', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/cors`, {
      method: 'POST',
      headers: {
        ...authHeader(ownerToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ origin: 'http://localhost:3000' }),
    });
    expect(res.status).toBe(200);
  });

  it('records cors_origin_admitted audit event', async () => {
    const url = await mount();
    await fetch(`${url}/rc/cors`, {
      method: 'POST',
      headers: {
        ...authHeader(ownerToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ origin: 'https://app.example.com' }),
    });
    const auditRec = audit.calls.find(
      (c) => c.action === 'cors_origin_admitted',
    );
    expect(auditRec).toBeDefined();
    expect((auditRec?.detail as { origin: string }).origin).toBe(
      'https://app.example.com',
    );
  });

  it('requires owner scope', async () => {
    const url = await mount();
    const { token: readToken } = await store.issue(['session:read'], 'read');
    const res = await fetch(`${url}/rc/cors`, {
      method: 'POST',
      headers: { ...authHeader(readToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com' }),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /rc/cors/:origin — remove origin
// ---------------------------------------------------------------------------

describe('DELETE /rc/cors/:origin', () => {
  it('removes a db-admitted origin', async () => {
    const url = await mount();
    await store.admitOrigin('https://app.example.com', 'tok1');
    allowlist.add('https://app.example.com');

    const encodedOrigin = encodeURIComponent('https://app.example.com');
    const res = await fetch(`${url}/rc/cors/${encodedOrigin}`, {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; origin: string };
    expect(body.removed).toBe(true);
    expect(body.origin).toBe('https://app.example.com');
  });

  it('removes origin from the in-memory allowlist', async () => {
    const url = await mount();
    await store.admitOrigin('https://app.example.com', 'tok1');
    allowlist.add('https://app.example.com');

    const encodedOrigin = encodeURIComponent('https://app.example.com');
    await fetch(`${url}/rc/cors/${encodedOrigin}`, {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });
    expect(allowlist.isAllowed('https://app.example.com')).toBe(false);
  });

  it('returns 404 for an unknown origin', async () => {
    const url = await mount();
    const encodedOrigin = encodeURIComponent('https://never.example.com');
    const res = await fetch(`${url}/rc/cors/${encodedOrigin}`, {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('origin_not_found');
  });

  it('returns 409 for a config-sourced origin', async () => {
    const url = await mount(['https://config.example.com']);
    const encodedOrigin = encodeURIComponent('https://config.example.com');
    const res = await fetch(`${url}/rc/cors/${encodedOrigin}`, {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('origin_config_sourced');
  });

  it('records cors_origin_removed audit event', async () => {
    const url = await mount();
    await store.admitOrigin('https://app.example.com', 'tok1');
    allowlist.add('https://app.example.com');

    const encodedOrigin = encodeURIComponent('https://app.example.com');
    await fetch(`${url}/rc/cors/${encodedOrigin}`, {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });
    const auditRec = audit.calls.find(
      (c) => c.action === 'cors_origin_removed',
    );
    expect(auditRec).toBeDefined();
    expect((auditRec?.detail as { origin: string }).origin).toBe(
      'https://app.example.com',
    );
  });

  it('requires owner scope', async () => {
    const url = await mount();
    await store.admitOrigin('https://app.example.com', 'tok1');
    const { token: readToken } = await store.issue(['session:read'], 'read');
    const encodedOrigin = encodeURIComponent('https://app.example.com');
    const res = await fetch(`${url}/rc/cors/${encodedOrigin}`, {
      method: 'DELETE',
      headers: authHeader(readToken),
    });
    expect(res.status).toBe(403);
  });
});
