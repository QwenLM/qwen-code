/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isOperationGrantSuccessor,
  parseOperationGrant,
  type OperationGrant,
} from './managed-extension-record.js';
import { ManagedSessionConflictError } from './managed-session-authority.js';
import type { ManagedSessionKey } from './managed-session-records.js';

interface GateEntry {
  grant: OperationGrant | undefined;
  /** No revision at or below this one may be installed again. */
  revokedThrough: number;
}

function gateKey(sessionKey: ManagedSessionKey, operationId: string): string {
  return `${sessionKey.tenantId}\0${sessionKey.workspaceId}\0${sessionKey.sessionId}\0${operationId}`;
}

/**
 * The Runtime's per-operation gate. It holds the one OperationGrant an
 * operation may act under: installing the same grant again is idempotent, a
 * renewal or a later revision replaces it, and anything older is refused. A
 * revoked revision never reopens, so the next revision closes the old
 * admission before its phases can run again.
 */
export class ManagedOperationGrantGate {
  private readonly entries = new Map<string, GateEntry>();

  install(value: unknown): 'installed' | 'unchanged' {
    const grant = parseOperationGrant(value);
    const key = gateKey(grant.sessionKey, grant.operationId);
    const entry = this.entries.get(key);
    if (
      entry !== undefined &&
      grant.operationRevision <= entry.revokedThrough
    ) {
      throw new ManagedSessionConflictError(
        `operation ${grant.operationId} revision ${grant.operationRevision} was revoked.`,
      );
    }
    const current = entry?.grant;
    if (current !== undefined) {
      if (JSON.stringify(current) === JSON.stringify(grant)) {
        return 'unchanged';
      }
      if (!isOperationGrantSuccessor(current, grant)) {
        throw new ManagedSessionConflictError(
          `grant revision ${grant.operationRevision} of operation ${grant.operationId} cannot replace revision ${current.operationRevision}.`,
        );
      }
    }
    this.entries.set(key, {
      grant,
      revokedThrough: entry?.revokedThrough ?? 0,
    });
    return 'installed';
  }

  revoke(
    sessionKey: ManagedSessionKey,
    operationId: string,
    operationRevision: number,
  ): void {
    const key = gateKey(sessionKey, operationId);
    const entry = this.entries.get(key) ?? {
      grant: undefined,
      revokedThrough: 0,
    };
    entry.revokedThrough = Math.max(entry.revokedThrough, operationRevision);
    if (
      entry.grant !== undefined &&
      entry.grant.operationRevision <= entry.revokedThrough
    ) {
      entry.grant = undefined;
    }
    this.entries.set(key, entry);
  }

  /** Whether the installed grant admits `phase` of the operation at `now`. */
  admits(
    sessionKey: ManagedSessionKey,
    operationId: string,
    phase: string,
    now: number,
  ): boolean {
    const grant = this.entries.get(gateKey(sessionKey, operationId))?.grant;
    return (
      grant !== undefined &&
      now < grant.expiresAt &&
      grant.resourceScope.phases.includes(phase)
    );
  }
}
