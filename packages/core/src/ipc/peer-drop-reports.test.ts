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
  MAX_DROP_NOTICES_PER_WINDOW,
  MAX_DROP_RECEIPTS_PER_WINDOW,
  type DropNotice,
  type DroppedReceipt,
} from './peer-drop-reports.js';
import {
  buildUserFrame,
  MAX_DROPPED_MSG_IDS,
  type PeerUserFrame,
} from './peer-frames.js';
import type { PeerOrigin } from './inbound-gate.js';

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
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    const frame = frameFrom('/tmp/peer.sock');
    coalescer.note(frame, 'rate-limited');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.frame.msgId).toBe(frame.msgId);
    expect(sent[0]?.reason).toBe('rate-limited');
    expect(sent[0]?.droppedMsgIds).toEqual([]);
  });

  it('folds the drops that follow into one trailing receipt', () => {
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    const frames = Array.from({ length: 6 }, (_, index) =>
      frameFrom('/tmp/peer.sock', `message ${index}`),
    );
    for (const frame of frames) coalescer.note(frame, 'rate-limited');

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
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    coalescer.note(frameFrom('/tmp/peer.sock'), 'rate-limited');
    clock.advance(DROP_REPORT_WINDOW_MS + 1);
    coalescer.note(frameFrom('/tmp/peer.sock', 'later'), 'rate-limited');

    expect(sent).toHaveLength(2);
    expect(sent[1]?.droppedMsgIds).toEqual([]);
  });

  it('keeps one receipt per sender and reason', () => {
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    coalescer.note(frameFrom('/tmp/peer.sock'), 'rate-limited');
    coalescer.note(frameFrom('/tmp/peer.sock', 'same again'), 'duplicate');

    expect(sent.map((receipt) => receipt.reason)).toEqual([
      'rate-limited',
      'duplicate',
    ]);
  });

  it('caps the ids one receipt lists', () => {
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    for (let index = 0; index < MAX_DROPPED_MSG_IDS + 50; index++) {
      coalescer.note(
        frameFrom('/tmp/peer.sock', `message ${index}`),
        'rate-limited',
      );
    }
    clock.advance(DROP_RECEIPT_TRAIL_MS);

    expect(sent[1]?.droppedMsgIds).toHaveLength(MAX_DROPPED_MSG_IDS);
  });

  it('stops sending receipts once the window budget is spent', () => {
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    // A distinct sender each time, so every one of these would otherwise
    // earn an immediate receipt.
    for (let index = 0; index < MAX_DROP_RECEIPTS_PER_WINDOW + 5; index++) {
      coalescer.note(frameFrom(`/tmp/peer-${index}.sock`), 'rate-limited');
    }

    expect(sent).toHaveLength(MAX_DROP_RECEIPTS_PER_WINDOW);
  });

  it('defers an over-budget receipt to the next window instead of dropping it', () => {
    // The budget bounds receipts per window, not which drops ever get
    // one: a drop noted under someone else's flood is still owed its
    // answer, so it waits out the window in the trailing batch.
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    for (let index = 0; index < MAX_DROP_RECEIPTS_PER_WINDOW; index++) {
      coalescer.note(frameFrom(`/tmp/peer-${index}.sock`), 'rate-limited');
    }
    expect(sent).toHaveLength(MAX_DROP_RECEIPTS_PER_WINDOW);

    // One more drop inside the same window: nothing goes out, but the
    // drop is not discarded either.
    coalescer.note(frameFrom('/tmp/legit.sock'), 'rate-limited');
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
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    coalescer.note(frameFrom(undefined), 'rate-limited');
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

    coalescer.note(frameFrom('/tmp/peer.sock', 'first'), 'rate-limited');
    coalescer.note(frameFrom('/tmp/peer.sock', 'second'), 'rate-limited');
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

    coalescer.note(frameFrom('/tmp/peer.sock', 'first'), 'rate-limited');
    coalescer.note(frameFrom('/tmp/peer.sock', 'second'), 'rate-limited');

    const flushing = coalescer.flush(500);
    vi.advanceTimersByTime(500);
    await expect(flushing).resolves.toBeUndefined();
  });

  it('drops its timers when disposed', () => {
    const clock = stubClock();
    const sent: DroppedReceipt[] = [];
    const coalescer = new DropReceiptCoalescer(
      (receipt) => {
        sent.push(receipt);
      },
      { now: clock.now },
    );

    coalescer.note(frameFrom('/tmp/peer.sock', 'first'), 'rate-limited');
    coalescer.note(frameFrom('/tmp/peer.sock', 'second'), 'rate-limited');
    coalescer.dispose();
    clock.advance(DROP_RECEIPT_TRAIL_MS * 2);

    expect(sent).toHaveLength(1);
  });
});

describe('DropNoticeThrottle', () => {
  it('tells the user once per window and counts the rest', () => {
    const clock = stubClock();
    const notices: DropNotice[] = [];
    const throttle = new DropNoticeThrottle((notice) => notices.push(notice), {
      now: clock.now,
    });

    for (let index = 0; index < 13; index++) {
      throttle.note(frameFrom('/tmp/peer.sock'), PEER, 'rate-limited');
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]?.suppressed).toBe(0);

    clock.advance(DROP_REPORT_WINDOW_MS + 1);
    throttle.note(frameFrom('/tmp/peer.sock'), PEER, 'rate-limited');

    expect(notices).toHaveLength(2);
    expect(notices[1]?.suppressed).toBe(12);
  });

  it('separates senders and reasons', () => {
    const clock = stubClock();
    const notices: DropNotice[] = [];
    const throttle = new DropNoticeThrottle((notice) => notices.push(notice), {
      now: clock.now,
    });

    throttle.note(frameFrom('/tmp/a.sock'), PEER, 'rate-limited');
    throttle.note(frameFrom('/tmp/b.sock'), PEER, 'rate-limited');
    throttle.note(frameFrom('/tmp/a.sock'), PEER, 'duplicate');

    expect(notices).toHaveLength(3);
  });

  it('meters a sender that gave no address by what the transport knew', () => {
    const clock = stubClock();
    const notices: DropNotice[] = [];
    const throttle = new DropNoticeThrottle((notice) => notices.push(notice), {
      now: clock.now,
    });

    throttle.note(frameFrom(undefined), { selfSent: true }, 'rate-limited');
    throttle.note(frameFrom(undefined), { selfSent: false }, 'rate-limited');
    // A script and a stranger do not share one anonymous bucket.
    expect(notices).toHaveLength(2);
  });

  it('folds what the global budget swallowed into the next notice', () => {
    const clock = stubClock();
    const notices: DropNotice[] = [];
    const throttle = new DropNoticeThrottle((notice) => notices.push(notice), {
      now: clock.now,
    });

    for (let index = 0; index < MAX_DROP_NOTICES_PER_WINDOW + 3; index++) {
      throttle.note(frameFrom(`/tmp/peer-${index}.sock`), PEER, 'rate-limited');
    }
    expect(notices).toHaveLength(MAX_DROP_NOTICES_PER_WINDOW);

    clock.advance(DROP_REPORT_WINDOW_MS + 1);
    throttle.note(frameFrom('/tmp/latecomer.sock'), PEER, 'rate-limited');

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

    expect(() =>
      throttle.note(frameFrom('/tmp/peer.sock'), PEER, 'rate-limited'),
    ).not.toThrow();
  });
});
