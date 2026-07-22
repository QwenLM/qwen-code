/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryCapabilityReplayStore,
  PostgresCapabilityReplayStore,
} from './capability-replay-store.js';
import type { VerifiedRuntimeIdentity } from './security/capability-verifier.js';

function identity(
  overrides: Partial<VerifiedRuntimeIdentity> = {},
): VerifiedRuntimeIdentity {
  return {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    workspaceId: 'workspace-a',
    repositoryId: 'repository-a',
    revocationEpoch: 0,
    capabilityId: 'capability-a',
    capabilityFingerprint: 'fingerprint-a',
    replayExpiresAt: new Date('2026-07-22T00:01:05.000Z'),
    requestBinding: 'binding-a',
    ...overrides,
  };
}

describe('InMemoryCapabilityReplayStore', () => {
  it('allows an exact retry and rejects conflicting reuse inside a tenant', async () => {
    const store = new InMemoryCapabilityReplayStore();
    await store.record(identity());
    await expect(store.record(identity())).resolves.toBeUndefined();
    await expect(
      store.record(identity({ requestBinding: 'binding-b' })),
    ).rejects.toThrow('binding conflict');
    await expect(
      store.record(identity({ capabilityFingerprint: 'fingerprint-b' })),
    ).rejects.toThrow('binding conflict');
  });

  it('keeps identical capability IDs tenant scoped', async () => {
    const store = new InMemoryCapabilityReplayStore();
    await store.record(identity());
    await expect(
      store.record(
        identity({
          tenantId: 'tenant-b',
          principalId: 'principal-b',
          requestBinding: 'binding-b',
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('PostgresCapabilityReplayStore', () => {
  it('reads the replay binding inside the tenant boundary', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          principal_id: 'principal-a',
          capability_fingerprint: 'fingerprint-a',
          request_binding: 'binding-a',
          expires_at: new Date('2026-07-22T00:01:05.000Z'),
        },
      ],
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    await new PostgresCapabilityReplayStore(pool).record(identity());

    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('WHERE tenant_id = $1'),
      ['tenant-a', 'capability-a'],
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves the operation failure when rollback also fails', async () => {
    const operationError = new Error('insert failed');
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') {
        throw new Error('rollback failed');
      }
      if (sql.includes('INSERT INTO')) {
        throw operationError;
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    await expect(
      new PostgresCapabilityReplayStore(pool).record(identity()),
    ).rejects.toBe(operationError);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
