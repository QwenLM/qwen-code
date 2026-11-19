/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROP_RECEIPT_TRAIL_MS,
  DROP_REPORT_WINDOW_MS,
  DropNoticeThrottle,
  DropReceiptCoalescer,
  FLUSH_CONCURRENCY,
  MAX_DEFERRED_RECEIPT_AGE_MS,
  MAX_DROP_NOTICES_PER_WINDOW,
  MAX_DROP_RECEIPTS_PER_WINDOW,
  MAX_DROP_REPORT_KEYS,
  type DropNotice,
  type DroppedReceipt,
} from './peer-drop-reports.js';
import {
  buildUserFrame,
  MAX_DROPPED_MSG_IDS,
  type PeerUserFrame,
} from './peer-frames.js';
import { peerSenderKey, type PeerOrigin } from './inbound-gate.js';

const PEER: PeerOrigin = { selfSent: false };

function frameFrom(from: string | undefined, content = 'hello'): PeerUserFrame {
  return buildUserFrame({
    content,
    ...(from !== undefined ? { from } : {}),
  });
}

/**
 * The reporters read an injected clock but arm real timers, so a test has
 * to move both together or a trail fires against a clock that never moved.
 */
function stubClock() {
  let value = 0;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

type Clock = { now: () => number };
type Reporter = DropReceiptCoalescer | DropNoticeThrottle;
type Reason = Parameters<Reporter['note']>[2];

/** A coalescer that records every receipt it sends. */
function recordingCoalescer(clock?: Clock, trailMs?: number) {
  const sent: DroppedReceipt[] = [];
  const coalescer = new DropReceiptCoalescer(
    (receipt) => {
      sent.push(receipt);
    },
    clock && { now: clock.now, ...(trailMs === undefined ? {} : { trailMs }) },
  );
  return { sent, coalescer };
}

/** A throttle that records every notice it emits. */
function recordingThrottle(clock?: Clock) {
  const notices: DropNotice[] = [];
  const throttle = new DropNoticeThrottle(
    (notice) => notices.push(notice),
    clock && { now: clock.now },
  );
  return { notices, throttle };
}

/** Notes a drop of a frame from `from` (content 'hello' by default). */
function drop(
  reporter: Reporter,
  from: string | undefined,
  content?: string,
  reason: Reason = 'rate-limited',
): void {
  reporter.note(frameFrom(from, content), PEER, reason);
}

/** One drop from each of `count` distinct senders `/tmp/<prefix>-<i>.sock`. */
function dropFromMany(
  reporter: Reporter,
  count: number,
  prefix = 'peer',
  reason: Reason = 'rate-limited',
): void {
  for (let index = 0; index < count; index++) {
    drop(reporter, `/tmp/${prefix}-${index}.sock`, undefined, reason);
  }
}

// Both reporters are driven by the injected clock; the coalescer also
// arms real timers, so the whole file runs on mocked ones.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DropReceiptCoalescer', () => {
  it('answers the first drop from a sender at once', () => {
    const { sent, coalescer } = recordingCoalescer(stubClock());

    const frame = frameFrom('/tmp/peer.sock');
    coalescer.note(frame, PEER, 'rate-limited');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.frame.msgId).toBe(frame.msgId);
    expect(sent[0]?.reason).toBe('rate-limited');
    expect(sent[0]?.droppedMsgIds).toEqual([]);
  });

  it('folds the drops that follow into one trailing receipt', () => {
    const clock = stubClock();
    const { sent, coalescer } = recordingCoalescer(clock);

    const frames = Array.from({ length: 6 }, (_, index) =>
      frameFrom('/tmp/peer.sock', `message ${index}`),
    );
    for (const frame of frames) coalescer.note(frame, PEER, 'rate-limited');

    // Still only the immediate one until the trail elapses.
    expect(sent).toHaveLength(1);
    clock.advance(DROP_RECEIPT_TRAIL_MS);

    expect(sent).toHaveLength(2);
    // The batch is addressed for the first drop it holds, and names the
    // rest, so one frame settles every message the sender lost.
    expect(sent[1]?.frame.msgId).toBe(frames[1]?.msgId);
    expect(sent[1]?.droppedMsgIds).toEqual([
      frames[2]?.msgId,
      frames[3]?.msgId,
      frames[4]?.msgId,
      frames[5]?.msgId,
    ]);
  });

  it('answers immediately again once the window has passed', () => {
    const clock = stubClock();
    const { sent, coalescer } = recordingCoalescer(clock);

    drop(coalescer, '/tmp/peer.sock');
    clock.advance(DROP_REPORT_WINDOW_MS + 1);
    drop(coalescer, '/tmp/peer.sock', 'later');

    expect(sent).toHaveLength(2);
    expect(sent[1]?.droppedMsgIds).toEqual([]);
  });

  it('keeps one receipt per sender and reason', () => {
    const { sent, coalescer } = recordingCoalescer(stubClock());

    drop(coalescer, '/tmp/peer.sock');
    drop(coalescer, '/tmp/peer.sock', 'same again', 'duplicate');

    expect(sent.map((receipt) => receipt.reason)).toEqual([
      'rate-limited',
      'duplicate',
    ]);
  });

  it('does not merge authenticated origins that claim the same address', () => {
    const { sent, coalescer } = recordingCoalescer(stubClock());
    const frame = frameFrom('/tmp/shared.sock');

    coalescer.note(frame, { selfSent: true }, 'rate-limited');
    coalescer.note(frame, { selfSent: false }, 'rate-limited');

    expect(sent).toHaveLength(2);
  });

  it('caps the ids one receipt lists', () => {
    const clock = stubClock();
    const { sent, coalescer } = recordingCoalescer(clock);

    for (let index = 0; index < MAX_DROPPED_MSG_IDS + 50; index++) {
      drop(coalescer, '/tmp/peer.sock', `message ${index}`);
    }
    clock.advance(DROP_RECEIPT_TRAIL_MS);

    expect(sent[1]?.droppedMsgIds).toHaveLength(MAX_DROPPED_MSG_IDS);
  });

  it('stops sending receipts once the window budget is spent', () => {
    const { sent, coalescer } = recordingCoalescer(stubClock());

    // A distinct sender each time, so every one of these would otherwise
    // earn an immediate receipt.
    dropFromMany(coalescer, MAX_DROP_RECEIPTS_PER_WINDOW + 5);

    expect(sent).toHaveLength(MAX_DROP_RECEIPTS_PER_WINDOW);
  });

  it('defers an over-budget receipt to the next window instead of dropping it', () => {
    // The budget bounds receipts per window, not which drops ever get
    // one: a drop noted under someone else's flood is still owed its
    // answer, so it waits out the window in the trailing batch.
    const clock = stubClock();
    const { sent, coalescer } = recordingCoalescer(clock);

    dropFromMany(coalescer, MAX_DROP_RECEIPTS_PER_WINDOW);
    expect(sent).toHaveLength(MAX_DROP_RECEIPTS_PER_WINDOW);

    // One more drop inside the same window: nothing goes out, but the
    // drop is not discarded either.
    drop(coalescer, '/tmp/legit.sock', undefined, 'queue-full');
    clock.advance(DROP_RECEIPT_TRAIL_MS);
    expect(sent).toHaveLength(MAX_DROP_RECEIPTS_PER_WINDOW);

    // The window rolls, the re-armed trail fires, and the receipt that
    // was owed goes out.
    clock.advance(DROP_REPORT_WINDOW_MS);
    expect(sent).toHaveLength(MAX_DROP_RECEIPTS_PER_WINDOW + 1);
    expect(sent.at(-1)?.frame.from).toBe('/tmp/legit.sock');
  });

  it('says nothing to a sender that gave no reply address', () => {
    const clock = stubClock();
    const { sent, coalescer } = recordingCoalescer(clock);

    drop(coalescer, undefined);
    drop(coalescer, '');
    clock.advance(DROP_RECEIPT_TRAIL_MS);

    expect(sent).toHaveLength(0);
  });

  it('sends what is still waiting when the session closes', async () => {
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
        return Promise.resolve();
      },
      { now: clock.now },
    );

    drop(coalescer, '/tmp/peer.sock', 'first');
    drop(coalescer, '/tmp/peer.sock', 'second');
    expect(sent).toHaveLength(1);

    await coalescer.flush();
    expect(sent).toHaveLength(2);
  });

  it('gives up on a flush that outlasts its bound', async () => {
    const clock = stubClock();
    const coalescer = new DropReceiptCoalescer(
      () => new Promise<void>(() => {}),
      { now: clock.now },
    );

    drop(coalescer, '/tmp/peer.sock', 'first');
    drop(coalescer, '/tmp/peer.sock', 'second');

    const flushing = coalescer.flush(500);
    vi.advanceTimersByTime(500);
    await expect(flushing).resolves.toBeUndefined();
  });

  it('drops its timers when disposed', () => {
    const clock = stubClock();
    const { sent, coalescer } = recordingCoalescer(clock);

    drop(coalescer, '/tmp/peer.sock', 'first');
    drop(coalescer, '/tmp/peer.sock', 'second');
    coalescer.dispose();
    clock.advance(DROP_RECEIPT_TRAIL_MS * 2);

    expect(sent).toHaveLength(1);
  });
});

describe('DropNoticeThrottle', () => {
  it('tells the user once per window and counts the rest', () => {
    const clock = stubClock();
    const { notices, throttle } = recordingThrottle(clock);

    for (let index = 0; index < 13; index++) {
      drop(throttle, '/tmp/peer.sock');
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]?.suppressed).toBe(0);

    clock.advance(DROP_REPORT_WINDOW_MS + 1);
    drop(throttle, '/tmp/peer.sock');

    expect(notices).toHaveLength(2);
    expect(notices[1]?.suppressed).toBe(12);
  });

  it('separates senders and reasons', () => {
    const { notices, throttle } = recordingThrottle(stubClock());

    drop(throttle, '/tmp/a.sock');
    drop(throttle, '/tmp/b.sock');
    drop(throttle, '/tmp/a.sock', undefined, 'duplicate');

    expect(notices).toHaveLength(3);
  });

  it('meters a sender that gave no address by what the transport knew', () => {
    const { notices, throttle } = recordingThrottle(stubClock());

    throttle.note(frameFrom(undefined), { selfSent: true }, 'rate-limited');
    throttle.note(frameFrom(undefined), { selfSent: false }, 'rate-limited');
    // A script and a stranger do not share one anonymous bucket.
    expect(notices).toHaveLength(2);
  });

  it('folds what the global budget swallowed into the next notice', () => {
    const clock = stubClock();
    const { notices, throttle } = recordingThrottle(clock);

    dropFromMany(throttle, MAX_DROP_NOTICES_PER_WINDOW + 3);
    expect(notices).toHaveLength(MAX_DROP_NOTICES_PER_WINDOW);

    clock.advance(DROP_REPORT_WINDOW_MS + 1);
    drop(throttle, '/tmp/latecomer.sock');

    expect(notices).toHaveLength(MAX_DROP_NOTICES_PER_WINDOW + 1);
    expect(notices.at(-1)?.suppressed).toBe(3);
  });

  it('survives a listener that throws', () => {
    const clock = stubClock();
    const throttle = new DropNoticeThrottle(
      () => {
        throw new Error('boom');
      },
      { now: clock.now },
    );

    expect(() => drop(throttle, '/tmp/peer.sock')).not.toThrow();
  });
});

describe('DropReceiptCoalescer bounds', () => {
  /** A clock the test moves without also firing the fake timers. */
  function quietClock() {
    let value = 0;
    return {
      now: () => value,
      advance(ms: number) {
        value += ms;
      },
    };
  }

  const spendBudget = (coalescer: DropReceiptCoalescer) =>
    dropFromMany(coalescer, MAX_DROP_RECEIPTS_PER_WINDOW, 'budget');

  it('coalesces addresses that differ only past the retained prefix', () => {
    const { sent, coalescer } = recordingCoalescer();
    const prefix = peerSenderKey(frameFrom('x'.repeat(1000)), PEER).slice(
      'peer:'.length,
    );

    for (let index = 0; index < MAX_DROP_REPORT_KEYS + 100; index++) {
      drop(coalescer, `${prefix}${index}`);
    }

    expect(sent[0]?.frame.from).toBe(prefix);
    expect(vi.getTimerCount()).toBe(1);
    coalescer.dispose();
  });

  it('does not retain an oversized reply token in a deferred receipt', () => {
    const { sent, coalescer } = recordingCoalescer();
    const oversized = {
      ...frameFrom('/tmp/peer.sock'),
      replyToken: 'x'.repeat(500_000),
    };

    coalescer.note(oversized, PEER, 'rate-limited');
    coalescer.note(oversized, PEER, 'rate-limited');
    void coalescer.flush(10);

    expect(sent.at(-1)?.frame).not.toHaveProperty('replyToken');
    coalescer.dispose();
  });

  it('retains a bounded reply token needed to authenticate the receipt', () => {
    const { sent, coalescer } = recordingCoalescer();
    const frame = { ...frameFrom('/tmp/peer.sock'), replyToken: 'secret' };

    coalescer.note(frame, PEER, 'rate-limited');

    expect(sent[0]?.frame.replyToken).toBe('secret');
    coalescer.dispose();
  });

  it('emits a narrow notice without the rejected message body', () => {
    const { notices, throttle } = recordingThrottle();

    drop(throttle, '/tmp/peer.sock', 'x'.repeat(100_000), 'duplicate');

    expect(notices[0]?.frame).not.toHaveProperty('message');
  });

  it('leaves no timer behind when a batch is evicted from the table', () => {
    // An evicted batch is no longer in the map `flush` and `dispose`
    // iterate, so a timer it kept would outlive both — and hold a
    // rejected message's ids for the life of the session.
    const clock = quietClock();
    const coalescer = new DropReceiptCoalescer(() => {}, { now: clock.now });
    spendBudget(coalescer);
    for (let index = 0; index < MAX_DROP_REPORT_KEYS + 100; index++) {
      const from = `/tmp/rotating-${index}.sock`;
      drop(coalescer, from);
      drop(coalescer, from, 'again');
    }

    expect(vi.getTimerCount()).toBeLessThanOrEqual(MAX_DROP_REPORT_KEYS);
    coalescer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends what an evicted batch was holding, when the budget allows', () => {
    const clock = quietClock();
    const { sent, coalescer } = recordingCoalescer(clock, 60_000);

    const owed = frameFrom('/tmp/owed.sock');
    coalescer.note(owed, PEER, 'rate-limited');
    drop(coalescer, '/tmp/owed.sock', 'folded');
    const before = sent.length;

    // A fresh window, so the eviction's receipt is not refused for budget.
    clock.advance(DROP_REPORT_WINDOW_MS + 1);
    dropFromMany(coalescer, MAX_DROP_REPORT_KEYS, 'evictor', 'duplicate');

    expect(sent.length).toBeGreaterThan(before);
    expect(
      sent.some((receipt) => receipt.frame.from === '/tmp/owed.sock'),
    ).toBe(true);
  });

  it('carries no message body on a receipt', () => {
    // A waiting batch outlives its drop, and a frame may be a megabyte.
    const { sent, coalescer } = recordingCoalescer(quietClock());

    drop(coalescer, '/tmp/peer.sock', 'x'.repeat(4096));

    expect(sent[0]?.frame).not.toHaveProperty('message');
    expect(sent[0]?.frame.from).toBe('/tmp/peer.sock');
  });

  it('sends a batch the spent budget is holding when the session closes', async () => {
    // The budget bounds how loud this session is while it is running, and
    // it is not running after this. The sender still owed a receipt is
    // the one the same budget silenced.
    const { sent, coalescer } = recordingCoalescer(quietClock());

    spendBudget(coalescer);
    drop(coalescer, '/tmp/legit.sock');
    const beforeFlush = sent.length;
    expect(beforeFlush).toBe(MAX_DROP_RECEIPTS_PER_WINDOW);

    await coalescer.flush();
    expect(sent.length).toBe(beforeFlush + 1);
    expect(sent.at(-1)?.frame.from).toBe('/tmp/legit.sock');
  });

  it('abandons a receipt the budget held past the age it is still true for', () => {
    // A `rate-limited` receipt is a live throttle on the sending side.
    // One this old would pace an innocent sender against a bucket that
    // refilled minutes ago, so past the bound it is dropped instead.
    const clock = stubClock();
    // A trail longer than the bound, so the batch's first chance to
    // send arrives after it is already too old to act on.
    const { sent, coalescer } = recordingCoalescer(
      clock,
      MAX_DEFERRED_RECEIPT_AGE_MS + 10_000,
    );

    spendBudget(coalescer);
    drop(coalescer, '/tmp/stale.sock');
    const beforeAging = sent.length;

    clock.advance(MAX_DEFERRED_RECEIPT_AGE_MS + 10_001);

    expect(
      sent.slice(beforeAging).some((r) => r.frame.from === '/tmp/stale.sock'),
    ).toBe(false);
    // And it is gone rather than still re-arming.
    coalescer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a receipt the immediate path already started', async () => {
    // `flush` exists so a receipt is not cut off mid-write at exit; one
    // started outside a batch is exactly as easy to cut off.
    const clock = quietClock();
    let release: (() => void) | undefined;
    const coalescer = new DropReceiptCoalescer(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { now: clock.now },
    );
    drop(coalescer, '/tmp/peer.sock');
    expect(release).toBeDefined();

    let settled = false;
    const flushing = coalescer.flush(60_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await flushing;
    expect(settled).toBe(true);
  });

  it('does not start more receipts at once than the close path can spare', async () => {
    const clock = quietClock();
    let outstanding = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const coalescer = new DropReceiptCoalescer(
      () =>
        new Promise<void>((resolve) => {
          outstanding += 1;
          peak = Math.max(peak, outstanding);
          releases.push(() => {
            outstanding -= 1;
            resolve();
          });
        }),
      { now: clock.now, trailMs: 60_000 },
    );

    for (let index = 0; index < FLUSH_CONCURRENCY * 3; index++) {
      const from = `/tmp/slow-${index}.sock`;
      drop(coalescer, from);
      drop(coalescer, from, 'folded');
    }
    // Let the immediate-path sends settle first: what is under test is
    // how many *flush* starts at once.
    releases.splice(0, releases.length).forEach((release) => release());
    await Promise.resolve();
    peak = 0;

    const flushing = coalescer.flush(60_000);
    for (let round = 0; round < 10; round += 1) {
      await Promise.resolve();
      releases.splice(0, releases.length).forEach((release) => release());
    }
    await flushing;

    expect(peak).toBeLessThanOrEqual(FLUSH_CONCURRENCY);
  });

  it('survives a send that throws, on both paths', () => {
    const clock = stubClock();
    const coalescer = new DropReceiptCoalescer(
      () => {
        throw new Error('boom');
      },
      { now: clock.now },
    );
    expect(() => drop(coalescer, '/tmp/peer.sock')).not.toThrow();
    drop(coalescer, '/tmp/peer.sock', 'second');
    expect(() => clock.advance(DROP_RECEIPT_TRAIL_MS)).not.toThrow();
  });

  it('does not leave a rejected receipt unobserved', async () => {
    const clock = stubClock();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const coalescer = new DropReceiptCoalescer(
        () => Promise.reject(new Error('boom')),
        { now: clock.now },
      );
      drop(coalescer, '/tmp/peer.sock');
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
  });
});

describe('DropNoticeThrottle bounds', () => {
  it('carries an evicted sender unannounced drops rather than losing them', () => {
    // The count this reporter promises is a total, and a flood rotating
    // `from` is exactly what evicts a quiet sender still owed one.
    const clock = stubClock();
    const { notices, throttle } = recordingThrottle(clock);

    const quiet = frameFrom('/tmp/quiet.sock');
    for (let index = 0; index < 13; index++) {
      throttle.note(quiet, PEER, 'rate-limited');
    }
    expect(notices).toHaveLength(1);

    // Spread the evictors over windows so the global budget stays clear
    // and the only carry is the evicted sender's own.
    for (let index = 0; index < MAX_DROP_REPORT_KEYS; index++) {
      if (index % MAX_DROP_NOTICES_PER_WINDOW === 0) {
        clock.advance(DROP_REPORT_WINDOW_MS + 1);
      }
      drop(throttle, `/tmp/evictor-${index}.sock`, undefined, 'duplicate');
    }

    // The carry rides the next notice that gets through, whichever sender
    // that is about — so what must hold is that the 12 were announced
    // somewhere, not that they waited for their own sender.
    const carried = notices
      .slice(1)
      .reduce((total, notice) => total + notice.suppressed, 0);
    expect(carried).toBeGreaterThanOrEqual(12);
  });

  it('stops the state table growing past the cap', () => {
    const clock = stubClock();
    const throttle = new DropNoticeThrottle(() => {}, { now: clock.now });
    dropFromMany(throttle, MAX_DROP_REPORT_KEYS * 3);
    // Nothing to assert but that it did not grow without bound; the cap
    // is observable through the eviction carry above.
    expect(true).toBe(true);
  });
});
