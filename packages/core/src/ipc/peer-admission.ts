/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How fast a peer may talk to this session.
 *
 * Everything downstream of here — the gate's policy, the hold buffer, the
 * input queue — costs something per message, and the one thing none of
 * them bounds is the *arrival rate*. A peer that writes as fast as a
 * socket accepts does not need to be malicious to hurt: two sessions in
 * the same review class replying to each other automatically is a loop
 * that auto-delivers, and a model in a retry loop re-sends the same
 * sentence until something changes. Both fill the receiver's queue, and
 * both starve the receipts that would tell their senders to stop —
 * receipts share one outbound ceiling with everything else this session
 * sends, so under a flood the messages that lose their receipt first are
 * the legitimate ones.
 *
 * So arrival is metered before policy runs. Three numbers do it:
 *
 *   per sender   30 at once, then one every two seconds
 *   all senders  32 at once, then one a second
 *   duplicates   the same body from one peer inside 30 seconds
 *
 * The per-sender bucket is what an ordinary conversation meets; the
 * global one exists because a sender is self-asserted. `from` is a field in a frame (see the note
 * in `uds-inbox.ts`), so a peer that wants a fresh bucket only has to
 * write a different one — the global bucket is what makes rotating it
 * pointless. It sits barely above one sender's burst deliberately: every
 * admitted message draws a receipt, and those share one outbound ceiling
 * with everything else this session sends. Neither is a security boundary: a hostile same-uid process
 * has better options than flooding a socket. They bound the damage an
 * ordinary bug does.
 *
 * A duplicate is judged on the body because the id is not evidence: the
 * gate already ignores a re-sent `msgId`, and a model looping on "are you
 * done yet" mints a fresh one every time. Only messages from another
 * session are compared. A process this session started, and a controller
 * the user granted a token to, are exempt: a hook that reports two builds
 * in thirty seconds is reporting two facts, and a user who says
 * "continue" twice to a voice front-end means it twice. Neither is the
 * model-driven repetition this check exists to stop, and both are already
 * limited by the buckets, which apply to every sender alike.
 *
 * Nothing here reports anything. A verdict is returned; the gate decides
 * what to tell the sender and the user (`peer-drop-reports.ts` folds
 * both, so a burst does not become a burst of notices).
 */

import { createHash } from 'node:crypto';
import { createDebugLogger } from '../utils/debugLogger.js';
import { canonicalizeMsgId } from './peer-frames.js';

const debugLogger = createDebugLogger('PEER_ADMISSION');

/**
 * Why a message never reached the gate's policy.
 *
 * `queue-full` is not decided here — it is what the gate reports when an
 * accepted message cannot be handed to the session's input queue — but it
 * travels on the same receipt and belongs to the same vocabulary.
 */
export type PeerDropReason = 'rate-limited' | 'duplicate' | 'queue-full';

/**
 * The metering constants.
 *
 * Deliberately not settings. A session's protection against a peer that
 * outruns it is not something the peer's user, or a repository, should be
 * able to widen, and these are far above what a person or a well-behaved
 * model reaches: thirty messages at once is more than a session can read
 * in a turn, and one every two seconds sustained is faster than any
 * useful conversation between two agents.
 */
export interface PeerAdmissionLimits {
  /** Burst a single sender may land before the sustained rate applies. */
  bucketCapacity: number;
  /** Sustained per-sender rate once the burst is spent. */
  refillPerSecond: number;
  /** The same body from the same peer inside this window is a duplicate. */
  dedupWindowMs: number;
  /**
   * Burst across every sender combined — `from` is self-asserted.
   *
   * Kept at half the 64-send outbound ceiling so an admitted burst cannot
   * occupy every receipt slot. The downstream buffers are larger (50 each),
   * so the meter remains the first bound a rotating sender reaches.
   */
  globalBucketCapacity: number;
  globalRefillPerSecond: number;
  /** Sender buckets kept at once; see the eviction note in `trackSender`. */
  maxTrackedSenders: number;
}

// Annotated rather than `as const`: the literal types a const assertion
// infers would make `Partial<PeerAdmissionLimits>` accept only these exact
// values, so a caller could not narrow one for a test.
export const PEER_ADMISSION_LIMITS: Readonly<PeerAdmissionLimits> = {
  bucketCapacity: 30,
  refillPerSecond: 0.5,
  dedupWindowMs: 30_000,
  globalBucketCapacity: 32,
  globalRefillPerSecond: 1,
  maxTrackedSenders: 256,
};

/**
 * How long a burst takes to refill completely, in milliseconds.
 *
 * The sender-side pacer uses it to decide when a burst it counted is over.
 */
export const PEER_BURST_WINDOW_MS =
  (PEER_ADMISSION_LIMITS.bucketCapacity /
    PEER_ADMISSION_LIMITS.refillPerSecond) *
  1000;

/**
 * A token bucket's level, brought forward to `now`.
 *
 * Shared with the sender-side pacer in `peer-send.ts` so the two sides
 * cannot drift: a sender that models the receiver's limit with different
 * arithmetic would refuse sends the receiver would have taken, or let
 * through sends it drops.
 *
 * Elapsed time is floored at zero. The callers pass a monotonic clock, but
 * a caller that passes a wall clock must not be handed *more* than the
 * capacity by a backward step.
 */
export function refillBucket(
  tokens: number,
  lastRefill: number,
  now: number,
  capacity: number,
  perSecond: number,
): number {
  const elapsedSeconds = Math.max(0, now - lastRefill) / 1000;
  return Math.min(capacity, tokens + elapsedSeconds * perSecond);
}

/** A bucket has something to spend only at a whole token. */
export function hasToken(tokens: number): boolean {
  return tokens >= 1;
}

/** Whether a remembered body is still inside the shared repeat window. */
export function isBodyWithinWindow(
  at: number,
  atWall: number,
  now: number,
  wallNow: number,
  windowMs: number,
): boolean {
  return Math.max(now - at, wallNow - atWall) < windowMs;
}

/**
 * A sender's meter.
 *
 * The body is kept as a digest rather than as itself: a frame may carry a
 * megabyte, and remembering the last one for each of 256 senders would be
 * a quarter of a gigabyte held to answer a question that only needs
 * "same or not". A digest collision would drop one message as a repeat,
 * and the sender is told; the memory is not worth the difference.
 */
interface AdmittedBody {
  messageId: string | undefined;
  hash: string;
  at: number;
  atWall: number;
}

interface SenderMeter {
  tokens: number;
  lastRefill: number;
  /**
   * Bodies admitted inside the dedup window, in arrival order.
   *
   * The gate can roll back admitted messages in any order, so one previous
   * slot is not enough. The latest record is the duplicate baseline; older
   * records remain only long enough to become the baseline if a later
   * undelivered message is removed.
   */
  bodies: AdmittedBody[];
}

export interface AdmissionRequest {
  /**
   * Stable identity for the sender. The frame's `from` when it gave one,
   * otherwise what the transport established — see `peerSenderKey`.
   */
  senderKey: string;
  body: string;
  /** Message identity used to roll back this exact admission. */
  messageId?: string;
  /**
   * Skip the duplicate check. Set for this session's own processes and
   * for trusted controllers; the buckets still apply.
   */
  exemptFromDedup?: boolean;
}

export type AdmissionVerdict =
  | { admitted: true }
  | { admitted: false; reason: 'rate-limited' | 'duplicate' };

export interface PeerAdmissionOptions {
  /** Injectable monotonic clock. Production uses `performance.now()`. */
  now?: () => number;
  /**
   * Injectable wall clock, read only for the repeat window. Production
   * uses `Date.now()`.
   */
  wallNow?: () => number;
  limits?: Partial<PeerAdmissionLimits>;
}

/**
 * Per-session meter. In memory only, like the hold buffer: a rate limit
 * describes a conversation in progress, and there is no conversation to
 * carry across a restart.
 */
export class PeerAdmission {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly limits: PeerAdmissionLimits;
  private readonly senders = new Map<string, SenderMeter>();
  private globalTokens: number;
  private globalRefill: number;

  constructor(options: PeerAdmissionOptions = {}) {
    // The buckets run on performance.now(), not Date.now(): a wall-clock
    // step would either hand a flooding peer a full bucket or freeze a
    // well-behaved one out for as long as the step, and neither is about
    // how fast it is actually sending. The repeat window cannot: a
    // monotonic clock does not tick across a system suspend, so a re-send
    // after a resume would be judged against only the seconds the machine
    // was awake. There the larger of the wall and monotonic deltas is
    // what counts — the same max the hold buffer's `ageOf` takes. A
    // forward wall step can then admit one repeat, which the
    // still-monotonic buckets bound.
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.limits = { ...PEER_ADMISSION_LIMITS, ...options.limits };
    this.globalTokens = this.limits.globalBucketCapacity;
    this.globalRefill = this.now();
  }

  /**
   * Whether this message may go on to the gate's policy.
   *
   * The order matters. The global bucket is checked first, so a flood
   * that rotates `from` is stopped before it can mint a meter per name.
   * The duplicate check comes before the sender's bucket is charged: a
   * repeat should not also cost the sender the allowance it would need to
   * say something new. Nothing is charged unless every check passes.
   */
  admit(request: AdmissionRequest): AdmissionVerdict {
    const now = this.now();
    const wallNow = this.wallNow();

    this.globalTokens = refillBucket(
      this.globalTokens,
      this.globalRefill,
      now,
      this.limits.globalBucketCapacity,
      this.limits.globalRefillPerSecond,
    );
    this.globalRefill = now;
    if (!hasToken(this.globalTokens)) {
      debugLogger.debug(
        `dropping a peer message from ${request.senderKey}: every sender combined is over the rate limit`,
      );
      return { admitted: false, reason: 'rate-limited' };
    }

    const meter = this.trackSender(request.senderKey, now);

    meter.bodies = meter.bodies.filter((record) =>
      isBodyWithinWindow(
        record.at,
        record.atWall,
        now,
        wallNow,
        this.limits.dedupWindowMs,
      ),
    );

    const bodyHash = request.exemptFromDedup
      ? undefined
      : hashBody(request.body);
    const lastBody = meter.bodies.at(-1);
    if (bodyHash !== undefined && lastBody?.hash === bodyHash) {
      debugLogger.debug(
        `dropping a peer message from ${request.senderKey}: identical to its previous message`,
      );
      return { admitted: false, reason: 'duplicate' };
    }

    meter.tokens = refillBucket(
      meter.tokens,
      meter.lastRefill,
      now,
      this.limits.bucketCapacity,
      this.limits.refillPerSecond,
    );
    meter.lastRefill = now;
    if (!hasToken(meter.tokens)) {
      debugLogger.debug(
        `dropping a peer message from ${request.senderKey}: over its rate limit`,
      );
      return { admitted: false, reason: 'rate-limited' };
    }

    this.globalTokens -= 1;
    meter.tokens -= 1;
    if (bodyHash !== undefined) {
      meter.bodies.push({
        messageId: request.messageId,
        hash: bodyHash,
        at: now,
        atWall: wallNow,
      });
    }
    return { admitted: true };
  }

  /** How many senders are metered right now. For tests and diagnostics. */
  trackedSenderCount(): number {
    return this.senders.size;
  }

  /**
   * Undo the repeat record `body` left when it was admitted, leaving the
   * bucket alone.
   *
   * The gate calls this wherever it settles an admitted message as
   * anything other than delivered or held — a full input queue, a
   * standing refusal, a hold buffer with no room, a shutdown, a session
   * swap. In every one of those the far model never saw the message, so a
   * `duplicate` verdict on the sender's honest retry would assert
   * something false: that identical content is already over there. The
   * retry then meets the repeat check it would have met had this message
   * never arrived.
   *
   * Removes only this message's record. A later admitted message remains
   * the duplicate baseline, and the body admitted before this one keeps
   * the protection it earned if it becomes the latest remaining record.
   *
   * The token stays spent. It is the only bound on how often a peer can
   * make the receiver attempt, and fail, a delivery.
   */
  forgetBody(senderKey: string, body: string, messageId?: string): void {
    const meter = this.senders.get(senderKey);
    if (meter === undefined) return;
    const bodyHash = hashBody(body);
    for (let index = meter.bodies.length - 1; index >= 0; index -= 1) {
      const record = meter.bodies[index];
      if (
        record?.hash === bodyHash &&
        (messageId === undefined || record.messageId === messageId)
      ) {
        meter.bodies.splice(index, 1);
      }
    }
  }

  /** Undo every repeat record owned by one admitted message. */
  forgetMessage(senderKey: string, messageId: string): void {
    const meter = this.senders.get(senderKey);
    if (meter === undefined) return;
    const canonicalId = canonicalizeMsgId(messageId);
    meter.bodies = meter.bodies.filter(
      (record) =>
        record.messageId === undefined ||
        canonicalizeMsgId(record.messageId) !== canonicalId,
    );
  }

  /** Start a fresh per-session conversation without replacing the gate. */
  reset(): void {
    this.senders.clear();
    this.globalTokens = this.limits.globalBucketCapacity;
    this.globalRefill = this.now();
  }

  /**
   * The meter for `key`, creating one and making room if needed.
   *
   * The map is an LRU: a hit is re-inserted so iteration order is
   * least-recently-seen first. When it is full, a meter whose bucket has
   * refilled completely goes first — it is not limiting anyone, so
   * forgetting it changes no verdict except that its last body is
   * forgotten too, which can admit one repeat. Losing a repeat check is
   * the right thing to trade for a bounded map; losing a *bucket* that is
   * currently holding a flood back is not, which is why a full bucket is
   * preferred over a merely old one.
   */
  private trackSender(key: string, now: number): SenderMeter {
    const existing = this.senders.get(key);
    if (existing !== undefined) {
      this.senders.delete(key);
      this.senders.set(key, existing);
      return existing;
    }

    const limit = Math.max(1, this.limits.maxTrackedSenders);
    while (this.senders.size >= limit) {
      let victim: string | undefined;
      for (const [candidate, meter] of this.senders) {
        const level = refillBucket(
          meter.tokens,
          meter.lastRefill,
          now,
          this.limits.bucketCapacity,
          this.limits.refillPerSecond,
        );
        if (level >= this.limits.bucketCapacity) {
          victim = candidate;
          break;
        }
      }
      victim ??= this.senders.keys().next().value;
      if (victim === undefined) break;
      this.senders.delete(victim);
    }

    const fresh: SenderMeter = {
      tokens: this.limits.bucketCapacity,
      lastRefill: now,
      bodies: [],
    };
    this.senders.set(key, fresh);
    return fresh;
  }
}

/** The digest a body is remembered by; see `SenderMeter`. */
export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
