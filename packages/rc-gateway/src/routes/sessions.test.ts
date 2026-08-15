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
import { join, resolve as pathResolve } from 'node:path';
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
  await writeTranscriptAt(chatsDir, id, parent);
}

async function writeTranscriptAt(
  dir: string,
  id: string,
  parent?: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const rec: Record<string, unknown> = { sessionId: id, type: 'user' };
  if (parent) rec['forkedFrom'] = { sessionId: parent, messageUuid: 'm0' };
  await writeFile(join(dir, `${id}.jsonl`), JSON.stringify(rec) + '\n');
}

// Mirrors the `/rc/sessions` resolver wired in server.ts: an explicit `?cwd`
// wins (path.resolve'd so `/proj` and `/proj/` hit the same chats dir), else
// falls back to the boot workspace.
async function mountWithQueryCwd(
  bootCwd: string | undefined,
  audit: AuditRecorder,
): Promise<string> {
  const app = express();
  app.get(
    '/rc/sessions',
    createSessionListRoute(async (req) => {
      const q = req.query.cwd;
      if (typeof q === 'string' && q.length > 0) return pathResolve(q);
      return bootCwd;
    }, audit),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
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
    const body = (await res.json()) as {
      sessions: unknown[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    // Each item now also carries an `updatedAt` (ISO string); the list is
    // ordered by it, so assert set membership (order-independent) + count
    // rather than a positional deep-equal.
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions).toEqual(
      expect.arrayContaining([
        { sessionId: ROOT, forks: [FORK], updatedAt: expect.any(String) },
        {
          sessionId: FORK,
          parentSessionId: ROOT,
          forks: [],
          updatedAt: expect.any(String),
        },
      ]),
    );
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'session_list_read',
      detail: { count: 2, truncated: false },
    });
    // Privacy: no session ids in the audit detail.
    expect(JSON.stringify(audit.calls[0].detail)).not.toContain(ROOT);
    expect(JSON.stringify(audit.calls[0].detail)).not.toContain(FORK);
  });

  it('surfaces a custom_title as the item title, never in the audit (cycle 85)', async () => {
    await mkdir(chatsDir, { recursive: true });
    await writeFile(
      join(chatsDir, `${ROOT}.jsonl`),
      JSON.stringify({ sessionId: ROOT, type: 'user' }) +
        '\n' +
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'Refactor the auth flow' },
          sessionId: ROOT,
        }) +
        '\n',
    );
    const audit = fakeAudit();
    const base = await mount(CWD, audit);
    const res = await fetch(`${base}/rc/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; title?: string }>;
    };
    expect(body.sessions).toEqual([
      // titleSource defaults to 'manual' when the record omits it (cycle 95).
      // updatedAt is an ISO string stat'd from the transcript file.
      {
        sessionId: ROOT,
        title: 'Refactor the auth flow',
        titleSource: 'manual',
        forks: [],
        updatedAt: expect.any(String),
      },
    ]);
    // Privacy: the title (user content) is NEVER in the audit.
    expect(JSON.stringify(audit.calls[0].detail)).not.toContain('Refactor');
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

const BOOT = '/sessions-test/boot';
const OTHER = '/sessions-test/proj/x';
const BOOT_SESSION = '33333333333333333333333333333333';
const PROJ_SESSION = '44444444444444444444444444444444';

describe('GET /rc/sessions?cwd', () => {
  it('lists THAT workspace, not boot', async () => {
    await writeTranscriptAt(resolveChatsDir(BOOT), BOOT_SESSION);
    await writeTranscriptAt(resolveChatsDir(OTHER), PROJ_SESSION);
    const audit = fakeAudit();
    const base = await mountWithQueryCwd(BOOT, audit);

    const res = await fetch(
      `${base}/rc/sessions?cwd=${encodeURIComponent(OTHER)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(body.sessions.map((s) => s.sessionId)).toEqual(
      expect.arrayContaining([PROJ_SESSION]),
    );
    expect(body.sessions.map((s) => s.sessionId)).not.toContain(BOOT_SESSION);
  });

  it('with no cwd still lists the boot workspace (unchanged)', async () => {
    await writeTranscriptAt(resolveChatsDir(BOOT), BOOT_SESSION);
    await writeTranscriptAt(resolveChatsDir(OTHER), PROJ_SESSION);
    const audit = fakeAudit();
    const base = await mountWithQueryCwd(BOOT, audit);

    const res = await fetch(`${base}/rc/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(body.sessions.map((s) => s.sessionId)).toEqual(
      expect.arrayContaining([BOOT_SESSION]),
    );
    expect(body.sessions.map((s) => s.sessionId)).not.toContain(PROJ_SESSION);
  });

  it('normalizes a trailing slash to the same chats dir (/proj/x/ === /proj/x)', async () => {
    await writeTranscriptAt(resolveChatsDir(OTHER), PROJ_SESSION);
    const audit = fakeAudit();
    const base = await mountWithQueryCwd(BOOT, audit);

    const res = await fetch(
      `${base}/rc/sessions?cwd=${encodeURIComponent(OTHER + '/')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(body.sessions.map((s) => s.sessionId)).toEqual(
      expect.arrayContaining([PROJ_SESSION]),
    );
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
