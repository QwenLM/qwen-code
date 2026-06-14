/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  MatrixStreamRouter,
  MatrixStreamBuffer,
  MX_FLUSH_MAX_BYTES,
  type MatrixStreamPoster,
} from './streamRouter.js';

function harness(roomsFor: (s: string) => string[]) {
  const sent: Array<{
    roomId: string;
    text: string;
    threadRootEventId?: string;
  }> = [];
  let nextEvt = 1;
  const timers: Array<() => void> = [];
  const poster: MatrixStreamPoster = {
    sendStream: async (roomId, opts) => {
      sent.push({ roomId, ...opts });
      return `$evt_${nextEvt++}`;
    },
  };
  const router = new MatrixStreamRouter({
    poster,
    roomsFor,
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  return {
    router,
    sent,
    fireTimers: () => {
      for (const fn of timers.splice(0)) fn();
    },
  };
}

describe('MatrixStreamBuffer', () => {
  it('flushes on paragraph break, fence close, and the byte cap', () => {
    const b = new MatrixStreamBuffer();
    b.append('hi');
    expect(b.hardDue()).toBe(false);
    b.append('\n\nthere');
    expect(b.hardDue()).toBe(true);

    const c = new MatrixStreamBuffer();
    c.append('x'.repeat(MX_FLUSH_MAX_BYTES));
    expect(c.hardDue()).toBe(true);
  });
});

describe('MatrixStreamRouter', () => {
  it('buffers then sends a single event to the room on a hard trigger', async () => {
    const h = harness(() => ['!r:h']);
    h.router.onChunk('s', 'partial '); // no trigger
    await h.router.whenIdle();
    expect(h.sent).toEqual([]);
    h.router.onChunk('s', 'rest\n\n'); // paragraph → flush
    await h.router.whenIdle();
    expect(h.sent).toEqual([{ roomId: '!r:h', text: 'partial rest\n\n' }]);
  });

  it('flushes on the idle timer', async () => {
    const h = harness(() => ['!r:h']);
    h.router.onChunk('s', 'quiet line');
    expect(h.sent).toEqual([]);
    h.fireTimers();
    await h.router.whenIdle();
    expect(h.sent[0].text).toBe('quiet line');
  });

  it('relates the 7th+ message of a turn into the thread off the first message', async () => {
    const h = harness(() => ['!r:h']);
    for (let i = 1; i <= 6; i++) {
      h.router.onChunk('s', `m${i}\n\n`);
      await h.router.whenIdle();
    }
    // first six carry no thread relation
    expect(h.sent.every((m) => m.threadRootEventId === undefined)).toBe(true);

    h.router.onChunk('s', 'm7\n\n');
    await h.router.whenIdle();
    expect(h.sent[6].threadRootEventId).toBe('$evt_1'); // first message of turn
    h.router.onChunk('s', 'm8\n\n');
    await h.router.whenIdle();
    expect(h.sent[7].threadRootEventId).toBe('$evt_1'); // stays in the thread
  });

  it('a new turn (after resolve) does not reuse the thread', async () => {
    const h = harness(() => ['!r:h']);
    for (let i = 1; i <= 7; i++) {
      h.router.onChunk('s', `m${i}\n\n`);
      await h.router.whenIdle();
    }
    expect(h.sent[6].threadRootEventId).toBe('$evt_1');
    h.router.notePermissionResolved('s');
    h.router.onChunk('s', 'newturn\n\n');
    await h.router.whenIdle();
    expect(h.sent[h.sent.length - 1].threadRootEventId).toBeUndefined();
  });

  it('a new inbound prompt also ends the turn', async () => {
    const h = harness(() => ['!r:h']);
    for (let i = 1; i <= 7; i++) {
      h.router.onChunk('s', `m${i}\n\n`);
      await h.router.whenIdle();
    }
    h.router.bumpTurn('s');
    h.router.onChunk('s', 'after\n\n');
    await h.router.whenIdle();
    expect(h.sent[h.sent.length - 1].threadRootEventId).toBeUndefined();
  });

  it('fans out to every bound room', async () => {
    const h = harness(() => ['!a:h', '!b:h']);
    h.router.onChunk('s', 'hi\n\n');
    await h.router.whenIdle();
    expect(h.sent.map((m) => m.roomId).sort()).toEqual(['!a:h', '!b:h']);
  });
});
