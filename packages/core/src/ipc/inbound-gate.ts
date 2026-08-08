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
 *   receiver YOLO      + sender YOLO       → accept
 *   receiver YOLO      + sender prompting  → hold
 *   receiver YOLO      + sender unasserted → hold
 *   receiver prompting + anything          → accept
 *   receiver mode unknown                  → hold  (fail closed)
 *
 * A prompting receiver can accept freely because every consequential
 * action still faces its own gate; the message is a suggestion, not an
 * execution. A YOLO receiver has no such backstop, so anything it is told
 * to do simply happens — which is why an unverified sender has to be
 * reviewed first.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { ApprovalMode } from '../config/approval-mode.js';
import type { PeerUserFrame } from './peer-frames.js';

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
  | 'mode-unknown';

/**
 * Cap on parked messages.
 *
 * A hold buffer is reachable by anything that can write to the socket, so
 * it needs a ceiling or a chatty peer becomes a memory leak in a session
 * whose user stepped away. Oldest is evicted first: the newest message is
 * the one most likely to still be relevant.
 */
export const MAX_HELD_MESSAGES = 50;

/** Sender's approval-mode class, as asserted on the wire. */
export type ModeClass = 'bypass' | 'prompting';

/**
 * Map an approval mode onto the two classes that matter for parity.
 *
 * Only YOLO is "bypass". AUTO is deliberately "prompting": it does not
 * stop to ask, but every tool call still passes the permission
 * classifier, which sees the full message text.
 */
export function approvalModeClass(mode: ApprovalMode): ModeClass {
  return mode === ApprovalMode.YOLO ? 'bypass' : 'prompting';
}

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
  resolvePolicy(frame?: Pick<PeerUserFrame, 'fromMode'>): {
    policy: InboundPolicy;
    cause: HoldCause;
  } {
    const explicit = this.options.getPolicySetting();
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
    if (mode === null) return { policy: 'hold', cause: 'mode-unknown' };

    const receiver = approvalModeClass(mode);
    if (receiver === 'prompting') {
      return { policy: 'accept', cause: 'explicit-setting' };
    }

    // Receiver is bypassing prompts from here down.
    const sender = frame?.fromMode;
    if (sender === undefined) {
      return { policy: 'hold', cause: 'no-mode-asserted' };
    }
    return sender === 'bypass'
      ? { policy: 'accept', cause: 'explicit-setting' }
      : { policy: 'hold', cause: 'mode-mismatch' };
  }

  /** Run a freshly-arrived message through the gate. */
  admit(frame: PeerUserFrame): GateDecision {
    const { policy, cause } = this.resolvePolicy(frame);

    if (policy === 'refuse') {
      debugLogger.debug(`refused peer message ${frame.msgId}`);
      this.options.reportStatus?.(frame, 'denied');
      return 'refused';
    }

    // Checked before the accept branch, not after: teardown strands an
    // accepted message just as surely as a parked one. The socket keeps
    // accepting until the inbox closes, and every exit path calls
    // `process.exit()` right after the cleanup chain, so a message
    // delivered into the queue here dies before any model reads it — and
    // the `delivered` receipt would tell the sender the opposite. A parked
    // one strands the same way: nothing will ever release it, and the
    // sender would wait on a decision that cannot come.
    if (this.shuttingDown) {
      debugLogger.debug(
        `not admitting peer message ${frame.msgId} during shutdown; expiring it`,
      );
      this.options.reportStatus?.(frame, 'expired');
      return 'refused';
    }

    if (policy === 'accept') {
      this.options.deliver(frame);
      this.options.reportStatus?.(frame, 'delivered');
      return 'accept';
    }

    if (this.held.length >= MAX_HELD_MESSAGES) {
      const evicted = this.held.shift();
      if (evicted) {
        debugLogger.debug(`hold buffer full; expiring ${evicted.frame.msgId}`);
        this.options.reportStatus?.(evicted.frame, 'expired');
      }
    }

    this.held.push({ frame, cause, heldAt: Date.now() });
    debugLogger.debug(
      `held peer message ${frame.msgId} (cause=${cause}, ${this.held.length} held)`,
    );
    this.options.reportStatus?.(frame, 'held');
    this.notifyHeldChange();
    return 'held';
  }

  /**
   * Release or drop one parked message.
   *
   * Returns 'gone' when the id is unknown — it may have been evicted,
   * expired at shutdown, or already decided. Callers surface that rather
   * than treating it as an error, because a stale UI action is normal.
   */
  decide(msgId: string, decision: 'approve' | 'deny'): 'done' | 'gone' {
    const index = this.held.findIndex((entry) => entry.frame.msgId === msgId);
    if (index === -1) return 'gone';
    const [entry] = this.held.splice(index, 1);
    if (!entry) return 'gone';

    if (decision === 'approve') {
      this.options.deliver(entry.frame);
      this.options.reportStatus?.(entry.frame, 'delivered');
    } else {
      this.options.reportStatus?.(entry.frame, 'denied');
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
      const { policy, cause } = this.resolvePolicy(entry.frame);
      if (policy === 'accept') {
        release.push(entry);
      } else if (policy === 'refuse') {
        dropped += 1;
        this.options.reportStatus?.(entry.frame, 'denied');
      } else {
        stillHeld.push(cause === entry.cause ? entry : { ...entry, cause });
      }
    }

    this.held.length = 0;
    this.held.push(...stillHeld);

    for (const entry of release) {
      this.options.deliver(entry.frame);
      this.options.reportStatus?.(entry.frame, 'delivered');
    }

    if (release.length > 0 || dropped > 0) {
      debugLogger.debug(
        `reevaluate (${reason}): released ${release.length}, dropped ${dropped}, ${this.held.length} still held`,
      );
      this.notifyHeldChange();
    }
    return release.length;
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
      this.options.reportStatus?.(entry.frame, 'expired');
    }
    this.notifyHeldChange();
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
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}
