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
// Injected fork ids must be valid hex session ids (the route guards `newId`
// against `isValidSessionId` as defense-in-depth), so use 32-hex literals.
const NEW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROLLBACK_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
    const url = await mount({ daemon, audit, randomId: () => NEW_ID });
    const res = await postFork(url, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(NEW_ID);
    expect(body.parentSessionId).toBe(PARENT_ID);
    expect(typeof body.forkedAt).toBe('string');

    // The fork file exists with the rewritten sessionId.
    const forkPath = join(chatsDir, `${NEW_ID}.jsonl`);
    await stat(forkPath); // throws if missing
    const written = await readFile(forkPath, 'utf8');
    const first = JSON.parse(written.split('\n')[0]);
    expect(first.sessionId).toBe(NEW_ID);
    expect(first.cwd).toBe(CWD); // cwd untouched

    // loadSession called with the new id.
    expect(calls).toEqual([NEW_ID]);

    // Audit: ids + count only, never record content.
    const entry = audit.calls.find((c) => c.action === 'session_forked');
    expect(entry).toBeDefined();
    expect(entry!.actorTokenId).toBe('tok1');
    expect(entry!.target).toBe(PARENT_ID);
    expect(entry!.detail).toMatchObject({
      newSessionId: NEW_ID,
      copiedCount: 1,
    });
    expect(JSON.stringify(entry)).not.toContain('hello');
  });

  it('names a fork: appends a custom_title record, audits named:true not the title', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => NEW_ID });
    const res = await postFork(url, { name: '  Refactor the auth flow  ' });
    expect(res.status).toBe(200);

    const written = await readFile(join(chatsDir, `${NEW_ID}.jsonl`), 'utf8');
    const recs = written
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    // The parent's single record plus the appended title record.
    expect(recs).toHaveLength(2);
    const titleRec = recs[recs.length - 1];
    expect(titleRec.type).toBe('system');
    expect(titleRec.subtype).toBe('custom_title');
    // Trimmed, manual, chained onto the last copied record's uuid.
    expect(titleRec.systemPayload).toEqual({
      customTitle: 'Refactor the auth flow',
      titleSource: 'manual',
    });
    expect(titleRec.parentUuid).toBe('p0');
    expect(titleRec.sessionId).toBe(NEW_ID);
    expect('forkedFrom' in titleRec).toBe(false);

    // Audit: named flag only, never the title value (user content).
    const entry = audit.calls.find((c) => c.action === 'session_forked');
    expect(entry!.detail).toMatchObject({ copiedCount: 1, named: true });
    expect(JSON.stringify(entry)).not.toContain('Refactor');
  });

  it('an un-named fork stays byte-identical and audits named:false', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => NEW_ID });
    const res = await postFork(url, {});
    expect(res.status).toBe(200);
    const written = await readFile(join(chatsDir, `${NEW_ID}.jsonl`), 'utf8');
    // Only the single copied record — no title record appended.
    expect(written.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    expect(written).not.toContain('custom_title');
    const entry = audit.calls.find((c) => c.action === 'session_forked');
    expect(entry!.detail).toMatchObject({ named: false });
  });

  it('a blank/whitespace name is treated as un-named (no title record)', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => NEW_ID });
    const res = await postFork(url, { name: '   ' });
    expect(res.status).toBe(200);
    const written = await readFile(join(chatsDir, `${NEW_ID}.jsonl`), 'utf8');
    expect(written).not.toContain('custom_title');
    const entry = audit.calls.find((c) => c.action === 'session_forked');
    expect(entry!.detail).toMatchObject({ named: false });
  });

  it('502s and removes the fork file when loadSession rejects', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => {
      throw new Error('daemon down');
    });
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => ROLLBACK_ID });
    const res = await postFork(url, {});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
    // The just-written fork file was rolled back.
    await expect(
      stat(join(chatsDir, `${ROLLBACK_ID}.jsonl`)),
    ).rejects.toThrow();
  });

  it('500s (does not hang) when reading the parent throws a non-ENOENT error', async () => {
    // Make the parent "transcript" a directory: readFile → EISDIR, which
    // readParentRecords re-throws (only ENOENT maps to null). With no global
    // error middleware, an uncaught throw would hang the request; the route's
    // catch-all must map it to a clean 500 instead.
    await mkdir(join(chatsDir, `${PARENT_ID}.jsonl`), { recursive: true });
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit });
    const res = await postFork(url, {});
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('fork_failed');
  });
});
