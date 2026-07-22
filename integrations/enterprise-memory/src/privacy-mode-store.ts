/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pool, PoolClient } from 'pg';
import type {
  PersonalMemoryMode,
  PrivacyIdentity,
  PrivacyModeResolver,
} from './memory-service.js';

export interface PersonalPreferenceIdentity {
  tenantId: string;
  principalId: string;
}

export interface PersonalMemoryPreferenceStore extends PrivacyModeResolver {
  setPersonalMode(
    identity: PersonalPreferenceIdentity,
    mode: PersonalMemoryMode,
  ): Promise<void>;
}

export class PostgresPersonalMemoryPreferenceStore
  implements PersonalMemoryPreferenceStore
{
  constructor(private readonly pool: Pool) {}

  async getPersonalMode(
    identity: PrivacyIdentity,
  ): Promise<PersonalMemoryMode> {
    return this.transaction(identity, async (client) => {
      const result = await client.query<{ mode: PersonalMemoryMode }>(
        `SELECT mode FROM personal_memory_preferences
          WHERE tenant_id = $1 AND principal_id = $2`,
        [identity.tenantId, identity.principalId],
      );
      return result.rows[0]?.mode ?? 'off';
    });
  }

  async setPersonalMode(
    identity: PersonalPreferenceIdentity,
    mode: PersonalMemoryMode,
  ): Promise<void> {
    await this.transaction(identity, async (client) => {
      await client.query(
        `INSERT INTO personal_memory_preferences (
           tenant_id, principal_id, mode, updated_at
         ) VALUES ($1,$2,$3,clock_timestamp())
         ON CONFLICT (tenant_id, principal_id)
         DO UPDATE SET mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at`,
        [identity.tenantId, identity.principalId, mode],
      );
    });
  }

  private async transaction<T>(
    identity: PersonalPreferenceIdentity,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.principal_id', $2, true),
                set_config('app.repository_id', '', true)`,
        [identity.tenantId, identity.principalId],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
