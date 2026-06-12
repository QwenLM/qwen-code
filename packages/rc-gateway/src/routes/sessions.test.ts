/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { requireScope } from '../auth.js';
import { OWNER, SESSION_READ, type RcScope } from '../scopes.js';
import { createSessionListRoute } from './sessions.js';

const CWD = '/sessions-test/ws';
const ROOT = '11111111111111111111111111111111';
const FORK = '22222222222222222222222222222222';

let server: Server | undefined;
let runtimeBase: string;
let chatsDir: string;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function writeTranscript(id: string, parent?: string): Promise<void> {
  await mkdir(chatsDir, { recursive: true });
  const rec: Record<string, unknown> = { sessionId: id, type: 'user' };
  if (parent) rec['forkedFrom'] = { sessionId: parent, messageUuid: 'm0' };
  await writeFile(join(chatsDir, `${id}.jsonl`), JSON.stringify(rec) + '\n');
}

async function mount(
  cwd: string | undefined,
  audit: AuditRecorder,
): Promise<string> {
  const app = express();
  app.get(
    '/rc/sessions',
    createSessionListRoute(async () => cwd, audit),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-sessions-'));
  process.env['QWEN_RUNTIME_DIR'] = runtimeBase;
  chatsDir = resolveChatsDir(CWD);
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  server = undefined;
  delete process.env['QWEN_RUNTIME_DIR'];
  await rm(runtimeBase, { recursive: true, force: true });
});

describe('GET /rc/sessions', () => {
  it('returns the fork tree and audits count + truncated only', async () => {
    await writeTranscript(ROOT);
    await writeTranscript(FORK, ROOT);
    const audit = fakeAudit();
    const base = await mount(CWD, audit);

    const res = await fetch(`${base}/rc/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessions: [
        { sessionId: ROOT, forks: [FORK] },
        { sessionId: FORK, parentSessionId: ROOT, forks: [] },
      ],
      truncated: false,
    });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'session_list_read',
      detail: { count: 2, truncated: false },
    });
    // Privacy: no session ids in the audit detail.
    expect(JSON.stringify(audit.calls[0].detail)).not.toContain(ROOT);
    expect(JSON.stringify(audit.calls[0].detail)).not.toContain(FORK);
  });

  it('200 empty when the chats dir does not exist yet', async () => {
    const audit = fakeAudit();
    const base = await mount(CWD, audit);
    const res = await fetch(`${base}/rc/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [], truncated: false });
  });

  it('502s when the workspace cwd is unresolvable', async () => {
    const audit = fakeAudit();
    const base = await mount(undefined, audit);
    const res = await fetch(`${base}/rc/sessions`);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
    expect(audit.calls).toHaveLength(0);
  });
});

// Mounts behind requireScope(OWNER) — the production posture — to lock the
// single riskiest line: a downgrade to SESSION_READ would 200 a non-owner the
// whole workspace topology.
async function mountGuarded(
  scopes: RcScope[],
  audit: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok', scopes };
    next();
  });
  app.get(
    '/rc/sessions',
    requireScope(OWNER, audit),
    createSessionListRoute(async () => CWD, audit),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /rc/sessions — OWNER gate', () => {
  it('403s a non-owner (session:read) token before the handler runs', async () => {
    await writeTranscript(ROOT);
    const audit = fakeAudit();
    const base = await mountGuarded([SESSION_READ], audit);
    const res = await fetch(`${base}/rc/sessions`);
    expect(res.status).toBe(403);
    expect(audit.calls.some((c) => c.action === 'session_list_read')).toBe(
      false,
    );
  });

  it('200s an owner token through the same gate', async () => {
    await writeTranscript(ROOT);
    const audit = fakeAudit();
    const base = await mountGuarded([OWNER], audit);
    const res = await fetch(`${base}/rc/sessions`);
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toHaveLength(1);
  });
});
