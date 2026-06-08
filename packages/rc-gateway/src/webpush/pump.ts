/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonClient,
  DaemonEvent,
  DaemonSessionSummary,
} from '@qwen-code/sdk';

/**
 * The subset of `PushNotifier` the pump drives. Kept structural so tests
 * can pass a lightweight collector. `notify` is best-effort and never throws.
 */
export interface PumpNotifier {
  notify(
    event: { type: string; data: unknown },
    ctx: { sessionId: string; sessionName?: string },
  ): Promise<void>;
}

export interface SessionEventPumpOptions {
  /** Poll interval for the workspace session set. Default 5000ms. */
  pollMs?: number;
  /** Backoff between reconnect attempts of a still-active loop. Default 1000ms. */
  reconnectMs?: number;
  /** Map a session summary to a display name for push payloads. */
  sessionName?: (s: DaemonSessionSummary) => string | undefined;
  /** Injectable timer fns so tests don't wait real time. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Injectable sleep so tests don't wait real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: called after each event is dispatched to the notifier. */
  onDispatch?: (sessionId: string, event: DaemonEvent) => void;
}

/** Per-session subscription loop state. */
interface Loop {
  active: boolean;
  ctrl: AbortController;
  lastEventId?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Holds the gateway's own persistent daemon-SSE subscriptions: discover sessions
 * via capabilities + workspace session list, subscribe per session, and fan each
 * event into the push notifier — so push fires with no browser open.
 *
 * Best-effort by construction: every failure path is caught and logged, and no
 * code path rethrows into the gateway. `start()` always resolves. `stop()` aborts
 * every loop and clears the poll interval, leaving no open handles.
 */
export class SessionEventPump {
  private readonly pollMs: number;
  private readonly reconnectMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sessionName?: (
    s: DaemonSessionSummary,
  ) => string | undefined;
  private readonly onDispatch?: (sessionId: string, event: DaemonEvent) => void;

  private readonly loops = new Map<string, Loop>();
  private workspaceCwd = '';
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly daemon: DaemonClient,
    private readonly notifier: PumpNotifier,
    opts: SessionEventPumpOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 5000;
    this.reconnectMs = opts.reconnectMs ?? 1000;
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
    this.sleep = opts.sleep ?? defaultSleep;
    this.sessionName = opts.sessionName;
    this.onDispatch = opts.onDispatch;
  }

  /** Resolves once the first reconcile has run. Never throws. */
  async start(): Promise<void> {
    this.stopped = false;
    try {
      const caps = await this.daemon.capabilities();
      this.workspaceCwd = caps.workspaceCwd ?? '';
    } catch (err) {
      // No workspace → idle; retried on each poll tick. Never crash the gateway.
      // eslint-disable-next-line no-console
      console.warn('[pump] capabilities failed; idling:', err);
      this.workspaceCwd = '';
    }
    await this.reconcile();
    this.timer = this.setIntervalFn(() => {
      void this.reconcile();
    }, this.pollMs);
    // Don't let the poll timer keep the process alive.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Diff the listed session set against tracked loops. Never throws. */
  private async reconcile(): Promise<void> {
    if (this.stopped || !this.workspaceCwd) return;
    let list: DaemonSessionSummary[];
    try {
      list = await this.daemon.listWorkspaceSessions(this.workspaceCwd);
    } catch {
      // Transient daemon error → try again next tick.
      return;
    }
    const ids = new Set(list.map((s) => s.sessionId));
    for (const s of list) {
      if (!this.loops.has(s.sessionId)) this.spawnLoop(s);
    }
    for (const [id, loop] of this.loops) {
      if (!ids.has(id)) {
        loop.active = false;
        loop.ctrl.abort();
        this.loops.delete(id);
      }
    }
  }

  private spawnLoop(s: DaemonSessionSummary): void {
    const loop: Loop = { active: true, ctrl: new AbortController() };
    this.loops.set(s.sessionId, loop);
    void this.runLoop(s, loop);
  }

  /**
   * Per-session subscription loop. Self-heals: when the stream ends or throws
   * (and the loop is still active and the pump still running) it reconnects after
   * a short backoff, resuming from the last seen event id. An aborted loop exits
   * and never reconnects. Never rethrows.
   */
  private async runLoop(s: DaemonSessionSummary, loop: Loop): Promise<void> {
    const name = this.sessionName?.(s);
    while (loop.active && !this.stopped) {
      try {
        for await (const ev of this.daemon.subscribeEvents(s.sessionId, {
          signal: loop.ctrl.signal,
          lastEventId: loop.lastEventId,
        })) {
          if (typeof ev.id === 'number') loop.lastEventId = ev.id;
          await this.notifier.notify(
            { type: ev.type, data: ev.data },
            { sessionId: s.sessionId, sessionName: name },
          );
          this.onDispatch?.(s.sessionId, ev);
        }
      } catch {
        if (loop.ctrl.signal.aborted) break;
        // Otherwise fall through to backoff + reconnect.
      }
      if (!loop.active || this.stopped) break;
      await this.sleep(this.reconnectMs);
    }
  }

  /** Aborts every loop and clears the poll interval. Leaves no open handles. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    for (const loop of this.loops.values()) {
      loop.active = false;
      loop.ctrl.abort();
    }
    this.loops.clear();
  }
}
