/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One session's parked fires.
 *
 * A trigger only enqueues a prompt; the run happens later in the agent loop.
 * Threading a fire id through `QueuedCommand` would mean editing the TUI,
 * headless and ACP dispatch paths separately, and any one of them left
 * unedited would silently charge a run to the wrong task — so the fire is
 * parked instead, and the agent loop claims it by recognising the prompt
 * prefix that `cronManager.ts` stamps on every scheduled prompt.
 *
 * Parked on the owning `CronManager` rather than process-wide: claiming splices
 * from the front, so a shared registry would let session B's turn take the fire
 * session A parked and charge it against the wrong task's allowance.
 *
 * `CronManager` holds one instance, so it is session-scoped by construction and
 * is released with its `Config` — no eviction hook, and no session key that a
 * future caller can forget to pass.
 */

/**
 * Prefix `cronManager.ts` stamps on every fired prompt via `withTimestamp()`.
 * The only producer of this string in the repo, which is what makes it usable as
 * a correlation key. Monitor notifications use `<task-notification>` tags and
 * cannot collide.
 */
const SCHEDULED_PROMPT_MARKER = '[Running scheduled task (';

/**
 * A fire whose prompt reached the queue but was never dequeued — the user
 * cleared the queue, or the process is shutting down — waits here forever.
 * Both bounds exist so a stale fire is dropped rather than charged to an
 * unrelated run hours later.
 */
const PENDING_FIRE_LIMIT = 32;
const PENDING_FIRE_TTL_MS = 2 * 60 * 60 * 1000;

/** What a scheduler hands over so the run it starts can be charged back. */
export interface CronFireClaim {
  /** Task charged for this run, or the wakeup loop id for a dynamic wakeup. */
  taskId?: string;
  /** A dynamic wakeup is charged to the session's wakeup allowance. */
  isWakeup: boolean;
}

export interface PendingCronFire extends CronFireClaim {
  registeredAt: number;
}

/**
 * What a scheduler needs from the registry of the session that owns it: park
 * the fire it just triggered.
 *
 * Narrower than `CronFireRegistry` on purpose — claiming belongs to the agent
 * loop, and a scheduler that could reach it would be able to consume a turn it
 * did not run.
 */
export interface CronFireSink {
  registerFire(fire: CronFireClaim): void;
}

export class CronFireRegistry implements CronFireSink {
  private readonly pendingFires: PendingCronFire[] = [];

  /** Parks a fire until the agent loop runs the prompt it enqueued. */
  registerFire(fire: CronFireClaim): void {
    const now = Date.now();
    this.pruneExpiredFires(now);
    this.pendingFires.push({ ...fire, registeredAt: now });
    while (this.pendingFires.length > PENDING_FIRE_LIMIT) {
      this.pendingFires.shift();
    }
  }

  /**
   * Claims the fires that `promptText` actually carries.
   *
   * A scheduler tick can fire several tasks at once, and the queue processor
   * drains every same-mode notification and joins them with
   * `prompts.join('\n')` — so N fires genuinely map to one turn, and the caller
   * splits that turn's cost across the N claims.
   *
   * The count is bounded by how many scheduled-task markers the prompt contains
   * rather than by how many fires happen to be parked. A fire registered after
   * the queue drained would otherwise be swept into this turn and then be
   * missing from its own, charging one run's cost to the wrong task and
   * losing the other run entirely. Claims from the front to match the queue's
   * FIFO drain order, which is safe now that the queue it mirrors belongs to the
   * same session.
   */
  claimPendingFires(promptText: string): PendingCronFire[] {
    if (this.pendingFires.length === 0) return [];
    const carried = this.countScheduledMarkers(promptText);
    if (carried === 0) return [];
    this.pruneExpiredFires(Date.now());
    return this.pendingFires.splice(
      0,
      Math.min(carried, this.pendingFires.length),
    );
  }

  /** Fires parked and not yet claimed. Exists so tests can assert on the cap. */
  pendingFireCount(): number {
    return this.pendingFires.length;
  }

  /** Number of scheduled-task prompts merged into this text. */
  private countScheduledMarkers(promptText: string): number {
    let count = 0;
    let at = promptText.indexOf(SCHEDULED_PROMPT_MARKER);
    while (at !== -1) {
      count++;
      at = promptText.indexOf(SCHEDULED_PROMPT_MARKER, at + 1);
    }
    return count;
  }

  private pruneExpiredFires(now: number): void {
    for (let i = this.pendingFires.length - 1; i >= 0; i--) {
      if (now - this.pendingFires[i].registeredAt > PENDING_FIRE_TTL_MS) {
        this.pendingFires.splice(i, 1);
      }
    }
  }
}
