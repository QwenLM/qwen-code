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
 *   receiver unreviewed + sender bypass     → accept
 *   receiver unreviewed + sender prompting  → hold
 *   receiver unreviewed + sender unasserted → hold
 *   receiver reviewed   + anything          → accept
 *   receiver mode unknown/unrecognized      → hold  (fail closed)
 *   policy setting unreadable               → hold  (fail closed)
 *
 * A reviewed receiver can accept freely because every consequential
 * action still faces its own gate; the message is a suggestion, not an
 * execution. An unreviewed receiver has no such backstop, so anything it
 * is told to do simply happens — which is why an unverified sender has
 * to be reviewed first. "Unreviewed" means YOLO *and* AUTO_EDIT:
 * auto-edit approves every edit-shaped tool call outright
 * (`permissionFlow.isAutoEditApproved`), with no prompt and no
 * classifier, so a peer asking for a file change gets it unseen.
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
 * True when something — a human prompt or the AUTO classifier — still
 * inspects each action this session takes.
 *
 * YOLO reviews nothing. AUTO_EDIT reviews nothing about an edit: the
 * scheduler approves every edit-shaped confirmation outright, so a peer
 * message asking for a file change is carried out with no prompt, no
 * classifier and no user in the loop — the one thing auto-delivery is
 * supposed to rule out.
 */
export function receiverReviewsActions(mode: ApprovalMode): boolean {
  return mode !== ApprovalMode.YOLO && mode !== ApprovalMode.AUTO_EDIT;
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

export interface HeldMessage {
  frame: PeerUserFrame;
  cause: HoldCause;
  heldAt: number;
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
  deliver: (frame: PeerUserFrame) => void;
  /** Report a terminal outcome back to the sender. Best-effort. */
  reportStatus?: (
    frame: PeerUserFrame,
    status: 'held' | 'denied' | 'expired' | 'delivered',
  ) => void;
  /** Called whenever the held set changes, for UI. */
  onHeldChange?: (held: readonly HeldMessage[]) => void;
}

/**
 * Per-session gate. Holds parked messages in memory only: a message the
 * user never reviewed should not outlive the session that received it.
 */
export class InboundGate {
  private readonly held: HeldMessage[] = [];
  private shuttingDown = false;

  constructor(private readonly options: InboundGateOptions) {}

  /** Messages currently parked, oldest first. */
  getHeld(): readonly HeldMessage[] {
    return this.held;
  }

  /**
   * Resolve the policy for a frame, and explain it.
   *
   * Exposed for tests and for the UI, which shows the cause next to a
   * held message.
   */
  resolvePolicy(frame?: Pick<PeerUserFrame, 'fromMode'>): PolicyDecision {
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

    // Nothing reviews what this session does from here down.
    const sender = frame?.fromMode;
    if (sender === undefined) {
      return { policy: 'hold', cause: 'no-mode-asserted' };
    }
    return sender === 'bypass'
      ? { policy: 'accept' }
      : { policy: 'hold', cause: 'mode-mismatch' };
  }

  /** Run a freshly-arrived message through the gate. */
  admit(frame: PeerUserFrame): GateDecision {
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
      this.report(frame, 'held');
      return 'held';
    }

    const decision = this.resolvePolicy(frame);
    const { policy } = decision;

    if (policy === 'refuse') {
      debugLogger.debug(`refused peer message ${frame.msgId}`);
      this.report(frame, 'denied');
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
      this.report(frame, 'expired');
      return 'refused';
    }

    if (policy === 'accept') {
      const ok = this.tryDeliver(frame);
      this.report(frame, ok ? 'delivered' : 'expired');
      return ok ? 'accept' : 'refused';
    }

    if (this.held.length >= MAX_HELD_MESSAGES) {
      const evicted = this.held.shift();
      if (evicted) {
        debugLogger.debug(`hold buffer full; expiring ${evicted.frame.msgId}`);
        this.report(evicted.frame, 'expired');
      }
    }

    const cause = decision.policy === 'hold' ? decision.cause : 'mode-unknown';
    this.held.push({ frame, cause, heldAt: Date.now() });
    debugLogger.debug(
      `held peer message ${frame.msgId} (cause=${cause}, ${this.held.length} held)`,
    );
    this.report(frame, 'held');
    this.notifyHeldChange();
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
    const index = this.held.findIndex((entry) => entry.frame.msgId === msgId);
    if (index === -1) return 'gone';
    const [entry] = this.held.splice(index, 1);
    if (!entry) return 'gone';

    if (decision === 'approve') {
      if (!this.tryDeliver(entry.frame)) {
        this.held.splice(index, 0, entry);
        this.report(entry.frame, 'held');
        this.notifyHeldChange();
        return 'failed';
      }
      this.report(entry.frame, 'delivered');
    } else {
      this.report(entry.frame, 'denied');
    }
    this.notifyHeldChange();
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
    if (this.held.length === 0) return 0;

    const stillHeld: HeldMessage[] = [];
    const release: HeldMessage[] = [];
    let dropped = 0;

    for (const entry of this.held) {
      const decision = this.resolvePolicy(entry.frame);
      const { policy } = decision;
      if (policy === 'accept') {
        release.push(entry);
      } else if (policy === 'refuse') {
        dropped += 1;
        this.report(entry.frame, 'denied');
      } else {
        const cause = decision.policy === 'hold' ? decision.cause : entry.cause;
        stillHeld.push(cause === entry.cause ? entry : { ...entry, cause });
      }
    }

    let released = 0;
    for (const entry of release) {
      if (this.tryDeliver(entry.frame)) {
        released += 1;
        this.report(entry.frame, 'delivered');
      } else {
        // A failed delivery must not drop a message the user can still
        // review: park it again and tell the sender it is still waiting.
        stillHeld.push(entry);
        this.report(entry.frame, 'held');
      }
    }

    this.held.length = 0;
    this.held.push(...stillHeld);

    if (release.length > 0 || dropped > 0) {
      debugLogger.debug(
        `reevaluate (${reason}): released ${released}, dropped ${dropped}, ${this.held.length} still held`,
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
  shutdown(): void {
    this.shuttingDown = true;
    if (this.held.length === 0) return;
    const settling = this.held.splice(0, this.held.length);
    debugLogger.debug(
      `shutdown: expiring ${settling.length} held peer message(s)`,
    );
    for (const entry of settling) {
      this.report(entry.frame, 'expired');
    }
    this.notifyHeldChange();
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
    status: 'held' | 'denied' | 'expired' | 'delivered',
  ): void {
    try {
      this.options.reportStatus?.(frame, status);
    } catch (error) {
      debugLogger.debug(
        `reportStatus(${status}) threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Hand a message to the session, reporting whether it landed. */
  private tryDeliver(frame: PeerUserFrame): boolean {
    try {
      this.options.deliver(frame);
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

/** One-line explanation of why a message is parked, for the UI. */
export function describeHoldCause(cause: HoldCause): string {
  switch (cause) {
    case 'explicit-setting':
      return 'your crossSessionInbound setting is "hold"';
    case 'mode-mismatch':
      return 'this session bypasses permission prompts and the sender does not';
    case 'no-mode-asserted':
      return 'this session bypasses permission prompts and the sender did not say whether it does';
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
