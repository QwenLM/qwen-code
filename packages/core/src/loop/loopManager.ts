/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loop Manager
 *
 * Framework-agnostic state management for the /loop command.
 * Tracks active loop configuration and iteration state.
 */

/** Minimum allowed interval in milliseconds (10 seconds) */
export const MIN_INTERVAL_MS = 10_000;

/** Maximum allowed interval in milliseconds (24 hours) */
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Default interval in milliseconds (10 minutes) */
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** Default max consecutive failures before pausing */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Configuration for a loop
 */
export interface LoopConfig {
  /** The prompt or command to execute each cycle */
  prompt: string;
  /** Interval between iterations in milliseconds */
  intervalMs: number;
  /** Maximum number of iterations (0 = unlimited) */
  maxIterations: number;
}

/**
 * Runtime state of an active loop
 */
export interface LoopState {
  /** Loop configuration */
  config: LoopConfig;
  /** Whether the loop is currently active */
  isActive: boolean;
  /** Whether the loop is paused (e.g., due to consecutive failures) */
  isPaused: boolean;
  /** Current iteration count (1-based) */
  iteration: number;
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** Timestamp when the loop started */
  startedAt: number;
  /** Timestamp of the last iteration */
  lastIterationAt: number;
  /** Timer ID for the next scheduled iteration */
  timerId: ReturnType<typeof setTimeout> | null;
  /** Whether the loop is waiting for an AI response to complete */
  waitingForResponse: boolean;
}

/**
 * Callback invoked when a loop iteration should execute
 */
export type LoopIterationCallback = (prompt: string, iteration: number) => void;

/**
 * Parse an interval string like "30s", "5m", "1h" into milliseconds.
 * Returns null if the string is not a valid interval.
 */
export function parseInterval(input: string): number | null {
  const match = input.match(/^(\d+(?:\.\d+)?)(s|m|h)$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (value <= 0 || !isFinite(value)) return null;

  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's':
      return Math.round(value * 1000);
    case 'm':
      return Math.round(value * 60 * 1000);
    case 'h':
      return Math.round(value * 60 * 60 * 1000);
    default:
      return null;
  }
}

/**
 * Format milliseconds into a human-readable string like "5m" or "30s".
 * Prefers the largest unit that gives a clean representation.
 */
export function formatInterval(ms: number): string {
  if (ms >= 3600_000 && ms % 3600_000 === 0) {
    return `${ms / 3600_000}h`;
  }
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms >= 60_000) {
    // Non-round minutes (e.g., 90_000 → "1.5m")
    const rounded = Math.round((ms / 60_000) * 10) / 10;
    return `${rounded}m`;
  }
  return `${ms / 1000}s`;
}

/**
 * Manages a single active loop.
 */
export class LoopManager {
  private state: LoopState | null = null;
  private onIteration: LoopIterationCallback | null = null;

  /**
   * Register the callback that will be invoked for each loop iteration.
   * This should be called once during initialization (e.g., in AppContainer).
   */
  setIterationCallback(callback: LoopIterationCallback): void {
    this.onIteration = callback;
  }

  /**
   * Start a new loop. Stops any existing loop first.
   *
   * @param config Loop configuration
   * @param skipFirstIteration If true, don't execute immediately
   *   (caller will handle the first submission, e.g., via submit_prompt)
   */
  start(config: LoopConfig, skipFirstIteration = false): void {
    this.stop();

    this.state = {
      config,
      isActive: true,
      isPaused: false,
      iteration: skipFirstIteration ? 1 : 0,
      consecutiveFailures: 0,
      startedAt: Date.now(),
      lastIterationAt: skipFirstIteration ? Date.now() : 0,
      timerId: null,
      waitingForResponse: skipFirstIteration,
    };

    if (!skipFirstIteration) {
      this.executeIteration();
    }
  }

  /**
   * Stop the active loop.
   */
  stop(): void {
    if (this.state) {
      if (this.state.timerId) {
        clearTimeout(this.state.timerId);
      }
      this.state = null;
    }
  }

  /**
   * Get the current loop state (null if no loop is active).
   */
  getState(): Readonly<LoopState> | null {
    return this.state;
  }

  /**
   * Check if a loop is currently active (running or paused).
   */
  isActive(): boolean {
    return this.state !== null && this.state.isActive;
  }

  /**
   * Check if a loop is waiting for an AI response.
   */
  isWaitingForResponse(): boolean {
    return this.state !== null && this.state.waitingForResponse;
  }

  /**
   * Called by the host (AppContainer) when a loop iteration's AI response
   * has completed. Schedules the next iteration after the configured delay.
   */
  onIterationComplete(success: boolean): void {
    if (!this.state || !this.state.isActive || !this.state.waitingForResponse) {
      return;
    }
    this.state.waitingForResponse = false;

    if (success) {
      this.state.consecutiveFailures = 0;
    } else {
      this.state.consecutiveFailures++;
      if (this.state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.state.isPaused = true;
        return;
      }
    }

    // Check if we've reached max iterations
    if (
      this.state.config.maxIterations > 0 &&
      this.state.iteration >= this.state.config.maxIterations
    ) {
      this.state.isActive = false;
      if (this.state.timerId) {
        clearTimeout(this.state.timerId);
        this.state.timerId = null;
      }
      // Keep state accessible briefly so caller can read final iteration count
      return;
    }

    // Schedule next iteration
    this.scheduleNext();
  }

  /**
   * Resume a paused loop.
   */
  resume(): void {
    if (this.state && this.state.isPaused) {
      this.state.isPaused = false;
      this.state.consecutiveFailures = 0;
      this.scheduleNext();
    }
  }

  private executeIteration(): void {
    if (!this.state || !this.state.isActive || !this.onIteration) return;

    this.state.iteration++;
    this.state.lastIterationAt = Date.now();
    this.state.waitingForResponse = true;
    this.onIteration(this.state.config.prompt, this.state.iteration);
  }

  private scheduleNext(): void {
    if (!this.state || !this.state.isActive) return;

    // Clear any existing timer
    if (this.state.timerId) {
      clearTimeout(this.state.timerId);
    }

    this.state.timerId = setTimeout(() => {
      this.executeIteration();
    }, this.state.config.intervalMs);
  }
}

/**
 * Singleton loop manager instance
 */
let defaultLoopManager: LoopManager | null = null;

export function getLoopManager(): LoopManager {
  if (!defaultLoopManager) {
    defaultLoopManager = new LoopManager();
  }
  return defaultLoopManager;
}

export function resetLoopManager(): void {
  if (defaultLoopManager) {
    defaultLoopManager.stop();
  }
  defaultLoopManager = null;
}
