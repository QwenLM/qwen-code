/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';

// H3 of #12827: the embedded scheduler that makes a Monitor wake
// effective. A monitor observation commits its notification input and its
// `wake.requested` in one transaction; this pump turns that pending input
// into a runnable activation. A busy Session queues the input in the
// journal exactly like a channel or Goal input — the pump re-reads the
// journal, so nothing is held in memory and a restart re-derives the
// pending set. A Session that is blocked keeps its reminders pending and
// reports them accurately; a closing Session settles its notifications
// model-free on the close path. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

/** One pending notification, ready to be delivered to its turn. */
export interface HostedMonitorWakeTurn {
  readonly turnId: string;
  readonly text: string;
  /**
   * The committed input's source (`monitor`, or H4b's `child_agent`): the
   * session wrapper consumes a child acceptance's evidence after the turn
   * settles, which a monitor notification never owes. It also lets a
   * settle hook tell a channel turn apart.
   */
  readonly source?: string;
}

export type HostedMonitorWakeState = 'idle' | 'busy' | 'blocked';

/**
 * A durable-resource read that faulted after the Store's own retry: the
 * committed input is still owed, so the pump retries the read on its
 * cadence instead of parking the resident Session as terminally broken.
 */
export class MonitorWakeTransientReadError extends Error {}

/**
 * Whether the wake turn's id already carries durable history. A previous
 * attempt that reached the transcript and died there left work behind —
 * exactly what its recovery paths own — while a fresh text re-drive would
 * mint a second user record and hand the model a transcript whose first
 * attempt's call was never answered.
 */
export function wakeHasPriorAttempt(
  entries: ReadonlyArray<{ readonly daemonPromptId?: string }>,
  turnId: string,
): boolean {
  return entries.some((entry) => entry.daemonPromptId === turnId);
}

export interface HostedMonitorWakeDeps {
  /**
   * The oldest pending monitor notification with its envelope text, or
   * undefined when the Session owes none. Read failures must throw; a
   * durable resource fault throws as {@link MonitorWakeTransientReadError}
   * and the pump retries it on its cadence, while anything else reports
   * through {@link failed}.
   */
  next(): Promise<HostedMonitorWakeTurn | undefined>;
  /** Busy Sessions queue; blocked Sessions report their remainder. */
  state(): HostedMonitorWakeState;
  /**
   * Runs the notification's text turn and settles the input's turnId, or
   * marks the owner blocked when the turn cannot settle. Returns 'busy'
   * when the owner took a turn synchronously between the pump's state
   * check and this call — the pump retries; 'held' when a durable owner
   * (a pending approval) holds the wait — the pump re-derives on its slow
   * cadence without blocking, leaving the resolve route usable and
   * observing the final Action itself; anything else must consume the
   * input (the pump verifies the settle before taking the next one). The
   * busy claim must be checked and taken synchronously at the top of the
   * call so a prompt route admission cannot interleave.
   */
  runTurn(
    turn: HostedMonitorWakeTurn,
  ): Promise<'settled' | 'settled_incomplete' | 'busy' | 'held'>;
  /** A failure the pump itself cannot recover: the owner decides. */
  failed(cause: unknown): void;
}

export class HostedMonitorWakeScheduler {
  private inFlight = false;
  private closed = false;
  private pendingKick = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: HostedMonitorWakeDeps,
    private readonly retryMs = 500,
    // A held wait's owner decides on a human timescale: re-derive on a slow
    // cadence rather than the busy retry's, so the pump observes the final
    // Action without hammering the Store behind an approval.
    private readonly holdRetryMs = retryMs * 30,
  ) {}

  /**
   * An observation notification landed (or a Session just opened): try to
   * deliver what's pending. Idempotent — one pump per Session at a time,
   * and a kick that lands mid-pump is remembered for the one after it, so
   * a notification committed while this pump's last read ran is never
   * swallowed with it.
   */
  kick(): void {
    if (this.closed) return;
    if (this.inFlight) {
      this.pendingKick = true;
      return;
    }
    this.inFlight = true;
    void this.pump()
      .catch((cause: unknown) => this.deps.failed(cause))
      .finally(() => {
        this.inFlight = false;
        if (this.pendingKick && !this.closed) {
          this.pendingKick = false;
          this.kick();
        }
      });
  }

  /**
   * The owner is going away: stop every future pump, so nothing starts a
   * turn while the Session drains and closes.
   */
  close(): void {
    this.closed = true;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
  }

  private async pump(): Promise<void> {
    for (;;) {
      if (this.closed) return;
      const state = this.deps.state();
      // A transiently blocked Session — an MCP or Hook operation in
      // flight, or an activation that has not come up yet — has no other
      // kick source, so the reminder arms its own retry here too.
      if (state === 'blocked') {
        this.armRetry();
        return;
      }
      let next: HostedMonitorWakeTurn | undefined;
      try {
        next = await this.deps.next();
      } catch (cause) {
        // A faulting envelope read is owed the same retry cadence as a
        // busy Session: the durable input stays pending, and everything
        // the pump would have parked on heals without a detach.
        if (cause instanceof MonitorWakeTransientReadError) {
          this.armRetry();
          return;
        }
        throw cause;
      }
      if (next === undefined) return;
      if (state === 'busy' || this.deps.state() === 'busy') {
        this.armRetry();
        return;
      }
      const outcome = await this.deps.runTurn(next);
      if (outcome === 'busy') {
        this.armRetry();
        return;
      }
      // A held wait belongs to its durable owner (a pending approval): no
      // busy retry and no settle-verify — but the durable Action decides
      // in this process, so the pump re-derives on the slow cadence and
      // settles the ended wait itself instead of waiting for a new input.
      if (outcome === 'held') {
        this.armRetry(this.holdRetryMs);
        return;
      }
      // runTurn must have consumed the input: re-reading the journal is
      // the only honest check, and consuming is what lets the next
      // notification's turn begin. When the owner's own settle path went
      // blocked meanwhile, that accurate blocked is where this pump stops;
      // anything else that leaves the input in place is a programming
      // error and is thrown.
      let again: HostedMonitorWakeTurn | undefined;
      try {
        again = await this.deps.next();
      } catch (cause) {
        // The settle-verify read walks the same durable path as the intake
        // read: a transient fault there owes the retry cadence too, or the
        // Session latches blocked behind a verified settle (R10 P2).
        if (cause instanceof MonitorWakeTransientReadError) {
          this.armRetry();
          return;
        }
        throw cause;
      }
      if (again?.turnId === next.turnId) {
        if (this.deps.state() === 'blocked') return;
        throw new Error(
          `Monitor wake turn ${next.turnId} did not consume its input.`,
        );
      }
      if (again === undefined) return;
    }
  }

  private armRetry(delayMs = this.retryMs): void {
    if (this.retry !== undefined) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.kick();
    }, delayMs);
    this.retry.unref();
  }
}

/**
 * The unadmittable path: a monitor or child-agent notification that never
 * ran a turn settles cancelled without a model turn, under the turn-result
 * record's own idempotency key. Called on the close path so no wedged
 * notification parks the Session as `hosted_turn_recovery_required` at its
 * next open. A notification whose wake turn already started belongs to the
 * recovery fleet, never to a `cancelled` line on top of a turn that ran.
 */
export async function settlePendingMonitorInputs(params: {
  readonly authority: LocalManagedSessionAuthority;
  readonly sink: ManagedSessionRecordSink;
  readonly sessionId: string;
  readonly cwd: string;
  /** The notification sources to settle; H5 adds `channel` to the
   * monitor-family default. */
  readonly sources?: readonly string[];
}): Promise<number> {
  const sources = params.sources ?? ['monitor', 'child_agent'];
  // The whole committed prefix, not a bounded page: a notification input
  // lands late in the log, and `readEvents()` alone would stop at the
  // default page and leave the Session's owed inputs unsettled — which is
  // exactly the wedge this close-path settle exists to prevent.
  const authority = params.authority;
  const attempted = await params.sink.project();
  const pending = pendingSessionInputs(
    authority.eventsInSequenceRange(1, authority.committedSequence),
  ).filter(
    (input) =>
      sources.includes(input.source) &&
      !wakeHasPriorAttempt(attempted, input.turnId),
  );
  for (const input of pending) {
    const settle: ChatRecord = {
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: params.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      cwd: params.cwd,
      version: 'hosted-harness/1',
      subtype: 'turn_result',
      systemPayload: {
        promptId: input.turnId,
        state: 'cancelled',
        stopReason: 'session_closing',
        endedAt: Date.now(),
      },
    };
    await params.sink.write(settle);
  }
  return pending.length;
}
