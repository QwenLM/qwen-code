/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuditRecord } from './auditLog.js';
import type { WalFrame } from './wal.js';

/**
 * A `routing_decision` event emitted for every routing-rule evaluation so
 * an operator can observe which rules fired (or passed) in real time.
 *
 * Emitted by the notifier for every event it evaluates, before any send, so
 * observing it is non-intrusive and happens even when the event is dropped.
 * Carries only metadata — NO session content, NO tool args.
 */
export interface RoutingDecisionEvent {
  type: 'routing_decision';
  /** Event kind being evaluated (e.g. `'permission.required'`). */
  kind: string;
  /** Session name if known. */
  sessionName?: string;
  /**
   * `'drop'` when a rule matched and suppressed the fan-out; `'pass'` when no
   * rule matched and the event proceeds to the normal delivery path.
   */
  decision: 'drop' | 'pass';
  /** Id of the first matching drop rule (present when `decision='drop'`). */
  ruleId?: string;
  /** Timestamp (ISO-8601) of the evaluation. */
  evaluatedAt: string;
}

/**
 * Rate-limit state carried in `idle_suggestions` SSE frames so the UI can show
 * an accurate "X of Y remaining this hour" indicator without a round-trip.
 */
export interface IdleRateLimitState {
  /** How many more suggestion firings are allowed in the current rolling hour. */
  remaining: number;
  /**
   * Absolute cap read from config at fire time (so the UI can render
   * "2 of 5 remaining" even before any reset has occurred).
   */
  max: number;
}

/**
 * A frame broadcast on the owner-level event stream. A discriminated union so
 * producers can add variants without breaking consumers (clients switch on
 * `type` and ignore unknown frames). The `/rc/events` route JSON-stringifies the
 * whole frame, so a new variant flows through with no route change.
 *
 *  - `audit`: a durably-appended audit record (the live security feed; cycle 49).
 *  - `idle_suggestions`: gateway-generated next-step suggestions emitted when a
 *    session's active prompt finishes (proposal `add-idle-suggestions`, slice 2).
 *    `suggestions` is a small list of short imperative strings — NEVER transcript
 *    text, only the model's distilled next-step phrases.
 *    `expiresAt` is an ISO-8601 timestamp after which the client SHOULD dismiss
 *    the suggestions (default TTL: 30 minutes from the firing instant).
 *    `rateLimitState` carries the per-session rolling-hour budget so the UI can
 *    show an accurate "N remaining" indicator without a round-trip.
 *  - `routing_decision`: emitted for every routing evaluation before fan-out.
 *  - `session_event`: a WAL frame (session lifecycle event such as
 *    `session_forked` or `child_forked`) emitted by the fork route so
 *    subscribers can observe fork lifecycle in real time.
 */
export type OwnerEvent =
  | { type: 'audit'; record: AuditRecord }
  | {
      type: 'idle_suggestions';
      sessionId: string;
      suggestions: string[];
      /** ISO-8601 expiry for client-side auto-dismiss (30 min from fire time). */
      expiresAt: string;
      /** Rolling-hour budget snapshot taken immediately after consuming a slot. */
      rateLimitState: IdleRateLimitState;
    }
  | RoutingDecisionEvent
  | {
      /** A WAL frame for a specific session (e.g. session_forked, child_forked). */
      type: 'session_event';
      sessionId: string;
      event: WalFrame;
    };

export type OwnerEventHandler = (event: OwnerEvent) => void;

/**
 * Hard cap on concurrent owner subscribers — defense-in-depth atop the OWNER
 * scope gate so a bug or a misbehaving owner client can't open unbounded streams.
 */
export const MAX_OWNER_SUBSCRIBERS = 32;

/**
 * A synchronous in-memory pub/sub for owner-level events. Internal to the gateway
 * app (never exposed). `publish` runs inside the audit log's never-throw write
 * chain, so it MUST be synchronous and MUST NOT let a subscriber's failure
 * propagate.
 */
export class OwnerEventBus {
  private readonly handlers = new Set<OwnerEventHandler>();

  /** Current subscriber count. */
  get size(): number {
    return this.handlers.size;
  }

  /**
   * Register a handler. Returns an unsubscribe function, or null when the bus is
   * already at {@link MAX_OWNER_SUBSCRIBERS} (the caller should 503).
   */
  subscribe(handler: OwnerEventHandler): (() => void) | null {
    if (this.handlers.size >= MAX_OWNER_SUBSCRIBERS) return null;
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Fan an event out to every subscriber synchronously. Each handler runs in its
   * own try/catch so a throwing subscriber can neither break the others nor the
   * publisher (which is the audit write chain).
   */
  publish(event: OwnerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A subscriber's failure must not affect the publisher or other subs.
      }
    }
  }
}
