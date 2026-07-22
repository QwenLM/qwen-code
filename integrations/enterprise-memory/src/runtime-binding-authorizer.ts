/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pool } from 'pg';
import type { RuntimeIdentity } from './domain.js';

export interface RuntimeBindingAuthorizer {
  authorize(identity: RuntimeIdentity): Promise<void>;
}

export class RuntimeAuthorizationError extends Error {}

export class PostgresRuntimeBindingAuthorizer
  implements RuntimeBindingAuthorizer
{
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorize(identity: RuntimeIdentity): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.principal_id', $2, true),
                set_config('app.repository_id', $3, true)`,
        [identity.tenantId, identity.principalId, identity.repositoryId],
      );
      const result = await client.query(
        `SELECT 1
           FROM workspace_bindings
          WHERE tenant_id = $1
            AND principal_id = $2
            AND workspace_id = $3
            AND repository_id = $4
            AND revocation_epoch = $5
            AND authz_expires_at >= $6
            AND state = 'active'`,
        [
          identity.tenantId,
          identity.principalId,
          identity.workspaceId,
          identity.repositoryId,
          identity.revocationEpoch,
          this.now(),
        ],
      );
      if (result.rowCount !== 1) {
        throw new RuntimeAuthorizationError(
          'Runtime binding is not currently authorized',
        );
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
