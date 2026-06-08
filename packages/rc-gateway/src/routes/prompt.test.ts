/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createPromptRoute } from './prompt.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

async function mount(
  daemon: DaemonClient,
  audit: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok1', scopes: ['write'] };
    next();
  });
  app.post('/rc/session/:id/prompt', createPromptRoute(daemon, audit));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postPrompt(
  url: string,
  body: unknown,
  sessionId = 'sess-1',
): Promise<Response> {
  return fetch(`${url}/rc/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('prompt route', () => {
  it('sends a string prompt and returns the stopReason (200)', async () => {
    stub = await startStubDaemon({ promptStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: 'hello' });
    expect(res.status).toBe(200);
    expect((await res.json()).stopReason).toBe('end_turn');
  });

  it('accepts a blocks array verbatim (200)', async () => {
    stub = await startStubDaemon({ promptStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, {
      blocks: [{ type: 'text', text: 'hi' }],
    });
    expect(res.status).toBe(200);
  });

  it('400s an empty body', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_prompt');
  });

  it('400s an empty prompt string', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: '' });
    expect(res.status).toBe(400);
  });

  it('400s an empty blocks array', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { blocks: [] });
    expect(res.status).toBe(400);
  });

  it('502s when the daemon errors', async () => {
    stub = await startStubDaemon({ promptStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: 'hello' });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('audits prompt_sent without the prompt text', async () => {
    stub = await startStubDaemon({ promptStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: 'hello' });
    expect(res.status).toBe(200);
    const entry = audit.calls.find((c) => c.action === 'prompt_sent');
    expect(entry).toBeDefined();
    expect(entry!.actorTokenId).toBe('tok1');
    expect(entry!.target).toBe('sess-1');
    expect(entry!.detail).toMatchObject({ stopReason: 'end_turn' });
    expect(typeof entry!.detail!.blocks).toBe('number');
    // The audit entry must never carry the prompt text.
    expect(JSON.stringify(entry)).not.toContain('hello');
  });
});
