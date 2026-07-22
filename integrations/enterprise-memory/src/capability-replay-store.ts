/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pool } from 'pg';
import type { VerifiedRuntimeIdentity } from './security/capability-verifier.js';

export interface CapabilityReplayStore {
  record(identity: VerifiedRuntimeIdentity): Promise<void>;
}

export class CapabilityReplayError extends Error {}

export class InMemoryCapabilityReplayStore implements CapabilityReplayStore {
  private readonly bindings = new Map<
    string,
    {
      principalId: string;
      capabilityFingerprint: string;
      requestBinding: string;
      expiresAt: number;
    }
  >();

  async record(identity: VerifiedRuntimeIdentity): Promise<void> {
    const key = JSON.stringify([identity.tenantId, identity.capabilityId]);
    const existing = this.bindings.get(key);
    const expected = {
      principalId: identity.principalId,
      capabilityFingerprint: identity.capabilityFingerprint,
      requestBinding: identity.requestBinding,
      expiresAt: identity.replayExpiresAt.getTime(),
    };
    if (existing && !sameBinding(existing, expected)) {
      throw new CapabilityReplayError('Capability ID binding conflict');
    }
    this.bindings.set(key, expected);
  }
}

export class PostgresCapabilityReplayStore implements CapabilityReplayStore {
  constructor(private readonly pool: Pool) {}

  async record(identity: VerifiedRuntimeIdentity): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.principal_id', $2, true),
                set_config('app.repository_id', $3, true)`,
        [identity.tenantId, identity.principalId, identity.repositoryId],
      );
      await client.query(
        `INSERT INTO runtime_capability_replays (
           tenant_id, capability_id, principal_id, capability_fingerprint,
           request_binding, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, capability_id) DO NOTHING`,
        [
          identity.tenantId,
          identity.capabilityId,
          identity.principalId,
          identity.capabilityFingerprint,
          identity.requestBinding,
          identity.replayExpiresAt,
        ],
      );
      const result = await client.query<{
        principal_id: string;
        capability_fingerprint: string;
        request_binding: string;
        expires_at: Date;
      }>(
        `SELECT principal_id, capability_fingerprint, request_binding, expires_at
           FROM runtime_capability_replays
          WHERE capability_id = $1`,
        [identity.capabilityId],
      );
      const existing = result.rows[0];
      if (
        !existing ||
        existing.principal_id !== identity.principalId ||
        existing.capability_fingerprint !== identity.capabilityFingerprint ||
        existing.request_binding !== identity.requestBinding ||
        existing.expires_at.getTime() !== identity.replayExpiresAt.getTime()
      ) {
        throw new CapabilityReplayError('Capability ID binding conflict');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function sameBinding(
  left: {
    principalId: string;
    capabilityFingerprint: string;
    requestBinding: string;
    expiresAt: number;
  },
  right: {
    principalId: string;
    capabilityFingerprint: string;
    requestBinding: string;
    expiresAt: number;
  },
): boolean {
  return (
    left.principalId === right.principalId &&
    left.capabilityFingerprint === right.capabilityFingerprint &&
    left.requestBinding === right.requestBinding &&
    left.expiresAt === right.expiresAt
  );
}
