/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

export const DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS = 30_000;
export const MAX_AGENT_VIEW_ATTACH_LEASE_TTL_MS = 3_600_000;

export interface AgentViewAttachLease {
  sessionId: string;
  leaseId: string;
  clientId?: string;
  acquiredAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
}

export type AgentViewAttachLeaseConflict = Omit<
  AgentViewAttachLease,
  'leaseId'
>;

export type AgentViewAttachLeaseAcquireResult =
  | { ok: true; lease: AgentViewAttachLease }
  | {
      ok: false;
      reason: 'already_attached';
      lease: AgentViewAttachLeaseConflict;
    };

export interface AgentViewAttachLeaseAcquireOptions {
  clientId?: string;
  leaseId?: string;
  ttlMs?: number;
}

export interface AgentViewAttachLeaseHeartbeatOptions {
  ttlMs?: number;
}

export interface AgentViewAttachLeaseManagerOptions {
  defaultTtlMs?: number;
  now?: () => Date;
  createLeaseId?: () => string;
}

export class AgentViewAttachLeaseManager {
  private readonly leases = new Map<string, AgentViewAttachLease>();
  private readonly defaultTtlMs: number;
  private readonly now: () => Date;
  private readonly createLeaseId: () => string;

  constructor(options: AgentViewAttachLeaseManagerOptions = {}) {
    this.defaultTtlMs =
      options.defaultTtlMs ?? DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.createLeaseId = options.createLeaseId ?? randomUUID;
  }

  acquire(
    sessionId: string,
    options: AgentViewAttachLeaseAcquireOptions = {},
  ): AgentViewAttachLeaseAcquireResult {
    this.requireSessionId(sessionId);
    this.expire();

    const existing = this.leases.get(sessionId);
    if (existing) {
      return {
        ok: false,
        reason: 'already_attached',
        lease: redactLeaseId(existing),
      };
    }

    const acquiredAt = this.now();
    const lease: AgentViewAttachLease = {
      sessionId,
      leaseId: options.leaseId || this.createLeaseId(),
      ...(options.clientId ? { clientId: options.clientId } : {}),
      acquiredAt: acquiredAt.toISOString(),
      lastHeartbeatAt: acquiredAt.toISOString(),
      expiresAt: this.expiresAt(acquiredAt, options.ttlMs).toISOString(),
    };
    this.leases.set(sessionId, lease);
    return { ok: true, lease };
  }

  heartbeat(
    sessionId: string,
    leaseId: string,
    options: AgentViewAttachLeaseHeartbeatOptions = {},
  ): AgentViewAttachLease | undefined {
    this.requireSessionId(sessionId);
    this.expire();

    const lease = this.leases.get(sessionId);
    if (!lease || lease.leaseId !== leaseId) {
      return undefined;
    }

    const now = this.now();
    const next: AgentViewAttachLease = {
      ...lease,
      lastHeartbeatAt: now.toISOString(),
      expiresAt: this.expiresAt(now, options.ttlMs).toISOString(),
    };
    this.leases.set(sessionId, next);
    return next;
  }

  release(sessionId: string, leaseId: string): boolean {
    this.requireSessionId(sessionId);
    this.expire();

    const lease = this.leases.get(sessionId);
    if (!lease || lease.leaseId !== leaseId) {
      return false;
    }
    this.leases.delete(sessionId);
    return true;
  }

  expire(): AgentViewAttachLease[] {
    const nowMs = this.now().getTime();
    const expired: AgentViewAttachLease[] = [];

    for (const [sessionId, lease] of this.leases) {
      const expiresAtMs = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        this.leases.delete(sessionId);
        expired.push(lease);
      }
    }

    return expired;
  }

  get(sessionId: string): AgentViewAttachLease | undefined {
    this.requireSessionId(sessionId);
    this.expire();
    return this.leases.get(sessionId);
  }

  private expiresAt(now: Date, ttlMs: number | undefined): Date {
    const resolvedTtlMs = ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(resolvedTtlMs) || resolvedTtlMs <= 0) {
      throw new RangeError('Attach lease ttlMs must be positive.');
    }
    if (resolvedTtlMs > MAX_AGENT_VIEW_ATTACH_LEASE_TTL_MS) {
      throw new RangeError(
        `Attach lease ttlMs must not exceed ${MAX_AGENT_VIEW_ATTACH_LEASE_TTL_MS}.`,
      );
    }
    return new Date(now.getTime() + resolvedTtlMs);
  }

  private requireSessionId(sessionId: string): void {
    if (sessionId.length === 0) {
      throw new Error('Agent View session id is required.');
    }
  }
}

function redactLeaseId(
  lease: AgentViewAttachLease,
): AgentViewAttachLeaseConflict {
  return {
    sessionId: lease.sessionId,
    ...(lease.clientId ? { clientId: lease.clientId } : {}),
    acquiredAt: lease.acquiredAt,
    lastHeartbeatAt: lease.lastHeartbeatAt,
    expiresAt: lease.expiresAt,
  };
}
