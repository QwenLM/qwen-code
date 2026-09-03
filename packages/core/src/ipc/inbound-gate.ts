/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decides what happens to an inbound peer message before this session's
 * model ever sees it.
 *
 * Three outcomes: **accept** (queue it), **hold** (park it for the user to
 * review, model never sees it), **refuse** (drop it and tell the sender).
 *
 * The explicit `crossSessionInbound` setting wins when set. When it is
 * unset the policy is derived from **approval-mode parity**, which
 * encodes one idea: a message may auto-deliver only when acting on it
 * cannot do more than the sender could already have done itself.
 *
 *   sender is a process this session started → accept
 *   receiver not fully reviewed + sender bypass     → accept
 *   receiver not fully reviewed + sender prompting  → hold
 *   receiver not fully reviewed + sender unasserted → hold
 *   receiver fully reviewed     + anything          → accept
 *   receiver mode unknown/unrecognized      → hold  (fail closed)
 *   policy setting unreadable               → hold  (fail closed)
 *
 * The first row is the one case where the sender is known: a connection
 * that authenticated with the child token was opened by a script or hook
 * this session itself ran, and whatever it can ask for, the session
 * already chose to run the thing that is asking. Parity has nothing to
 * weigh there. The explicit setting still wins over it — a user who said
 * `hold` reviews everything, own processes included.
 *
 * A fully reviewed receiver can accept freely because every consequential
 * action still faces its own gate; the message is a suggestion, not an
 * execution. A receiver that can apply any action without review lacks that
 * universal backstop, which is why an unverified sender has to be reviewed
 * first. These modes are YOLO, AUTO_EDIT, and AUTO:
 * auto-edit approves every edit-shaped tool call outright, while AUTO's
 * in-workspace edit fast path runs before its classifier. In either mode,
 * a peer can ask for a file change that no human or classifier sees.
 *
 * A hold is not open-ended. The sender is blocked on a decision that
 * only a person can give, so a parked message expires after
 * `agents.crossSessionHeldExpiry` (five minutes by default) and the
 * sender is told, rather than being left unable to distinguish "still
 * waiting" from "never coming". The two negative receipts stay distinct
 * for the same reason: `refused` means this session's policy turns peer
 * messages away and nobody looked, `denied` means somebody did.
 *
 * The sender's half of the parity is self-asserted and unverifiable —
 * nothing authenticates `fromMode`, and any process running as this user
 * can claim anything. It is a cooperation signal that keeps honest
 * sessions from surprising each other, not an access control; the
 * envelope's authority notice and the classifier are what stand up to a
 * hostile peer.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { APPROVAL_MODES, ApprovalMode } from '../config/approval-mode.js';
import { canonicalizeMsgId, type PeerUserFrame } from './peer-frames.js';

const debugLogger = createDebugLogger('PEER_INBOUND');

export type InboundPolicy = 'accept' | 'hold' | 'refuse';
export type GateDecision = 'accept' | 'held' | 'refused';

/**
 * Why a message ended up where it did. Surfaced to the user so a held
 * message explains itself instead of just appearing.
 */
export type HoldCause =
  | 'explicit-setting'
  | 'mode-mismatch'
  | 'no-mode-asserted'
  | 'mode-unknown'
  | 'policy-unreadable';

/**
 * Cap on parked messages.
 *
 * A hold buffer is reachable by anything that can write to the socket, so
 * it needs a ceiling or a chatty peer becomes a memory leak in a session
 * whose user stepped away. Oldest is evicted first: the newest message is
 * the one most likely to still be relevant.
 */
export const MAX_HELD_MESSAGES = 50;

/**
 * Cap on settled-id memory.
 *
 * Tombstones only have to outlive a sender's retry window; a map that
 * grew with every id the session ever saw would be the same leak the
 * hold buffer's ceiling exists to prevent. Oldest is pruned first,
 * mirroring the hold buffer.
 */
export const MAX_SETTLED_IDS = 512;

/**
 * True when a human prompt still inspects each action this session takes.
 *
 * YOLO reviews nothing. AUTO_EDIT approves edit-shaped confirmations
 * outright. AUTO's accept-edits fast path also applies in-workspace edits
 * before the classifier runs. A peer asking either mode for a file change
 * can therefore have it applied with no prompt, classifier, or user in the
 * loop — the one thing auto-delivery is supposed to rule out.
 */
export function receiverReviewsActions(mode: ApprovalMode): boolean {
  return (
    mode !== ApprovalMode.YOLO &&
    mode !== ApprovalMode.AUTO_EDIT &&
    mode !== ApprovalMode.AUTO
  );
}

/** Narrow an untyped setting value; anything else is unreadable. */
function isInboundPolicy(value: unknown): value is InboundPolicy {
  return value === 'accept' || value === 'hold' || value === 'refuse';
}

/**
 * A hold always has a reason; an accept or a refuse has none to give.
 *
 * Modelled as a union rather than an optional field because the previous
 * shape let every branch carry `cause: 'explicit-setting'`, which the UI
 * rendered as "your crossSessionInbound setting is 'hold'" even for
 * messages that sailed straight through on mode parity.
 */
export type PolicyDecision =
  | { policy: 'hold'; cause: HoldCause }
  | { policy: 'accept' | 'refuse' };

/**
 * What the transport could establish about a frame's sender. Kept apart
 * from the frame because it is not on the wire: a peer writes the frame,
 * the inbox determines this.
 */
export interface PeerOrigin {
  /**
   * The connection authenticated with the child token, so the frame came
   * from a process this session started.
   */
  selfSent: boolean;
}

/**
 * setTimeout's 32-bit ceiling. Above it Node clamps the delay to 1 ms and
 * warns, so an unclamped re-arm becomes a busy loop.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface HeldMessage {
  frame: PeerUserFrame;
  cause: HoldCause;
  heldAt: number;
  /**
   * Monotonic counterpart of `heldAt`, from `performance.now()`.
   *
   * `heldAt` is wall-clock because the UI renders a countdown from it,
   * but expiry must not move when the system clock steps. A backward NTP
   * correction would otherwise stretch a 5-minute hold to over an hour
   * with no receipt, and a step past ~24.8 days would push the delay
   * beyond setTimeout's 32-bit range, where Node clamps it to 1 ms and
   * the re-arm spins at ~1 kHz.
   *
   * Optional so entries built by hand (tests, older callers) still work;
   * those fall back to the wall clock.
   */
  monotonicAt?: number;
  /** Set when the message came from one of this session's own processes. */
  selfSent?: true;
}

export interface InboundGateOptions {
  /**
   * Current approval mode, or null when it cannot be determined — which
   * is treated as unknown, not as permissive.
   */
  getApprovalMode: () => ApprovalMode | null;
  /** Explicit user setting, if any. */
  getPolicySetting: () => InboundPolicy | undefined;
  /** Deliver an accepted message into the session's input queue. */
  deliver: (frame: PeerUserFrame, origin: PeerOrigin) => void;
  /** Report a terminal outcome back to the sender. Best-effort. */
  reportStatus?: (
    frame: PeerUserFrame,
    status:
      | 'held'
      | 'denied'
      | 'refused'
      | 'expired'
      | 'delivered'
      | 'misaddressed',
  ) => void;
  /**
   * The session id this process holds now, when pinning is wired. A
   * parked frame pinned to another id was addressed to whoever held the
   * socket before an in-process session swap (/clear, /resume), and a
   * release path must drop it as misaddressed rather than deliver it
   * into the session that replaced its addressee.
   */
  getSessionId?: () => string | undefined;
  /**
   * How long a message may sit parked before it expires, in
   * milliseconds, or null to keep it until the session ends. Read on
   * every reschedule rather than captured once, so changing the setting
   * takes effect on messages already waiting.
   */
  getHeldExpiryMs?: () => number | null;
  /** Called whenever the held set changes, for UI. */
  onHeldChange?: (held: readonly HeldMessage[]) => void;
}

/**
 * How long a held message waits for a decision by default.
 *
 * A hold is a question put to a person who may not be at the keyboard,
 * and the sender is blocked on the answer. Five minutes is long enough
 * for someone who is there to notice `/peers` and short enough that a
 * sender is not left indefinitely unable to tell "still waiting" from
 * "never coming".
 */
export const DEFAULT_HELD_EXPIRY_MS = 5 * 60 * 1000;

/** The hold lifetimes `agents.crossSessionHeldExpiry` accepts. */
const HELD_EXPIRY_VALUES: Record<string, number | null> = {
  '1m': 60 * 1000,
  '5m': DEFAULT_HELD_EXPIRY_MS,
  '10m': 10 * 60 * 1000,
  never: null,
};

/**
 * The accepted `crossSessionHeldExpiry` values, in schema order.
 *
 * Exported so the settings schema's option list can be asserted against
 * this table rather than kept in step by hand. An option added there
 * without an entry here does not fail anywhere: `parseHeldExpiry` takes
 * its unrecognized branch, logs at debug level, and silently returns the
 * five-minute default -- so a user who asked for thirty minutes gets a
 * review window six times shorter, with no error and a green suite.
 */
export const HELD_EXPIRY_OPTIONS: readonly string[] =
  Object.keys(HELD_EXPIRY_VALUES);

/**
 * Turn the configured hold lifetime into milliseconds, or null for
 * "never".
 *
 * An unset or unrecognized value is the default rather than "never":
 * this setting decides how long a *sender* waits without an answer, and
 * failing closed here means bounding that wait, not extending it
 * indefinitely on a typo.
 */
export function parseHeldExpiry(value: unknown): number | null {
  if (value === undefined) return DEFAULT_HELD_EXPIRY_MS;
  if (typeof value !== 'string' || !Object.hasOwn(HELD_EXPIRY_VALUES, value)) {
    debugLogger.debug(
      `unrecognized crossSessionHeldExpiry value (using the default): ${String(
        value,
      )}`,
    );
    return DEFAULT_HELD_EXPIRY_MS;
  }
  return HELD_EXPIRY_VALUES[value] ?? null;
}

/**
 * Per-session gate. Holds parked messages in memory only: a message the
 * user never reviewed should not outlive the session that received it.
 */
export class InboundGate {
  private readonly held: HeldMessage[] = [];
  /**
   * Canonicalized ids this gate already settled, with their verdict.
   * A re-sent id repeats its verdict instead of re-entering the gate:
   * the duplicate guard over `held` alone would let a peer slip a
   * different body behind an id the user already decided — or saw
   * evicted — and have it decided again.
   */
  private readonly settled = new Map<
    string,
    'delivered' | 'denied' | 'refused' | 'expired' | 'misaddressed'
  >();
  private shuttingDown = false;
  /**
   * One timer for the whole buffer, armed for the message that expires
   * first. A timer per message would be up to `MAX_HELD_MESSAGES` of
   * them, all firing to do the same sweep.
   */
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: InboundGateOptions) {}

  /** Messages currently parked, oldest first. */
  getHeld(): readonly HeldMessage[] {
    return this.held;
  }

  /**
   * The current hold lifetime in milliseconds, or null when holds do not
   * expire. Exposed so `/peers` can tell the user how long a message has
   * left rather than making them guess.
   */
  getHeldExpiryMs(): number | null {
    if (this.options.getHeldExpiryMs === undefined) {
      return DEFAULT_HELD_EXPIRY_MS;
    }
    try {
      return this.options.getHeldExpiryMs();
    } catch (error) {
      debugLogger.debug(
        `held-expiry getter threw; falling back to the default: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return DEFAULT_HELD_EXPIRY_MS;
    }
  }

  /**
   * Resolve the policy for a frame, and explain it.
   *
   * Exposed for tests and for the UI, which shows the cause next to a
   * held message.
   */
  resolvePolicy(
    frame?: Pick<PeerUserFrame, 'fromMode'>,
    origin?: PeerOrigin,
  ): PolicyDecision {
    // The setting is read from user configuration, so it can be missing,
    // misspelled, or backed by a getter that throws mid-teardown. None of
    // those are "the user asked for accept".
    let explicit: InboundPolicy | undefined;
    try {
      const configured = this.options.getPolicySetting();
      if (configured !== undefined && !isInboundPolicy(configured)) {
        debugLogger.debug(
          `unrecognized crossSessionInbound value (failing closed): ${String(
            configured,
          )}`,
        );
        return { policy: 'hold', cause: 'policy-unreadable' };
      }
      explicit = configured;
    } catch (error) {
      debugLogger.debug(
        `policy-setting getter threw (failing closed): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { policy: 'hold', cause: 'policy-unreadable' };
    }
    if (explicit !== undefined) {
      return { policy: explicit, cause: 'explicit-setting' };
    }

    // Known sender: parity compares what two sessions may do, and a
    // process this session ran is not another session.
    if (origin?.selfSent) {
      return { policy: 'accept' };
    }

    let mode: ApprovalMode | null;
    try {
      mode = this.options.getApprovalMode();
    } catch (error) {
      debugLogger.debug(
        `approval-mode getter threw (failing closed): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      mode = null;
    }
    // A mode this build does not know about is unknown, not permissive:
    // the parity rule can say nothing about a mode whose gating behaviour
    // it has never seen.
    if (mode === null || !APPROVAL_MODES.includes(mode)) {
      return { policy: 'hold', cause: 'mode-unknown' };
    }

    if (receiverReviewsActions(mode)) {
      return { policy: 'accept' };
    }

    // Not every action this session takes is reviewed from here down.
    const sender = frame?.fromMode;
    if (sender === undefined) {
      return { policy: 'hold', cause: 'no-mode-asserted' };
    }
    return sender === 'bypass'
      ? { policy: 'accept' }
      : { policy: 'hold', cause: 'mode-mismatch' };
  }

  /**
   * Run a freshly-arrived message through the gate. `origin` defaults to
   * an ordinary peer — the transport asserts self-sent, never the frame.
   */
  admit(
    frame: PeerUserFrame,
    origin: PeerOrigin = { selfSent: false },
  ): GateDecision {
    // Timers can be starved or slept through (a suspended laptop), so
    // every entry point sweeps before it reads the buffer rather than
    // trusting the timer to have fired.
    this.expireOverdue();

    // An id that is already settled has a final answer: repeat its
    // receipt and stop. This is what keeps a re-send from re-parking a
    // swapped body under a handle the user already reviewed.
    const settled = this.settled.get(canonicalizeMsgId(frame.msgId));
    if (settled !== undefined) {
      debugLogger.debug(
        `re-sent msgId ${frame.msgId}; repeating earlier verdict ${settled}`,
      );
      void this.report(frame, settled);
      return 'refused';
    }

    // An id that is already parked has an answer. A second frame under
    // the same id is the sender retrying, or a peer slipping a different
    // body behind an id the user has already been shown — and two entries
    // sharing an id can never be decided individually, because `/peers`
    // rejects an id that matches more than one message. Repeat the
    // verdict and keep exactly one entry per id. Compared in the same
    // canonical form `/peers` prints and resolves — dashes stripped, case
    // folded — so a case- or dash-variant clone is the same handle.
    if (
      this.held.some(
        (entry) =>
          canonicalizeMsgId(entry.frame.msgId) ===
          canonicalizeMsgId(frame.msgId),
      )
    ) {
      debugLogger.debug(`duplicate msgId ${frame.msgId}; already held`);
      void this.report(frame, 'held');
      return 'held';
    }

    const decision = this.resolvePolicy(frame, origin);
    const { policy } = decision;

    if (policy === 'refuse') {
      debugLogger.debug(`refused peer message ${frame.msgId}`);
      // Not 'denied': nobody looked at it. A sender told its message was
      // declined waits for a person to change their mind; one told the
      // session refuses peer messages knows to stop.
      this.recordSettled(frame.msgId, 'refused');
      void this.report(frame, 'refused');
      return 'refused';
    }

    if (this.shuttingDown) {
      // Nothing will act on a message accepted now — the input queue goes
      // away with the session — and nothing will ever release one parked
      // now. Either way the honest receipt is 'expired'; 'delivered'
      // would leave the sender believing the peer has the message.
      debugLogger.debug(
        `not admitting peer message ${frame.msgId} during shutdown; expiring it`,
      );
      void this.report(frame, 'expired');
      return 'refused';
    }

    if (policy === 'accept') {
      const ok = this.tryDeliver(frame, origin);
      if (ok) {
        this.recordSettled(frame.msgId, 'delivered');
      }
      // A failed delivery is transient (the input queue is full); the id
      // is deliberately not settled, so an honest sender retry can land.
      void this.report(frame, ok ? 'delivered' : 'expired');
      return ok ? 'accept' : 'refused';
    }

    if (this.held.length >= MAX_HELD_MESSAGES) {
      const evicted = this.held.shift();
      if (evicted) {
        debugLogger.debug(`hold buffer full; expiring ${evicted.frame.msgId}`);
        this.recordSettled(evicted.frame.msgId, 'expired');
        void this.report(evicted.frame, 'expired');
      }
    }

    const cause = decision.policy === 'hold' ? decision.cause : 'mode-unknown';
    this.held.push({
      frame,
      cause,
      heldAt: Date.now(),
      monotonicAt: performance.now(),
      ...(origin.selfSent ? { selfSent: true } : {}),
    });
    debugLogger.debug(
      `held peer message ${frame.msgId} (cause=${cause}, ${this.held.length} held)`,
    );
    void this.report(frame, 'held');
    this.notifyHeldChange();
    this.rescheduleExpiry();
    return 'held';
  }

  /**
   * Release or drop one parked message.
   *
   * Returns 'gone' when the id is unknown — it may have been evicted,
   * expired at shutdown, or already decided. Callers surface that rather
   * than treating it as an error, because a stale UI action is normal.
   *
   * Returns 'failed' when an approved message could not be delivered
   * (the input queue is full or tearing down). The message is parked
   * again exactly where it was, so it stays reviewable and the user can
   * retry; claiming 'done' would report a release that never happened.
   */
  decide(
    msgId: string,
    decision: 'approve' | 'deny',
  ): 'done' | 'failed' | 'gone' {
    // Before the lookup: an expired message must read as 'gone' rather
    // than be released by a user acting on a listing that has gone stale.
    this.expireOverdue();
    const index = this.held.findIndex((entry) => entry.frame.msgId === msgId);
    if (index === -1) return 'gone';
    const [entry] = this.held.splice(index, 1);
    if (!entry) return 'gone';

    if (decision === 'approve') {
      if (!this.pinStillValid(entry.frame)) {
        // Dropped, not released: the id is tombstoned like every other
        // terminal outcome, and the caller is told the message is gone
        // rather than that it will appear on the next turn.
        this.recordSettled(entry.frame.msgId, 'misaddressed');
        void this.report(entry.frame, 'misaddressed');
        this.notifyHeldChange();
        this.rescheduleExpiry();
        return 'gone';
      }
      if (!this.tryDeliver(entry.frame, originOf(entry))) {
        // Parked again at its old position, keeping its original
        // `heldAt`: a failed release does not restart the clock, or a
        // full input queue could keep a message alive indefinitely.
        this.held.splice(index, 0, entry);
        void this.report(entry.frame, 'held');
        this.notifyHeldChange();
        this.rescheduleExpiry();
        return 'failed';
      }
      this.recordSettled(entry.frame.msgId, 'delivered');
      void this.report(entry.frame, 'delivered');
    } else {
      this.recordSettled(entry.frame.msgId, 'denied');
      void this.report(entry.frame, 'denied');
    }
    this.notifyHeldChange();
    this.rescheduleExpiry();
    return 'done';
  }

  /**
   * Re-run every parked message through the gate.
   *
   * Called when the approval mode or the setting changes: a message held
   * only because the modes disagreed should be delivered once they agree,
   * without the user having to approve it by hand. The reverse also
   * holds — switching to `refuse` drops the backlog.
   *
   * Returns the number of messages released.
   */
  reevaluate(reason: string): number {
    // Runs on every settings change, which is also how a changed hold
    // lifetime reaches the buffer: sweep against the new one, then re-arm
    // the timer for whatever survives.
    this.expireOverdue();
    this.rescheduleExpiry();
    if (this.held.length === 0) return 0;

    const stillHeld: HeldMessage[] = [];
    const release: HeldMessage[] = [];
    let dropped = 0;

    for (const entry of this.held) {
      const decision = this.resolvePolicy(entry.frame, originOf(entry));
      const { policy } = decision;
      if (policy === 'accept') {
        release.push(entry);
      } else if (policy === 'refuse') {
        dropped += 1;
        // 'denied', not 'refused': this message was admitted and parked,
        // and what settles it now is the user switching the setting —
        // a decision, made after the fact, by a person.
        this.recordSettled(entry.frame.msgId, 'denied');
        void this.report(entry.frame, 'denied');
      } else {
        const cause = decision.policy === 'hold' ? decision.cause : entry.cause;
        stillHeld.push(cause === entry.cause ? entry : { ...entry, cause });
      }
    }

    let released = 0;
    let misaddressed = 0;
    for (const entry of release) {
      if (!this.pinStillValid(entry.frame)) {
        misaddressed += 1;
        this.recordSettled(entry.frame.msgId, 'misaddressed');
        void this.report(entry.frame, 'misaddressed');
        continue;
      }
      if (this.tryDeliver(entry.frame, originOf(entry))) {
        released += 1;
        this.recordSettled(entry.frame.msgId, 'delivered');
        void this.report(entry.frame, 'delivered');
      } else {
        // A failed delivery must not drop a message the user can still
        // review: park it again and tell the sender it is still waiting.
        stillHeld.push(entry);
        void this.report(entry.frame, 'held');
      }
    }

    this.held.length = 0;
    // Sorted, not appended in loop order: a failed release keeps its
    // original (older) timestamp, and pushing it behind newer entries
    // would leave `held.shift()` evicting the newest message at
    // MAX_HELD_MESSAGES -- the opposite of "evict the oldest".
    stillHeld.sort((a, b) => a.heldAt - b.heldAt);
    this.held.push(...stillHeld);
    this.rescheduleExpiry();

    if (release.length > 0 || dropped > 0) {
      debugLogger.debug(
        `reevaluate (${reason}): released ${released}, dropped ${dropped}, misaddressed ${misaddressed}, ${this.held.length} still held`,
      );
      this.notifyHeldChange();
    }
    return released;
  }

  /**
   * Settle every parked message as expired and refuse new holds.
   *
   * A sender blocked on a decision has to learn that no decision is
   * coming; silence would look identical to "delivered and ignored".
   */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.held.length === 0) return Promise.resolve();
    const settling = this.held.splice(0, this.held.length);
    debugLogger.debug(
      `shutdown: expiring ${settling.length} held peer message(s)`,
    );
    const receipts = settling.map((entry) =>
      this.report(entry.frame, 'expired'),
    );
    this.notifyHeldChange();
    // The caller tears the socket down next and the process exits right
    // after: a receipt still in flight when close resolves is a receipt
    // the sender never receives.
    return Promise.allSettled(receipts).then(() => undefined);
  }

  /** Remember a settled id, pruning the oldest beyond the cap. */
  private recordSettled(
    msgId: string,
    verdict: 'delivered' | 'denied' | 'refused' | 'expired' | 'misaddressed',
  ): void {
    const key = canonicalizeMsgId(msgId);
    // Delete-then-set refreshes recency: Map iterates in insertion
    // order, and the prune below drops the oldest.
    this.settled.delete(key);
    this.settled.set(key, verdict);
    while (this.settled.size > MAX_SETTLED_IDS) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }

  /**
   * A frame's pin is judged at arrival, but a session swap can happen
   * while it sits parked; the release paths re-judge against the id the
   * session holds now, not the one the frame saw on arrival.
   */
  private pinStillValid(frame: PeerUserFrame): boolean {
    if (frame.toSessionId === undefined) return true;
    const ownSessionId = this.options.getSessionId?.();
    return ownSessionId === undefined || frame.toSessionId === ownSessionId;
  }

  /**
   * Receipt a terminal outcome without letting the transport take the
   * gate down with it.
   *
   * These run inside loops that have already removed entries from the
   * held set: a throw partway through would strand every message after it
   * with no receipt and no way for the user to reach it — the exact
   * silent loss the receipts exist to prevent.
   */
  private report(
    frame: PeerUserFrame,
    status:
      | 'held'
      | 'denied'
      | 'refused'
      | 'expired'
      | 'delivered'
      | 'misaddressed',
  ): Promise<void> {
    try {
      return Promise.resolve(this.options.reportStatus?.(frame, status));
    } catch (error) {
      debugLogger.debug(
        `reportStatus(${status}) threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return Promise.resolve();
    }
  }

  /** Hand a message to the session, reporting whether it landed. */
  private tryDeliver(frame: PeerUserFrame, origin: PeerOrigin): boolean {
    try {
      this.options.deliver(frame, origin);
      return true;
    } catch (error) {
      debugLogger.error(
        `deliver threw for ${frame.msgId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Settle every message whose hold has run out.
   *
   * Expiry is judged against the lifetime configured *now*, not the one
   * in force when each message arrived: shortening the setting expires a
   * backlog that is already too old, and lengthening it gives the
   * backlog the longer window. Either reading is defensible; this one
   * has the property that what `/peers` shows as remaining is what
   * actually happens.
   */
  /**
   * How long `entry` has been parked: the larger of the wall-clock and
   * monotonic elapsed times.
   *
   * Neither clock alone is right. The wall clock is what a suspended
   * machine advances -- CLOCK_MONOTONIC does not tick across suspend, so
   * a monotonic-only age would keep a message parked through a two-hour
   * sleep. But the wall clock also moves when nothing elapsed: a
   * backward NTP correction of an hour would stretch a five-minute hold
   * past sixty, and a step over ~24.8 days pushes the re-armed delay
   * beyond setTimeout's range.
   *
   * Taking the larger keeps the suspend case working and makes a
   * backward step a no-op, at the cost of treating a forward step as
   * elapsed time -- which is the conservative direction, and in any case
   * a forward step is indistinguishable from a suspend from in here.
   */
  private ageOf(entry: HeldMessage): number {
    const wall = Date.now() - entry.heldAt;
    if (entry.monotonicAt === undefined) return wall;
    return Math.max(wall, performance.now() - entry.monotonicAt);
  }

  private expireOverdue(): void {
    const expiryMs = this.getHeldExpiryMs();
    if (expiryMs === null || this.held.length === 0) return;
    const survivors: HeldMessage[] = [];
    const expired: HeldMessage[] = [];
    for (const entry of this.held) {
      (this.ageOf(entry) >= expiryMs ? expired : survivors).push(entry);
    }
    if (expired.length === 0) return;

    this.held.length = 0;
    this.held.push(...survivors);
    for (const entry of expired) {
      debugLogger.debug(
        `held peer message ${entry.frame.msgId} expired after ${expiryMs} ms`,
      );
      this.recordSettled(entry.frame.msgId, 'expired');
      void this.report(entry.frame, 'expired');
    }
    this.notifyHeldChange();
    // Every entry point sweeps, and several of them return without
    // touching the buffer afterwards (`decide` answering 'gone',
    // `admit`'s non-hold paths). Without this a survivor's own deadline
    // would wait on the next unrelated frame, or on a stale timer.
    this.rescheduleExpiry();
  }

  /**
   * Arm the timer for whichever message expires first, or clear it when
   * nothing is waiting and when holds do not expire.
   *
   * Called after every change to the buffer. Unref'd: a session with a
   * message parked should still be able to exit, and shutdown settles
   * the backlog anyway.
   */
  private rescheduleExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.shuttingDown) return;
    const expiryMs = this.getHeldExpiryMs();
    if (expiryMs === null) return;
    let oldestAge: number | null = null;
    for (const entry of this.held) {
      const age = this.ageOf(entry);
      if (oldestAge === null || age > oldestAge) oldestAge = age;
    }
    if (oldestAge === null) return;

    // Scanned rather than read from `held[0]`: a failed release re-parks
    // an entry keeping its original timestamp, so the buffer is not
    // reliably oldest-first and the head can carry a later deadline.
    //
    // Never negative, and never zero: a zero-delay timer that fires
    // inside the same tick as the change that armed it would recurse.
    // Never above setTimeout's 32-bit ceiling either, where Node clamps
    // to 1 ms and the callback re-arms the same oversized delay.
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(1, expiryMs - oldestAge));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expireOverdue();
      this.rescheduleExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private notifyHeldChange(): void {
    try {
      this.options.onHeldChange?.(this.held);
    } catch (error) {
      debugLogger.debug(
        `onHeldChange threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function originOf(entry: HeldMessage): PeerOrigin {
  return { selfSent: entry.selfSent === true };
}

/** One-line explanation of why a message is parked, for the UI. */
export function describeHoldCause(cause: HoldCause): string {
  switch (cause) {
    case 'explicit-setting':
      return 'your crossSessionInbound setting is "hold"';
    case 'mode-mismatch':
      return 'this session can apply some actions without per-action review and the sender does not';
    case 'no-mode-asserted':
      return 'this session can apply some actions without per-action review and the sender did not say whether it does';
    case 'mode-unknown':
      return "this session's approval mode could not be determined";
    case 'policy-unreadable':
      return 'your crossSessionInbound setting could not be read';
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}
