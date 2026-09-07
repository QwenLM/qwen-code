/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Telling people about dropped messages without becoming the flood.
 *
 * A message the admission meter turns away has two audiences. The sender
 * has to learn that its message is not coming back — silence reads
 * exactly like "delivered and ignored", and a model that cannot tell the
 * two apart re-sends. The receiving user has to learn that something is
 * hammering their session, or the only symptom is a session that feels
 * busy.
 *
 * Both are reports about a flood, so neither may scale with it. A receipt
 * is itself an outbound connection competing for the same ceiling that
 * carries the receipts of legitimate messages, and a transcript notice
 * per drop would push the user's own work off the screen faster than the
 * flood would.
 *
 * So both are folded. A sender hears immediately the first time, then at
 * most once every few seconds, with the ids it missed listed in the one
 * receipt; the user is told once a minute per sender, with a count of
 * what was suppressed. Both are also capped globally, because a flood
 * that rotates its `from` would otherwise mint a fresh budget per name.
 *
 * Receipts are best-effort: over the global budget they wait for the
 * next window rather than going out at once — a drop noted under someone
 * else's flood is still owed its answer — and a session that closes
 * first may never send them. The sender is already being told to stop,
 * and the budget exists precisely because more receipts would not help.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { PeerDropReason } from './peer-admission.js';
import { peerSenderKey, type PeerOrigin } from './inbound-gate.js';
import { MAX_DROPPED_MSG_IDS, type PeerUserFrame } from './peer-frames.js';

const debugLogger = createDebugLogger('PEER_DROP_REPORTS');

/**
 * The period both budgets are measured over, and the gap after which a
 * sender earns another immediate receipt.
 */
export const DROP_REPORT_WINDOW_MS = 60_000;

/**
 * How long a batch waits for more drops before it is sent.
 *
 * Long enough that a burst lands in one receipt, short enough that a
 * sender blocked on the answer is not left guessing.
 */
export const DROP_RECEIPT_TRAIL_MS = 5_000;

/** How long `flush` waits for in-flight receipts at shutdown. */
export const DROP_FLUSH_BOUND_MS = 500;

/** Most dropped-receipts sent per window, across every sender. */
export const MAX_DROP_RECEIPTS_PER_WINDOW = 40;

/** Most drop notices shown to the user per window, across every sender. */
export const MAX_DROP_NOTICES_PER_WINDOW = 20;

/** Most (sender, reason) pairs either reporter tracks at once. */
export const MAX_DROP_REPORT_KEYS = 256;

export interface DroppedReceipt {
  /** The frame the receipt is addressed for: the first of the batch. */
  frame: PeerUserFrame;
  reason: PeerDropReason;
  /** Later ids folded into this receipt; empty for an immediate one. */
  droppedMsgIds: string[];
}

interface ReceiptBatch {
  lastImmediateAt: number;
  /** The first drop still waiting, whose id addresses the receipt. */
  frame: PeerUserFrame | undefined;
  reason: PeerDropReason | undefined;
  /** Ids of the drops after the first. */
  ids: string[];
  pending: number;
  timer: NodeJS.Timeout | undefined;
}

export interface DropReceiptCoalescerOptions {
  /** Injectable clock. Production uses `performance.now()`. */
  now?: () => number;
  /** Override for tests; production uses {@link DROP_RECEIPT_TRAIL_MS}. */
  trailMs?: number;
}

/**
 * Folds a burst of drops from one sender into few receipts.
 *
 * Keyed by (reply address, reason): a sender being rate-limited and the
 * same sender repeating itself are two different things to say, and a
 * sender with no reply address has nowhere to hear either.
 */
export class DropReceiptCoalescer {
  private readonly now: () => number;
  private readonly trailMs: number;
  private readonly batches = new Map<string, ReceiptBatch>();
  private windowStartedAt: number;
  private sentInWindow = 0;
  private disposed = false;

  constructor(
    private readonly send: (receipt: DroppedReceipt) => Promise<void> | void,
    options: DropReceiptCoalescerOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.trailMs = options.trailMs ?? DROP_RECEIPT_TRAIL_MS;
    this.windowStartedAt = this.now();
  }

  /** Record a drop. Sends now, or joins the batch already waiting. */
  note(frame: PeerUserFrame, reason: PeerDropReason): void {
    if (this.disposed) return;
    // No reply address, no receipt. Nothing is lost that could have been
    // delivered: a sender that gave no `from` cannot be told anything.
    if (!frame.from) return;

    const now = this.now();
    const batch = this.touch(`${frame.from}\u0000${reason}`);

    // The first drop in a window answers at once — a sender that has just
    // started overrunning should learn immediately, while it can still
    // stop. After that the trailing batch is what answers, so a sender
    // that keeps going costs one receipt per trail rather than one per
    // message. When the window's receipt budget is spent, the immediate
    // answer is deferred to the trailing batch instead of discarded: the
    // drop it answers may be a legitimate message caught in someone
    // else's flood, and its sender is still owed the receipt.
    if (
      batch.pending === 0 &&
      now - batch.lastImmediateAt >= DROP_REPORT_WINDOW_MS &&
      !this.budgetSpent(now)
    ) {
      batch.lastImmediateAt = now;
      void this.dispatch({ frame, reason, droppedMsgIds: [] });
      return;
    }

    batch.pending += 1;
    if (batch.frame === undefined) {
      batch.frame = frame;
      batch.reason = reason;
      batch.timer = setTimeout(() => {
        batch.timer = undefined;
        void this.sendBatch(batch);
      }, this.trailMs);
      // A session with a batch waiting should still be able to exit; the
      // close path flushes what is left.
      batch.timer.unref?.();
    } else if (batch.ids.length < MAX_DROPPED_MSG_IDS) {
      batch.ids.push(frame.msgId);
    }
  }

  /**
   * Send every batch still waiting, giving them at most `boundMs`.
   *
   * Called before the socket goes away. A receipt still in flight when
   * the process exits is a receipt the sender never receives, and a
   * sender left waiting on one cannot tell a drop from a delivery.
   */
  async flush(boundMs = DROP_FLUSH_BOUND_MS): Promise<void> {
    const settling: Array<Promise<void> | void> = [];
    for (const batch of this.batches.values()) {
      if (batch.timer !== undefined) {
        clearTimeout(batch.timer);
        batch.timer = undefined;
      }
      if (batch.pending > 0) settling.push(this.sendBatch(batch));
    }
    const inFlight = settling.filter(
      (value): value is Promise<void> => value instanceof Promise,
    );
    if (inFlight.length === 0) return;
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, boundMs);
        deadline.unref?.();
      }),
    ]);
  }

  /** Drop every timer and forget every batch. */
  dispose(): void {
    this.disposed = true;
    for (const batch of this.batches.values()) {
      if (batch.timer !== undefined) clearTimeout(batch.timer);
      batch.timer = undefined;
    }
    this.batches.clear();
  }

  private sendBatch(batch: ReceiptBatch): Promise<void> | void {
    if (this.disposed) return;
    const frame = batch.frame;
    const reason = batch.reason;
    if (frame === undefined || reason === undefined) {
      batch.pending = 0;
      batch.ids = [];
      if (batch.timer !== undefined) {
        clearTimeout(batch.timer);
        batch.timer = undefined;
      }
      return;
    }
    if (this.budgetSpent(this.now())) {
      // The window's budget is still spent: keep the batch and re-arm the
      // trail, so these drops are receipted once the window rolls rather
      // than vanishing. The budget bounds receipts per window, not which
      // drops ever get one.
      if (batch.timer === undefined) {
        batch.timer = setTimeout(() => {
          batch.timer = undefined;
          void this.sendBatch(batch);
        }, this.trailMs);
        batch.timer.unref?.();
      }
      return;
    }
    const droppedMsgIds = batch.ids;
    batch.frame = undefined;
    batch.reason = undefined;
    batch.ids = [];
    batch.pending = 0;
    if (batch.timer !== undefined) {
      clearTimeout(batch.timer);
      batch.timer = undefined;
    }
    return this.dispatch({ frame, reason, droppedMsgIds });
  }

  /**
   * Roll the receipt window if it has passed, then whether this window's
   * budget is gone. The accounting itself stays in `dispatch`.
   */
  private budgetSpent(now: number): boolean {
    if (now - this.windowStartedAt >= DROP_REPORT_WINDOW_MS) {
      this.windowStartedAt = now;
      this.sentInWindow = 0;
    }
    return this.sentInWindow >= MAX_DROP_RECEIPTS_PER_WINDOW;
  }

  private dispatch(receipt: DroppedReceipt): Promise<void> | void {
    if (this.budgetSpent(this.now())) {
      debugLogger.debug(
        'not sending another dropped receipt this minute; the budget is spent',
      );
      return;
    }
    this.sentInWindow += 1;
    try {
      return this.send(receipt);
    } catch (error) {
      debugLogger.debug(`sending a dropped receipt threw: ${describe(error)}`);
      return;
    }
  }

  private touch(key: string): ReceiptBatch {
    const existing = this.batches.get(key);
    if (existing !== undefined) {
      this.batches.delete(key);
      this.batches.set(key, existing);
      return existing;
    }
    while (this.batches.size >= MAX_DROP_REPORT_KEYS) {
      const oldest = this.batches.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.batches.get(oldest);
      this.batches.delete(oldest);
      // Send what it was holding rather than forgetting it: the sender is
      // owed the answer whether or not this session still has room to
      // remember who it was.
      if (evicted && evicted.pending > 0) void this.sendBatch(evicted);
      else if (evicted?.timer !== undefined) clearTimeout(evicted.timer);
    }
    const fresh: ReceiptBatch = {
      // Negative infinity, not `now`: the first drop from a sender is the
      // one most worth answering at once.
      lastImmediateAt: Number.NEGATIVE_INFINITY,
      frame: undefined,
      reason: undefined,
      ids: [],
      pending: 0,
      timer: undefined,
    };
    this.batches.set(key, fresh);
    return fresh;
  }
}

export interface DropNotice {
  frame: PeerUserFrame;
  origin: PeerOrigin;
  reason: PeerDropReason;
  /**
   * Drops not announced since the last notice: this sender's suppressed
   * repeats, plus anything the global budget swallowed. Zero on a notice
   * that stands for one drop.
   */
  suppressed: number;
}

export interface DropNoticeThrottleOptions {
  /** Injectable clock. Production uses `performance.now()`. */
  now?: () => number;
}

interface NoticeState {
  lastReportAt: number;
  suppressed: number;
}

/**
 * Throttles what the receiving user is told.
 *
 * One line per sender per minute, carrying the count of what it stands
 * for. The user needs to know a peer is misbehaving and roughly how
 * badly; they do not need a line per message, which is the thing the
 * flood was going to do to their transcript anyway.
 */
export class DropNoticeThrottle {
  private readonly now: () => number;
  private readonly states = new Map<string, NoticeState>();
  private windowStartedAt: number;
  private emittedInWindow = 0;
  private globalSuppressed = 0;

  constructor(
    private readonly emit: (notice: DropNotice) => void,
    options: DropNoticeThrottleOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.windowStartedAt = this.now();
  }

  note(frame: PeerUserFrame, origin: PeerOrigin, reason: PeerDropReason): void {
    const now = this.now();
    const key = `${peerSenderKey(frame, origin)}\u0000${reason}`;
    const state = this.touch(key);

    if (now - state.lastReportAt < DROP_REPORT_WINDOW_MS) {
      state.suppressed += 1;
      return;
    }

    if (now - this.windowStartedAt >= DROP_REPORT_WINDOW_MS) {
      this.windowStartedAt = now;
      this.emittedInWindow = 0;
    }
    if (this.emittedInWindow >= MAX_DROP_NOTICES_PER_WINDOW) {
      // Held against the next notice that does get through, whichever
      // sender it is about, so the total stays honest even when the
      // sender that caused it is never announced again.
      this.globalSuppressed += 1;
      return;
    }
    this.emittedInWindow += 1;

    const suppressed = state.suppressed + this.globalSuppressed;
    this.globalSuppressed = 0;
    state.suppressed = 0;
    state.lastReportAt = now;

    try {
      this.emit({ frame, origin, reason, suppressed });
    } catch (error) {
      debugLogger.debug(`drop-notice listener threw: ${describe(error)}`);
    }
  }

  private touch(key: string): NoticeState {
    const existing = this.states.get(key);
    if (existing !== undefined) {
      this.states.delete(key);
      this.states.set(key, existing);
      return existing;
    }
    while (this.states.size >= MAX_DROP_REPORT_KEYS) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
    const fresh: NoticeState = {
      lastReportAt: Number.NEGATIVE_INFINITY,
      suppressed: 0,
    };
    this.states.set(key, fresh);
    return fresh;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
