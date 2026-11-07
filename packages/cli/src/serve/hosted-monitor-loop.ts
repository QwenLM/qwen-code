/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostedMonitorSession } from './hosted-monitor-session.js';
import type { ManagedSessionInputRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type { ManagedChildRunProcess } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { buildMonitorNotificationInput } from './hosted-monitor-notification.js';

// H3 of #12827: the observation loop of one admitted Monitor. The funnel
// owns the record line; this loop owns time: stdout lines aggregate into one
// observation per debounce window (floored at one second so the reopen
// replay bound holds whatever command the watch runs), and the run settles
// itself on the contract's own terminal conditions — the observation quota,
// the idle timeout, or the watch ending. The executor is injected: the
// managed-runtime worker's cgroup watch plugs in behind this interface, and
// tests drive the loop with a fake executor and fake timers. Notification
// composition is the Legacy task-notification envelope; the embedded
// scheduler that consumes the wake it raises is the next increment. See
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
    /**
     * Fires exactly once, after the start promise resolved. May return a
     * promise carrying the exit's flush and settle in order; an owner
     * that awaits it never settles ahead of the last observation.
     */
    onExit: (
      failed: boolean,
      /** #13856 A8: the end followed a platform-requested stop. */
      stopRequested?: boolean,
    ) => Promise<void> | void,
    identity?: {
      readonly unitName: string;
      readonly cwd?: string;
      /**
       * Raw bytes of both streams, ahead of any line decode: the durable
       * capture reproduces the command's output exactly — no line
       * splitting, no dropped blanks, no lost tail — while onLine keeps
       * the Legacy stdout-only observation-line semantics. (Round-5
       * finding: a capture rebuilt from lines cannot do both.)
       */
      readonly onChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
    },
  ): Promise<MonitorWatchHandle>;
}

export interface MonitorWatchHandle {
  /** The physical start receipt the record sets once at attach. */
  readonly receipt: Readonly<Record<string, unknown>>;
  /** The supervised physical unit, exposed to the worker's own registry. */
  readonly process?: ManagedChildRunProcess;
  /**
   * Ends the watch and reports whether that stop is proven. A handle whose
   * watch runs in the worker answers `true` only on the worker's exit
   * evidence (#13896); anything less parks the record instead of claiming
   * a settlement the physical side never confirmed (#13856).
   */
  terminate(): Promise<boolean>;
}

export interface MonitorLoopClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const GLOBAL_CLOCK: MonitorLoopClock = {
  now: () => Date.now(),
  // Never anchor the process to an observation window: a live Runtime
  // always has other handles, and a dead one rewinds on the next resume.
  setTimeout: (handler, ms) => setTimeout(handler, ms).unref(),
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
  /**
   * The loop stopped its own observing and time-keeping. A park sets this
   * without {@link settled}, so the watch's later physical evidence still
   * has a record to settle (#13856).
   */
  private ended = false;
  /** The record reached a terminal state; no later evidence revises it. */
  private settled = false;
  /**
   * The reason an auto-stop still waiting on the worker settles at. The
   * worker answers a stop only after the finalize that carries the watch's
   * exit returns, so an exit that arrives meanwhile is that stop's own
   * evidence: it settles the record at this reason from inside its chain,
   * and the answer that follows finds the record settled. A proven stop
   * whose finalize the publisher refused keeps the reason for that
   * finalize's redrive (#13896).
   */
  private stopping: 'exited' | 'max_events' | 'idle_timeout' | undefined;
  /** The auto-stop's whole arm, which a stop call waits out first. */
  private autoStop: Promise<void> | undefined;
  private pending = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private failure: unknown;
  private lifecycleCleanup = false;

  constructor(
    private readonly monitors: HostedMonitorSession,
    private readonly monitorId: string,
    private readonly executor: MonitorWatchExecutor,
    private readonly clock: MonitorLoopClock = GLOBAL_CLOCK,
    private readonly onNotification?: () => void,
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
        (failed, stopRequested) => this.onExit(failed, stopRequested),
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

  /**
   * Resumes the observation lifecycle for a watch whose admission arm
   * already committed intent, dispatch and the start receipt (the hosted
   * turn path). This loop must never re-commit any of those: a record
   * without its start receipt refuses instead of silently minting one. A
   * record the publisher already settled — the watch ended before its
   * observer could register — has nothing left to resume.
   */
  async resumeAttached(params: MonitorLoopParams): Promise<void> {
    this.params = params;
    this.debounceMs = Math.max(params.debounceMs, MONITOR_DEBOUNCE_FLOOR_MS);
    const record = this.monitors.record(this.monitorId);
    if (record === undefined || record.startReceiptRef === null) {
      throw new Error(
        `Monitor ${this.monitorId} has no attached watch to resume.`,
      );
    }
    if (record.stopReason !== null) {
      // The Session close stops every registered loop; unmarked, that stop
      // writes a second terminal revision the settled record refuses, and
      // the close fails (#13984).
      this.ended = true;
      this.settled = true;
      return;
    }
    this.handle = await this.executor.start(
      params.args,
      (line) => this.onLine(line),
      (failed, stopRequested) => this.onExit(failed, stopRequested),
      { unitName: this.monitorId },
    );
    this.armWindow();
    this.armIdle();
  }

  /**
   * The watch's physical end. The returned chain carries the exit's own
   * flush and settle in order, so an owner that awaits it settles nothing
   * ahead of the last observation's commit — a caller that settles first
   * (and lets the successor rule reject the late observe) is exactly how
   * a final window once died silently between two async hops. A platform
   * stop arrives with stopRequested set and projects as the requested
   * stop, never as a bare exit (#13856 A8). A loop that parked on an
   * unproven auto-stop is still open here: the watch kept running, so its
   * physical end is the evidence that finally settles the record. An exit
   * that arrives while an auto-stop waits on the worker, or that a refused
   * finalize's redrive delivers after the stop proved the end, settles at
   * that stop's reason instead of its own stop marker (#13896).
   */
  private onExit(failed: boolean, stopRequested = false): Promise<void> {
    if (this.settled && !failed) return Promise.resolve();
    return this.enqueue(async () => {
      if (failed) {
        if (this.settled) return;
        this.ended = true;
        this.settled = true;
        this.disarm();
        await this.monitors.settleFailed(this.monitorId, {
          stopReason: 'watch_failed',
          started: true,
        });
        return;
      }
      if (this.settled) return;
      // The watch's physical end supersedes its quota: this final window
      // commits, but the quota must not park the record ahead of the exit's
      // own settle (#13856 R1-30).
      await this.flush(false);
      if (this.settled) return;
      if (this.stopping !== undefined) {
        this.settled = true;
        await this.monitors.settleQuiet(this.monitorId, this.stopping);
        return;
      }
      if (stopRequested) {
        this.ended = true;
        this.settled = true;
        this.disarm();
        await this.monitors.settleStopRequested(this.monitorId);
        return;
      }
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

  /**
   * The stop call: end the loop's own time-keeping, terminate the physical
   * watch, then settle the record at the outcome the caller may claim. A
   * caller that cannot prove the Runtime stopped the watch — its release
   * was refused, so the physical side was never told at all — must not
   * mint a `stop_requested` settlement; it parks the record on the
   * runtime_lost line where a later open rebuilds it (read-only) or keeps
   * it accurately blocked instead of reporting a stopped task that never
   * stopped. A loop that parked on an unproven auto-stop is still stoppable
   * here, so the close's proven drain upgrades that parked record to the
   * requested stop instead of leaving it blocked forever. The runtime_lost
   * arm parks the same open way: the failed close that asks for it keeps the
   * Session and its publisher alive for a retry, and that retry's proven
   * drain — or the watch's own end — still owes the record its settlement
   * (#13856). An auto-stop already waiting on the worker goes first: its
   * proof settles the record, and only its park leaves the record to this
   * call. A proven auto-stop whose final output never landed settles here
   * at its own reason, with no second stop. The exit a stop causes may
   * settle the record before the stop's own answer returns, and that
   * settlement stands (#13896).
   */
  async stop(
    settle: 'stop_requested' | 'runtime_lost' = 'stop_requested',
  ): Promise<void> {
    await this.autoStop?.catch(() => undefined);
    if (this.settled) return;
    if (this.stopping !== undefined) {
      const stopReason = this.stopping;
      this.stopping = undefined;
      this.settled = true;
      await this.monitors.settleQuiet(this.monitorId, stopReason);
      return;
    }
    this.ended = true;
    this.disarm();
    await this.handle?.terminate();
    if (this.settled) return;
    if (settle === 'runtime_lost') {
      await this.monitors.blockedRuntimeLost(this.monitorId);
      return;
    }
    this.settled = true;
    await this.monitors.settleStopRequested(this.monitorId);
  }

  prepareLifecycle(): void {
    this.lifecycleCleanup = true;
    if (this.idle !== undefined) this.clock.clearTimeout(this.idle);
    this.idle = undefined;
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
  private async flush(settleQuota: boolean = true): Promise<void> {
    if (this.ended || this.buffered.length === 0) return;
    const lines = this.buffered;
    this.buffered = [];
    const nextSequence =
      (this.monitors.record(this.monitorId)?.observationSequence ?? 0) + 1;
    const input = this.lifecycleCleanup
      ? undefined
      : await this.notification(nextSequence, lines);
    await this.monitors.observe(
      this.monitorId,
      { lines },
      this.lifecycleCleanup || !input ? undefined : { input },
    );
    if (!this.lifecycleCleanup) {
      this.onNotification?.();
      this.armIdle();
    }
    const sequence = this.monitors.record(this.monitorId)?.observationSequence;
    if (
      settleQuota &&
      !this.lifecycleCleanup &&
      this.params !== undefined &&
      sequence !== undefined &&
      sequence >= this.params.maxEvents
    )
      await this.settle('max_events', true);
  }

  /** One notification per accepted observation, as the Legacy wake did. */
  private async notification(
    sequence: number,
    lines: readonly string[],
  ): Promise<ManagedSessionInputRequest> {
    const args = this.params?.args ?? {};
    const description =
      typeof args['description'] === 'string' && args['description'].trim()
        ? (args['description'] as string)
        : typeof args['command'] === 'string'
          ? (args['command'] as string)
          : this.monitorId;
    return buildMonitorNotificationInput({
      monitorId: this.monitorId,
      toolUseId: this.params?.executionCallId ?? null,
      description,
      sequence,
      lines,
      resourceStore: this.monitors.resourceStore,
    });
  }

  private async settle(
    stopReason: 'exited' | 'max_events' | 'idle_timeout',
    terminate: boolean,
  ): Promise<void> {
    // A quota or idle stop belongs to a loop that still observes: a window
    // or timer that fired while another stop was under way has nothing left
    // to stop.
    if (this.settled || (terminate && this.ended)) return;
    this.ended = true;
    this.disarm();
    if (terminate && this.handle !== undefined) {
      this.autoStop = this.autoStopWatch(this.handle, stopReason);
      return this.autoStop;
    }
    this.settled = true;
    await this.monitors.settleQuiet(this.monitorId, stopReason);
  }

  /**
   * The quota or the idle window ended this loop's own observing; only a
   * proven stop may settle the record at that reason. An unproven one parks
   * on the same honest line `stop()` uses, so a watch that still runs never
   * reports as a task that ended — and the park leaves the record open,
   * because that watch's own end is still to come (#13856). A proven stop
   * normally finds the record already settled by its exit (D5). One that
   * does not means the publisher refused the finalize carrying that exit,
   * and its redrive must still advance the record's output to the sealed
   * manifest, which a terminal record refuses: the record stays open at
   * this reason until that exit lands, or the Session close settles it
   * (#13896).
   */
  private async autoStopWatch(
    handle: MonitorWatchHandle,
    stopReason: 'exited' | 'max_events' | 'idle_timeout',
  ): Promise<void> {
    this.stopping = stopReason;
    let proven = false;
    try {
      proven = await handle.terminate();
    } finally {
      if (!proven || this.settled) this.stopping = undefined;
    }
    if (this.settled || proven) return;
    await this.monitors.blockedRuntimeLost(this.monitorId);
  }

  private disarm(): void {
    if (this.window !== undefined) this.clock.clearTimeout(this.window);
    if (this.idle !== undefined) this.clock.clearTimeout(this.idle);
    this.window = undefined;
    this.idle = undefined;
  }
}
