/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { createForkRoute } from './fork.js';

// A cwd whose sanitizeCwd is stable and lands under our tmp runtime base.
const CWD = '/fork-test/ws';
const PARENT_ID = '11111111111111111111111111111111';

let server: Server | undefined;
let runtimeBase: string;
let chatsDir: string;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

/** A daemon stub exposing only loadSession (the route's sole daemon dep). */
function fakeDaemon(loadSession: (id: string) => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    daemon: {
      loadSession: async (id: string) => {
        calls.push(id);
        return loadSession(id);
      },
    },
  };
}

async function writeParent(): Promise<void> {
  await mkdir(chatsDir, { recursive: true });
  const rec = {
    uuid: 'p0',
    parentUuid: null,
    sessionId: PARENT_ID,
    cwd: CWD,
    type: 'user',
    message: { role: 'user', parts: [{ text: 'hello' }] },
  };
  await writeFile(
    join(chatsDir, `${PARENT_ID}.jsonl`),
    JSON.stringify(rec) + '\n',
    'utf8',
  );
}

interface MountOpts {
  daemon: { loadSession: (id: string) => Promise<unknown> };
  audit: AuditRecorder;
  cwd?: string | undefined;
  randomId?: () => string;
}

async function mount(opts: MountOpts): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok1', scopes: ['write'] };
    next();
  });
  app.post(
    '/rc/session/:id/fork',
    createForkRoute(
      opts.daemon as never,
      async () => ('cwd' in opts ? opts.cwd : CWD),
      { audit: opts.audit, randomId: opts.randomId },
    ),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postFork(
  url: string,
  body: unknown,
  id = PARENT_ID,
): Promise<Response> {
  return fetch(`${url}/rc/session/${id}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-fork-route-'));
  process.env['QWEN_RUNTIME_DIR'] = runtimeBase;
  delete process.env['QWEN_HOME'];
  chatsDir = resolveChatsDir(CWD);
  expect(chatsDir.startsWith(runtimeBase)).toBe(true);
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  delete process.env['QWEN_RUNTIME_DIR'];
  await rm(runtimeBase, { recursive: true, force: true });
});

describe('fork route', () => {
  it('400s an unsupported transcript mode', async () => {
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit });
    const res = await postFork(url, { transcript: 'empty' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_fork_mode');
  });

  it('400s when fromEventId is present', async () => {
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit });
    const res = await postFork(url, { fromEventId: 5 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_fork_mode');
  });

  it('404s an invalid (too-short) parent id (cannot be a file)', async () => {
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit });
    // `abc` fails SESSION_FILE_RE, so it can never name a transcript file.
    const res = await postFork(url, {}, 'abc');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('parent_transcript_not_found');
  });

  it('502s when no workspace cwd is resolvable', async () => {
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, cwd: undefined });
    const res = await postFork(url, {});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('404s when the parent transcript does not exist', async () => {
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit });
    const res = await postFork(url, {});
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('parent_transcript_not_found');
  });

  it('forks (200): writes a rewritten file, loads it, audits ids+count not content', async () => {
    await writeParent();
    const { daemon, calls } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => 'NEWFORKID' });
    const res = await postFork(url, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe('NEWFORKID');
    expect(body.parentSessionId).toBe(PARENT_ID);
    expect(typeof body.forkedAt).toBe('string');

    // The fork file exists with the rewritten sessionId.
    const forkPath = join(chatsDir, 'NEWFORKID.jsonl');
    await stat(forkPath); // throws if missing
    const written = await readFile(forkPath, 'utf8');
    const first = JSON.parse(written.split('\n')[0]);
    expect(first.sessionId).toBe('NEWFORKID');
    expect(first.cwd).toBe(CWD); // cwd untouched

    // loadSession called with the new id.
    expect(calls).toEqual(['NEWFORKID']);

    // Audit: ids + count only, never record content.
    const entry = audit.calls.find((c) => c.action === 'session_forked');
    expect(entry).toBeDefined();
    expect(entry!.actorTokenId).toBe('tok1');
    expect(entry!.target).toBe(PARENT_ID);
    expect(entry!.detail).toMatchObject({
      newSessionId: 'NEWFORKID',
      copiedCount: 1,
    });
    expect(JSON.stringify(entry)).not.toContain('hello');
  });

  it('502s and removes the fork file when loadSession rejects', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => {
      throw new Error('daemon down');
    });
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => 'ROLLBACKID' });
    const res = await postFork(url, {});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
    // The just-written fork file was rolled back.
    await expect(stat(join(chatsDir, 'ROLLBACKID.jsonl'))).rejects.toThrow();
  });
});
