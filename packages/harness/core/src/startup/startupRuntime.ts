/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';

export const CONFIG_STARTUP_GATES = [
  'base',
  'commands',
  'memory',
  'mcp-budget',
] as const;

export const SESSION_STARTUP_GATES = ['session-start'] as const;

export type ConfigStartupGate = (typeof CONFIG_STARTUP_GATES)[number];
export type SessionStartupGate = (typeof SESSION_STARTUP_GATES)[number];
export type StartupGate = ConfigStartupGate | SessionStartupGate;

export type StartupChangeEvent =
  | 'commands'
  | 'dynamic-commands'
  | 'extensions'
  | 'mcp'
  | 'skills';

export type StartupDegradationCode =
  | 'auth-degraded'
  | 'config-initialization-failed'
  | 'mcp-initialization-failed'
  | 'mcp-budget-timeout'
  | 'memory-refresh-failed'
  | 'session-start-initialization-failed'
  | 'session-hooks-failed'
  | 'skills-emit-failed'
  | 'skills-discovery-failed';

export interface StartupDegradation {
  code: StartupDegradationCode;
  message: string;
  error?: unknown;
}

export type StartupGateState =
  | { status: 'pending'; reasons: [] }
  | { status: 'ready'; reasons: [] }
  | { status: 'degraded'; reasons: StartupDegradation[] }
  | { status: 'failed'; reasons: StartupDegradation[] };

export type StartupGateResult =
  | { status: 'ready'; reasons?: [] }
  | { status: 'degraded'; reasons: StartupDegradation[] };

export type StartupSnapshot<G extends string> = Record<G, StartupGateState>;

export interface StartupRuntimeOptions<G extends string> {
  gates: readonly G[];
  dependencies?: Partial<Record<G, readonly G[]>>;
  changeDebounceMs?: number;
  changeMaxWaitMs?: number;
}

export interface StartupWaitOptions {
  signal?: AbortSignal;
}

declare const startupTaskResult: unique symbol;

export type StartupTaskId<T> = string & {
  readonly [startupTaskResult]: T;
};

export function startupTaskId<T>(taskId: string): StartupTaskId<T> {
  return taskId as StartupTaskId<T>;
}

export interface StartupTaskOptions<T> extends StartupWaitOptions {
  taskId: StartupTaskId<T>;
}

type OwnGateState =
  | StartupGateState
  | {
      status: 'ready';
      reasons: StartupDegradation[];
    };

type Waiter<G extends string> = {
  gate: G;
  reject: (error: unknown) => void;
  resolve: (result: StartupGateResult) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type ChangeTimerState = {
  trailing: ReturnType<typeof setTimeout>;
  maxWait: ReturnType<typeof setTimeout>;
};

function pendingState(): StartupGateState {
  return { status: 'pending', reasons: [] };
}

function readyState(): StartupGateState {
  return { status: 'ready', reasons: [] };
}

function degradedState(reasons: StartupDegradation[]): StartupGateState {
  return { status: 'degraded', reasons };
}

function failedState(reasons: StartupDegradation[]): StartupGateState {
  return { status: 'failed', reasons };
}

function mergeDegradationReasons(
  existing: StartupDegradation[],
  incoming: StartupDegradation[],
): StartupDegradation[] {
  const merged = [...existing];
  for (const reason of incoming) {
    const alreadyRecorded = merged.some(
      (existingReason) =>
        existingReason.code === reason.code &&
        existingReason.message === reason.message,
    );
    if (!alreadyRecorded) {
      merged.push(reason);
    }
  }
  return merged;
}

function makeAbortError(): Error {
  const error = new Error('Startup readiness wait aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Small readiness ledger for startup gates.
 *
 * It deliberately exposes two different concepts:
 * - readiness gates: one-shot, replayable, and dependency-aware
 * - change events: repeatable and debounced at the runtime boundary
 */
export class StartupRuntime<G extends string> {
  private readonly gates: readonly G[];
  private readonly dependencies: Partial<Record<G, readonly G[]>>;
  private readonly ownStates = new Map<G, OwnGateState>();
  private readonly startedElapsedMs = new Map<G, number>();
  private readonly settledElapsedMs = new Map<G, number>();
  private readonly waiters = new Set<Waiter<G>>();
  private readonly readyListeners = new Map<
    G,
    Set<(result: StartupGateResult) => void>
  >();
  private readonly notifiedGateStates = new Map<G, string>();
  private readonly gateNotificationVersions = new Map<G, number>();
  private readonly changeListeners = new Map<
    StartupChangeEvent,
    Set<() => void>
  >();
  private readonly taskPromises = new Map<string, Promise<unknown>>();
  private readonly changeTimers = new Map<
    StartupChangeEvent,
    ChangeTimerState
  >();
  private readonly changeDebounceMs: number;
  private readonly changeMaxWaitMs: number;
  private disposed = false;

  constructor(options: StartupRuntimeOptions<G>) {
    this.gates = options.gates;
    this.dependencies = options.dependencies ?? {};
    this.changeDebounceMs = options.changeDebounceMs ?? 175;
    this.changeMaxWaitMs =
      options.changeMaxWaitMs ?? Math.max(this.changeDebounceMs * 4, 1);
    for (const gate of this.gates) {
      this.ownStates.set(gate, pendingState());
    }
  }

  when(gate: G, options: StartupWaitOptions = {}): Promise<StartupGateResult> {
    if (this.disposed) {
      return Promise.reject(makeAbortError());
    }
    const current = this.computeState(gate);
    if (current.status === 'ready') {
      return Promise.resolve({ status: 'ready' });
    }
    if (current.status === 'degraded') {
      return Promise.resolve({
        status: 'degraded',
        reasons: current.reasons,
      });
    }
    if (current.status === 'failed') {
      return Promise.reject(this.toGateFailure(gate, current.reasons));
    }

    if (options.signal?.aborted) {
      return Promise.reject(makeAbortError());
    }

    return new Promise<StartupGateResult>((resolve, reject) => {
      const waiter: Waiter<G> = {
        gate,
        reject,
        resolve,
        signal: options.signal,
      };
      if (options.signal) {
        waiter.abortListener = () => {
          this.waiters.delete(waiter);
          reject(makeAbortError());
        };
        options.signal.addEventListener('abort', waiter.abortListener, {
          once: true,
        });
      }
      this.waiters.add(waiter);
    });
  }

  onReady(
    gate: G,
    listener: (result: StartupGateResult) => void,
  ): () => void {
    let listeners = this.readyListeners.get(gate);
    if (!listeners) {
      listeners = new Set();
      this.readyListeners.set(gate, listeners);
    }
    listeners.add(listener);

    const current = this.computeState(gate);
    if (current.status === 'ready' || current.status === 'degraded') {
      const replayVersion = this.gateNotificationVersions.get(gate) ?? 0;
      const replayKey = this.getNotificationKey(
        current.status === 'ready'
          ? { status: 'ready' }
          : { status: 'degraded', reasons: current.reasons },
      );
      queueMicrotask(() => {
        if (!listeners?.has(listener)) return;
        if ((this.gateNotificationVersions.get(gate) ?? 0) !== replayVersion) {
          return;
        }
        const latest = this.computeState(gate);
        if (latest.status !== 'ready' && latest.status !== 'degraded') {
          return;
        }
        const result: StartupGateResult =
          latest.status === 'ready'
            ? { status: 'ready' }
            : { status: 'degraded', reasons: latest.reasons };
        if (this.getNotificationKey(result) !== replayKey) {
          return;
        }
        listener(result);
      });
    }

    return () => {
      listeners?.delete(listener);
    };
  }

  onChange(event: StartupChangeEvent, listener: () => void): () => void {
    let listeners = this.changeListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.changeListeners.set(event, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  }

  runOnce<T>(
    taskId: StartupTaskId<T>,
    task: () => Promise<T> | T,
  ): Promise<T> {
    const existing = this.taskPromises.get(taskId) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const promise = Promise.resolve().then(task);
    this.taskPromises.set(taskId, promise);
    return promise;
  }

  runOnceWhenReady<T>(
    gate: G,
    options: StartupTaskOptions<T>,
    task: (result: StartupGateResult) => Promise<T> | T,
  ): Promise<T> {
    return this.when(gate, options).then((result) =>
      this.runOnce(options.taskId, () => task(result)),
    );
  }

  emitChange(event: StartupChangeEvent): void {
    if (this.disposed) return;
    // Per-event debounce with a max wait. Bursty changes coalesce, but a
    // sustained stream still delivers periodic refreshes.
    const existing = this.changeTimers.get(event);
    if (existing) {
      clearTimeout(existing.trailing);
      existing.trailing = setTimeout(() => {
        this.flushChange(event);
      }, this.changeDebounceMs);
      return;
    }

    const timerState: ChangeTimerState = {
      trailing: setTimeout(() => {
        this.flushChange(event);
      }, this.changeDebounceMs),
      maxWait: setTimeout(() => {
        this.flushChange(event);
      }, this.changeMaxWaitMs),
    };
    this.changeTimers.set(event, timerState);
  }

  private flushChange(event: StartupChangeEvent): void {
    const timerState = this.changeTimers.get(event);
    if (!timerState) {
      return;
    }
    clearTimeout(timerState.trailing);
    clearTimeout(timerState.maxWait);
    this.changeTimers.delete(event);

    const listeners = this.changeListeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Readiness notifications must not break unrelated subscribers.
      }
    }
  }

  markReady(gate: G): void {
    if (this.disposed) return;
    this.markSettled(gate);
    this.ownStates.set(gate, readyState());
    this.flushGateUpdates();
  }

  /** Records the first monotonic start offset for an observable startup gate. */
  markStarted(gate: G): void {
    if (this.disposed || this.startedElapsedMs.has(gate)) return;
    this.startedElapsedMs.set(gate, performance.now());
  }

  markDegraded(
    gate: G,
    reasonOrReasons: StartupDegradation | StartupDegradation[],
  ): void {
    if (this.disposed) return;
    this.markSettled(gate);
    const reasons = Array.isArray(reasonOrReasons)
      ? reasonOrReasons
      : [reasonOrReasons];
    const current = this.ownStates.get(gate);
    const mergedReasons =
      current?.status === 'degraded'
        ? mergeDegradationReasons(current.reasons, reasons)
        : reasons;
    this.ownStates.set(gate, degradedState(mergedReasons));
    this.flushGateUpdates();
  }

  markFailed(
    gate: G,
    reasonOrReasons: StartupDegradation | StartupDegradation[],
  ): void {
    if (this.disposed) return;
    this.markSettled(gate);
    const reasons = Array.isArray(reasonOrReasons)
      ? reasonOrReasons
      : [reasonOrReasons];
    this.ownStates.set(gate, failedState(reasons));
    this.flushGateUpdates();
  }

  reset(gate: G): void {
    if (this.disposed) return;
    this.ownStates.set(gate, pendingState());
    this.startedElapsedMs.delete(gate);
    this.settledElapsedMs.delete(gate);
    this.notifiedGateStates.delete(gate);
    this.gateNotificationVersions.set(
      gate,
      (this.gateNotificationVersions.get(gate) ?? 0) + 1,
    );
    this.flushGateUpdates();
  }

  snapshot(): StartupSnapshot<G> {
    const snapshot = {} as StartupSnapshot<G>;
    for (const gate of this.gates) {
      snapshot[gate] = this.computeState(gate);
    }
    return snapshot;
  }

  /**
   * Monotonic milliseconds from process time origin until this gate first
   * settled. Kept outside StartupGateState so readiness consumers do not start
   * depending on observability-only data.
   */
  getSettledElapsedMs(gate: G): number | undefined {
    return this.settledElapsedMs.get(gate);
  }

  /** Monotonic milliseconds from process time origin until this gate started. */
  getStartedElapsedMs(gate: G): number | undefined {
    return this.startedElapsedMs.get(gate);
  }

  ready(gate: G): boolean {
    const state = this.computeState(gate);
    return state.status === 'ready' || state.status === 'degraded';
  }

  private markSettled(gate: G): void {
    if (!this.settledElapsedMs.has(gate)) {
      this.settledElapsedMs.set(gate, performance.now());
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.changeTimers.values()) {
      clearTimeout(timer.trailing);
      clearTimeout(timer.maxWait);
    }
    this.changeTimers.clear();
    this.readyListeners.clear();
    this.changeListeners.clear();
    this.notifiedGateStates.clear();
    this.gateNotificationVersions.clear();
    for (const waiter of this.waiters) {
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.reject(makeAbortError());
    }
    this.waiters.clear();
  }

  private computeState(gate: G, seen = new Set<G>()): StartupGateState {
    if (seen.has(gate)) {
      throw new Error(`Startup readiness dependency cycle at gate "${gate}"`);
    }
    seen.add(gate);
    try {
      const own = this.ownStates.get(gate) ?? pendingState();
      if (own.status === 'failed') {
        return own as StartupGateState;
      }

      const reasons: StartupDegradation[] = [];
      for (const dependency of this.dependencies[gate] ?? []) {
        const depState = this.computeState(dependency, seen);
        if (depState.status === 'failed') {
          return failedState(depState.reasons);
        }
        if (depState.status === 'pending') {
          return pendingState();
        }
        if (depState.status === 'degraded') {
          reasons.push(...depState.reasons);
        }
      }

      if (own.status === 'pending') {
        return pendingState();
      }
      reasons.push(...own.reasons);

      return reasons.length > 0 ? degradedState(reasons) : readyState();
    } finally {
      seen.delete(gate);
    }
  }

  private flushGateUpdates(): void {
    for (const gate of this.gates) {
      const state = this.computeState(gate);
      if (state.status === 'pending') continue;

      if (state.status === 'failed') {
        for (const waiter of [...this.waiters]) {
          if (waiter.gate !== gate) continue;
          this.removeWaiter(waiter);
          waiter.reject(this.toGateFailure(gate, state.reasons));
        }
        continue;
      }

      const result: StartupGateResult =
        state.status === 'ready'
          ? { status: 'ready' }
          : { status: 'degraded', reasons: state.reasons };

      for (const waiter of [...this.waiters]) {
        if (waiter.gate !== gate) continue;
        this.removeWaiter(waiter);
        waiter.resolve(result);
      }

      const notificationKey = this.getNotificationKey(result);
      if (this.notifiedGateStates.get(gate) === notificationKey) {
        continue;
      }

      this.notifiedGateStates.set(gate, notificationKey);
      this.gateNotificationVersions.set(
        gate,
        (this.gateNotificationVersions.get(gate) ?? 0) + 1,
      );
      const listeners = this.readyListeners.get(gate);
      if (listeners) {
        for (const listener of [...listeners]) {
          try {
            listener(result);
          } catch {
            // Keep readiness notification fan-out best-effort.
          }
        }
      }
    }
  }

  private getNotificationKey(result: StartupGateResult): string {
    if (result.status === 'ready') {
      return 'ready';
    }
    return `degraded:${result.reasons
      .map((reason) => `${reason.code}:${reason.message}`)
      .join('|')}`;
  }

  private removeWaiter(waiter: Waiter<G>): void {
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
  }

  private toGateFailure(gate: G, reasons: StartupDegradation[]): Error {
    const details = reasons.map((reason) => reason.message).join('; ');
    return new Error(
      `Startup readiness gate "${gate}" failed${details ? `: ${details}` : ''}`,
    );
  }
}

export function createConfigStartupRuntime(): StartupRuntime<ConfigStartupGate> {
  return new StartupRuntime<ConfigStartupGate>({
    gates: CONFIG_STARTUP_GATES,
    dependencies: {
      commands: ['base'],
      memory: ['base'],
      'mcp-budget': ['base'],
    },
  });
}

export function createSessionStartupRuntime(): StartupRuntime<SessionStartupGate> {
  return new StartupRuntime<SessionStartupGate>({
    gates: SESSION_STARTUP_GATES,
  });
}
