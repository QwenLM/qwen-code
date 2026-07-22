/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryAntiResurrectionLedger,
  LedgerKeyFactory,
} from './anti-resurrection-ledger.js';
import {
  InMemoryCanonicalStore,
  type StoreContext,
} from './canonical-store.js';
import { InMemoryContentProtector } from './content-protector.js';
import type {
  ProviderBinding,
  ProviderSearchResult,
  RuntimeIdentity,
} from './domain.js';
import {
  MemoryService,
  type ManagementIdentity,
  StaticPolicyResolver,
  StaticPrivacyModeResolver,
} from './memory-service.js';
import {
  EntityIdMapper,
  FakeSemanticIndex,
  type SemanticIndex,
} from './semantic-index.js';

const now = new Date('2026-07-22T00:00:00.000Z');

function identity(
  tenantId = 'tenant-a',
  principalId = 'principal-a',
  repositoryId = 'repository-a',
): RuntimeIdentity {
  return {
    tenantId,
    principalId,
    workspaceId: `workspace-${tenantId}-${principalId}-${repositoryId}`,
    repositoryId,
    revocationEpoch: 0,
  };
}

function manager(
  runtime: RuntimeIdentity,
  authority: ManagementIdentity['authority'],
): ManagementIdentity {
  return {
    tenantId: runtime.tenantId,
    principalId: runtime.principalId,
    repositoryId: runtime.repositoryId,
    authority,
  };
}

function fixture(
  store = new InMemoryCanonicalStore(),
  index: SemanticIndex = new FakeSemanticIndex(),
  ledger = new InMemoryAntiResurrectionLedger(
    new LedgerKeyFactory(randomBytes(32)),
  ),
  rawCaptureEnabled = false,
) {
  const privacy = new StaticPrivacyModeResolver();
  const protector = new InMemoryContentProtector();
  const service = new MemoryService(
    store,
    ledger,
    protector,
    index,
    new EntityIdMapper(randomBytes(32), 'v1'),
    privacy,
    new StaticPolicyResolver(),
    {
      idempotencySecret: randomBytes(32),
      now: () => now,
      searchThreshold: 0,
      rawCaptureEnabled,
    },
  );
  return { service, store, index, privacy, ledger, protector };
}

describe('MemoryService', () => {
  it('defaults personal memory to off and requires explicit read-write consent to capture', async () => {
    const runtime = identity();
    const { service, privacy } = fixture();

    await expect(
      service.propose(
        runtime,
        { scope: 'personal', summary: 'Use pnpm', references: [] },
        randomUUID(),
      ),
    ).rejects.toThrow('disabled');

    privacy.set(runtime.tenantId, runtime.principalId, 'read_write');
    const candidate = await service.propose(
      runtime,
      { scope: 'personal', summary: 'Use pnpm', references: [] },
      randomUUID(),
    );
    expect(candidate.lifecycleState).toBe('candidate');
  });

  it('applies current personal consent to approval, search, and exact reads', async () => {
    const runtime = identity();
    const { service, privacy } = fixture();
    privacy.set(runtime.tenantId, runtime.principalId, 'read_write');
    const candidate = await service.propose(
      runtime,
      { scope: 'personal', summary: 'Prefer concise output', references: [] },
      randomUUID(),
    );
    const subject = manager(runtime, 'data_subject');
    privacy.set(runtime.tenantId, runtime.principalId, 'off');
    await expect(
      service.approveCandidate(subject, candidate.id, candidate.version),
    ).rejects.toThrow('disabled');

    privacy.set(runtime.tenantId, runtime.principalId, 'read_write');
    const active = await service.approveCandidate(
      subject,
      candidate.id,
      candidate.version,
    );
    await expect(service.get(runtime, active.id)).resolves.toMatchObject({
      id: active.id,
    });

    privacy.set(runtime.tenantId, runtime.principalId, 'off');
    await expect(service.get(runtime, active.id)).resolves.toBeNull();
    expect((await service.search(runtime, 'concise output')).memories).toEqual(
      [],
    );
  });

  it('does not activate an expired personal candidate', async () => {
    let current = now;
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const privacy = new StaticPrivacyModeResolver();
    const service = new MemoryService(
      store,
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      new InMemoryContentProtector(),
      new FakeSemanticIndex(),
      new EntityIdMapper(randomBytes(32), 'v1'),
      privacy,
      new StaticPolicyResolver(),
      {
        idempotencySecret: randomBytes(32),
        personalRetentionMs: 1,
        now: () => current,
      },
    );
    privacy.set(runtime.tenantId, runtime.principalId, 'read_write');
    const candidate = await service.propose(
      runtime,
      { scope: 'personal', summary: 'Use concise output', references: [] },
      randomUUID(),
    );
    current = new Date(now.getTime() + 2);

    await expect(
      service.approveCandidate(
        manager(runtime, 'data_subject'),
        candidate.id,
        candidate.version,
      ),
    ).rejects.toThrow('version conflict');
  });

  it('keeps candidate creation idempotent and rejects operation ID content changes', async () => {
    const runtime = identity();
    const { service } = fixture();
    const operationId = randomUUID();
    const input = {
      scope: 'repository' as const,
      summary: 'Run npm test before merge',
      references: ['docs/testing.md'],
    };

    const first = await service.propose(runtime, input, operationId);
    const retry = await service.propose(runtime, input, operationId);
    expect(retry.id).toBe(first.id);

    await expect(
      service.propose(
        runtime,
        { ...input, summary: 'Skip all tests' },
        operationId,
      ),
    ).rejects.toThrow('different candidate content');
  });

  it('rejects credentials embedded in candidate references', async () => {
    const runtime = identity();
    const { service } = fixture();

    await expect(
      service.propose(
        runtime,
        {
          scope: 'repository',
          summary: 'Use the release checklist',
          references: ['ghp_abcdefghijklmnopqrstuvwxyz123456'],
        },
        randomUUID(),
      ),
    ).rejects.toThrow('reference is invalid');
  });

  it('activates only through matching scope authority and never recalls across tenants', async () => {
    const runtime = identity();
    const { service } = fixture();
    const candidate = await service.propose(
      runtime,
      {
        scope: 'repository',
        summary: 'Run targeted vitest before merge',
        references: ['docs/testing.md'],
      },
      randomUUID(),
    );

    await expect(
      service.approveCandidate(
        manager(runtime, 'data_subject'),
        candidate.id,
        candidate.version,
      ),
    ).rejects.toThrow('authority');

    const active = await service.approveCandidate(
      manager(runtime, 'repository_maintainer'),
      candidate.id,
      candidate.version,
    );
    expect((await service.search(runtime, 'targeted vitest')).memories).toEqual(
      [expect.objectContaining({ id: active.id, scope: 'repository' })],
    );
    expect(
      (await service.search(identity('tenant-b'), 'targeted vitest')).memories,
    ).toEqual([]);
  });

  it('makes provider activation retryable after a binding failure', async () => {
    const store = new FailFirstBindingStore();
    const index = new FakeSemanticIndex();
    const runtime = identity();
    const { service } = fixture(store, index);
    const candidate = await service.propose(
      runtime,
      {
        scope: 'repository',
        summary: 'Build with npm run build',
        references: [],
      },
      randomUUID(),
    );
    const maintainer = manager(runtime, 'repository_maintainer');

    await expect(
      service.approveCandidate(maintainer, candidate.id, candidate.version),
    ).rejects.toThrow('simulated binding failure');
    await expect(service.get(runtime, candidate.id)).resolves.toBeNull();
    const active = await service.approveCandidate(
      maintainer,
      candidate.id,
      candidate.version,
    );

    expect(active.version).toBe(candidate.version + 1);
    expect(
      (await service.search(runtime, 'npm run build')).memories,
    ).toHaveLength(1);
  });

  it('stops recall at deletion intent and converges repeated erasure', async () => {
    const runtime = identity();
    const { service, ledger, protector } = fixture();
    const candidate = await service.propose(
      runtime,
      {
        scope: 'repository',
        summary: 'Use the release checklist',
        references: ['docs/release.md'],
      },
      randomUUID(),
    );
    const active = await service.approveCandidate(
      manager(runtime, 'repository_maintainer'),
      candidate.id,
      candidate.version,
    );
    const protectedContent = active.protectedContent;

    await service.eraseMemory(
      manager(runtime, 'repository_maintainer'),
      active.id,
      active.version,
      'repository',
      'maintainer_request',
    );

    expect(await service.get(runtime, active.id)).toBeNull();
    expect(
      (await service.search(runtime, 'release checklist')).memories,
    ).toEqual([]);
    expect(
      await ledger.getDeletion(runtime.tenantId, active.id, active.version),
    ).toMatchObject({ state: 'erased' });
    await expect(
      protector.reveal(runtime.tenantId, protectedContent),
    ).rejects.toThrow('unavailable');
    await expect(
      service.eraseMemory(
        manager(runtime, 'repository_maintainer'),
        active.id,
        active.version,
        'repository',
        'maintainer_request',
      ),
    ).resolves.toBeUndefined();
  });

  it('finishes ledger reconciliation after a crash following content removal', async () => {
    const runtime = identity();
    const ledger = new FailFirstMarkErasedLedger(
      new LedgerKeyFactory(randomBytes(32)),
    );
    const { service } = fixture(
      new InMemoryCanonicalStore(),
      new FakeSemanticIndex(),
      ledger,
    );
    const candidate = await service.propose(
      runtime,
      {
        scope: 'repository',
        summary: 'Use the checked release process',
        references: [],
      },
      randomUUID(),
    );
    const active = await service.approveCandidate(
      manager(runtime, 'repository_maintainer'),
      candidate.id,
      candidate.version,
    );
    const maintainer = manager(runtime, 'repository_maintainer');

    await expect(
      service.eraseMemory(
        maintainer,
        active.id,
        active.version,
        'repository',
        'maintainer_request',
      ),
    ).rejects.toThrow('simulated ledger outage');
    await expect(
      service.eraseMemory(
        maintainer,
        active.id,
        active.version,
        'repository',
        'maintainer_request',
      ),
    ).resolves.toBeUndefined();
    expect(
      await ledger.getDeletion(runtime.tenantId, active.id, active.version),
    ).toMatchObject({ state: 'erased' });
  });

  it('retries the database tombstone after ledger intent succeeds first', async () => {
    const runtime = identity();
    const store = new FailFirstTombstoneStore();
    const { service, ledger } = fixture(store);
    const candidate = await service.propose(
      runtime,
      {
        scope: 'repository',
        summary: 'Use the governed deploy workflow',
        references: [],
      },
      randomUUID(),
    );
    const maintainer = manager(runtime, 'repository_maintainer');
    const active = await service.approveCandidate(
      maintainer,
      candidate.id,
      candidate.version,
    );

    await expect(
      service.eraseMemory(
        maintainer,
        active.id,
        active.version,
        'repository',
        'maintainer_request',
      ),
    ).rejects.toThrow('simulated tombstone failure');
    expect(
      await ledger.getDeletion(runtime.tenantId, active.id, active.version),
    ).toMatchObject({ state: 'deletion_intent' });
    await expect(
      service.eraseMemory(
        maintainer,
        active.id,
        active.version,
        'repository',
        'maintainer_request',
      ),
    ).resolves.toBeUndefined();
  });

  it('discards provider IDs that are not authorized by the canonical store', async () => {
    const runtime = identity();
    const index = new ForeignResultIndex();
    const { service } = fixture(new InMemoryCanonicalStore(), index);

    expect((await service.search(runtime, 'anything')).memories).toEqual([]);
  });

  it('keeps raw turn IDs deterministic and rejects event ID content changes', async () => {
    const runtime = identity();
    const { service } = fixture(
      new InMemoryCanonicalStore(),
      new FakeSemanticIndex(),
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      true,
    );
    const request = {
      eventId: randomUUID(),
      sessionId: 'session-a',
      occurredAt: now,
      prompt: 'How do I build this repository?',
    };

    const first = await service.openTurn(runtime, request);
    const retry = await service.openTurn(runtime, request);
    expect(retry.turnId).toBe(first.turnId);
    await expect(
      service.openTurn(runtime, { ...request, prompt: 'Different prompt' }),
    ).rejects.toThrow('different content');
    await expect(
      service.openTurn(runtime, {
        ...request,
        eventId: randomUUID(),
        occurredAt: new Date(now.getTime() + 10 * 60 * 1000),
      }),
    ).rejects.toThrow('clock skew');
  });

  it('rejects a ledger receipt that extends the configured raw retention', async () => {
    const runtime = identity();
    const { service } = fixture(
      new InMemoryCanonicalStore(),
      new FakeSemanticIndex(),
      new OversizedRetentionLedger(new LedgerKeyFactory(randomBytes(32))),
      true,
    );

    await expect(
      service.openTurn(runtime, {
        eventId: randomUUID(),
        sessionId: 'session-a',
        occurredAt: now,
        prompt: 'How do I test this?',
      }),
    ).rejects.toThrow('retention already expired');
  });

  it('stores idempotent content-free feedback for an authorized active memory', async () => {
    const runtime = identity();
    const { service } = fixture();
    const candidate = await service.propose(
      runtime,
      { scope: 'repository', summary: 'Use npm run test', references: [] },
      randomUUID(),
    );
    const active = await service.approveCandidate(
      manager(runtime, 'repository_maintainer'),
      candidate.id,
      candidate.version,
    );
    const eventId = randomUUID();

    await expect(
      service.recordFeedback(
        runtime,
        eventId,
        'session-a',
        active.id,
        'helpful',
        now,
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.recordFeedback(
        runtime,
        eventId,
        'session-a',
        active.id,
        'helpful',
        now,
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.recordFeedback(
        runtime,
        eventId,
        'session-a',
        active.id,
        'unsafe',
        now,
      ),
    ).rejects.toThrow('different content');
    await expect(
      service.recordFeedback(
        runtime,
        eventId,
        'session-b',
        active.id,
        'helpful',
        now,
      ),
    ).rejects.toThrow('different content');
  });
});

class FailFirstBindingStore extends InMemoryCanonicalStore {
  private failed = false;

  override async activateWithProvider(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    authority: string,
    binding: ProviderBinding,
  ) {
    if (!this.failed) {
      this.failed = true;
      throw new Error('simulated binding failure');
    }
    return super.activateWithProvider(
      context,
      memoryId,
      expectedVersion,
      authority,
      binding,
    );
  }
}

class ForeignResultIndex implements SemanticIndex {
  async add(): Promise<string> {
    return 'foreign-provider-id';
  }

  async search(): Promise<readonly ProviderSearchResult[]> {
    return [{ providerMemoryId: 'foreign-provider-id', score: 1 }];
  }

  async delete(): Promise<void> {}
}

class FailFirstMarkErasedLedger extends InMemoryAntiResurrectionLedger {
  private failed = false;

  override async markErased(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
  ): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('simulated ledger outage');
    }
    await super.markErased(tenantId, canonicalMemoryId, version);
  }
}

class FailFirstTombstoneStore extends InMemoryCanonicalStore {
  private failed = false;

  override async markPendingErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
  ) {
    if (!this.failed) {
      this.failed = true;
      throw new Error('simulated tombstone failure');
    }
    return super.markPendingErasure(context, memoryId, expectedVersion);
  }
}

class OversizedRetentionLedger extends InMemoryAntiResurrectionLedger {
  override async ensureRawReceipt(
    tenantId: string,
    eventId: string,
    receivedAt: Date,
  ) {
    return {
      key: new LedgerKeyFactory(randomBytes(32)).rawEvent(tenantId, eventId),
      receivedAt,
      purgeAt: new Date(receivedAt.getTime() + 25 * 60 * 60 * 1000),
      state: 'received' as const,
    };
  }
}
