/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session fan-out broadcaster for gateway-injected SSE events.
 *
 * Used to deliver synthetic events (e.g. `stream_error` with code
 * `prompt_timeout`) to all active `/session/:id/events` subscribers when the
 * gateway itself needs to signal something — without the event originating
 * from the daemon.
 *
 * Mirrors the design of `UsageTickBroadcaster`: listeners register a writer
 * callback; `emit` fans a payload to every registered writer for a session.
 * A throwing listener is swallowed so one wedged relay never breaks siblings.
 */

export interface GatewayEvent {
  type: string;
  data: unknown;
}

export class PromptEventBroadcaster {
  private readonly listeners = new Map<
    string,
    Set<(event: GatewayEvent) => void>
  >();

  /** Register a per-session event writer; returns an unregister function. */
  register(
    sessionId: string,
    write: (event: GatewayEvent) => void,
  ): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(write);
    return () => {
      const s = this.listeners.get(sessionId);
      if (!s) return;
      s.delete(write);
      if (s.size === 0) this.listeners.delete(sessionId);
    };
  }

  /** Fan an event to every registered writer for the session. Never throws. */
  emit(sessionId: string, event: GatewayEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const write of set) {
      try {
        write(event);
      } catch {
        // A wedged relay must not break sibling subscribers.
      }
    }
  }

  /** Number of registered writers for a session (tests / introspection). */
  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }
}
