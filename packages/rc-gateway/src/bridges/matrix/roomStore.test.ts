/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatrixRoomStore } from './roomStore.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-mx-room-'));
  path = join(dir, 'rooms.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('MatrixRoomStore', () => {
  it('binds, looks up, and reverse-looks-up by session', async () => {
    const s = await MatrixRoomStore.open(path);
    await s.bind('!abc:home.example.com', 'sess_xyz', '2026-01-01T00:00:00Z');
    expect(s.sessionFor('!abc:home.example.com')).toBe('sess_xyz');
    expect(s.roomsFor('sess_xyz')).toEqual(['!abc:home.example.com']);
    expect(s.boundSessions()).toEqual(['sess_xyz']);
    expect(s.all()[0]).toEqual({
      roomId: '!abc:home.example.com',
      sessionId: 'sess_xyz',
      boundAt: '2026-01-01T00:00:00Z',
    });
  });

  it('persists across reload (opaque room id verbatim)', async () => {
    const s1 = await MatrixRoomStore.open(path);
    await s1.bind('!room:other-server.org', 'sess_q');
    const s2 = await MatrixRoomStore.open(path);
    expect(s2.sessionFor('!room:other-server.org')).toBe('sess_q');
  });

  it('overwrites a re-attached room', async () => {
    const s = await MatrixRoomStore.open(path);
    await s.bind('!r:h', 'sess_old');
    await s.bind('!r:h', 'sess_new');
    expect(s.sessionFor('!r:h')).toBe('sess_new');
    expect(s.roomsFor('sess_old')).toEqual([]);
  });

  it('unbind removes and reports prior existence', async () => {
    const s = await MatrixRoomStore.open(path);
    await s.bind('!r:h', 'sess_q');
    expect(await s.unbind('!r:h')).toBe(true);
    expect(await s.unbind('!r:h')).toBe(false);
    expect(s.sessionFor('!r:h')).toBeUndefined();
  });

  it('a missing or corrupt file opens empty (never throws)', async () => {
    expect((await MatrixRoomStore.open(path)).all()).toEqual([]);
    await writeFile(path, 'not json {{{');
    expect((await MatrixRoomStore.open(path)).all()).toEqual([]);
  });

  it('skips malformed rows but keeps valid ones', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        rooms: [
          { roomId: '!r1:h', sessionId: 'sess_ok', boundAt: '' },
          { roomId: '!r2:h' }, // missing sessionId
          'garbage',
        ],
      }),
    );
    const s = await MatrixRoomStore.open(path);
    expect(s.all().map((b) => b.roomId)).toEqual(['!r1:h']);
  });
});
