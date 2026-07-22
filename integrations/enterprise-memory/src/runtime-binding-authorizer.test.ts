/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentity } from './domain.js';
import {
  PostgresRuntimeBindingAuthorizer,
  RuntimeAuthorizationError,
} from './runtime-binding-authorizer.js';

const identity: RuntimeIdentity = {
  tenantId: 'tenant-a',
  principalId: 'principal-a',
  workspaceId: 'workspace-a',
  repositoryId: 'repository-a',
  revocationEpoch: 7,
};

function poolWithQuery(query: ReturnType<typeof vi.fn>): {
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return {
    pool: {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool,
    release,
  };
}

describe('PostgresRuntimeBindingAuthorizer', () => {
  it('authorizes the exact active binding inside a transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const { pool, release } = poolWithQuery(query);
    const now = new Date('2026-07-22T00:00:00.000Z');

    await new PostgresRuntimeBindingAuthorizer(pool, () => now).authorize(
      identity,
    );

    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('WHERE tenant_id = $1'),
      ['tenant-a', 'principal-a', 'workspace-a', 'repository-a', 7, now],
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('fails closed and releases the connection for a missing binding', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({});
    const { pool, release } = poolWithQuery(query);

    await expect(
      new PostgresRuntimeBindingAuthorizer(pool).authorize(identity),
    ).rejects.toBeInstanceOf(RuntimeAuthorizationError);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves an authorization failure when rollback also fails', async () => {
    const authorizationError = new Error('query failed');
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') {
        throw new Error('rollback failed');
      }
      if (sql.includes('FROM workspace_bindings')) {
        throw authorizationError;
      }
      return {};
    });
    const { pool, release } = poolWithQuery(query);

    await expect(
      new PostgresRuntimeBindingAuthorizer(pool).authorize(identity),
    ).rejects.toBe(authorizationError);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
