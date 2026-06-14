/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  StreamRouter,
  StreamBuffer,
  FLUSH_MAX_CHARS,
  type StreamPoster,
} from './streamRouter.js';

/** A poster that records posts/threads and lets the test control timers. */
function harness(channelsFor: (s: string) => string[]) {
  const posts: Array<{ dest: string; content: string }> = [];
  const threads: Array<{ channelId: string; messageId: string }> = [];
  let nextMsg = 1;
  let nextThread = 1;
  const timers: Array<() => void> = [];

  const poster: StreamPoster = {
    postMessage: async (dest, content) => {
      posts.push({ dest, content });
      return `msg_${nextMsg++}`;
    },
    createThread: async (channelId, messageId) => {
      threads.push({ channelId, messageId });
      return `thread_${nextThread++}`;
    },
  };
  const router = new StreamRouter({
    poster,
    channelsFor,
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
    posts,
    threads,
    fireTimers: () => {
      const pending = timers.splice(0);
      for (const fn of pending) fn();
    },
  };
}

describe('StreamBuffer', () => {
  it('flushes on a paragraph break', () => {
    const b = new StreamBuffer();
    b.append('hello');
    expect(b.hardDue()).toBe(false);
    b.append('\n\nworld');
    expect(b.hardDue()).toBe(true);
  });

  it('flushes when a fenced block closes (even fence count)', () => {
    const b = new StreamBuffer();
    b.append('```ts\ncode');
    expect(b.hardDue()).toBe(false); // open fence, not yet closed
    b.append('\n```');
    expect(b.hardDue()).toBe(true);
  });

  it('flushes at the char cap', () => {
    const b = new StreamBuffer();
    b.append('x'.repeat(FLUSH_MAX_CHARS));
    expect(b.hardDue()).toBe(true);
  });

  it('take() returns and clears', () => {
    const b = new StreamBuffer();
    b.append('abc');
    expect(b.take()).toBe('abc');
    expect(b.isEmpty()).toBe(true);
  });
});

describe('StreamRouter — buffering + flush', () => {
  it('buffers until a hard trigger, then posts to the channel', async () => {
    const h = harness(() => ['chan_1']);
    h.router.onChunk('sess', 'partial '); // no trigger
    await h.router.whenIdle();
    expect(h.posts).toEqual([]); // still buffered
    h.router.onChunk('sess', 'rest\n\n'); // paragraph break → flush
    await h.router.whenIdle();
    expect(h.posts).toEqual([{ dest: 'chan_1', content: 'partial rest\n\n' }]);
  });

  it('flushes on the idle timer when no hard trigger fires', async () => {
    const h = harness(() => ['chan_1']);
    h.router.onChunk('sess', 'a quiet line');
    expect(h.posts).toEqual([]);
    h.fireTimers(); // 1500ms elapsed
    await h.router.whenIdle();
    expect(h.posts).toEqual([{ dest: 'chan_1', content: 'a quiet line' }]);
  });

  it('fans out to every bound channel', async () => {
    const h = harness(() => ['chan_1', 'chan_2']);
    h.router.onChunk('sess', 'hi\n\n');
    await h.router.whenIdle();
    expect(h.posts.map((p) => p.dest).sort()).toEqual(['chan_1', 'chan_2']);
  });

  it('ignores empty text', async () => {
    const h = harness(() => ['chan_1']);
    h.router.onChunk('sess', '');
    h.fireTimers();
    await h.router.whenIdle();
    expect(h.posts).toEqual([]);
  });
});

describe('StreamRouter — threads on long streams', () => {
  // Each flush is a paragraph (hard trigger) → one posted message per flush.
  const flush = (h: ReturnType<typeof harness>, n: number) =>
    h.router.onChunk('sess', `msg ${n}\n\n`);

  it('opens a thread on the 7th message and redirects subsequent posts', async () => {
    const h = harness(() => ['chan_42']);
    for (let i = 1; i <= 6; i++) {
      flush(h, i);
      await h.router.whenIdle();
    }
    expect(h.threads).toEqual([]); // 6 messages, still in channel
    expect(h.posts.every((p) => p.dest === 'chan_42')).toBe(true);

    flush(h, 7);
    await h.router.whenIdle();
    // thread created off the FIRST message of the turn (msg_1)
    expect(h.threads).toEqual([{ channelId: 'chan_42', messageId: 'msg_1' }]);
    // the 7th message went into the thread, not the channel
    expect(h.posts[h.posts.length - 1].dest).toBe('thread_1');

    flush(h, 8);
    await h.router.whenIdle();
    expect(h.posts[h.posts.length - 1].dest).toBe('thread_1'); // stays in thread
  });

  it('a single flush that splits into >6 parts opens the thread mid-flush', async () => {
    const h = harness(() => ['chan_42']);
    // ~7 messages worth in one flush: distinct paragraphs over the cap.
    const big = Array.from(
      { length: 7 },
      (_, i) => `${'z'.repeat(1700)}#${i}`,
    ).join('\n\n');
    h.router.onChunk('sess', big);
    h.router.onChunk('sess', '\n\n'); // ensure a hard trigger
    await h.router.whenIdle();
    expect(h.threads).toHaveLength(1); // counts POSTED messages, not flushes
    const threadPosts = h.posts.filter((p) => p.dest.startsWith('thread_'));
    expect(threadPosts.length).toBeGreaterThanOrEqual(1);
  });

  it('a new turn (after permission_resolved) does NOT reuse the thread', async () => {
    const h = harness(() => ['chan_42']);
    for (let i = 1; i <= 7; i++) {
      flush(h, i);
      await h.router.whenIdle();
    }
    expect(h.threads).toHaveLength(1);

    // Turn boundary: resolve → the NEXT chunk starts a fresh turn.
    h.router.notePermissionResolved('sess');
    flush(h, 8); // first message of turn 2
    await h.router.whenIdle();
    // back to the channel, not the old thread
    expect(h.posts[h.posts.length - 1].dest).toBe('chan_42');
    expect(h.threads).toHaveLength(1); // no new thread until 6 more in this turn
  });

  it('a new inbound prompt also ends the turn', async () => {
    const h = harness(() => ['chan_42']);
    for (let i = 1; i <= 7; i++) {
      flush(h, i);
      await h.router.whenIdle();
    }
    h.router.bumpTurn('sess'); // inbound prompt
    flush(h, 8);
    await h.router.whenIdle();
    expect(h.posts[h.posts.length - 1].dest).toBe('chan_42');
  });
});

describe('StreamRouter — ordering', () => {
  it('preserves order despite concurrent slow posts (serialized chain)', async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const poster: StreamPoster = {
      postMessage: async (_dest, content) => {
        if (!resolveFirst) {
          // Make the FIRST post slow; the second must still land after it.
          await new Promise<void>((r) => (resolveFirst = r));
        }
        order.push(content);
        return 'msg';
      },
      createThread: async () => 'thread',
    };
    const router = new StreamRouter({
      poster,
      channelsFor: () => ['chan_1'],
      setTimer: (_ms, fn) => {
        fn();
        return () => {};
      },
    });
    router.onChunk('sess', 'first\n\n');
    router.onChunk('sess', 'second\n\n');
    // Let the chain's microtasks run so the first (slow) post is in-flight.
    while (!resolveFirst) await new Promise((r) => setTimeout(r, 0));
    // release the slow first post; the chain guarantees first-then-second
    resolveFirst();
    await router.whenIdle();
    expect(order).toEqual(['first\n\n', 'second\n\n']);
  });
});
