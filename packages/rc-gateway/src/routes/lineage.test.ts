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
import { createLineageRoute } from './lineage.js';

const CWD = '/lineage-test/ws';
const PARENT = '11111111111111111111111111111111';
const FORK = '22222222222222222222222222222222';

let server: Server | undefined;
let runtimeBase: string;
let chatsDir: string;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

/** Write a transcript: a root record, or one declaring `parent` as fork source. */
async function writeTranscript(id: string, parent?: string): Promise<void> {
  await mkdir(chatsDir, { recursive: true });
  const rec: Record<string, unknown> = {
    uuid: `${id}-0`,
    sessionId: id,
    cwd: CWD,
    type: 'user',
    message: { role: 'user', parts: [{ text: 'hi' }] },
  };
  if (parent) rec['forkedFrom'] = { sessionId: parent, messageUuid: 'm0' };
  await writeFile(
    join(chatsDir, `${id}.jsonl`),
    JSON.stringify(rec) + '\n',
    'utf8',
  );
}

interface MountOpts {
  audit: AuditRecorder;
  cwd?: string | undefined;
}

async function mount(opts: MountOpts): Promise<string> {
  const app = express();
  app.use(express.json());
  app.get(
    '/session/:id/lineage',
    createLineageRoute(async () => opts.cwd, opts.audit),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-lineage-'));
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

describe('GET /session/:id/lineage', () => {
  it('returns the chain self-first to root for a fork', async () => {
    await writeTranscript(PARENT);
    await writeTranscript(FORK, PARENT);
    const audit = fakeAudit();
    const base = await mount({ audit, cwd: CWD });

    const res = await fetch(`${base}/session/${FORK}/lineage`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: FORK,
      chain: [{ sessionId: FORK }, { sessionId: PARENT }],
      truncated: false,
    });
    // Audit records depth + truncated only (no session ids in detail).
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'session_lineage_read',
      target: FORK,
      detail: { depth: 2, truncated: false },
    });
    expect(JSON.stringify(audit.calls[0].detail)).not.toContain(PARENT);
  });

  it('enriches chain nodes with their custom_title (cycle 95)', async () => {
    await writeTranscript(PARENT);
    await writeTranscript(FORK, PARENT);
    // Append a title record to PARENT only; FORK stays untitled.
    await writeFile(
      join(chatsDir, `${PARENT}.jsonl`),
      JSON.stringify({
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle: 'Root work', titleSource: 'manual' },
        sessionId: PARENT,
      }) + '\n',
      { flag: 'a' },
    );
    const base = await mount({ audit: fakeAudit(), cwd: CWD });
    const res = await fetch(`${base}/session/${FORK}/lineage`);
    expect(await res.json()).toEqual({
      sessionId: FORK,
      // FORK has no title key; PARENT carries its title.
      chain: [{ sessionId: FORK }, { sessionId: PARENT, title: 'Root work' }],
      truncated: false,
    });
  });

  it('returns a single-node chain for a root session', async () => {
    await writeTranscript(PARENT);
    const audit = fakeAudit();
    const base = await mount({ audit, cwd: CWD });

    const res = await fetch(`${base}/session/${PARENT}/lineage`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: PARENT,
      chain: [{ sessionId: PARENT }],
      truncated: false,
    });
  });

  it('404s when the session transcript is missing', async () => {
    const audit = fakeAudit();
    const base = await mount({ audit, cwd: CWD });
    const res = await fetch(`${base}/session/${FORK}/lineage`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('session_not_found');
    expect(audit.calls).toHaveLength(0);
  });

  it('404s on a syntactically invalid session id', async () => {
    const audit = fakeAudit();
    const base = await mount({ audit, cwd: CWD });
    const res = await fetch(`${base}/session/not-valid/lineage`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('session_not_found');
  });

  it('502s when the workspace cwd is unresolvable', async () => {
    await writeTranscript(PARENT);
    const audit = fakeAudit();
    const base = await mount({ audit, cwd: undefined });
    const res = await fetch(`${base}/session/${PARENT}/lineage`);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });
});

// Mounts the route BEHIND a requireScope(OWNER) gate (the production posture),
// with an injectable client standing in for bearerResolve, to lock down the
// single riskiest line: a downgrade to SESSION_READ would 200 a non-owner.
async function mountGuarded(
  scopes: RcScope[],
  audit: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok', scopes };
    next();
  });
  app.get(
    '/session/:id/lineage',
    requireScope(OWNER, audit),
    createLineageRoute(async () => CWD, audit),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /session/:id/lineage — OWNER gate', () => {
  it('403s a non-owner (session:read) token before the handler runs', async () => {
    await writeTranscript(PARENT);
    const audit = fakeAudit();
    const base = await mountGuarded([SESSION_READ], audit);
    const res = await fetch(`${base}/session/${PARENT}/lineage`);
    expect(res.status).toBe(403);
    // Handler never ran -> no lineage read was audited.
    expect(audit.calls.some((c) => c.action === 'session_lineage_read')).toBe(
      false,
    );
  });

  it('200s an owner token through the same gate', async () => {
    await writeTranscript(PARENT);
    const audit = fakeAudit();
    const base = await mountGuarded([OWNER], audit);
    const res = await fetch(`${base}/session/${PARENT}/lineage`);
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe(PARENT);
  });
});
