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
import {
  MAX_SENDER_KEY_CHARS,
  peerSenderKey,
  type PeerOrigin,
} from './inbound-gate.js';
import {
  MAX_DROPPED_MSG_IDS,
  MAX_RETAINED_REPLY_TOKEN_CHARS,
  type PeerUserFrame,
} from './peer-frames.js';

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

/**
 * How long a receipt may be held back by a spent budget before it is
 * abandoned.
 *
 * A deferred receipt is not just late news: the sender turns a
 * `rate-limited` one into a live throttle on itself. Past this the
 * receiver's own bucket has long since refilled, so the receipt would
 * make an innocent sender pace itself against a wall that is no longer
 * there. Comfortably above one trail plus one window, which is the
 * longest an ordinary deferral takes.
 */
export const MAX_DEFERRED_RECEIPT_AGE_MS = 2 * DROP_REPORT_WINDOW_MS;

/**
 * Receipts `flush` starts at once.
 *
 * Each one is an outbound connection, and the close path fires its own
 * burst of corrective receipts straight afterwards against a shared
 * ceiling that must stay above `MAX_HELD_MESSAGES`. Draining in slices
 * keeps that headroom instead of occupying it.
 */
export const FLUSH_CONCURRENCY = 8;

/** Most dropped-receipts sent per window, across every sender. */
export const MAX_DROP_RECEIPTS_PER_WINDOW = 40;

/** Most drop notices shown to the user per window, across every sender. */
export const MAX_DROP_NOTICES_PER_WINDOW = 20;

/** Most (sender, reason) pairs either reporter tracks at once. */
export const MAX_DROP_REPORT_KEYS = 256;

/**
 * What a receipt needs to reach its sender, and nothing else.
 *
 * Deliberately not the frame. A waiting batch outlives the drop by the
 * trail, and longer while the budget is spent; holding the whole frame
 * would pin up to a megabyte of the rejected message per waiting sender,
 * so a flood the meter turned away would live on in the heap of the
 * session that turned it away. The digest in `SenderMeter` exists for the
 * same reason.
 */
export type DropReceiptTarget = Pick<
  PeerUserFrame,
  'msgId' | 'from' | 'replyToken'
>;

export interface DroppedReceipt {
  /** The message the receipt is addressed for: the first of the batch. */
  frame: DropReceiptTarget;
  reason: PeerDropReason;
  /** Later ids folded into this receipt; empty for an immediate one. */
  droppedMsgIds: string[];
}

interface ReceiptBatch {
  lastImmediateAt: number;
  /** The first drop still waiting, whose id addresses the receipt. */
  frame: DropReceiptTarget | undefined;
  reason: PeerDropReason | undefined;
  /** When that first drop was noted, for the deferral's age bound. */
  firstNotedAt: number;
  /** Ids of the drops after the first. */
  ids: string[];
  pending: number;
  timer: NodeJS.Timeout | undefined;
  /**
   * Evicted from the table, so nothing tracks it any more. It must not
   * re-arm: `flush` and `dispose` iterate the table, so a timer on a
   * batch that left it would outlive both.
   */
  detached: boolean;
}

function receiptTargetOf(
  frame: PeerUserFrame,
  from: string,
): DropReceiptTarget {
  return {
    msgId: frame.msgId,
    from,
    ...(frame.replyToken !== undefined &&
    frame.replyToken.length <= MAX_RETAINED_REPLY_TOKEN_CHARS
      ? { replyToken: frame.replyToken }
      : {}),
  };
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
  /**
   * Receipts already handed to the transport. `flush` waits on these too:
   * one started from the immediate path is exactly as easy to cut off
   * mid-write as one it starts itself.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly send: (receipt: DroppedReceipt) => Promise<void> | void,
    options: DropReceiptCoalescerOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.trailMs = options.trailMs ?? DROP_RECEIPT_TRAIL_MS;
    this.windowStartedAt = this.now();
  }

  /** Record a drop. Sends now, or joins the batch already waiting. */
  note(frame: PeerUserFrame, origin: PeerOrigin, reason: PeerDropReason): void {
    if (this.disposed) return;
    // No reply address, no receipt. Nothing is lost that could have been
    // delivered: a sender that gave no `from` cannot be told anything.
    const replyAddress = frame.from?.slice(0, MAX_SENDER_KEY_CHARS);
    if (!replyAddress) return;

    const now = this.now();
    const batch = this.touch(`${peerSenderKey(frame, origin)}\u0000${reason}`);

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
      ignore(
        this.dispatch({
          frame: receiptTargetOf(frame, replyAddress),
          reason,
          droppedMsgIds: [],
        }),
      );
      return;
    }

    batch.pending += 1;
    if (batch.frame === undefined) {
      batch.frame = receiptTargetOf(frame, replyAddress);
      batch.reason = reason;
      batch.firstNotedAt = now;
      this.arm(batch);
    } else if (batch.ids.length < MAX_DROPPED_MSG_IDS) {
      batch.ids.push(frame.msgId);
    }
  }

  /**
   * Wait one trail, then try to send. Never on a detached batch: nothing
   * would clear the timer afterwards.
   */
  private arm(batch: ReceiptBatch): void {
    if (batch.detached || batch.timer !== undefined) return;
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      ignore(this.sendBatch(batch));
    }, this.trailMs);
    // A session with a batch waiting should still be able to exit; the
    // close path flushes what is left.
    batch.timer.unref?.();
  }

  /**
   * Send every batch still waiting, giving them at most `boundMs`.
   *
   * Called before the socket goes away. A receipt still in flight when
   * the process exits is a receipt the sender never receives, and a
   * sender left waiting on one cannot tell a drop from a delivery.
   */
  async flush(boundMs = DROP_FLUSH_BOUND_MS): Promise<void> {
    const waiting: ReceiptBatch[] = [];
    for (const batch of this.batches.values()) {
      if (batch.timer !== undefined) {
        clearTimeout(batch.timer);
        batch.timer = undefined;
      }
      if (batch.pending > 0) waiting.push(batch);
    }

    let overdue = false;
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, boundMs);
      timer.unref?.();
    });
    void deadline.then(() => {
      overdue = true;
    });

    // In slices: each receipt is an outbound connection, and the close
    // path fires its own corrective burst straight after this against a
    // ceiling that has to stay above the hold buffer's size.
    const draining = (async () => {
      for (let at = 0; at < waiting.length; at += FLUSH_CONCURRENCY) {
        if (overdue) return;
        const slice = waiting.slice(at, at + FLUSH_CONCURRENCY);
        const sends = slice
          // Forced: the budget bounds how loud this session is while it is
          // running, and it is not running after this. The senders still
          // owed a receipt are the ones the same budget silenced.
          .map((batch) => this.sendBatch(batch, true))
          .filter((value): value is Promise<void> => value instanceof Promise);
        if (sends.length > 0) await Promise.allSettled(sends);
      }
    })();

    await Promise.race([
      Promise.allSettled([draining, ...this.inFlight]),
      deadline,
    ]);
  }

  /** Drop every timer and forget every batch. */
  dispose(): void {
    this.disposed = true;
    for (const batch of this.batches.values()) {
      if (batch.timer !== undefined) clearTimeout(batch.timer);
      batch.timer = undefined;
      batch.detached = true;
    }
    this.batches.clear();
  }

  private sendBatch(batch: ReceiptBatch, force = false): Promise<void> | void {
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
    const now = this.now();
    const age = now - batch.firstNotedAt;
    if (!force && age >= MAX_DEFERRED_RECEIPT_AGE_MS) {
      // Too old to be worth holding. Nothing here decides how much of a
      // late receipt still applies: the ids it names are always worth
      // settling, since a sender left in silence cannot tell a drop from
      // a delivery that was ignored. The one part that does go stale —
      // the throttle a `rate-limited` receipt implies — is judged on the
      // sending side, which knows when it wrote each message. The close
      // path forces these out regardless, because there the sender is
      // about to lose its only chance at any answer.
      debugLogger.debug(
        `abandoning a dropped receipt held ${Math.round(age)} ms by a spent budget`,
      );
      this.clearBatch(batch);
      return;
    }
    if (!force && this.budgetSpent(now)) {
      // The window's budget is still spent: keep the batch and re-arm the
      // trail, so these drops are receipted once the window rolls rather
      // than vanishing. The budget bounds receipts per window, not which
      // drops ever get one.
      this.arm(batch);
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
    this.sentInWindow += 1;
    let result: Promise<void> | void;
    try {
      result = this.send(receipt);
    } catch (error) {
      // A `send` that throws synchronously must not take the caller down:
      // one of them is a timer callback, where it would surface as an
      // uncaught exception rather than as an error anyone can attribute.
      debugLogger.debug(`sending a dropped receipt threw: ${describe(error)}`);
      return;
    }
    if (!(result instanceof Promise)) return result;
    // Tracked so `flush` can wait for receipts it did not start itself,
    // and cleaned up either way.
    this.inFlight.add(result);
    void result.catch(() => {}).finally(() => this.inFlight.delete(result));
    return result;
  }

  private clearBatch(batch: ReceiptBatch): void {
    batch.frame = undefined;
    batch.reason = undefined;
    batch.ids = [];
    batch.pending = 0;
    if (batch.timer !== undefined) {
      clearTimeout(batch.timer);
      batch.timer = undefined;
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
      if (!evicted) continue;
      // Detached first: nothing tracks this batch any more, so a timer it
      // re-armed would outlive both `flush` and `dispose` and keep a
      // rejected message's ids alive for the life of the session.
      evicted.detached = true;
      if (evicted.timer !== undefined) {
        clearTimeout(evicted.timer);
        evicted.timer = undefined;
      }
      // Send what it was holding rather than forgetting it: the sender is
      // owed the answer whether or not this session still has room to
      // remember who it was. Not forced — an eviction is driven by the
      // flood itself, so forcing here would hand a rotating `from` an
      // unbounded supply of receipts, which is the one thing the budget
      // exists to stop. One attempt, since a detached batch cannot wait.
      if (evicted.pending > 0) ignore(this.sendBatch(evicted));
    }
    const fresh: ReceiptBatch = {
      // Negative infinity, not `now`: the first drop from a sender is the
      // one most worth answering at once.
      lastImmediateAt: Number.NEGATIVE_INFINITY,
      frame: undefined,
      reason: undefined,
      firstNotedAt: 0,
      ids: [],
      pending: 0,
      timer: undefined,
      detached: false,
    };
    this.batches.set(key, fresh);
    return fresh;
  }
}

export interface DropNotice {
  frame: Pick<PeerUserFrame, 'from' | 'fromName'>;
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
      this.emit({
        frame: {
          ...(frame.from !== undefined ? { from: frame.from } : {}),
          ...(frame.fromName !== undefined ? { fromName: frame.fromName } : {}),
        },
        origin,
        reason,
        suppressed,
      });
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
      const evicted = this.states.get(oldest);
      this.states.delete(oldest);
      // Its unannounced drops are carried, not discarded: the count this
      // reporter promises is a total, and a flood rotating `from` is
      // exactly what evicts a quiet sender that was still owed one.
      if (evicted) this.globalSuppressed += evicted.suppressed;
    }
    const fresh: NoticeState = {
      lastReportAt: Number.NEGATIVE_INFINITY,
      suppressed: 0,
    };
    this.states.set(key, fresh);
    return fresh;
  }
}

/**
 * Start a receipt nobody is waiting on.
 *
 * A receipt is best-effort by contract, so a rejected one is not an error
 * anyone can act on — but an unobserved rejection is reported to the user
 * as a crash worth filing a bug about, which is a worse lie than the
 * silence.
 */
function ignore(result: Promise<void> | void): void {
  if (result instanceof Promise) void result.catch(() => {});
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
