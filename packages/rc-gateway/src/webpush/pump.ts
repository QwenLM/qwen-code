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
import type { PolicyEnforcer } from '../policy/enforcer.js';

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
  /**
   * Called for EVERY event seen (before policy/notify branches), independent of
   * push. The subscriber-independent ingestion hook for cost tracking
   * (`add-cost-tracking`: "subscribe to every emitted session_update"). Must be
   * total — invoked inside the loop's try, but should never throw.
   */
  onEvent?: (sessionId: string, event: DaemonEvent) => void;
  /**
   * Optional policy enforcer. When set, `permission_request` events are first
   * offered to it; an auto-handled (voted) event is NOT pushed to the notifier.
   */
  enforcer?: PolicyEnforcer;
  /**
   * Optional idle handler (proposal `add-idle-suggestions`, slice 2). Called ONCE
   * per session whenever its `hasActivePrompt` transitions true→false across poll
   * ticks — the daemon's authoritative "the agent just went idle" edge (the
   * bridge sets `hasActivePrompt = activePromptOriginatorClientId !== undefined`,
   * so it is true for the whole prompt turn INCLUDING tool calls; the falling edge
   * is genuine idle, never a mid-tool gap). Invoked synchronously inside a
   * try/catch and expected to be fire-and-forget — it must never block or throw
   * into reconcile.
   */
  onSessionIdle?: (sessionId: string, workspaceCwd: string) => void;
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
  private readonly onEvent?: (sessionId: string, event: DaemonEvent) => void;
  private readonly enforcer?: PolicyEnforcer;
  private readonly onSessionIdle?: (
    sessionId: string,
    workspaceCwd: string,
  ) => void;

  private readonly loops = new Map<string, Loop>();
  /**
   * Last-observed active-prompt state per session, for true→false edge detection
   * (idle suggestions). Tracked only when `onSessionIdle` is wired; cleared on
   * session-drop and `stop()` so it never outlives the loops.
   */
  private readonly activePrompt = new Map<string, boolean>();
  private workspaceCwd = '';
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly daemon: DaemonClient,
    // Optional: the pump also runs for cost tracking with no push notifier
    // (push gated on VAPID; cost tracking is not). notify is guarded below.
    private readonly notifier: PumpNotifier | undefined,
    opts: SessionEventPumpOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 5000;
    this.reconnectMs = opts.reconnectMs ?? 1000;
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
    this.sleep = opts.sleep ?? defaultSleep;
    this.sessionName = opts.sessionName;
    this.onDispatch = opts.onDispatch;
    this.onEvent = opts.onEvent;
    this.enforcer = opts.enforcer;
    this.onSessionIdle = opts.onSessionIdle;
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
    // A concurrent stop() during the awaits above would not have seen a timer
    // to clear (it's assigned below). Re-check so we don't install a live poll
    // timer after stop() — honoring the "leaves no open handles" contract.
    if (this.stopped) return;
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
    // stop() may have landed during the await — don't spawn loops post-stop.
    if (this.stopped) return;
    const ids = new Set(list.map((s) => s.sessionId));
    for (const s of list) {
      if (!this.loops.has(s.sessionId)) this.spawnLoop(s);
      this.detectIdleEdge(s);
    }
    for (const [id, loop] of this.loops) {
      if (!ids.has(id)) {
        loop.active = false;
        loop.ctrl.abort();
        this.loops.delete(id);
        this.activePrompt.delete(id);
      }
    }
  }

  /**
   * Track this session's active-prompt state and fire {@link onSessionIdle} once
   * on a true→false transition (the agent just went idle). The FIRST observation
   * only seeds the state — a session first seen idle, or first seen mid-prompt,
   * never fires until we actually witness the falling edge — so startup doesn't
   * emit a suggestion storm for every pre-existing session. No-op when no idle
   * handler is wired (so the map stays empty and there's zero overhead).
   */
  private detectIdleEdge(s: DaemonSessionSummary): void {
    if (!this.onSessionIdle) return;
    const now = s.hasActivePrompt === true;
    const prev = this.activePrompt.get(s.sessionId);
    this.activePrompt.set(s.sessionId, now);
    if (prev === true && now === false) {
      try {
        this.onSessionIdle(s.sessionId, s.workspaceCwd);
      } catch {
        // Idle suggestions are best-effort enrichment; a throwing handler must
        // never break the reconcile loop or push delivery.
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
          // Advance the resume cursor first, before any handling branch, so a
          // reconnect never re-delivers an event we already auto-voted on.
          if (typeof ev.id === 'number') loop.lastEventId = ev.id;
          // Subscriber-independent ingestion (cost tracking): see EVERY event,
          // before policy/notify. Guarded so it never breaks the loop.
          if (this.onEvent) {
            try {
              this.onEvent(s.sessionId, ev);
            } catch {
              /* ingestion is best-effort; never break the subscribe loop */
            }
          }
          // Consult the policy enforcer for permission_request events. An
          // auto-handled (voted) event is suppressed from push; everything else
          // — non-permission events and prompt/fail-safe decisions — still
          // notifies, identical to pre-policy behavior.
          if (this.enforcer && ev.type === 'permission_request') {
            const handled = await this.enforcer.handlePermission(s.sessionId, {
              type: ev.type,
              data: ev.data,
            });
            if (handled) {
              this.onDispatch?.(s.sessionId, ev);
              continue;
            }
          }
          await this.notifier?.notify(
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
    this.activePrompt.clear();
  }
}
