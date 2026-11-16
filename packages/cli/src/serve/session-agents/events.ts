/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Live agent-run frames for chat sessions, one hub per workspace.
 *
 * In-flight state is never written to the transcript (contract.ts). The
 * orchestrator publishes `run` frames here as an agent streams; subscribers
 * (the session-events SSE route) filter by chat session. Nothing is replayed:
 * a client that connects or reconnects first reads the orchestrator snapshot.
 *
 * Streaming frames for one run are throttled to one per
 * {@link RUN_FRAME_THROTTLE_MS}; the latest frame always wins, and a frame
 * whose status changed is delivered at once.
 */

import type {
  SessionAgentEventFrame,
  SessionAgentRunFrame,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';

export const RUN_FRAME_THROTTLE_MS = 100;

export type SessionAgentEventListener = (frame: SessionAgentEventFrame) => void;

interface Subscriber {
  /** Undefined receives every session's frames. */
  sessionId?: string;
  listener: SessionAgentEventListener;
}

interface PendingRunFrame {
  frame: SessionAgentRunFrame;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionAgentEventHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly pending = new Map<string, PendingRunFrame>();
  /** Last delivered status per run, to deliver status changes immediately. */
  private readonly deliveredStatus = new Map<string, string>();

  constructor(private readonly throttleMs = RUN_FRAME_THROTTLE_MS) {}

  subscribe(
    listener: SessionAgentEventListener,
    sessionId?: string,
  ): () => void {
    const subscriber: Subscriber = { listener, sessionId };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * `immediate` skips the throttle for a frame whose delivery matters even
   * though nothing streaming changed (a recorded permission decision wakes
   * the Host's decisions poll, which follows these frames).
   */
  publish(
    frame: SessionAgentEventFrame,
    options: { immediate?: boolean } = {},
  ): void {
    if (frame.type !== 'run') {
      this.deliver(frame);
      return;
    }
    const key = `${frame.sessionId}\u0000${frame.runId}`;
    const existing = this.pending.get(key);
    // Status, record state and the pending approval are state changes, not
    // streaming: a throttled frame would be replaced by the next one and the
    // change (e.g. "record write failed, retrying") would never be seen.
    const statusChanged =
      options.immediate === true ||
      this.deliveredStatus.get(key) !== frameStateKey(frame);
    if (statusChanged) {
      if (existing) clearTimeout(existing.timer);
      this.pending.delete(key);
      this.deliverRun(key, frame);
      return;
    }
    if (existing) {
      existing.frame = frame;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.pending.get(key);
      this.pending.delete(key);
      if (entry) this.deliverRun(key, entry.frame);
    }, this.throttleMs);
    timer.unref?.();
    this.pending.set(key, { frame, timer });
  }

  /** Drops throttle state for a run that will publish no more frames. */
  forgetRun(sessionId: string, runId: string): void {
    const key = `${sessionId}\u0000${runId}`;
    const entry = this.pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
      this.deliverRun(key, entry.frame);
    }
    this.deliveredStatus.delete(key);
  }

  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.deliveredStatus.clear();
    this.subscribers.clear();
  }

  private deliverRun(key: string, frame: SessionAgentRunFrame): void {
    this.deliveredStatus.set(key, frameStateKey(frame));
    this.deliver(frame);
  }

  private deliver(frame: SessionAgentEventFrame): void {
    for (const subscriber of [...this.subscribers]) {
      if (
        frame.type === 'run' &&
        subscriber.sessionId !== undefined &&
        subscriber.sessionId !== frame.sessionId
      ) {
        continue;
      }
      try {
        subscriber.listener(frame);
      } catch {
        // One broken subscriber (a closed socket) must not starve the rest.
      }
    }
  }
}

const hubs = new Map<string, SessionAgentEventHub>();

/** The hub for one workspace, created on first use. */
export function getSessionAgentEventHub(
  workspaceCwd: string,
): SessionAgentEventHub {
  let hub = hubs.get(workspaceCwd);
  if (!hub) {
    hub = new SessionAgentEventHub();
    hubs.set(workspaceCwd, hub);
  }
  return hub;
}

/** The parts of a run frame whose change must reach clients unthrottled. */
function frameStateKey(frame: SessionAgentRunFrame): string {
  return [
    frame.status,
    frame.recorded === undefined ? '' : String(frame.recorded),
    frame.permission?.requestId ?? '',
    frame.retryable ? 'retryable' : '',
  ].join('|');
}
