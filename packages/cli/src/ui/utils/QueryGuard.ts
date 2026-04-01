/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Atomic concurrency guard for the query loop.
 *
 * Prevents two independent callers (e.g. user submit + queue drain + tool
 * result continuation) from starting overlapping queries. Each successful
 * `tryStart()` returns a monotonically-increasing generation number. The
 * matching `end(generation)` call is a no-op if the generation has been
 * superseded (e.g. by `forceEnd()` during cancellation), preventing stale
 * `finally` blocks from releasing the lock too early.
 *
 * Modelled after Claude Code's QueryGuard pattern.
 */

type Status = 'idle' | 'running';

export class QueryGuard {
  private status: Status = 'idle';
  private generation = 0;

  /**
   * Attempt to start a new query. Returns the generation number on success,
   * or `null` if a query is already running.
   */
  tryStart(): number | null {
    if (this.status === 'running') {
      return null;
    }
    this.status = 'running';
    this.generation += 1;
    return this.generation;
  }

  /**
   * Safely end a query. Only transitions to idle if the provided generation
   * matches the current one — stale callers (whose generation was superseded
   * by `forceEnd()`) become no-ops.
   */
  end(generation: number): void {
    if (this.generation === generation) {
      this.status = 'idle';
    }
  }

  /**
   * Force-end the current query regardless of generation. Bumps the
   * generation so any in-flight `end()` calls from the old query become
   * no-ops. Used by cancellation.
   */
  forceEnd(): void {
    this.generation += 1;
    this.status = 'idle';
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  currentGeneration(): number {
    return this.generation;
  }
}
