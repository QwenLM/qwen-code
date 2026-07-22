/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { InMemoryCapabilityReplayStore } from './capability-replay-store.js';
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
    capabilityExpiresAt: new Date('2026-07-22T00:01:00.000Z'),
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
