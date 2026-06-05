/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission audit ring.
 *
 * Writes 5 record types (`permission.requested` / `permission.voted` /
 * `permission.forbidden` / `permission.resolved` / `permission.timeout`)
 * to an in-memory bounded FIFO ring buffer on the bridge — oldest
 * record evicts on overflow regardless of access pattern. NOT
 * routed onto the per-session SSE bus — audit and wire events are
 * intentionally separate channels per the F3 plan.
 *
 * v1 does not expose a `GET /workspace/permission/audit` route — the
 * ring is held inside `createHttpAcpBridge`'s closure for future query
 * infrastructure. This file provides the writer; the bridge factory
 * constructs the ring (only when `BridgeOptions.permissionAudit` is
 * omitted; a host-supplied publisher takes the ring's place) and
 * wires it to the publisher. The ring is NOT exposed on the
 * `HttpAcpBridge` interface today — a follow-up PR adding
 * `GET /workspace/permission/audit` will need to surface it via a new
 * accessor or pass it through `BridgeOptions`.
 *
 * Contract: every `record*` method MAY throw (the underlying ring is
 * synchronous and resilient by design, but the mediator's `safeAudit`
 * wrapper guarantees throws never block Promise settle).
 */

import type {
  PermissionAuditPublisher,
  PermissionDecisionReason,
} from '@qwen-code/acp-bridge';
import type {
  PermissionPolicy,
  PermissionRequestRecord,
  PermissionResolution,
  PermissionVote,
  PermissionVoteOutcome,
} from '@qwen-code/acp-bridge/permission';

/**
 * Default capacity of the audit ring. Mirrors the pre-F3
 * `MAX_RESOLVED_PERMISSION_RECORDS` (512); each row is small (≤1KB
 * with field names + UUID + decision reason) so 512 entries stays
 * well under 100 KB. Operators can override at construction time.
 */
export const DEFAULT_PERMISSION_AUDIT_RING_SIZE = 512;

/**
 * Common shape for every audit row. The discriminator `kind` mirrors
 * the publisher method names; consumers `switch` on it to project
 * onto a per-row payload.
 */
export type PermissionAuditEntry =
  | {
      readonly kind: 'permission.requested';
      readonly recordedAtMs: number;
      readonly requestId: string;
      readonly sessionId: string;
      readonly originatorClientId: string | undefined;
      readonly policy: PermissionPolicy;
      readonly votersAtIssue: readonly string[];
      readonly issuedAtMs: number;
      readonly allowedOptionIds: readonly string[];
    }
  | {
      readonly kind: 'permission.voted';
      readonly recordedAtMs: number;
      readonly requestId: string;
      readonly sessionId: string;
      readonly clientId: string | undefined;
      readonly optionId: string;
      readonly fromLoopback: boolean;
      readonly receivedAtMs: number;
      readonly outcome: PermissionVoteOutcome;
    }
  | {
      readonly kind: 'permission.forbidden';
      readonly recordedAtMs: number;
      readonly requestId: string;
      readonly sessionId: string;
      readonly clientId: string | undefined;
      readonly optionId: string;
      readonly fromLoopback: boolean;
      readonly reason: 'designated_mismatch' | 'remote_not_allowed';
    }
  | {
      readonly kind: 'permission.resolved';
      readonly recordedAtMs: number;
      readonly requestId: string;
      readonly sessionId: string;
      readonly resolution: PermissionResolution;
      readonly decisionReason: PermissionDecisionReason;
    }
  | {
      readonly kind: 'permission.timeout';
      readonly recordedAtMs: number;
      readonly requestId: string;
      readonly sessionId: string;
      readonly issuedAtMs: number;
    };

function takeLast<T>(
  arr: readonly T[],
  limit: number | undefined,
  methodName: string,
): readonly T[] {
  if (limit === undefined) return arr.slice();
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `${methodName} limit must be a non-negative integer; got ${String(limit)}`,
    );
  }
  return arr.slice(Math.max(0, arr.length - limit));
}

/**
 * Bounded ring buffer for permission audit entries. Operates as a
 * FIFO: when the ring is full, the oldest entry is evicted to make
 * room for the newest. Two consumers:
 *   1. `PermissionAuditPublisher` writes via `push()`.
 *   2. (future) `GET /workspace/permission/audit` reads via
 *      `snapshot(limit?)` / `snapshotForSession(sessionId, limit?)`.
 */
export class PermissionAuditRing {
  private readonly buf: PermissionAuditEntry[] = [];
  private readonly cap: number;

  constructor(capacity: number = DEFAULT_PERMISSION_AUDIT_RING_SIZE) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `PermissionAuditRing capacity must be a positive integer; got ${String(capacity)}`,
      );
    }
    this.cap = capacity;
  }

  push(entry: PermissionAuditEntry): void {
    this.buf.push(entry);
    while (this.buf.length > this.cap) this.buf.shift();
  }

  /** Snapshot the most-recent `limit` entries (or all if omitted). */
  snapshot(limit?: number): readonly PermissionAuditEntry[] {
    return takeLast(this.buf, limit, 'PermissionAuditRing.snapshot');
  }

  /** Subset filtered by sessionId. */
  snapshotForSession(
    sessionId: string,
    limit?: number,
  ): readonly PermissionAuditEntry[] {
    return takeLast(
      this.buf.filter((e) => e.sessionId === sessionId),
      limit,
      'PermissionAuditRing.snapshotForSession',
    );
  }

  /** Current entry count (≤ capacity). For diagnostics. */
  get size(): number {
    return this.buf.length;
  }

  /** Configured capacity. */
  get capacity(): number {
    return this.cap;
  }
}

/**
 * Build a `PermissionAuditPublisher` whose 5 `record*` methods push
 * a typed `PermissionAuditEntry` into the supplied ring.
 *
 * Modeled on `createAuditPublisher` in
 * `packages/cli/src/serve/fs/audit.ts:237` — same DI shape (single
 * deps object), same Omit-hidden internal fields synthesis, but
 * writes to a ring rather than the SSE bus.
 *
 * The optional `now` allows tests to inject a deterministic
 * wallclock; production passes `() => Date.now()`.
 */
export function createPermissionAuditPublisher(deps: {
  ring: PermissionAuditRing;
  now?: () => number;
}): PermissionAuditPublisher {
  const { ring } = deps;
  const now = deps.now ?? (() => Date.now());
  return {
    recordRequested(
      record: PermissionRequestRecord,
      policy: PermissionPolicy,
      votersAtIssue: ReadonlySet<string>,
    ): void {
      ring.push({
        kind: 'permission.requested',
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        originatorClientId: record.originatorClientId,
        policy,
        votersAtIssue: Array.from(votersAtIssue),
        issuedAtMs: record.issuedAtMs,
        allowedOptionIds: Array.from(record.allowedOptionIds),
      });
    },
    recordVoted(
      record: PermissionRequestRecord,
      vote: PermissionVote,
      outcome: PermissionVoteOutcome,
    ): void {
      ring.push({
        kind: 'permission.voted',
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        clientId: vote.clientId,
        optionId: vote.optionId,
        fromLoopback: vote.fromLoopback,
        receivedAtMs: vote.receivedAtMs,
        outcome,
      });
    },
    recordForbidden(
      record: PermissionRequestRecord,
      vote: PermissionVote,
      reason: 'designated_mismatch' | 'remote_not_allowed',
    ): void {
      ring.push({
        kind: 'permission.forbidden',
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        clientId: vote.clientId,
        optionId: vote.optionId,
        fromLoopback: vote.fromLoopback,
        reason,
      });
    },
    recordResolved(
      record: PermissionRequestRecord,
      resolution: PermissionResolution,
      decisionReason: PermissionDecisionReason,
    ): void {
      ring.push({
        kind: 'permission.resolved',
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        resolution,
        decisionReason,
      });
    },
    recordTimeout(record: PermissionRequestRecord): void {
      ring.push({
        kind: 'permission.timeout',
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        issuedAtMs: record.issuedAtMs,
      });
    },
  };
}
