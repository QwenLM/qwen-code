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

/** The four workflow lifecycle SSE event types (wire-protocol registry rows). */
export type WorkflowLifecycleEventType =
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'workflow_cancelled';

/** Payload of a workflow lifecycle frame (design: `{ runId, name, scriptHash,
 * status, agentCount, tokensSpent }`). Never carries the script source. */
export interface WorkflowEventPayload {
  runId: string;
  name: string;
  scriptHash: string;
  status: string;
  agentCount: number;
  tokensSpent: number;
}

/** The five lifecycle SSE event types (wire-protocol SSE registry rows). */
export type AgentLifecycleEventType =
  | 'agent_spawned'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_blocked'
  | 'agent_cancelled';

/**
 * Payload of an agent lifecycle frame on the OWNER events stream (design:
 * `{ agentId, sessionId, parentSessionId, agentType, status,
 * costMicrocents? }`). `task` is deliberately OPTIONAL and — per the
 * metadata-only invariant this type enforces for `/rc/events` — the owner
 * stream never actually sets it; the parent session's own stream (which
 * already knows the task it spawned with) and the notification pipeline
 * carry the full record separately as untyped `data`, outside this
 * interface (see agentLifecycle.ts's `emit`).
 */
export interface AgentLifecyclePayload {
  agentId: string;
  sessionId: string;
  parentSessionId: string | null;
  agentType: string;
  task?: string;
  status: string;
  costMicrocents?: number;
}

/** The four review lifecycle SSE event types (wire-protocol registry rows). */
export type ReviewLifecycleEventType =
  | 'review_started'
  | 'review_completed'
  | 'review_failed'
  | 'review_cancelled';

/**
 * Payload of a review lifecycle frame (design: `{ reviewId, sessionId, target,
 * status, reportPath?, summary? }`). On the OWNER events stream, `target`'s
 * `path` branch is reduced to `{ kind: 'path' }` — a `path` target's raw
 * filesystem path is caller-supplied and, mirroring
 * `webpush/payload.ts`'s review branch, must never leave the daemon that ran
 * the review (see `sanitizeReviewTarget` in reviewRegistry.ts, used by
 * reviewLifecycle.ts's `emit` and routes/review.ts's audit record). `path` is
 * therefore optional here so both the full record (still used for the
 * notification pipeline's `data`) and the sanitized owner-stream view satisfy
 * this one type.
 */
export interface ReviewLifecyclePayload {
  reviewId: string;
  sessionId: string;
  target:
    | { kind: 'pr'; number: number }
    | { kind: 'path'; path?: string }
    | { kind: 'local' };
  status: string;
  reportPath?: string | null;
  summary?: { findingsCount?: number; verdict?: string } | null;
}

/**
 * Payload of an `approval_mode_changed` frame, emitted when a session's
 * approval mode is set via the remote-control route and forwarded from the
 * daemon's own `approval_mode_changed` event (add-remote-approval-mode).
 */
export interface ApprovalModePayload {
  sessionId: string;
  previous: string;
  next: string;
  persisted: boolean;
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
 *  - `review_*`: review lifecycle frames (add-remote-review) emitted as a
 *    tagged daemon session runs the `/review` skill against a PR, path, or
 *    the local working tree.
 *  - `approval_mode_changed`: a session's approval mode was set (mirrors the
 *    daemon's own `approval_mode_changed` event; add-remote-approval-mode).
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
    }
  | {
      /** Agent lifecycle frame (add-agent-observability). */
      type: AgentLifecycleEventType;
      agent: AgentLifecyclePayload;
    }
  | {
      /** Review lifecycle frame (add-remote-review). */
      type: ReviewLifecycleEventType;
      review: ReviewLifecyclePayload;
    }
  | {
      /** Approval-mode change frame (add-remote-approval-mode). */
      type: 'approval_mode_changed';
      mode: ApprovalModePayload;
    }
  | {
      /**
       * Read-only mirror of a local hook firing (POST /rc/hooks/ingest).
       * OWNER stream only — hook payloads carry tool arguments. `dropped`
       * surfaces how many frames the ingest rate limiter dropped since the
       * previously mirrored frame.
       */
      type: 'hook_event';
      event: string;
      sessionId?: string;
      toolName?: string;
      payload: unknown;
      dropped?: number;
    }
  | {
      /** Workflow lifecycle frame (add-workflow-orchestration). */
      type: WorkflowLifecycleEventType;
      workflow: WorkflowEventPayload;
    }
  | {
      /** The running workflow called `phase(title)`. Owner stream only. */
      type: 'workflow_phase';
      runId: string;
      phase: string;
      phaseIndex?: number;
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
