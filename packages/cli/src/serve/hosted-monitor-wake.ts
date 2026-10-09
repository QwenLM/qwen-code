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
   * The committed input's source (`monitor`, H6's `automation`, or H4b's
   * `child_agent`): an automation run settles from its turn, and a child
   * acceptance's evidence gets consumed after the turn settles, which a
   * monitor notification never owes.
   */
  readonly source?: string;
}

export type HostedMonitorWakeState = 'idle' | 'busy' | 'blocked';

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
   * undefined when the Session owes none. Read failures must throw; the
   * pump reports them through {@link failed}.
   */
  next(): Promise<HostedMonitorWakeTurn | undefined>;
  /** Busy Sessions queue; blocked Sessions report their remainder. */
  state(): HostedMonitorWakeState;
  /**
   * Runs the notification's text turn and settles the input's turnId, or
   * marks the owner blocked when the turn cannot settle. Returns 'busy'
   * when the owner took a turn synchronously between the pump's state
   * check and this call — the pump retries; anything else must consume
   * the input (the pump verifies the settle before taking the next one).
   * 'recovery' says the turn stopped in a way the journal cannot prove
   * either way — its trackers settle it for cause, never re-run it.
   * The busy claim must be checked and taken synchronously at the top of
   * the call so a prompt route admission cannot interleave.
   */
  runTurn(
    turn: HostedMonitorWakeTurn,
  ): Promise<'settled' | 'busy' | 'recovery' | 'settled_incomplete'>;
  /** A failure the pump itself cannot recover: the owner decides. */
  failed(cause: unknown): void;
  /**
   * A Session blocked on a crash whose settle could not finish — its
   * parked Runtime executions, the wake session's lease, the consume
   * write — re-arms forever with no other kick source. While present,
   * each blocked pump pass lets the owner retry that settle once, before
   * re-arming: the state is re-read after it, so a settle that landed
   * lets this very pass run the inputs it freed. Must not throw; a
   * failure leaves the state blocked and the retry falls to the next
   * pass (or to a load, which runs the same settle from the journal).
   */
  recoverBlocked?(): Promise<void>;
}

export class HostedMonitorWakeScheduler {
  private inFlight = false;
  private closed = false;
  private pendingKick = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: HostedMonitorWakeDeps,
    private readonly retryMs = 500,
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
      .catch((cause: unknown) => {
        this.deps.failed(cause);
        // A pass that dies while its owner is blocked — a crash residue's
        // settle meeting a transient fault — must not take the reminders
        // with it: the blocked cycle re-arms itself, or only a reload
        // would ever run the same settle again.
        if (!this.closed && this.deps.state() === 'blocked') {
          this.armRetry();
        }
      })
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
      // kick source, so the reminder arms its own retry here too. A
      // crash-blocked one gets its settle retried first: when it lands,
      // this same pass runs what it freed instead of waiting a cycle.
      if (state === 'blocked') {
        if (this.deps.recoverBlocked === undefined) {
          this.armRetry();
          return;
        }
        await this.deps.recoverBlocked();
        if (this.deps.state() === 'blocked') {
          this.armRetry();
          return;
        }
      }
      const next = await this.deps.next();
      if (next === undefined) return;
      if (state === 'busy' || this.deps.state() === 'busy') {
        this.armRetry();
        return;
      }
      if ((await this.deps.runTurn(next)) === 'busy') {
        this.armRetry();
        return;
      }
      // runTurn must have consumed the input: re-reading the journal is
      // the only honest check, and consuming is what lets the next
      // notification's turn begin. When the owner's own settle path went
      // blocked meanwhile — a crash residue its consume write could not
      // finish — that accurate blocked is where this pump stops: it keeps
      // its own reminder armed, so the settle is retried instead of
      // waiting for a reload or another caller to kick. Anything else
      // that leaves the input in place is a programming error and is
      // thrown.
      const again = await this.deps.next();
      if (again?.turnId === next.turnId) {
        if (this.deps.state() === 'blocked') {
          this.armRetry();
          return;
        }
        throw new Error(
          `Monitor wake turn ${next.turnId} did not consume its input.`,
        );
      }
      if (again === undefined) return;
    }
  }

  private armRetry(): void {
    if (this.retry !== undefined) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.kick();
    }, this.retryMs);
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
  /** The notification sources to settle; H6 adds `automation` to `monitor`. */
  readonly sources?: readonly string[];
}): Promise<number> {
  const sources = params.sources ?? ['monitor'];
  // The whole committed prefix, not a bounded page: a notification input
  // lands late in the log, and `readEvents()` alone would stop at the
  // default page and leave the Session's owed inputs unsettled — which is
  // exactly the wedge this close-path settle exists to prevent.
  const authority = params.authority;
  const queued = pendingSessionInputs(
    authority.eventsInSequenceRange(1, authority.committedSequence),
  ).filter((input) => sources.includes(input.source));
  // A close over no such input pays no transcript projection at all: every
  // close path induced by an attached Session would otherwise page the
  // whole committed prefix.
  if (queued.length === 0) {
    return 0;
  }
  const attempted = await params.sink.project();
  const pending = queued.filter(
    (input) => !wakeHasPriorAttempt(attempted, input.turnId),
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
