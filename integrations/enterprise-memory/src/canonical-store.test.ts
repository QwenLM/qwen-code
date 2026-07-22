/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  PostgresCanonicalStore,
  type StoreContext,
} from './canonical-store.js';
import type { CanonicalMemoryRecord, ProviderBinding } from './domain.js';

const now = new Date('2026-07-22T00:00:00.000Z');
const memoryId = 'ea09a5be-4e32-48cb-b76d-d513492d9c82';
const context: StoreContext = {
  tenantId: 'tenant-a',
  principalId: 'principal-a',
  repositoryId: 'repository-a',
};

function record(
  scope: CanonicalMemoryRecord['scope'] = 'personal',
): CanonicalMemoryRecord {
  return {
    id: memoryId,
    tenantId: context.tenantId,
    scope,
    scopeId: scope === 'personal' ? context.principalId : context.repositoryId,
    protectedContent: { ciphertext: 'ciphertext', keyHandle: 'key-handle' },
    authority: 'model_proposal',
    lifecycleState: 'candidate',
    erasureState: 'live',
    version: 1,
    sourceOperationId: '8d39189f-cb3d-4a18-bd43-52f7bf9014e9',
    sourceFingerprint: 'fingerprint',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 1_000),
  };
}

function row(value: CanonicalMemoryRecord): Record<string, unknown> {
  return {
    id: value.id,
    tenant_id: value.tenantId,
    scope: value.scope,
    scope_id: value.scopeId,
    content_ciphertext: value.protectedContent.ciphertext,
    content_key_handle: value.protectedContent.keyHandle,
    authority: value.authority,
    lifecycle_state: value.lifecycleState,
    erasure_state: value.erasureState,
    version: value.version,
    source_operation_id: value.sourceOperationId,
    source_fingerprint: value.sourceFingerprint,
    created_at: value.createdAt,
    expires_at: value.expiresAt,
  };
}

function fixture(
  handle: (
    text: string,
    values: readonly unknown[] | undefined,
  ) => { rows?: Record<string, unknown>[]; rowCount?: number },
) {
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => ({
    rows: [],
    rowCount: 0,
    ...handle(text, values),
  }));
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { store: new PostgresCanonicalStore(pool), query };
}

describe('PostgresCanonicalStore security predicates', () => {
  it('checks current personal consent in candidate insertion SQL', async () => {
    const candidate = record();
    const { store, query } = fixture((text) => {
      if (text.includes('FOR SHARE')) {
        return { rows: [{ mode: 'read_write' }], rowCount: 1 };
      }
      if (text.includes('FROM memory_source_receipts')) {
        return {
          rows: [
            {
              canonical_memory_id: candidate.id,
              source_fingerprint: candidate.sourceFingerprint,
              state: 'live',
            },
          ],
          rowCount: 1,
        };
      }
      return text.includes('INSERT INTO memory_records')
        ? { rows: [row(candidate)], rowCount: 1 }
        : {};
    });

    await store.insertCandidate(
      { ...context, workspaceId: 'workspace-a', revocationEpoch: 0 },
      candidate,
    );

    const insertion = query.mock.calls.find(([text]) =>
      text.includes('INSERT INTO memory_records'),
    );
    expect(insertion?.[0]).toContain('personal_memory_preferences');
    expect(insertion?.[0]).toContain("p.mode = 'read_write'");
    const consentIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('FOR SHARE'),
    );
    const insertionIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('INSERT INTO memory_records'),
    );
    const receiptIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('INSERT INTO memory_source_receipts'),
    );
    expect(consentIndex).toBeGreaterThan(-1);
    expect(receiptIndex).toBeGreaterThan(consentIndex);
    expect(insertionIndex).toBeGreaterThan(consentIndex);
    expect(insertionIndex).toBeGreaterThan(receiptIndex);
  });

  it('reserves provider activation only after locking the candidate version', async () => {
    const candidate = record('repository');
    const expiresAt = new Date(now.getTime() + 60_000);
    const { store, query } = fixture((text) => {
      if (text.includes('FOR UPDATE')) {
        return { rows: [row(candidate)], rowCount: 1 };
      }
      if (text.includes('AS current')) {
        return { rows: [{ current: true }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO memory_activation_reservations')) {
        return { rowCount: 1 };
      }
      return {};
    });

    await store.reserveActivation(context, memoryId, 1, expiresAt);

    const lockIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('FOR UPDATE'),
    );
    const reservationIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('INSERT INTO memory_activation_reservations'),
    );
    expect(lockIndex).toBeGreaterThan(-1);
    expect(reservationIndex).toBeGreaterThan(lockIndex);
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('FROM memory_erasure_reservations'),
      ),
    ).toBe(true);
  });

  it('checks consent and the SCM lease at the activation statement', async () => {
    const active = {
      ...record('repository'),
      authority: 'maintainer_approved',
      lifecycleState: 'active' as const,
      version: 2,
    };
    const expiresAt = new Date(now.getTime() + 60_000);
    const binding: ProviderBinding = {
      tenantId: context.tenantId,
      canonicalMemoryId: memoryId,
      canonicalVersion: 2,
      providerMemoryId: 'provider-a',
      scope: 'repository',
      entityId: 'entity-a',
      state: 'active',
    };
    const { store, query } = fixture((text) => {
      if (text.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              tenant_id: active.tenantId,
              scope: active.scope,
              scope_id: active.scopeId,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('DELETE FROM memory_activation_reservations')) {
        return { rowCount: 1 };
      }
      return text.includes('UPDATE memory_records')
        ? { rows: [row(active)], rowCount: 1 }
        : {};
    });

    await store.activateWithProvider(
      context,
      memoryId,
      1,
      'maintainer_approved',
      binding,
      expiresAt,
    );

    const activation = query.mock.calls.find(([text]) =>
      text.includes('UPDATE memory_records'),
    );
    expect(activation?.[0]).toContain('clock_timestamp() < $4');
    expect(activation?.[0]).toContain('personal_memory_preferences');
    expect(activation?.[0]).toContain('memory_activation_reservations');
    expect(activation?.[1]?.[3]).toEqual(expiresAt);
  });

  it('clears the activation reservation when reusing a reconciled binding', async () => {
    const active = {
      ...record('repository'),
      authority: 'maintainer_approved',
      lifecycleState: 'active' as const,
      version: 2,
    };
    const binding: ProviderBinding = {
      tenantId: context.tenantId,
      canonicalMemoryId: memoryId,
      canonicalVersion: 2,
      providerMemoryId: 'provider-a',
      scope: 'repository',
      entityId: 'entity-a',
      state: 'active',
    };
    const { store, query } = fixture((text) => {
      if (text.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              tenant_id: active.tenantId,
              scope: active.scope,
              scope_id: active.scopeId,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('UPDATE memory_records')) {
        return { rows: [row(active)], rowCount: 1 };
      }
      if (text.includes('SELECT * FROM provider_bindings')) {
        return {
          rows: [
            {
              tenant_id: binding.tenantId,
              canonical_memory_id: binding.canonicalMemoryId,
              canonical_version: binding.canonicalVersion,
              provider_memory_id: binding.providerMemoryId,
              scope: binding.scope,
              entity_id: binding.entityId,
              state: binding.state,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('DELETE FROM memory_activation_reservations')) {
        return { rowCount: 1 };
      }
      return {};
    });

    await store.activateWithProvider(
      context,
      memoryId,
      1,
      'maintainer_approved',
      binding,
      new Date(now.getTime() + 60_000),
    );

    expect(
      query.mock.calls.some(([text]) =>
        text.includes('INSERT INTO provider_bindings'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('DELETE FROM memory_activation_reservations'),
      ),
    ).toBe(true);
  });

  it('does not activate personal memory after the locked preference is off', async () => {
    const candidate = record();
    const binding: ProviderBinding = {
      tenantId: context.tenantId,
      canonicalMemoryId: memoryId,
      canonicalVersion: 2,
      providerMemoryId: 'provider-a',
      scope: 'personal',
      entityId: 'entity-a',
      state: 'active',
    };
    const { store, query } = fixture((text) => {
      if (text.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              tenant_id: candidate.tenantId,
              scope: candidate.scope,
              scope_id: candidate.scopeId,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FOR SHARE')) {
        return { rows: [{ mode: 'off' }], rowCount: 1 };
      }
      return {};
    });

    await expect(
      store.activateWithProvider(
        context,
        memoryId,
        1,
        'user_confirmed',
        binding,
        null,
      ),
    ).rejects.toThrow('capture is disabled');
    expect(
      query.mock.calls.some(([text]) => text.includes('UPDATE memory_records')),
    ).toBe(false);
  });

  it('checks the SCM lease only after locking an erasure version', async () => {
    const active = {
      ...record('repository'),
      authority: 'maintainer_approved',
      lifecycleState: 'active' as const,
      version: 2,
    };
    const expiresAt = new Date(now.getTime() + 60_000);
    const { store, query } = fixture((text) => {
      if (text.includes('FOR UPDATE')) {
        return { rows: [row(active)], rowCount: 1 };
      }
      if (text.includes('AS current')) {
        return { rows: [{ current: true }], rowCount: 1 };
      }
      return {};
    });

    await store.reserveErasure(
      context,
      memoryId,
      2,
      'repository',
      'maintainer_request',
      now,
      expiresAt,
    );

    const lockIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('FOR UPDATE'),
    );
    const leaseIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('AS current'),
    );
    expect(lockIndex).toBeGreaterThan(-1);
    expect(leaseIndex).toBeGreaterThan(lockIndex);
    expect(query.mock.calls[leaseIndex]?.[1]?.[0]).toEqual(expiresAt);
  });

  it('does not reserve erasure while provider activation is in progress', async () => {
    const active = {
      ...record('repository'),
      authority: 'maintainer_approved',
      lifecycleState: 'active' as const,
      version: 2,
    };
    const { store, query } = fixture((text) => {
      if (text.includes('FOR UPDATE')) {
        return { rows: [row(active)], rowCount: 1 };
      }
      if (text.includes('AS current')) {
        return { rows: [{ current: true }], rowCount: 1 };
      }
      if (text.includes('FROM memory_activation_reservations')) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      return {};
    });

    await expect(
      store.reserveErasure(
        context,
        memoryId,
        active.version,
        'repository',
        'maintainer_request',
        now,
        new Date(now.getTime() + 60_000),
      ),
    ).rejects.toThrow('activation is in progress');
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('INSERT INTO memory_erasure_reservations'),
      ),
    ).toBe(false);
  });

  it('marks the source receipt erased before deleting canonical content', async () => {
    const { store, query } = fixture((text) => {
      if (text.includes('UPDATE memory_source_receipts')) {
        return {
          rows: [{ source_operation_id: record().sourceOperationId }],
          rowCount: 1,
        };
      }
      if (text.includes('DELETE FROM memory_records')) {
        return { rowCount: 1 };
      }
      return {};
    });

    await store.eraseContent(context, memoryId, 3);

    const receiptIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('UPDATE memory_source_receipts'),
    );
    const deletionIndex = query.mock.calls.findIndex(([text]) =>
      text.includes('DELETE FROM memory_records'),
    );
    expect(receiptIndex).toBeGreaterThan(-1);
    expect(deletionIndex).toBeGreaterThan(receiptIndex);
  });
});
