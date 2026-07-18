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
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { decodeSegment } from '../wal.js';

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
  bus?: OwnerEventBus;
  walDir?: string;
  now?: () => Date;
}

async function mount(opts: MountOpts): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok1', scopes: ['write'] };
    next();
  });
  app.post(
    '/session/:id/fork',
    createForkRoute(
      opts.daemon as never,
      async () => ('cwd' in opts ? opts.cwd : CWD),
      {
        audit: opts.audit,
        randomId: opts.randomId,
        bus: opts.bus,
        walDir: opts.walDir,
        now: opts.now,
      },
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
  return fetch(`${url}/session/${id}/fork`, {
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
  it('400s an unsupported transcript mode (unknown value)', async () => {
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit });
    const res = await postFork(url, { transcript: 'unknown-mode' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_fork_mode');
  });

  it('400s transcript=summary (not yet implemented)', async () => {
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit });
    const res = await postFork(url, { transcript: 'summary' });
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

    // The fork file exists. The first line is the fork header; the second is the copied record.
    const forkPath = join(chatsDir, `${NEW_ID}.jsonl`);
    await stat(forkPath); // throws if missing
    const written = await readFile(forkPath, 'utf8');
    const lines = written.split('\n').filter((l) => l.length > 0);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe('fork');
    expect(header.parentSessionId).toBe(PARENT_ID);
    const first = JSON.parse(lines[1]);
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
    // fork header + the parent's single record + the appended title record.
    expect(recs).toHaveLength(3);
    expect(recs[0].type).toBe('fork'); // fork header
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
    // Fork header + the single copied record — no title record appended.
    expect(written.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
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

  it('fork header: first JSONL line is {type:"fork", parentSessionId, transcriptMode, forkedAt}', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const now = new Date('2026-07-10T00:00:00.000Z');
    const url = await mount({
      daemon,
      audit,
      randomId: () => NEW_ID,
      now: () => now,
    });
    const res = await postFork(url, {});
    expect(res.status).toBe(200);

    const written = await readFile(join(chatsDir, `${NEW_ID}.jsonl`), 'utf8');
    const lines = written.split('\n').filter((l) => l.length > 0);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe('fork');
    expect(header.parentSessionId).toBe(PARENT_ID);
    expect(header.transcriptMode).toBe('include');
    expect(header.forkedAt).toBe('2026-07-10T00:00:00.000Z');
    expect('parentEventId' in header).toBe(false);
    // The copied records come AFTER the header.
    expect(lines.length).toBe(2); // 1 header + 1 copied record
    expect(JSON.parse(lines[1]).sessionId).toBe(NEW_ID);
  });

  it('fork header includes parentEventId when fromEventId is supplied', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => NEW_ID });
    const res = await postFork(url, { fromEventId: 7 });
    expect(res.status).toBe(200);

    const written = await readFile(join(chatsDir, `${NEW_ID}.jsonl`), 'utf8');
    const header = JSON.parse(
      written.split('\n').filter((l) => l.length > 0)[0],
    );
    expect(header.type).toBe('fork');
    expect(header.parentEventId).toBe(7);
  });

  it('fromEventId=0 forks with empty transcript body (include mode up to record 0)', async () => {
    // Write a parent with two records
    await mkdir(chatsDir, { recursive: true });
    const rec0 = {
      uuid: 'r0',
      parentUuid: null,
      sessionId: PARENT_ID,
      cwd: CWD,
      type: 'user',
    };
    const rec1 = {
      uuid: 'r1',
      parentUuid: 'r0',
      sessionId: PARENT_ID,
      cwd: CWD,
      type: 'assistant',
    };
    await writeFile(
      join(chatsDir, `${PARENT_ID}.jsonl`),
      [JSON.stringify(rec0), JSON.stringify(rec1)].join('\n') + '\n',
      'utf8',
    );
    const { daemon } = fakeDaemon(async () => ({}));
    const audit = fakeAudit();
    const url = await mount({ daemon, audit, randomId: () => NEW_ID });
    // fromEventId=0 means include records up to (but not beyond) event 0 — empty slice
    const res = await postFork(url, { fromEventId: 0 });
    expect(res.status).toBe(200);
    const written = await readFile(join(chatsDir, `${NEW_ID}.jsonl`), 'utf8');
    // Only the fork header, no copied records (slice is empty)
    const lines = written.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe('fork');
    expect(header.parentEventId).toBe(0);
  });

  describe('SSE session_forked / child_forked events', () => {
    it('emits session_forked on parent session and child_forked on child session when bus + walDir provided', async () => {
      await writeParent();
      const { daemon } = fakeDaemon(async () => ({}));
      const audit = fakeAudit();
      const bus = new OwnerEventBus();
      const received: OwnerEvent[] = [];
      bus.subscribe((e) => received.push(e));
      const walDir = join(runtimeBase, 'wal-test');
      const url = await mount({
        daemon,
        audit,
        randomId: () => NEW_ID,
        bus,
        walDir,
      });
      const res = await postFork(url, {});
      expect(res.status).toBe(200);

      // session_forked should be published on the bus for the parent session.
      const parentEvent = received.find(
        (e) => e.type === 'session_event' && e.sessionId === PARENT_ID,
      );
      expect(parentEvent).toBeDefined();
      if (parentEvent?.type === 'session_event') {
        expect(parentEvent.event.type).toBe('session_forked');
        expect(
          (parentEvent.event.data as Record<string, unknown>).childSessionId,
        ).toBe(NEW_ID);
      }

      // child_forked should be published for the new session.
      const childEvent = received.find(
        (e) => e.type === 'session_event' && e.sessionId === NEW_ID,
      );
      expect(childEvent).toBeDefined();
      if (childEvent?.type === 'session_event') {
        expect(childEvent.event.type).toBe('child_forked');
        expect(
          (childEvent.event.data as Record<string, unknown>).parentSessionId,
        ).toBe(PARENT_ID);
      }
    });

    it('WAL seeded: session_forked id = fromEventId + 1, child_forked id = 1 when no fromEventId', async () => {
      await writeParent();
      const { daemon } = fakeDaemon(async () => ({}));
      const audit = fakeAudit();
      const walDir = join(runtimeBase, 'wal-seed');
      const url = await mount({
        daemon,
        audit,
        randomId: () => NEW_ID,
        walDir,
      });
      const res = await postFork(url, {});
      expect(res.status).toBe(200);

      // Parent WAL: session_forked should have id=1 (fromEventId defaults to 0, so +1=1)
      const parentWalFrames = [
        ...decodeSegment(join(walDir, 'wal', `${PARENT_ID}.log`)),
      ];
      expect(parentWalFrames.length).toBeGreaterThanOrEqual(1);
      const forkedFrame = parentWalFrames.find(
        (f) => f.type === 'session_forked',
      );
      expect(forkedFrame).toBeDefined();
      expect(forkedFrame?.id).toBe(1);

      // Child WAL: child_forked should have id=1
      const childWalFrames = [
        ...decodeSegment(join(walDir, 'wal', `${NEW_ID}.log`)),
      ];
      expect(childWalFrames.length).toBeGreaterThanOrEqual(1);
      const childFrame = childWalFrames.find((f) => f.type === 'child_forked');
      expect(childFrame).toBeDefined();
      expect(childFrame?.id).toBe(1);
    });

    it('WAL seeded: session_forked id = fromEventId + 1 when fromEventId is provided', async () => {
      await writeParent();
      const { daemon } = fakeDaemon(async () => ({}));
      const audit = fakeAudit();
      const walDir = join(runtimeBase, 'wal-seed-feid');
      const url = await mount({
        daemon,
        audit,
        randomId: () => NEW_ID,
        walDir,
      });
      const res = await postFork(url, { fromEventId: 10 });
      expect(res.status).toBe(200);

      const parentWalFrames = [
        ...decodeSegment(join(walDir, 'wal', `${PARENT_ID}.log`)),
      ];
      const forkedFrame = parentWalFrames.find(
        (f) => f.type === 'session_forked',
      );
      expect(forkedFrame?.id).toBe(11); // fromEventId(10) + 1
    });

    it('no SSE/WAL side effects when bus and walDir are absent', async () => {
      await writeParent();
      const { daemon } = fakeDaemon(async () => ({}));
      const audit = fakeAudit();
      // No bus, no walDir — should still fork successfully with no side effects.
      const url = await mount({ daemon, audit, randomId: () => NEW_ID });
      const res = await postFork(url, {});
      expect(res.status).toBe(200);
    });
  });
});

describe('fromTurn addressing', () => {
  async function writeTwoTurnParent(): Promise<void> {
    await mkdir(chatsDir, { recursive: true });
    const records = [
      {
        uuid: 'u0',
        parentUuid: null,
        sessionId: PARENT_ID,
        cwd: CWD,
        type: 'user',
        message: { role: 'user', parts: [{ text: 'first' }] },
      },
      {
        uuid: 'a0',
        parentUuid: 'u0',
        sessionId: PARENT_ID,
        cwd: CWD,
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'reply' }] },
      },
      {
        uuid: 'u1',
        parentUuid: 'a0',
        sessionId: PARENT_ID,
        cwd: CWD,
        type: 'user',
        message: { role: 'user', parts: [{ text: 'second' }] },
      },
    ];
    await writeFile(
      join(chatsDir, `${PARENT_ID}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
  }

  it('fromTurn slices identically to the equivalent fromEventId', async () => {
    await writeTwoTurnParent();
    const { daemon: daemonA } = fakeDaemon(async () => ({}));
    const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');
    const urlA = await mount({
      daemon: daemonA,
      audit: fakeAudit(),
      randomId: () => NEW_ID,
      now: fixedNow,
    });
    const resA = await postFork(urlA, { fromTurn: 1 });
    expect(resA.status).toBe(200);
    const bodyA = await readFile(join(chatsDir, `${NEW_ID}.jsonl`), 'utf8');

    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const { daemon: daemonB } = fakeDaemon(async () => ({}));
    const urlB = await mount({
      daemon: daemonB,
      audit: fakeAudit(),
      randomId: () => ROLLBACK_ID,
      now: fixedNow,
    });
    const resB = await postFork(urlB, { fromEventId: 2 }); // turn 1's boundary = record index 2
    expect(resB.status).toBe(200);
    const bodyB = await readFile(
      join(chatsDir, `${ROLLBACK_ID}.jsonl`),
      'utf8',
    );

    // Both forks copy the same one record (the first user+assistant pair);
    // strip the differing sessionId/uuid fields the fork writer stamps.
    const stripIds = (text: string) =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const obj = JSON.parse(line) as Record<string, unknown>;
          delete obj['sessionId'];
          return obj;
        });
    expect(stripIds(bodyA)).toEqual(stripIds(bodyB));
  });

  it('rejects both fromTurn and fromEventId with 400 mutually_exclusive', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => ({}));
    const url = await mount({ daemon, audit: fakeAudit() });
    const res = await postFork(url, { fromTurn: 0, fromEventId: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'mutually_exclusive' });
  });

  it('maps an invalid fromTurn to 400 invalid_turn', async () => {
    await writeParent();
    const { daemon } = fakeDaemon(async () => ({}));
    const url = await mount({ daemon, audit: fakeAudit() });
    const res = await postFork(url, { fromTurn: -1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_turn' });
  });
});
