/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loop Manager
 *
 * Framework-agnostic state management for the /loop command.
 * Supports multiple concurrent loops, each identified by a unique ID.
 */

import { computeJitter } from './loopJitter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum allowed interval in milliseconds (10 seconds) */
export const MIN_INTERVAL_MS = 10_000;

/** Maximum allowed interval in milliseconds (24 hours) */
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Default interval in milliseconds (10 minutes) */
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** Default max concurrent loops */
export const DEFAULT_MAX_LOOPS = 50;

/** Default auto-expiry duration (7 days) */
export const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Max consecutive failures before auto-pausing */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Max backoff multiplier for consecutive failures */
const MAX_BACKOFF_MULTIPLIER = 4;

/**
 * Safety timer timeout (ms). If a loop prompt doesn't trigger AI streaming
 * within this window, the loop auto-advances to prevent hanging.
 */
const SAFETY_TIMEOUT_MS = 3_000;

/** Threshold above which drift-protected scheduling is used */
const MAX_SINGLE_TIMEOUT_MS = 60_000;

/** Interval for checking auto-expiry across all loops (60 seconds) */
const EXPIRY_CHECK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopConfig {
  prompt: string;
  intervalMs: number;
  /** 0 = unlimited */
  maxIterations: number;
  /** Caller-assigned ID. Auto-generated if omitted. */
  id?: string;
  /** Human-friendly label for status display */
  label?: string;
  /** Absolute timestamp for auto-expiry. Auto-set to now + 7 days if omitted. */
  expiresAt?: number;
  /** If true, loop fires once and is deleted. Equivalent to maxIterations=1. */
  oneShot?: boolean;
  /** If true, add deterministic jitter to the interval (default true). */
  jitter?: boolean;
  /** When restoring, resume from this iteration count instead of 0/1. */
  resumeIteration?: number;
}

export interface IterationResult {
  done: boolean;
  paused: boolean;
  iteration: number;
  consecutiveFailures: number;
  loopId: string;
}

export interface PersistedLoopState {
  id: string;
  config: LoopConfig;
  iteration: number;
  startedAt: number;
  createdAt: number;
  nextFireAt: number | null;
}

export interface PersistedLoopFile {
  version: 2;
  tasks: PersistedLoopState[];
  lastUpdatedAt: number;
}

export interface LoopState {
  id: string;
  config: LoopConfig;
  isActive: boolean;
  isPaused: boolean;
  iteration: number;
  consecutiveFailures: number;
  startedAt: number;
  createdAt: number;
  lastIterationAt: number;
  timerId: ReturnType<typeof setTimeout> | null;
  waitingForResponse: boolean;
  nextFireAt: number | null;
  jitterOffsetMs: number;
}

export type LoopIterationCallback = (
  prompt: string,
  iteration: number,
  loopId: string,
) => void;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Parse an interval string like "30s", "5m", "1h", "1d" into milliseconds.
 */
export function parseInterval(input: string): number | null {
  const match = input.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (value <= 0 || !isFinite(value)) return null;
  switch (match[2].toLowerCase()) {
    case 's':
      return Math.round(value * 1000);
    case 'm':
      return Math.round(value * 60_000);
    case 'h':
      return Math.round(value * 3_600_000);
    case 'd':
      return Math.round(value * 86_400_000);
    default:
      return null;
  }
}

/**
 * Format milliseconds into a human-readable string like "5m" or "30s".
 */
export function formatInterval(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 60_000) {
    const rounded = Math.round((ms / 60_000) * 10) / 10;
    // Avoid misleading "1m" for 62s — fall back to seconds if rounding
    // produces an integer that doesn't match the exact value
    if (Number.isInteger(rounded) && ms % 60_000 !== 0) {
      return `${ms / 1000}s`;
    }
    return `${rounded}m`;
  }
  return `${ms / 1000}s`;
}

let idCounter = 0;
function generateLoopId(): string {
  const hex = (Date.now() & 0xffffff).toString(16).padStart(6, '0');
  return `loop-${hex}-${(idCounter++).toString(16)}`;
}

// ---------------------------------------------------------------------------
// LoopManager
// ---------------------------------------------------------------------------

export class LoopManager {
  private tasks = new Map<string, LoopState>();
  private onIteration: LoopIterationCallback | null = null;
  private safetyTimerId: ReturnType<typeof setTimeout> | null = null;
  private expiryTimerId: ReturnType<typeof setInterval> | null = null;

  /**
   * ID of the "default" unnamed loop (for backward compatibility).
   * When `start()` is called without an explicit `config.id`, the previous
   * default loop is auto-stopped before the new one is created.
   */
  private defaultLoopId: string | null = null;

  /** Which loop currently owns the AI streaming slot. */
  private activeResponseLoopId: string | null = null;

  // -- Callback registration -----------------------------------------------

  setIterationCallback(callback: LoopIterationCallback | null): void {
    this.onIteration = callback;
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Start a new loop. Returns the assigned loop ID.
   *
   * If `config.id` is omitted, this is a "default" loop and any previous
   * default loop is auto-stopped (backward compatible with single-loop usage).
   * If `config.id` is provided, it coexists with other loops.
   */
  start(config: LoopConfig, skipFirstIteration = false): string {
    if (!this.onIteration) {
      throw new Error(
        'Cannot start loop: no iteration callback registered. Call setIterationCallback() first.',
      );
    }
    if (
      !Number.isFinite(config.intervalMs) ||
      config.intervalMs < MIN_INTERVAL_MS ||
      config.intervalMs > MAX_INTERVAL_MS
    ) {
      throw new Error(
        `intervalMs must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
      );
    }
    if (
      !Number.isFinite(config.maxIterations) ||
      config.maxIterations < 0 ||
      !Number.isInteger(config.maxIterations)
    ) {
      throw new Error('maxIterations must be a non-negative integer');
    }

    const id = config.id ?? generateLoopId();

    // Legacy (unnamed) path: replace the previous default loop
    if (!config.id) {
      if (this.defaultLoopId && this.tasks.has(this.defaultLoopId)) {
        this.stopOne(this.defaultLoopId);
      }
      this.defaultLoopId = id;
    } else if (this.tasks.has(id)) {
      // Explicit ID that already exists: replace it
      this.stopOne(id);
    }

    const now = Date.now();
    const effectiveConfig: LoopConfig = {
      ...config,
      id,
      maxIterations: config.oneShot ? 1 : config.maxIterations,
      expiresAt:
        config.expiresAt ??
        (config.oneShot ? undefined : now + DEFAULT_EXPIRY_MS),
    };

    const jitterEnabled = config.jitter !== false;
    const state: LoopState = {
      id,
      config: effectiveConfig,
      isActive: true,
      isPaused: false,
      iteration: config.resumeIteration ?? (skipFirstIteration ? 1 : 0),
      consecutiveFailures: 0,
      startedAt: now,
      createdAt: now,
      lastIterationAt: skipFirstIteration ? now : 0,
      timerId: null,
      waitingForResponse: skipFirstIteration,
      nextFireAt: null,
      jitterOffsetMs: jitterEnabled
        ? computeJitter(id, effectiveConfig.intervalMs)
        : 0,
    };

    this.tasks.set(id, state);

    if (!skipFirstIteration) {
      this.executeIteration(id);
    } else if (!this.activeResponseLoopId) {
      // This loop gets the streaming slot (caller will submit its prompt)
      this.activeResponseLoopId = id;
    } else {
      // Another loop already owns the streaming slot. Don't mark this one as
      // waiting — just schedule its first timer so it starts independently.
      state.waitingForResponse = false;
      state.iteration = 0;
      this.scheduleNext(id);
    }

    this.ensureExpiryTimer();
    return id;
  }

  /** Stop a specific loop by ID. */
  stopOne(loopId: string): void {
    const state = this.tasks.get(loopId);
    if (!state) return;
    if (state.timerId) clearTimeout(state.timerId);
    this.tasks.delete(loopId);
    if (this.activeResponseLoopId === loopId) {
      this.clearSafetyTimer();
      this.activeResponseLoopId = null;
    }
    if (this.defaultLoopId === loopId) this.defaultLoopId = null;
    if (this.tasks.size === 0) this.clearExpiryTimer();
  }

  /** Stop all loops (or a specific one for backward compat). */
  stop(loopId?: string): void {
    if (loopId) {
      this.stopOne(loopId);
      return;
    }
    // Stop ALL
    this.clearSafetyTimer();
    for (const state of this.tasks.values()) {
      if (state.timerId) clearTimeout(state.timerId);
    }
    this.tasks.clear();
    this.activeResponseLoopId = null;
    this.defaultLoopId = null;
    this.clearExpiryTimer();
  }

  // -- State queries --------------------------------------------------------

  getState(loopId?: string): Readonly<LoopState> | null {
    if (loopId) return this.tasks.get(loopId) ?? null;
    // Legacy: return the default loop or the first active loop
    if (this.defaultLoopId) return this.tasks.get(this.defaultLoopId) ?? null;
    const first = this.tasks.values().next();
    return first.done ? null : first.value;
  }

  getAllStates(): ReadonlyMap<string, Readonly<LoopState>> {
    return this.tasks;
  }

  getActiveCount(): number {
    return this.tasks.size;
  }

  isActive(loopId?: string): boolean {
    if (loopId) {
      const s = this.tasks.get(loopId);
      return s !== null && s !== undefined && s.isActive;
    }
    return this.tasks.size > 0;
  }

  isWaitingForResponse(): boolean {
    return this.activeResponseLoopId !== null;
  }

  getWaitingLoopId(): string | null {
    return this.activeResponseLoopId;
  }

  // -- Iteration lifecycle --------------------------------------------------

  onIterationComplete(success: boolean): IterationResult | null {
    this.clearSafetyTimer();

    const loopId = this.activeResponseLoopId;
    if (!loopId) return null;

    const state = this.tasks.get(loopId);
    if (!state || !state.isActive || !state.waitingForResponse) {
      this.activeResponseLoopId = null;
      return null;
    }

    state.waitingForResponse = false;
    this.activeResponseLoopId = null;

    if (success) {
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        state.isPaused = true;
        return {
          done: false,
          paused: true,
          iteration: state.iteration,
          consecutiveFailures: state.consecutiveFailures,
          loopId,
        };
      }
    }

    // Max iterations reached?
    if (
      state.config.maxIterations > 0 &&
      state.iteration >= state.config.maxIterations
    ) {
      const iteration = state.iteration;
      this.stopOne(loopId);
      return {
        done: true,
        paused: false,
        iteration,
        consecutiveFailures: 0,
        loopId,
      };
    }

    this.scheduleNext(loopId, state.consecutiveFailures);
    return {
      done: false,
      paused: false,
      iteration: state.iteration,
      consecutiveFailures: state.consecutiveFailures,
      loopId,
    };
  }

  // -- Pause / Resume -------------------------------------------------------

  pause(loopId?: string): void {
    if (loopId) {
      this.pauseOne(loopId);
    } else {
      for (const id of this.tasks.keys()) this.pauseOne(id);
    }
  }

  private pauseOne(loopId: string): void {
    const state = this.tasks.get(loopId);
    if (!state || !state.isActive || state.isPaused) return;
    if (this.activeResponseLoopId === loopId) {
      this.clearSafetyTimer();
      this.activeResponseLoopId = null;
      state.waitingForResponse = false;
    }
    state.isPaused = true;
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    state.nextFireAt = null;
  }

  resume(loopId?: string): void {
    if (loopId) {
      this.resumeOne(loopId);
    } else {
      for (const id of this.tasks.keys()) this.resumeOne(id);
    }
  }

  private resumeOne(loopId: string): void {
    const state = this.tasks.get(loopId);
    if (!state || !state.isPaused) return;
    state.isPaused = false;
    state.consecutiveFailures = 0;
    this.scheduleNext(loopId);
  }

  // -- Safety timer ---------------------------------------------------------

  startSafetyTimer(): void {
    this.clearSafetyTimer();
    this.safetyTimerId = setTimeout(() => {
      if (this.activeResponseLoopId) {
        const state = this.tasks.get(this.activeResponseLoopId);
        if (state && state.isActive && state.waitingForResponse) {
          this.onIterationComplete(true);
        }
      }
    }, SAFETY_TIMEOUT_MS);
  }

  clearSafetyTimer(): void {
    if (this.safetyTimerId) {
      clearTimeout(this.safetyTimerId);
      this.safetyTimerId = null;
    }
  }

  // -- Auto-expiry ----------------------------------------------------------

  /**
   * Check all loops for expiry. Returns IDs of expired loops that were stopped.
   */
  checkExpired(): string[] {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, state] of this.tasks) {
      if (state.config.expiresAt && now >= state.config.expiresAt) {
        expired.push(id);
      }
    }
    for (const id of expired) this.stopOne(id);
    return expired;
  }

  private ensureExpiryTimer(): void {
    if (this.expiryTimerId) return;
    this.expiryTimerId = setInterval(() => {
      this.checkExpired();
    }, EXPIRY_CHECK_INTERVAL_MS);
    // Allow the process to exit even if the timer is running
    if (
      this.expiryTimerId &&
      typeof this.expiryTimerId === 'object' &&
      'unref' in this.expiryTimerId
    ) {
      this.expiryTimerId.unref();
    }
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimerId) {
      clearInterval(this.expiryTimerId);
      this.expiryTimerId = null;
    }
  }

  // -- Missed task detection ------------------------------------------------

  /**
   * Given persisted states from a previous session, return those whose
   * nextFireAt is in the past and haven't expired.
   */
  getMissedTasks(persisted: PersistedLoopState[]): PersistedLoopState[] {
    const now = Date.now();
    return persisted.filter(
      (t) =>
        t.nextFireAt !== null &&
        t.nextFireAt < now &&
        (!t.config.expiresAt || t.config.expiresAt > now),
    );
  }

  // -- Persistence ----------------------------------------------------------

  toPersistedStates(): PersistedLoopState[] {
    const result: PersistedLoopState[] = [];
    for (const state of this.tasks.values()) {
      if (!state.isActive) continue;
      result.push({
        id: state.id,
        config: { ...state.config },
        iteration: state.iteration,
        startedAt: state.startedAt,
        createdAt: state.createdAt,
        nextFireAt: state.nextFireAt,
      });
    }
    return result;
  }

  /** Backward-compatible single-state accessor */
  toPersistedState(): PersistedLoopState | null {
    const states = this.toPersistedStates();
    return states.length > 0 ? states[0] : null;
  }

  // -- Internal scheduling --------------------------------------------------

  private executeIteration(loopId: string): void {
    const state = this.tasks.get(loopId);
    if (!state || !state.isActive || !this.onIteration) return;

    // Another loop is currently using the streaming slot — retry shortly
    if (this.activeResponseLoopId && this.activeResponseLoopId !== loopId) {
      state.timerId = setTimeout(() => {
        state.timerId = null;
        this.executeIteration(loopId);
      }, 1_000);
      return;
    }

    state.iteration++;
    state.lastIterationAt = Date.now();
    state.waitingForResponse = true;
    state.nextFireAt = null;
    this.activeResponseLoopId = loopId;
    this.onIteration(state.config.prompt, state.iteration, loopId);
  }

  private scheduleNext(loopId: string, failureCount = 0): void {
    const state = this.tasks.get(loopId);
    if (!state || !state.isActive || state.isPaused) return;

    if (state.timerId) clearTimeout(state.timerId);

    // Check expiry before scheduling
    if (state.config.expiresAt && Date.now() >= state.config.expiresAt) {
      this.stopOne(loopId);
      return;
    }

    // Backoff on consecutive failures
    let intervalMs = state.config.intervalMs;
    if (failureCount > 0) {
      const multiplier = Math.min(
        Math.pow(2, failureCount),
        MAX_BACKOFF_MULTIPLIER,
      );
      intervalMs = Math.round(intervalMs * multiplier);
    }

    // Add jitter
    intervalMs += state.jitterOffsetMs;

    const targetTime = Date.now() + intervalMs;
    state.nextFireAt = targetTime;

    if (intervalMs <= MAX_SINGLE_TIMEOUT_MS) {
      state.timerId = setTimeout(() => {
        state.timerId = null;
        this.executeIteration(loopId);
      }, intervalMs);
    } else {
      const check = () => {
        const s = this.tasks.get(loopId);
        if (!s || !s.isActive) return;
        const remaining = targetTime - Date.now();
        if (remaining <= 0) {
          s.nextFireAt = null;
          s.timerId = null;
          this.executeIteration(loopId);
        } else {
          const nextCheck = Math.min(remaining, 30_000);
          s.timerId = setTimeout(check, nextCheck);
        }
      };
      state.timerId = setTimeout(check, Math.min(intervalMs, 30_000));
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

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
