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
import type { RcScope } from '../scopes.js';
import { OWNER, SESSION_READ } from '../scopes.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { SnoozeStore } from '../routing/snooze.js';
import { createRoutingRouter } from './routing.js';

let server: Server | undefined;
let snooze: SnoozeStore;
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

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-routing-'));
  snooze = await SnoozeStore.open(join(dir, 'snooze.state'));
  audit = fakeAudit();
  client = { id: 'owner1', scopes: [SESSION_READ, OWNER] };
});

async function mount(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = client;
    next();
  });
  app.use('/rc/routing', createRoutingRouter(snooze, audit));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('routing routes', () => {
  it('POST /snooze with durationSec returns 200 {until,scope} and audits', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec: 60 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { until: number; scope: string };
    expect(body.scope).toBe('all');
    expect(typeof body.until).toBe('number');
    expect(snooze.isSnoozed('anything')).toBe(true);

    const a = audit.calls.find((c) => c.action === 'routing_snoozed');
    expect(a).toBeDefined();
    expect(a!.detail).toMatchObject({ scope: 'all', durationSec: 60 });
  });

  it('POST /snooze honors an explicit scope', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec: 60, scope: 'permission.required' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe('permission.required');
    expect(snooze.isSnoozed('task.completed')).toBe(false);
    expect(snooze.isSnoozed('permission.required')).toBe(true);
  });

  it('GET /snooze reflects an active snooze', async () => {
    const url = await mount();
    await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec: 60 }),
    });
    const res = await fetch(`${url}/rc/routing/snooze`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      active: boolean;
      until?: number;
      scope?: string;
    };
    expect(body.active).toBe(true);
    expect(body.scope).toBe('all');
    expect(typeof body.until).toBe('number');
  });

  it('GET /snooze reports inactive when none set', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/routing/snooze`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });

  it('DELETE /snooze clears and returns 204 + audits routing_unsnoozed', async () => {
    const url = await mount();
    await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec: 60 }),
    });
    const del = await fetch(`${url}/rc/routing/snooze`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(snooze.active()).toBeNull();
    expect(audit.calls.some((c) => c.action === 'routing_unsnoozed')).toBe(
      true,
    );

    const get = await fetch(`${url}/rc/routing/snooze`);
    const body = (await get.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });

  it('POST /snooze with durationSec 0 returns 400 invalid_snooze', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec: 0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_snooze');
  });

  it('POST /snooze with a missing durationSec returns 400 invalid_snooze', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_snooze');
  });

  it('POST /snooze rejects a non-finite durationSec', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec: 'soon' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_snooze');
  });

  // --- cycle 77: multi-snooze ---

  async function postSnooze(
    url: string,
    durationSec: number,
    scope?: string,
  ): Promise<Response> {
    return fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope ? { durationSec, scope } : { durationSec }),
    });
  }

  it('two POSTs accumulate; GET /snooze lists both in snoozes[]', async () => {
    const url = await mount();
    await postSnooze(url, 60, 'permission.required');
    await postSnooze(url, 120, 'task.completed');
    const res = await fetch(`${url}/rc/routing/snooze`);
    const body = (await res.json()) as { snoozes: Array<{ scope: string }> };
    const scopes = body.snoozes.map((e) => e.scope).sort();
    expect(scopes).toEqual(['permission.required', 'task.completed']);
    // Both are independently active.
    expect(snooze.isSnoozed('permission.required')).toBe(true);
    expect(snooze.isSnoozed('task.completed')).toBe(true);
  });

  it('DELETE /snooze?scope=<s> clears only that scope and audits it', async () => {
    const url = await mount();
    await postSnooze(url, 60, 'all');
    await postSnooze(url, 60, 'task.completed');
    const del = await fetch(`${url}/rc/routing/snooze?scope=all`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    expect(snooze.isSnoozed('permission.required')).toBe(false); // 'all' gone
    expect(snooze.isSnoozed('task.completed')).toBe(true); // kept
    const a = audit.calls.find((c) => c.action === 'routing_unsnoozed');
    expect(a!.detail).toEqual({ scope: 'all' });
  });

  it('DELETE /snooze with no scope clears everything', async () => {
    const url = await mount();
    await postSnooze(url, 60, 'all');
    await postSnooze(url, 60, 'task.completed');
    const del = await fetch(`${url}/rc/routing/snooze`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const res = await fetch(`${url}/rc/routing/snooze`);
    const body = (await res.json()) as { active: boolean; snoozes: unknown[] };
    expect(body.active).toBe(false);
    expect(body.snoozes).toEqual([]);
  });
});
