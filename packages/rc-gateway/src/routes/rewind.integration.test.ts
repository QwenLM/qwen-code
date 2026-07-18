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
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonClient } from '@qwen-code/sdk';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { createRewindRoute } from './rewind.js';
import { createSessionEventsRoute } from './sessionEvents.js';
import { ConnectionRegistry } from '../connectionRegistry.js';
import { SessionWal, decodeSegment } from '../wal.js';

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
  it('attach -> rewind -> marker on the live stream -> late reconnect replays across it', async () => {
    await writeTranscript(3);
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'one' } },
        { id: 2, type: 'session_update', data: { text: 'two' } },
      ],
      workspaceCwd: CWD,
      rewindResult: { targetTurnIndex: 1, apiTruncateIndex: 4 },
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.rcClient = { id: 'owner-1', scopes: ['owner'] };
      next();
    });
    const registry = new ConnectionRegistry();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(daemon, registry, undefined, undefined, walDir),
    );
    app.post(
      '/session/:id/rewind',
      createRewindRoute(daemon, async () => CWD, { walDir }),
    );
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Attach and drain the live stream once so its 2 daemon frames land
    //    in the WAL (createSessionEventsRoute appends every frame it relays).
    const attachRes = await fetch(`${baseUrl}/session/${SESSION_ID}/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(attachRes.status).toBe(200);
    await attachRes.text(); // stub ends the stream after its 2 frames

    // 2. Rewind to turn 1.
    const rewindRes = await fetch(`${baseUrl}/session/${SESSION_ID}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toTurn: 1 }),
    });
    expect(rewindRes.status).toBe(202);
    const rewindBody = (await rewindRes.json()) as {
      toTurn: number;
      truncatedEventId: number;
    };
    expect(rewindBody.toTurn).toBe(1);

    // 3. Exactly one session_rewound marker exists in the WAL, positioned
    //    after the 2 relayed frames.
    const wal = new SessionWal({ dir: walDir, sessionId: SESSION_ID });
    expect(wal.count()).toBe(3);
    expect(wal.latestId()).toBe(3);
    wal.close();
    const frames = [...decodeSegment(join(walDir, 'wal', `${SESSION_ID}.log`))];
    const marker = frames.find((f) => f.type === 'session_rewound');
    expect(marker).toBeDefined();
    expect(marker!.id).toBe(3);
    expect((marker!.data as { toTurn: number }).toTurn).toBe(1);

    // 4. A late reconnect with Last-Event-ID: 1 replays events 2 and 3
    //    (the second daemon frame, then the marker) from the WAL, without
    //    the daemon stub needing to be asked again for those two ids.
    const lateRes = await fetch(`${baseUrl}/session/${SESSION_ID}/events`, {
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': '1',
      },
    });
    expect(lateRes.status).toBe(200);
    const replayed = await lateRes.text();
    expect(replayed).toContain('"type":"session_rewound"');
    expect(replayed).toContain('"toTurn":1');
  });
});
