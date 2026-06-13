/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { IdleSessionToggles } from '../idle/sessionToggles.js';
import {
  createIdleToggleRoute,
  createIdleStatusRoute,
  type IdleStatusResolver,
} from './idleToggle.js';

const SESSION = '11111111111111111111111111111111';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

let server: Server | undefined;
let base: string;
let toggles: IdleSessionToggles;
let audit: ReturnType<typeof fakeAudit>;

function mount() {
  toggles = new IdleSessionToggles();
  audit = fakeAudit();
  const app = express();
  app.use(express.json());
  app.post(
    '/rc/session/:id/idle-suggest-toggle',
    createIdleToggleRoute(toggles, audit),
  );
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

async function post(id: string, body: unknown) {
  const res = await fetch(`${base}/rc/session/${id}/idle-suggest-toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

describe('POST /rc/session/:id/idle-suggest-toggle', () => {
  beforeEach(mount);
  afterEach(
    () => new Promise<void>((r) => (server ? server.close(() => r()) : r())),
  );

  it('sets enabled:false, stores it, and audits the flag only', async () => {
    const { status, json } = await post(SESSION, { enabled: false });
    expect(status).toBe(200);
    expect(json).toEqual({ sessionId: SESSION, enabled: false });
    expect(toggles.get(SESSION)).toBe(false);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0].action).toBe('idle_toggle_set');
    expect(audit.calls[0].target).toBe(SESSION);
    expect(audit.calls[0].detail).toEqual({ enabled: false });
  });

  it('sets enabled:true (revert to default)', async () => {
    const { status, json } = await post(SESSION, { enabled: true });
    expect(status).toBe(200);
    expect(json.enabled).toBe(true);
    expect(toggles.get(SESSION)).toBe(true);
  });

  it('rejects a non-boolean enabled with 400 invalid_toggle (no store write)', async () => {
    const { status, json } = await post(SESSION, { enabled: 'yes' });
    expect(status).toBe(400);
    expect(json.code).toBe('invalid_toggle');
    expect(toggles.get(SESSION)).toBeUndefined();
    expect(audit.calls).toHaveLength(0);
  });

  it('rejects a missing enabled with 400', async () => {
    const { status } = await post(SESSION, {});
    expect(status).toBe(400);
  });

  it('404s an invalid (non-hex) session id without touching the store', async () => {
    const { status, json } = await post('not-a-hex-id', { enabled: false });
    expect(status).toBe(404);
    expect(json.code).toBe('session_not_found');
    expect(toggles.get('not-a-hex-id')).toBeUndefined();
  });
});

describe('GET /rc/session/:id/idle-suggest-toggle (status)', () => {
  let toggles2: IdleSessionToggles;
  let statusServer: Server | undefined;
  let statusBase: string;

  function mountStatus(resolver: IdleStatusResolver) {
    toggles2 = new IdleSessionToggles();
    const app = express();
    app.get(
      '/rc/session/:id/idle-suggest-toggle',
      createIdleStatusRoute(toggles2, resolver),
    );
    return new Promise<void>((resolve) => {
      statusServer = app.listen(0, '127.0.0.1', () => {
        statusBase = `http://127.0.0.1:${(statusServer!.address() as AddressInfo).port}`;
        resolve();
      });
    });
  }
  afterEach(
    () =>
      new Promise<void>((r) =>
        statusServer ? statusServer.close(() => r()) : r(),
      ),
  );
  async function get(id: string) {
    const res = await fetch(
      `${statusBase}/rc/session/${id}/idle-suggest-toggle`,
    );
    return { status: res.status, json: await res.json() };
  }

  it('reports available:false when idle is not wired (resolver → undefined)', async () => {
    await mountStatus(() => undefined);
    const { status, json } = await get(SESSION);
    expect(status).toBe(200);
    expect(json).toEqual({
      sessionId: SESSION,
      enabled: false,
      available: false,
    });
  });

  it('effective enabled = globalEnabled && override !== false; reports budget', async () => {
    const snap = {
      globalEnabled: true,
      maxSuggestionsPerHour: 5,
      remainingThisHour: 4,
    };
    await mountStatus(() => snap);
    // No override → follows global (enabled).
    let r = await get(SESSION);
    expect(r.json).toEqual({
      sessionId: SESSION,
      available: true,
      enabled: true,
      maxSuggestionsPerHour: 5,
      remainingThisHour: 4,
    });
    // Override false → disabled.
    toggles2.set(SESSION, false);
    r = await get(SESSION);
    expect(r.json.enabled).toBe(false);
    // Override true → enabled (follows global).
    toggles2.set(SESSION, true);
    r = await get(SESSION);
    expect(r.json.enabled).toBe(true);
  });

  it('a true override CANNOT widen past a global-off', async () => {
    await mountStatus(() => ({
      globalEnabled: false,
      maxSuggestionsPerHour: 5,
      remainingThisHour: 5,
    }));
    toggles2.set(SESSION, true);
    const { json } = await get(SESSION);
    expect(json.enabled).toBe(false);
  });

  it('404s an invalid session id', async () => {
    await mountStatus(() => undefined);
    const { status, json } = await get('bad-id');
    expect(status).toBe(404);
    expect(json.code).toBe('session_not_found');
  });
});

describe('IdleSessionToggles', () => {
  it('get is undefined until set, then returns the stored value', () => {
    const t = new IdleSessionToggles();
    expect(t.get('s')).toBeUndefined();
    t.set('s', false);
    expect(t.get('s')).toBe(false);
    t.set('s', true);
    expect(t.get('s')).toBe(true);
  });
});
