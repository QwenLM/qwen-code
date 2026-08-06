/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';
import {
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_NOTIFICATION_METHOD,
  type ActiveWorkHoldV1,
  type ActiveWorkSnapshotV1,
} from '@qwen-code/acp-bridge/bridgeTypes';

const debugLogger = createDebugLogger('ACTIVE_WORK');

/**
 * A Session, as far as active-work reporting is concerned. `collectHolds()`
 * must *derive* its result from whatever subsystem actually owns the work
 * (the background-task registry, the notification queue, ...) rather than
 * read a ledger maintained alongside it: a ledger can miss a release and
 * then pin the Session forever, and a full snapshot would faithfully
 * republish that leak on every report.
 */
export interface ActiveWorkSource {
  readonly sessionId: string;
  collectActiveWorkHolds(): ActiveWorkHoldV1[];
}

type SendNotification = (
  method: string,
  params: Record<string, unknown>,
) => Promise<void>;

/**
 * Publishes channel-wide active-work snapshots to the daemon.
 *
 * One reporter per ACP connection, not per Session. Reporting at channel
 * scope is what keeps the always-on cadence affordable (one small message
 * per interval regardless of Session count) and it lets the daemon treat a
 * Session missing from a fresh snapshot as proof the child released it.
 *
 * Every message is a complete snapshot with a monotonic `seq`. The sequence
 * exists only to discard reordered messages — never to detect gaps — so a
 * dropped report costs at most one interval of staleness and needs no
 * retransmit, ack, or local "last reported" state to diff against.
 */
export class ActiveWorkReporter {
  #seq = 0;
  #tail: Promise<void> = Promise.resolve();
  #coalescing = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(
    private readonly send: SendNotification,
    private readonly listSources: () => Iterable<ActiveWorkSource>,
    readonly intervalMs: number,
  ) {
    this.#timer = setInterval(() => {
      this.#publish();
    }, intervalMs);
    this.#timer.unref?.();
    // Publish immediately so the daemon leaves the "negotiated but never
    // reported" state as early as possible instead of holding every Session
    // as unknown until the first interval elapses.
    this.#publish();
  }

  /**
   * Note that some Session's derived state may have changed. Coalesced to
   * one snapshot per microtask so a burst of transitions (an agent finishing
   * and its terminal notification enqueuing in the same tick) produces a
   * single message that already reflects the settled state.
   */
  notifyChanged(): void {
    if (this.#disposed || this.#coalescing) return;
    this.#coalescing = true;
    queueMicrotask(() => {
      if (!this.#coalescing) return;
      this.#coalescing = false;
      this.#publish();
    });
  }

  /**
   * Publish now and resolve once the snapshot has been handed to the
   * transport.
   *
   * Callers use this to order a snapshot ahead of an RPC response on the same
   * stream. The prompt path needs it: the daemon drops its own
   * `pendingPromptCount` the moment the prompt response lands, so a hold
   * taken during that prompt (a background agent it started) has to be on the
   * wire *first* or the daemon briefly sees neither fact and may reap the
   * Session.
   */
  async flush(): Promise<void> {
    this.#coalescing = false;
    this.#publish();
    // Never reject: this is awaited on the prompt path, and a reporting
    // problem must not turn into a failed prompt for the user.
    await this.#tail.catch(() => undefined);
  }

  dispose(): void {
    this.#disposed = true;
    this.#coalescing = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #publish(): void {
    if (this.#disposed) return;
    let sessions: ActiveWorkSnapshotV1['sessions'];
    try {
      sessions = [];
      for (const source of this.listSources()) {
        sessions.push({
          sessionId: source.sessionId,
          holds: source.collectActiveWorkHolds(),
        });
      }
    } catch (error) {
      // Abandon the whole snapshot rather than send a partial one. A Session
      // missing from a report means "the child released it", and a Session
      // reported with no holds means "safe to close" — so publishing whatever
      // we managed to collect before the failure would actively invite the
      // daemon to destroy live work. Sending nothing instead just lets the
      // daemon's copy age, which its freshness grading already treats as
      // untrustworthy and retains.
      debugLogger.warn(
        `active-work snapshot collection failed; skipping this report: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const snapshot: ActiveWorkSnapshotV1 = {
      v: ACTIVE_WORK_HEARTBEAT_VERSION,
      seq: ++this.#seq,
      sessions,
    };
    this.#tail = this.#tail
      .then(() =>
        this.#disposed
          ? undefined
          : this.send(
              ACTIVE_WORK_NOTIFICATION_METHOD,
              snapshot as unknown as Record<string, unknown>,
            ),
      )
      // A failed send needs no recovery path: the next snapshot carries the
      // whole truth again. Swallowing here is only safe *because* reports are
      // full snapshots on a fixed cadence.
      .catch(() => undefined);
  }
}
