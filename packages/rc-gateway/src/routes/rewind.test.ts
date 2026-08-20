/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonRewindSnapshotInfo } from '@qwen-code/sdk/daemon';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { createRewindRoute, type RewindDaemon } from './rewind.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { SessionWal, decodeSegment } from '../wal.js';
import { PromptQueue } from './promptQueue.js';

const CWD = '/rewind-test/ws';
const SESSION_ID = '11111111111111111111111111111111';

let server: Server | undefined;
let runtimeBase: string;
let chatsDir: string;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

/**
 * Build the daemon-side rewind snapshot list for a transcript of `turnCount`
 * user turns. The daemon keeps one snapshot per user turn (turnIndex 0..N-1);
 * the tip (turnIndex N) has none. `promptId` mirrors the daemon's real
 * convention of keying a snapshot by the prompt id that produced it.
 */
function makeSnapshots(turnCount: number): DaemonRewindSnapshotInfo[] {
  const out: DaemonRewindSnapshotInfo[] = [];
  for (let i = 0; i < turnCount; i++) {
    out.push({
      promptId: `${SESSION_ID}########${i}`,
      turnIndex: i,
      timestamp: `2026-01-01T00:00:0${i}.000Z`,
      diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
    });
  }
  return out;
}

/**
 * Fake `RewindDaemon` (the `getRewindSnapshots` + `rewindSession` pair the
 * route consumes). Records every `rewindSession` call's `(id, promptId)` and
 * counts `getRewindSnapshots` invocations so tests can assert which promptId
 * the route mapped `toTurn` onto, or that the daemon was never touched.
 */
function fakeDaemon(
  opts: {
    snapshots?: DaemonRewindSnapshotInfo[];
    /** Override the rewindSession body/throw; defaults to a clean success. */
    rewind?: (id: string, promptId: string) => Promise<unknown> | unknown;
  } = {},
) {
  const rewindCalls: Array<{ id: string; promptId: string }> = [];
  let snapshotCalls = 0;
  const snapshots = opts.snapshots ?? [];
  const daemon: RewindDaemon = {
    getRewindSnapshots: async (_id: string) => {
      snapshotCalls += 1;
      return { snapshots };
    },
    rewindSession: async (id: string, promptId: string) => {
      rewindCalls.push({ id, promptId });
      if (opts.rewind) return await opts.rewind(id, promptId);
      return {
        rewound: true,
        targetTurnIndex: 0,
        filesChanged: [],
        filesFailed: [],
      };
    },
  };
  return {
    rewindCalls,
    get snapshotCalls() {
      return snapshotCalls;
    },
    daemon,
  };
}

async function writeTranscript(userTurns: number): Promise<void> {
  await mkdir(chatsDir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < userTurns; i++) {
    lines.push(
      JSON.stringify({
        uuid: `u${i}`,
        parentUuid: i === 0 ? null : `a${i - 1}`,
        sessionId: SESSION_ID,
        cwd: CWD,
        type: 'user',
        message: { role: 'user', parts: [{ text: `turn ${i}` }] },
      }),
    );
    lines.push(
      JSON.stringify({
        uuid: `a${i}`,
        parentUuid: `u${i}`,
        sessionId: SESSION_ID,
        cwd: CWD,
        type: 'assistant',
        message: { role: 'model', parts: [{ text: `reply ${i}` }] },
      }),
    );
  }
  await writeFile(
    join(chatsDir, `${SESSION_ID}.jsonl`),
    lines.join('\n') + '\n',
    'utf8',
  );
}

interface MountOpts {
  daemon: RewindDaemon;
  audit?: AuditRecorder;
  bus?: OwnerEventBus;
  walDir?: string;
  queue?: PromptQueue;
  now?: () => Date;
}

async function mount(opts: MountOpts): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok1', scopes: ['owner'] };
    next();
  });
  app.post(
    '/session/:id/rewind',
    createRewindRoute(opts.daemon, async () => CWD, {
      audit: opts.audit,
      bus: opts.bus,
      walDir: opts.walDir,
      queue: opts.queue,
      now: opts.now,
    }),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postRewind(
  url: string,
  body: unknown,
  id = SESSION_ID,
): Promise<Response> {
  return fetch(`${url}/session/${id}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-rewind-route-'));
  process.env['QWEN_RUNTIME_DIR'] = runtimeBase;
  delete process.env['QWEN_HOME'];
  chatsDir = resolveChatsDir(CWD);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  delete process.env['QWEN_RUNTIME_DIR'];
  await rm(runtimeBase, { recursive: true, force: true });
});

describe('POST /session/:id/rewind', () => {
  it('happy path: 202 with toTurn + truncatedEventId, one WAL marker, one audit row', async () => {
    await writeTranscript(3);
    const { daemon, rewindCalls } = fakeDaemon({
      snapshots: makeSnapshots(3),
    });
    const audit = fakeAudit();
    const bus = new OwnerEventBus();
    const seen: OwnerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const walDir = join(runtimeBase, 'wal');
    const url = await mount({ daemon, audit, bus, walDir });

    const res = await postRewind(url, { toTurn: 1 });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      toTurn: number;
      truncatedEventId: number;
    };
    expect(body.toTurn).toBe(1);
    expect(body.truncatedEventId).toBe(2); // turn 1 boundary = record index 2

    // The route mapped toTurn 1 onto the daemon snapshot whose turnIndex is
    // 1 and rewound to THAT snapshot's promptId (never the toTurn itself —
    // the daemon is promptId-keyed post-merge).
    expect(rewindCalls).toEqual([
      { id: SESSION_ID, promptId: `${SESSION_ID}########1` },
    ]);

    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'session_rewound',
      actorTokenId: 'tok1',
      target: SESSION_ID,
      detail: { toTurn: 1, truncatedEventId: 2 },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'session_event',
      sessionId: SESSION_ID,
      event: {
        type: 'session_rewound',
        data: { toTurn: 1, truncatedEventId: 2 },
      },
    });

    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(1);
    const [frame] = [
      ...decodeSegment(join(walDir, 'wal', `${SESSION_ID}.log`)),
    ];
    expect(frame).toMatchObject({ id: 1, type: 'session_rewound' });
    // The persisted marker carries the full payload, including the actor id
    // derived from the authenticated client (never the request body).
    expect(frame.data).toMatchObject({
      toTurn: 1,
      truncatedEventId: 2,
      rewoundByTokenId: 'tok1',
    });
    expect((frame.data as { rewoundAt?: unknown }).rewoundAt).toEqual(
      expect.any(String),
    );
    wal.close();
  });

  it('409 rewind_in_progress when the prompt queue slot is held', async () => {
    await writeTranscript(2);
    const { daemon, rewindCalls, snapshotCalls } = fakeDaemon({
      snapshots: makeSnapshots(2),
    });
    const queue = new PromptQueue();
    const release = await queue.acquire(SESSION_ID, 60_000); // hold the slot
    const url = await mount({ daemon, queue });

    const res = await postRewind(url, { toTurn: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'rewind_in_progress' });
    // The daemon must never be touched while a prompt holds the slot —
    // neither the snapshots lookup nor the rewind itself.
    expect(rewindCalls).toHaveLength(0);
    expect(snapshotCalls).toBe(0);
    release();
  });

  it('400 invalid_turn for a negative toTurn; daemon never called', async () => {
    await writeTranscript(1);
    const { daemon, rewindCalls } = fakeDaemon({
      snapshots: makeSnapshots(1),
    });
    const url = await mount({ daemon });

    const res = await postRewind(url, { toTurn: -1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_turn' });
    expect(rewindCalls).toHaveLength(0);
  });

  it('409 rewind_not_applicable when toTurn is beyond the last turn', async () => {
    await writeTranscript(1);
    const { daemon, rewindCalls } = fakeDaemon({
      snapshots: makeSnapshots(1),
    });
    const url = await mount({ daemon });

    const res = await postRewind(url, { toTurn: 9 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'rewind_not_applicable' });
    // Rejected by the resolver before the daemon is ever consulted.
    expect(rewindCalls).toHaveLength(0);
  });

  it('saga rollback: daemon failure yields 502, no WAL marker, no audit', async () => {
    await writeTranscript(2);
    const { daemon } = fakeDaemon({
      snapshots: makeSnapshots(2),
      rewind: () => {
        throw new Error('daemon exploded');
      },
    });
    const audit = fakeAudit();
    const walDir = join(runtimeBase, 'wal');
    const url = await mount({ daemon, audit, walDir });

    const res = await postRewind(url, { toTurn: 1 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'daemon_unavailable' });
    expect(audit.calls).toHaveLength(0);

    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(0);
    wal.close();
  });

  it("maps the daemon's own 409 to 409 rewind_in_progress (not 502)", async () => {
    await writeTranscript(2);
    const audit = fakeAudit();
    const walDir = join(runtimeBase, 'wal');
    const { daemon } = fakeDaemon({
      snapshots: makeSnapshots(2),
      rewind: () => {
        throw Object.assign(new Error('rewind_in_progress'), { status: 409 });
      },
    });
    const url = await mount({ daemon, audit, walDir });

    const res = await postRewind(url, { toTurn: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'rewind_in_progress' });
    // Still a clean rollback: no marker, no audit.
    expect(audit.calls).toHaveLength(0);
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(0);
    wal.close();
  });

  it('maps a non-409 daemon HTTP error (e.g. 500) to 502 daemon_unavailable', async () => {
    await writeTranscript(2);
    const { daemon } = fakeDaemon({
      snapshots: makeSnapshots(2),
      rewind: () => {
        throw Object.assign(new Error('boom'), { status: 500 });
      },
    });
    const url = await mount({ daemon });

    const res = await postRewind(url, { toTurn: 1 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'daemon_unavailable' });
  });

  it('marker retry: a single WAL append failure is retried and the marker persists (202)', async () => {
    await writeTranscript(2);
    const { daemon } = fakeDaemon({ snapshots: makeSnapshots(2) });
    const audit = fakeAudit();
    const walDir = join(runtimeBase, 'wal');
    const url = await mount({ daemon, audit, walDir });

    // Fail the FIRST append only; the retry reverts to the real implementation.
    const spy = vi
      .spyOn(SessionWal.prototype, 'append')
      .mockImplementationOnce(() => {
        throw new Error('transient write failure');
      });

    const res = await postRewind(url, { toTurn: 1 });
    expect(res.status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(2); // one failed + one successful retry
    expect(audit.calls).toHaveLength(1);

    // The marker was actually durably written by the retry.
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(1);
    wal.close();
  });

  it('marker retry exhausted: two WAL append failures yield 500 rewind_marker_failed, no audit, no marker', async () => {
    await writeTranscript(2);
    const { daemon, rewindCalls } = fakeDaemon({
      snapshots: makeSnapshots(2),
    });
    const audit = fakeAudit();
    const walDir = join(runtimeBase, 'wal');
    const url = await mount({ daemon, audit, walDir });

    // Every append throws → both the initial attempt and the retry fail.
    const spy = vi
      .spyOn(SessionWal.prototype, 'append')
      .mockImplementation(() => {
        throw new Error('persistent write failure');
      });
    // The loud-log side effect must not spam the test output; assert it fired.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postRewind(url, { toTurn: 1 });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'rewind_marker_failed' });
    expect(spy).toHaveBeenCalledTimes(2);
    // The daemon already rewound — that call happened exactly once.
    expect(rewindCalls).toHaveLength(1);
    // Atomicity: marker absent → audit MUST also be absent.
    expect(audit.calls).toHaveLength(0);
    // Divergence was logged loudly.
    expect(errorSpy).toHaveBeenCalled();

    // Nothing was persisted (real append never ran).
    spy.mockRestore();
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(0);
    wal.close();
  });

  it('close() failure after a durable append still records audit + publishes + 202, marker persists', async () => {
    await writeTranscript(2);
    const { daemon } = fakeDaemon({ snapshots: makeSnapshots(2) });
    const audit = fakeAudit();
    const bus = new OwnerEventBus();
    const seen: OwnerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const walDir = join(runtimeBase, 'wal');
    const url = await mount({ daemon, audit, bus, walDir });

    // The marker append succeeds (real impl → bytes durable via writeSync), but
    // close() throws — a realistic deferred-writeback EIO on NFS. This must NOT
    // abort the post-commit steps: the marker is already committed on disk.
    const closeSpy = vi
      .spyOn(SessionWal.prototype, 'close')
      .mockImplementation(() => {
        throw new Error('EIO on close (deferred writeback)');
      });
    // The swallowed-close log must not spam test output; assert it fired.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postRewind(url, { toTurn: 1 });
    // Success, not 500 rewind_failed: append succeeded ⇒ committed.
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ toTurn: 1, truncatedEventId: 2 });

    // The invariant: marker durable ⇒ audit written AND frame published.
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'session_rewound',
      actorTokenId: 'tok1',
      target: SESSION_ID,
      detail: { toTurn: 1, truncatedEventId: 2 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'session_event',
      sessionId: SESSION_ID,
      event: { type: 'session_rewound', data: { toTurn: 1 } },
    });
    // close() failure was swallowed + logged, not thrown.
    expect(errorSpy).toHaveBeenCalled();

    // The marker really is on disk (append happened before close threw).
    closeSpy.mockRestore();
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(1);
    const [frame] = [
      ...decodeSegment(join(walDir, 'wal', `${SESSION_ID}.log`)),
    ];
    expect(frame).toMatchObject({ id: 1, type: 'session_rewound' });
    wal.close();
  });

  it('multi-client fan-out: two subscribers both observe the marker', async () => {
    await writeTranscript(2);
    const { daemon } = fakeDaemon({ snapshots: makeSnapshots(2) });
    const bus = new OwnerEventBus();
    const seenA: OwnerEvent[] = [];
    const seenB: OwnerEvent[] = [];
    bus.subscribe((e) => seenA.push(e));
    bus.subscribe((e) => seenB.push(e));
    const url = await mount({ daemon, bus });

    await postRewind(url, { toTurn: 1 });
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenA[0]).toMatchObject({
      type: 'session_event',
      sessionId: SESSION_ID,
      event: { type: 'session_rewound', data: { toTurn: 1 } },
    });
  });

  it('releases the queue slot after completion so a subsequent prompt can acquire it', async () => {
    await writeTranscript(1);
    const { daemon } = fakeDaemon({ snapshots: makeSnapshots(1) });
    const queue = new PromptQueue();
    const url = await mount({ daemon, queue });

    const res = await postRewind(url, { toTurn: 0 });
    expect(res.status).toBe(202);

    // If the rewind route failed to release, this acquire would hang past
    // the deadline and reject with QueueTimeoutError.
    const release = await queue.acquire(SESSION_ID, 1000);
    release();
  });

  it('tip (toTurn === addressableTurnCount): daemon NOT called, still 202 + marker + audit', async () => {
    await writeTranscript(3); // 3 user turns → tip is toTurn 3
    // Defensive: if the route ever (incorrectly) reached the daemon, the
    // rewind would throw and we'd get 502, not 202. The call counters below
    // also prove the daemon was never touched.
    const { daemon, rewindCalls, snapshotCalls } = fakeDaemon({
      snapshots: makeSnapshots(3),
      rewind: () => {
        throw new Error('daemon must not be called for a tip rewind');
      },
    });
    const audit = fakeAudit();
    const walDir = join(runtimeBase, 'wal');
    const url = await mount({ daemon, audit, walDir });

    const res = await postRewind(url, { toTurn: 3 });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      toTurn: number;
      truncatedEventId: number;
    };
    expect(body.toTurn).toBe(3);
    expect(body.truncatedEventId).toBe(6); // tip → whole transcript (3 turns × 2 records)

    // A tip rewind truncates nothing: the daemon (snapshots + rewind) is
    // NEVER called — only the gateway-side marker is recorded.
    expect(rewindCalls).toHaveLength(0);
    expect(snapshotCalls).toBe(0);

    // The marker + audit are still written (preserves the pre-merge no-op
    // behavior for a tip rewind).
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'session_rewound',
      detail: { toTurn: 3, truncatedEventId: 6 },
    });
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(1);
    wal.close();
  });

  it('409 rewind_not_applicable when a non-tip toTurn has no matching daemon snapshot (views diverged)', async () => {
    await writeTranscript(3); // 3 user turns → toTurn 1 is a valid non-tip boundary
    // The daemon's snapshot list is missing the turnIndex 1 snapshot (e.g. the
    // daemon was already rewound from the TUI and no longer supports that
    // boundary). The resolver accepted toTurn 1, but the daemon cannot honor it.
    const { daemon, rewindCalls } = fakeDaemon({
      snapshots: makeSnapshots(3).filter((s) => s.turnIndex !== 1),
    });
    const audit = fakeAudit();
    const walDir = join(runtimeBase, 'wal');
    const url = await mount({ daemon, audit, walDir });

    const res = await postRewind(url, { toTurn: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'rewind_not_applicable' });
    // The snapshots lookup ran (to find the missing snapshot) but the rewind
    // itself never fired — and nothing was persisted.
    expect(rewindCalls).toHaveLength(0);
    expect(audit.calls).toHaveLength(0);
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(0);
    wal.close();
  });
});
