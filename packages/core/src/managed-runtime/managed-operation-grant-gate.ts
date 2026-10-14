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
import {
  assertManagedSessionKey,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionJsonValue,
  type ManagedSessionKey,
} from './managed-session-records.js';

interface GateEntry {
  /**
   * The latest grant installed. A revocation keeps it, so the next grant
   * still has to be its successor.
   */
  grant: OperationGrant | undefined;
  /** No revision at or below this one admits or installs again. */
  revokedThrough: number;
}

/**
 * A malformed key is refused rather than looked up, so a revocation can never
 * miss the grant it names.
 */
function gateKey(sessionKey: ManagedSessionKey, operationId: string): string {
  const key = assertManagedSessionKey(
    sessionKey as unknown as ManagedSessionJsonValue,
  );
  const id = assertManagedSessionStableId(operationId, 'operationId');
  return `${key.tenantId}\0${key.workspaceId}\0${key.sessionId}\0${id}`;
}

/**
 * The Runtime's per-operation gate. It holds the one OperationGrant an
 * operation may act under: installing the same grant again is idempotent, a
 * renewal or a later revision replaces it, and anything older is refused. A
 * revoked revision never reopens, and the grant it revoked still bounds the
 * next one, so a revocation cannot let an older Workspace generation back in.
 * The gate lives in the Runtime's memory: a restarted Runtime starts with none,
 * and an entry stays until the process ends.
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
    // Both sides of the gate agree on the ceiling: a revocation parked
    // above every representable revision could never be overtaken.
    assertManagedSessionSequence(operationRevision, 'operationRevision');
    if (operationRevision < 1) {
      throw new ManagedSessionRecordError(
        'operationRevision must be a positive safe integer.',
      );
    }
    const entry = this.entries.get(key) ?? {
      grant: undefined,
      revokedThrough: 0,
    };
    entry.revokedThrough = Math.max(entry.revokedThrough, operationRevision);
    this.entries.set(key, entry);
  }

  /** Whether the installed grant admits `phase` of the operation at `now`. */
  admits(
    sessionKey: ManagedSessionKey,
    operationId: string,
    phase: string,
    now: number,
  ): boolean {
    const entry = this.entries.get(gateKey(sessionKey, operationId));
    if (entry?.grant === undefined) return false;
    const { grant } = entry;
    return (
      grant.operationRevision > entry.revokedThrough &&
      now < grant.expiresAt &&
      grant.resourceScope.phases.includes(phase)
    );
  }
}
