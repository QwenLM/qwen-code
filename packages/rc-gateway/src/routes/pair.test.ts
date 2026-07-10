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
import { PairingService } from '../pairing.js';
import { CorsAllowlist } from '../cors.js';
import { createPairRedeemRoute } from './pair.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { OWNER } from '../scopes.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

let server: Server | undefined;
let store: TokenStore;
let pairing: PairingService;
let allowlist: CorsAllowlist;
let audit: AuditRecorder & { calls: AuditEntry[] };

const OWN_UI_ORIGIN = 'http://localhost:4170';

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-pair-'));
  store = await TokenStore.open(join(dir, 'tokens.json'));
  pairing = new PairingService();
  allowlist = new CorsAllowlist();
  audit = fakeAudit();
});

async function mount(withCors = true): Promise<{ url: string }> {
  const app = express();
  app.use(express.json());
  app.post(
    '/rc/pair/redeem',
    createPairRedeemRoute(
      pairing,
      store,
      audit,
      withCors ? { ownUiOrigin: OWN_UI_ORIGIN, allowlist } : undefined,
    ),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// Basic redemption (regression)
// ---------------------------------------------------------------------------

describe('POST /rc/pair/redeem — basic', () => {
  it('redeems a valid code and returns id, token, scopes', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER]);
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'test' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      token: string;
      scopes: string[];
    };
    expect(body.token).toMatch(/^qwk_/);
    expect(body.scopes).toContain('owner');
  });

  it('returns 400 for an invalid code', async () => {
    const { url } = await mount();
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad-code', label: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an expired code (single-use consumed)', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER]);
    // consume it
    await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'first' }),
    });
    // second attempt should fail
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'second' }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CORS admission at redemption
// ---------------------------------------------------------------------------

describe('POST /rc/pair/redeem — CORS admission', () => {
  it('admits origin when codeAllowOrigin=true and Sec-Fetch-Site is absent', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER], { allowOrigin: true });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
      },
      body: JSON.stringify({ code, label: 'test' }),
    });
    expect(res.status).toBe(200);
    // Origin should be admitted to the allowlist
    expect(allowlist.isAllowed('https://app.example.com')).toBe(true);
    // Store should have the record
    const listed = store.listOrigins();
    expect(listed.some((r) => r.origin === 'https://app.example.com')).toBe(
      true,
    );
  });

  it('admits the own UI origin even when codeAllowOrigin=false', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER], { allowOrigin: false });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: OWN_UI_ORIGIN,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ code, label: 'test' }),
    });
    expect(res.status).toBe(200);
    expect(allowlist.isAllowed(OWN_UI_ORIGIN)).toBe(true);
  });

  it('does NOT admit origin when codeAllowOrigin=false and origin != ownUiOrigin', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER], { allowOrigin: false });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://third-party.example.com',
      },
      body: JSON.stringify({ code, label: 'test' }),
    });
    // Token still issued
    expect(res.status).toBe(200);
    // Origin NOT admitted
    expect(allowlist.isAllowed('https://third-party.example.com')).toBe(false);
  });

  it('does NOT admit origin when Sec-Fetch-Site is cross-site', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER], { allowOrigin: true });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ code, label: 'test' }),
    });
    expect(res.status).toBe(200);
    expect(allowlist.isAllowed('https://app.example.com')).toBe(false);
  });

  it('does NOT admit an invalid origin (http non-loopback)', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER], { allowOrigin: true });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://192.168.1.100',
      },
      body: JSON.stringify({ code, label: 'test' }),
    });
    expect(res.status).toBe(200); // token still issued
    expect(allowlist.isAllowed('http://192.168.1.100')).toBe(false);
  });

  it('still issues token even when no Origin header is present', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER], { allowOrigin: true });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'test' }),
    });
    expect(res.status).toBe(200);
  });

  it('records cors_origin_admitted audit event when origin is admitted', async () => {
    const { url } = await mount();
    const { code } = pairing.mint([OWNER], { allowOrigin: true });
    await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
      },
      body: JSON.stringify({ code, label: 'test' }),
    });
    const admitRec = audit.calls.find(
      (c) => c.action === 'cors_origin_admitted',
    );
    expect(admitRec).toBeDefined();
    expect((admitRec?.detail as { origin: string }).origin).toBe(
      'https://app.example.com',
    );
  });

  it('works without corsOpts (no CORS admission wired)', async () => {
    const { url } = await mount(false);
    const { code } = pairing.mint([OWNER], { allowOrigin: true });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
      },
      body: JSON.stringify({ code, label: 'test' }),
    });
    expect(res.status).toBe(200);
    // No admission without corsOpts
    expect(allowlist.isAllowed('https://app.example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PairingService allowOrigin flag
// ---------------------------------------------------------------------------

describe('PairingService.mint allowOrigin', () => {
  it('defaults allowOrigin to false when not specified', () => {
    const svc = new PairingService();
    const { code } = svc.mint([OWNER]);
    const grant = svc.redeem(code);
    expect(grant?.allowOrigin).toBe(false);
  });

  it('sets allowOrigin=true when specified', () => {
    const svc = new PairingService();
    const { code } = svc.mint([OWNER], { allowOrigin: true });
    const grant = svc.redeem(code);
    expect(grant?.allowOrigin).toBe(true);
  });
});
