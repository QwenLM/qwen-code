/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { loadOrCreateHookIngestToken } from '../agents/hookIngestToken.js';
import { createHookIngestRoute, type HookIngestDeps } from './hookIngest.js';

let gateway: Server | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  gateway = undefined;
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mount(over: Partial<HookIngestDeps> = {}) {
  const ownerEvents = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => seen.push(e));
  const audit = fakeAudit();
  const deps: HookIngestDeps = {
    ownerEvents,
    ingestToken: 'hook-token-1',
    audit,
    ...over,
  };
  const app = express();
  app.use(express.json());
  app.post('/rc/hooks/ingest', createHookIngestRoute(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, audit };
}

function post(url: string, body: unknown, token = 'hook-token-1') {
  return fetch(`${url}/rc/hooks/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('loadOrCreateHookIngestToken', () => {
  it('mints once at 0600 and returns the same token on reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-token-'));
    const path = join(dir, 'hook-ingest-token');
    const t1 = await loadOrCreateHookIngestToken(path);
    const t2 = await loadOrCreateHookIngestToken(path);
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(path, 'utf8')).trim()).toBe(t1);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('POST /rc/hooks/ingest', () => {
  it('mirrors a valid envelope as hook_event on the owner stream', async () => {
    const { url, seen } = await mount();
    const res = await post(url, {
      event: 'PreToolUse',
      sessionId: 's1',
      toolName: 'Bash',
      payload: { command: 'ls' },
    });
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'hook_event',
      event: 'PreToolUse',
      toolName: 'Bash',
    });
    // No drops so far → no dropped field on the frame.
    expect(
      (seen[0] as Extract<OwnerEvent, { type: 'hook_event' }>).dropped,
    ).toBeUndefined();
  });

  it('401s a wrong token, audits hook_ingest_rejected, mirrors nothing', async () => {
    const { url, seen, audit } = await mount();
    const res = await post(url, { event: 'PreToolUse', payload: {} }, 'nope');
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(audit.calls.some((c) => c.action === 'hook_ingest_rejected')).toBe(
      true,
    );
  });

  it('400s an invalid envelope', async () => {
    const { url, seen } = await mount();
    const res = await post(url, { notAnEvent: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'invalid_hook_envelope',
    );
    expect(seen).toHaveLength(0);
  });

  it('drops on bucket overflow and surfaces the count on the next frame', async () => {
    let nowMs = 1_000_000;
    const { url, seen } = await mount({
      bucketCapacity: 2,
      bucketRefillPerSec: 1,
      now: () => nowMs,
    });
    // Two pass, third and fourth drop (bucket empty, clock frozen).
    expect((await post(url, { event: 'e1', payload: {} })).status).toBe(202);
    expect((await post(url, { event: 'e2', payload: {} })).status).toBe(202);
    expect((await post(url, { event: 'e3', payload: {} })).status).toBe(202);
    expect((await post(url, { event: 'e4', payload: {} })).status).toBe(202);
    expect(seen).toHaveLength(2);
    // Refill one token; the next mirrored frame carries dropped: 2.
    nowMs += 1000;
    expect((await post(url, { event: 'e5', payload: {} })).status).toBe(202);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ type: 'hook_event', dropped: 2 });
    // Counter resets after being surfaced.
    nowMs += 1000;
    await post(url, { event: 'e6', payload: {} });
    expect(
      (seen[3] as Extract<OwnerEvent, { type: 'hook_event' }>).dropped,
    ).toBeUndefined();
  });
});
