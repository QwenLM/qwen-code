/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostedMonitorSession } from './hosted-monitor-session.js';

// H3 of #12827: the observation loop of one admitted Monitor. The funnel
// owns the record line; this loop owns time: stdout lines aggregate into one
// observation per debounce window (floored at one second so the reopen
// replay bound holds whatever command the watch runs), and the run settles
// itself on the contract's own terminal conditions — the observation quota,
// the idle timeout, or the watch ending. The executor is injected: the
// managed-runtime worker's cgroup watch plugs in behind this interface, and
// tests drive the loop with a fake executor and fake timers. Notification
// composition and the wake it raises stay with the next increment. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

export const MONITOR_DEBOUNCE_FLOOR_MS = 1000;

/** The physical watch; the worker's cgroup owner implements this. */
export interface MonitorWatchExecutor {
  /**
   * Starts the watch; resolves with its handle, rejects when it cannot.
   * `onLine` fires per stdout line; `onExit` fires exactly once, after the
   * start promise resolved (so the host attaches before it settles), with
   * whether the watch failed mid-run.
   */
  start(
    command: Readonly<Record<string, unknown>>,
    onLine: (line: string) => void,
    onExit: (failed: boolean) => void,
  ): Promise<MonitorWatchHandle>;
}

export interface MonitorWatchHandle {
  /** The physical start receipt the record sets once at attach. */
  readonly receipt: Readonly<Record<string, unknown>>;
  terminate(): Promise<void>;
}

export interface MonitorLoopClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const GLOBAL_CLOCK: MonitorLoopClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

interface MonitorLoopParams {
  readonly ownerScopeId: string;
  readonly executionCallId: string;
  readonly args: Record<string, unknown>;
  readonly maxEvents: number;
  readonly idleTimeoutMs: number;
  readonly debounceMs: number;
  readonly runtime: { runtimeBindingId: string; generation: string };
}

export class HostedMonitorLoop {
  private params: MonitorLoopParams | undefined;
  private handle: MonitorWatchHandle | undefined;
  private debounceMs = MONITOR_DEBOUNCE_FLOOR_MS;
  private buffered: string[] = [];
  private window: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private pending = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private failure: unknown;

  constructor(
    private readonly monitors: HostedMonitorSession,
    private readonly monitorId: string,
    private readonly executor: MonitorWatchExecutor,
    private readonly clock: MonitorLoopClock = GLOBAL_CLOCK,
  ) {}

  /** Resolves once every settle queued so far has finished. */
  get done(): Promise<void> {
    if (this.pending === 0) {
      return this.failure === undefined
        ? Promise.resolve()
        : Promise.reject(this.failure);
    }
    return new Promise<void>((resolve, reject) => {
      this.idleWaiters.push(() => {
        if (this.failure === undefined) resolve();
        else reject(this.failure);
      });
    });
  }

  /**
   * Admits the record, dispatches onto the binding, starts the watch and
   * runs until a terminal condition settles it.
   */
  async start(params: MonitorLoopParams): Promise<void> {
    this.params = params;
    this.debounceMs = Math.max(params.debounceMs, MONITOR_DEBOUNCE_FLOOR_MS);
    await this.monitors.admit({
      monitorId: this.monitorId,
      ownerScopeId: params.ownerScopeId,
      executionCallId: params.executionCallId,
      args: params.args,
      maxEvents: params.maxEvents,
      idleTimeoutMs: params.idleTimeoutMs,
      debounceMs: params.debounceMs,
    });
    await this.monitors.dispatchStarted(this.monitorId, params.runtime);
    let handle: MonitorWatchHandle;
    try {
      handle = await this.executor.start(
        params.args,
        (line) => this.onLine(line),
        (failed) => this.onExit(failed),
      );
    } catch (error) {
      await this.monitors.settleFailed(this.monitorId, {
        stopReason: 'start_failed',
        started: false,
      });
      throw error;
    }
    this.handle = handle;
    await this.monitors.attach(this.monitorId, params.runtime, {
      ...handle.receipt,
    });
    this.armWindow();
    this.armIdle();
  }

  private onExit(failed: boolean): void {
    if (this.ended && !failed) return;
    this.enqueue(async () => {
      if (failed) {
        if (this.ended) return;
        this.ended = true;
        this.disarm();
        await this.monitors.settleFailed(this.monitorId, {
          stopReason: 'watch_failed',
          started: true,
        });
        return;
      }
      if (this.ended) return;
      await this.flush();
      await this.settle('exited', false);
    });
  }

  /** Work that crosses async boundaries, so callers can await `done`. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const tracked = (async () => {
      try {
        await work();
      } catch (error) {
        this.failure ??= error;
        throw error;
      } finally {
        this.pending -= 1;
        if (this.pending === 0) {
          const waiters = this.idleWaiters.splice(0);
          for (const waiter of waiters) waiter();
        }
      }
    })();
    void tracked.catch(() => undefined);
    return tracked;
  }

  /** The stop call: terminate the physical watch, then settle the record. */
  async stop(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.disarm();
    await this.handle?.terminate();
    await this.monitors.settleStopRequested(this.monitorId);
  }

  private onLine(line: string): void {
    if (this.ended) return;
    this.buffered.push(line);
  }

  private armWindow(): void {
    this.window = this.clock.setTimeout(
      () =>
        this.enqueue(async () => {
          await this.flush();
          if (!this.ended) this.armWindow();
        }),
      this.debounceMs,
    );
  }

  private armIdle(): void {
    if (this.params === undefined || this.ended) return;
    if (this.idle !== undefined) this.clock.clearTimeout(this.idle);
    this.idle = this.clock.setTimeout(
      () => this.enqueue(() => this.settle('idle_timeout', true)),
      this.params.idleTimeoutMs,
    );
  }

  /** Commits whatever the window buffered as one observation revision. */
  private async flush(): Promise<void> {
    if (this.ended || this.buffered.length === 0) return;
    const lines = this.buffered;
    this.buffered = [];
    await this.monitors.observe(this.monitorId, { lines });
    this.armIdle();
    const sequence = this.monitors.record(this.monitorId)?.observationSequence;
    if (
      this.params !== undefined &&
      sequence !== undefined &&
      sequence >= this.params.maxEvents
    )
      await this.settle('max_events', true);
  }

  private async settle(
    stopReason: 'exited' | 'max_events' | 'idle_timeout',
    terminate: boolean,
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.disarm();
    if (terminate) await this.handle?.terminate();
    await this.monitors.settleQuiet(this.monitorId, stopReason);
  }

  private disarm(): void {
    if (this.window !== undefined) this.clock.clearTimeout(this.window);
    if (this.idle !== undefined) this.clock.clearTimeout(this.idle);
    this.window = undefined;
    this.idle = undefined;
  }
}
