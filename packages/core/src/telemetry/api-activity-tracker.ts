/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-global running counts of model API errors and automatic retries,
 * feeding the Daemon Status "model API health" charts.
 *
 * The two counters are incremented at the single telemetry choke points every
 * such event already passes through — `logApiError` (one per failed model API
 * attempt) and `logApiRetry` (one per automatic backoff retry) — and drained,
 * per live model round, by the ACP `MessageEmitter`, which stamps the drained
 * increments onto `agent_message_chunk._meta`. That is the exact same
 * child→daemon channel per-round token usage already rides: the daemon host
 * sniffs `_meta` at the bridge fan-in and folds the increments into its
 * time-bucketed metrics ring.
 *
 * Why drain-on-read rather than cumulative counters diffed by the reader: it
 * keeps this self-contained — no per-session map and no session-lifecycle
 * cleanup. Concurrent ACP sessions in one child share the counter; whichever
 * session emits the next live usage frame drains the pending increments, so the
 * daemon's process-wide *window* total stays exact. Attribution to a specific
 * session is irrelevant here — the ring aggregates across the whole daemon.
 *
 * A non-daemon process (plain interactive CLI) still increments the counters
 * but never drains them; that is harmless (two integers) since nothing reads
 * them there.
 */
export interface ApiActivityCounts {
  /** Model API error responses (one per failed attempt) since the last drain. */
  errors: number;
  /** Automatic backoff retries since the last drain. */
  retries: number;
}

class ApiActivityTracker {
  #errors = 0;
  #retries = 0;

  /** Fold in one model API error (called from `logApiError`). */
  recordError(): void {
    this.#errors += 1;
  }

  /** Fold in one automatic retry (called from `logApiRetry`). */
  recordRetry(): void {
    this.#retries += 1;
  }

  /**
   * Return the counts accumulated since the last drain and reset them to zero.
   * The read+reset is synchronous (no `await` between), so a `recordError` /
   * `recordRetry` racing an in-progress drain can never be lost — it simply
   * lands in the next window.
   */
  drain(): ApiActivityCounts {
    const counts: ApiActivityCounts = {
      errors: this.#errors,
      retries: this.#retries,
    };
    this.#errors = 0;
    this.#retries = 0;
    return counts;
  }

  /** Peek at the pending counts without draining (tests / diagnostics). */
  peek(): ApiActivityCounts {
    return { errors: this.#errors, retries: this.#retries };
  }
}

/** Process-wide singleton. See {@link ApiActivityTracker}. */
export const apiActivityTracker = new ApiActivityTracker();
