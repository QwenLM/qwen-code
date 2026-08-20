/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonClient } from '@qwen-code/sdk';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { SessionWal, decodeSegment } from '../wal.js';
import type { OwnerEvent } from '../ownerEvents.js';

const CWD = '/rewind-integration/ws';
const SESSION_ID = '22222222222222222222222222222222';

let server: Server | undefined;
let runtimeBase: string;
let chatsDir: string;
let walDir: string;
let stub: StubDaemon | undefined;

async function writeTranscript(userTurns: number): Promise<void> {
  await mkdir(chatsDir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < userTurns; i++) {
    lines.push(
      JSON.stringify({
        uuid: `u${i}`,
        sessionId: SESSION_ID,
        cwd: CWD,
        type: 'user',
        message: { role: 'user', parts: [{ text: `turn ${i}` }] },
      }),
    );
  }
  await writeFile(
    join(chatsDir, `${SESSION_ID}.jsonl`),
    lines.join('\n') + '\n',
    'utf8',
  );
}

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-rewind-integ-'));
  process.env['QWEN_RUNTIME_DIR'] = runtimeBase;
  delete process.env['QWEN_HOME'];
  chatsDir = resolveChatsDir(CWD);
  walDir = join(runtimeBase, 'wal-root');
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  delete process.env['QWEN_RUNTIME_DIR'];
  await rm(runtimeBase, { recursive: true, force: true });
});

describe('rewind integration', () => {
  it('attach (real SESSION_READ mount) -> rewind (real OWNER auth mount) -> WAL marker + owner-bus frame both carry the correct truncatedEventId; a write-scope token is refused', async () => {
    // 3 single-record user turns (u0, u1, u2) written directly to the parent
    // transcript, so `resolveTurn`'s `userTurnIndices` is exactly [0, 1, 2] —
    // the record-array index IS the turn number. Rewinding to toTurn: 1 must
    // therefore yield truncatedEventId 1 (userTurnIndices[1]); this is the
    // value turnResolver.ts computes, not anything read back post hoc from the
    // response.
    await writeTranscript(3);
    const EXPECTED_TRUNCATED_EVENT_ID = 1;

    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'one' } },
        { id: 2, type: 'session_update', data: { text: 'two' } },
      ],
      workspaceCwd: CWD,
      // The daemon is promptId-keyed post-merge: the gateway maps toTurn 1
      // onto the snapshot whose turnIndex is 1 and rewinds to its promptId.
      rewindResult: {
        rewound: true,
        targetTurnIndex: 1,
        filesChanged: [],
        filesFailed: [],
      },
      rewindSnapshots: [0, 1, 2].map((i) => ({
        promptId: `${SESSION_ID}########${i}`,
        turnIndex: i,
        timestamp: `2026-01-01T00:00:0${i}.000Z`,
        diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
      })),
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });

    // Real app: real TokenStore, real requireScope(OWNER)/bearerResolve mount
    // (server.ts wires POST /session/:id/rewind behind requireScope(OWNER),
    // GET /session/:id/events behind requireScope(SESSION_READ)) — no
    // hand-rolled express() app and no req.rcClient injection.
    const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
    const { token: ownerToken, id: ownerTokenId } = await store.issue(
      ['owner'],
      'owner-1',
    );
    const { token: writeToken } = await store.issue(['write'], 'writer-1');

    const gw = createGatewayApp({
      daemon,
      store,
      pairing: new PairingService(),
      auditPath: join(runtimeBase, 'audit.log'),
      walDir,
    });
    // The owner-event bus is the production emit surface for the
    // session_rewound marker (createGatewayApp wires `bus: ownerEvents` into
    // the rewind route). Subscribing here mirrors agents.integration.test.ts's
    // pattern of observing real gateway-internal fan-out, not a hand-rolled
    // stand-in bus.
    const ownerFrames: OwnerEvent[] = [];
    gw.ownerEvents.subscribe((e) => ownerFrames.push(e));

    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Attach and drain the live stream once, through the real
    //    requireScope(SESSION_READ) mount, proving the OWNER token also
    //    carries session:read (via SCOPE_IMPLIES) and the real bearer auth
    //    resolves it.
    //
    //    NOTE: unlike a hand-wired `createSessionEventsRoute(..., walDir)`,
    //    createGatewayApp's own mount of GET /session/:id/events passes
    //    `walDir: undefined` (server.ts's comment: "Omitted in production
    //    today — ... currently-dark wiring path"). So through the REAL app,
    //    this attach does NOT append the daemon's frames to the WAL, and a
    //    later reconnect cannot replay a rewind marker from it either. Only
    //    the rewind route itself is wired with `deps.walDir`. Asserting a
    //    WAL-replay-across-rewind here would mean re-introducing a
    //    hand-wired walDir into the events route — the same "test exercises
    //    a path production doesn't have" defect this rewrite is fixing for
    //    auth. So the WAL/marker assertions below are checked directly (via
    //    decodeSegment) and via the owner-bus frame instead of via a second
    //    SSE reconnect.
    const attachRes = await fetch(`${baseUrl}/session/${SESSION_ID}/events`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${ownerToken}`,
      },
    });
    expect(attachRes.status).toBe(200);
    await attachRes.text(); // stub ends the stream after its 2 frames

    // 1b. A write-scope token issuing the SAME rewind request through the
    //     SAME mounted route must be refused. This proves requireScope(OWNER)
    //     is actually in the request path — a write-scope token carries
    //     `session:read` (via SCOPE_IMPLIES) but never `owner`, so this can
    //     only pass if the real auth mount is exercised, not bypassed.
    const forbiddenRes = await fetch(
      `${baseUrl}/session/${SESSION_ID}/rewind`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${writeToken}`,
        },
        body: JSON.stringify({ toTurn: 1 }),
      },
    );
    expect(forbiddenRes.status).toBe(403);
    // No daemon call, no WAL marker: the write-scope attempt must be a total
    // no-op, not a partial rewind. Through the real app the events attach
    // above never wrote to the WAL (see note above), so the WAL is still
    // empty at this point.
    const walAfterForbidden = new SessionWal({
      dir: walDir,
      sessionId: SESSION_ID,
    });
    expect(walAfterForbidden.count()).toBe(0);
    walAfterForbidden.close();

    // 2. Rewind to turn 1, with the OWNER token, through the real mount.
    const rewindRes = await fetch(`${baseUrl}/session/${SESSION_ID}/rewind`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ toTurn: 1 }),
    });
    expect(rewindRes.status).toBe(202);
    const rewindBody = (await rewindRes.json()) as {
      toTurn: number;
      truncatedEventId: number;
    };
    expect(rewindBody.toTurn).toBe(1);
    expect(rewindBody.truncatedEventId).toBe(EXPECTED_TRUNCATED_EVENT_ID);

    // The real SDK client rewound to the promptId of the snapshot whose
    // turnIndex is 1 — the toTurn→promptId mapping happened end to end, not
    // by passing the raw turn number upstream.
    expect(stub.lastRewindBody).toMatchObject({
      promptId: `${SESSION_ID}########1`,
    });

    // 3. Exactly one session_rewound marker exists in the WAL (the rewind
    //    route itself is wired with `deps.walDir`, unlike the events route).
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(1);
    expect(wal.latestId()).toBe(1);
    wal.close();
    const frames = [...decodeSegment(join(walDir, 'wal', `${SESSION_ID}.log`))];
    const marker = frames.find((f) => f.type === 'session_rewound');
    expect(marker).toBeDefined();
    expect(marker!.id).toBe(1);
    expect(
      (marker!.data as { toTurn: number; truncatedEventId: number }).toTurn,
    ).toBe(1);
    expect(
      (marker!.data as { toTurn: number; truncatedEventId: number })
        .truncatedEventId,
    ).toBe(EXPECTED_TRUNCATED_EVENT_ID);

    // 4. The SAME marker, on the owner-bus production emit surface
    //    (createGatewayApp's `bus: ownerEvents` wiring), also carries the
    //    correct truncatedEventId, and its rewoundByTokenId is the
    //    AUTHENTICATED owner token's id — never anything from the request
    //    body — tying the real-auth actor to the real-marker coordinate.
    const ownerMarker = ownerFrames.find(
      (f): f is Extract<OwnerEvent, { type: 'session_event' }> =>
        f.type === 'session_event' && f.event.type === 'session_rewound',
    );
    expect(ownerMarker).toBeDefined();
    expect(ownerMarker!.sessionId).toBe(SESSION_ID);
    expect(ownerMarker!.event.data).toMatchObject({
      toTurn: 1,
      truncatedEventId: EXPECTED_TRUNCATED_EVENT_ID,
      rewoundByTokenId: ownerTokenId,
    });
  });
});
