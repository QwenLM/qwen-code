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
  type RawEventReceipt,
} from './anti-resurrection-ledger.js';
import {
  InMemoryCanonicalStore,
  type StoreContext,
} from './canonical-store.js';
import { InMemoryContentProtector } from './content-protector.js';
import type {
  CanonicalMemoryRecord,
  DeletionReason,
  MemoryScope,
  ProviderBinding,
  ProviderSearchResult,
  RawEventInput,
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
  const context = {
    tenantId: runtime.tenantId,
    principalId: runtime.principalId,
    repositoryId: runtime.repositoryId,
  };
  return authority === 'repository_maintainer'
    ? {
        ...context,
        authority,
        authorizationExpiresAt: new Date(now.getTime() + 60_000),
      }
    : { ...context, authority };
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
  it.each([
    { idempotencySecret: new Uint8Array() },
    { rawRetentionMs: Number.NaN },
    { personalRetentionMs: Number.POSITIVE_INFINITY },
    { personalRetentionMs: 365 * 24 * 60 * 60 * 1000 + 1 },
    { searchLimit: 7 },
    { searchThreshold: -0.1 },
    { maxEventClockSkewMs: 0.5 },
    { maxEventClockSkewMs: 5 * 60 * 1000 + 1 },
  ])('rejects unsafe service configuration: %o', (override) => {
    expect(
      () =>
        new MemoryService(
          new InMemoryCanonicalStore(),
          new InMemoryAntiResurrectionLedger(
            new LedgerKeyFactory(randomBytes(32)),
          ),
          new InMemoryContentProtector(),
          new FakeSemanticIndex(),
          new EntityIdMapper(randomBytes(32), 'v1'),
          new StaticPrivacyModeResolver(),
          new StaticPolicyResolver(),
          { idempotencySecret: randomBytes(32), ...override },
        ),
    ).toThrow('configuration is invalid');
  });

  it('rejects organization policy context above the injection budget', async () => {
    const runtime = identity();
    const service = new MemoryService(
      new InMemoryCanonicalStore(),
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      new InMemoryContentProtector(),
      new FakeSemanticIndex(),
      new EntityIdMapper(randomBytes(32), 'v1'),
      new StaticPrivacyModeResolver(),
      new StaticPolicyResolver({
        version: 1,
        expiresAt: new Date(now.getTime() + 60_000),
        systemContext: 'x'.repeat(4_001),
      }),
      { idempotencySecret: randomBytes(32), now: () => now },
    );

    await expect(service.getSessionContext(runtime)).rejects.toThrow(
      'Policy snapshot is invalid',
    );
  });

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

  it('keeps a candidate key when the database commit result is uncertain', async () => {
    const runtime = identity();
    const store = new AmbiguousCandidateCommitStore();
    const { service, protector } = fixture(store);

    await expect(
      service.propose(
        runtime,
        {
          scope: 'repository',
          summary: 'Preserve ambiguous data',
          references: [],
        },
        randomUUID(),
      ),
    ).rejects.toThrow('ambiguous commit');

    await expect(
      protector.reveal(runtime.tenantId, store.committed.protectedContent),
    ).resolves.toContain('Preserve ambiguous data');
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

  it('does not activate personal memory when consent changes during indexing', async () => {
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const privacy = new StaticPrivacyModeResolver();
    const index = new DelayedAddIndex(() => {
      privacy.set(runtime.tenantId, runtime.principalId, 'off');
    });
    const service = new MemoryService(
      store,
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      new InMemoryContentProtector(),
      index,
      new EntityIdMapper(randomBytes(32), 'v1'),
      privacy,
      new StaticPolicyResolver(),
      { idempotencySecret: randomBytes(32), now: () => now },
    );
    privacy.set(runtime.tenantId, runtime.principalId, 'read_write');
    const candidate = await service.propose(
      runtime,
      { scope: 'personal', summary: 'Prefer concise output', references: [] },
      randomUUID(),
    );

    await expect(
      service.approveCandidate(
        manager(runtime, 'data_subject'),
        candidate.id,
        candidate.version,
      ),
    ).rejects.toThrow('disabled');
    await expect(service.get(runtime, candidate.id)).resolves.toBeNull();
    await expect(
      service.eraseMemory(
        manager(runtime, 'data_subject'),
        candidate.id,
        candidate.version,
        'personal',
        'user_request',
      ),
    ).resolves.toBeUndefined();
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

  it('does not activate a candidate that expires during indexing', async () => {
    let current = now;
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const privacy = new StaticPrivacyModeResolver();
    const index = new DelayedAddIndex(() => {
      current = new Date(now.getTime() + 2);
    });
    const service = new MemoryService(
      store,
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      new InMemoryContentProtector(),
      index,
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
      { scope: 'personal', summary: 'Prefer concise output', references: [] },
      randomUUID(),
    );

    await expect(
      service.approveCandidate(
        manager(runtime, 'data_subject'),
        candidate.id,
        candidate.version,
      ),
    ).rejects.toThrow('version conflict');
    await expect(service.get(runtime, candidate.id)).resolves.toBeNull();
  });

  it('does not activate a repository candidate after the SCM lease expires', async () => {
    let current = now;
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const index = new DelayedAddIndex(() => {
      current = new Date(now.getTime() + 61_000);
    });
    const privacy = new StaticPrivacyModeResolver();
    const service = new MemoryService(
      store,
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      new InMemoryContentProtector(),
      index,
      new EntityIdMapper(randomBytes(32), 'v1'),
      privacy,
      new StaticPolicyResolver(),
      { idempotencySecret: randomBytes(32), now: () => current },
    );
    const candidate = await service.propose(
      runtime,
      { scope: 'repository', summary: 'Run governed checks', references: [] },
      randomUUID(),
    );

    await expect(
      service.approveCandidate(
        {
          tenantId: runtime.tenantId,
          principalId: runtime.principalId,
          repositoryId: runtime.repositoryId,
          authority: 'repository_maintainer',
          authorizationExpiresAt: new Date(now.getTime() + 60_000),
        },
        candidate.id,
        candidate.version,
      ),
    ).rejects.toThrow('authority');
    await expect(service.get(runtime, candidate.id)).resolves.toBeNull();
  });

  it('does not review or approve a version with a durable deletion intent', async () => {
    const runtime = identity();
    const { service, ledger } = fixture();
    const candidate = await service.propose(
      runtime,
      {
        scope: 'repository',
        summary: 'Use the governed release process',
        references: [],
      },
      randomUUID(),
    );
    const maintainer = manager(runtime, 'repository_maintainer');
    await ledger.beginDeletion(
      runtime.tenantId,
      candidate.id,
      candidate.version,
      'repository',
      'candidate_rejected',
      now,
    );

    await expect(
      service.getCandidateForReview(maintainer, candidate.id),
    ).resolves.toBeNull();
    await expect(
      service.approveCandidate(maintainer, candidate.id, candidate.version),
    ).rejects.toThrow('deletion is in progress');
  });

  it('does not report an active approval retry after deletion starts', async () => {
    const runtime = identity();
    const { service, ledger } = fixture();
    const candidate = await service.propose(
      runtime,
      { scope: 'repository', summary: 'Run governed checks', references: [] },
      randomUUID(),
    );
    const maintainer = manager(runtime, 'repository_maintainer');
    const active = await service.approveCandidate(
      maintainer,
      candidate.id,
      candidate.version,
    );
    await ledger.beginDeletion(
      runtime.tenantId,
      active.id,
      active.version,
      'repository',
      'maintainer_request',
      now,
    );

    await expect(
      service.approveCandidate(maintainer, candidate.id, candidate.version),
    ).rejects.toThrow('deletion is in progress');
  });

  it('does not return candidate content after concurrent activation', async () => {
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const protector = new BlockingRevealProtector();
    const service = new MemoryService(
      store,
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      protector,
      new FakeSemanticIndex(),
      new EntityIdMapper(randomBytes(32), 'v1'),
      new StaticPrivacyModeResolver(),
      new StaticPolicyResolver(),
      { idempotencySecret: randomBytes(32), now: () => now },
    );
    const candidate = await service.propose(
      runtime,
      { scope: 'repository', summary: 'Run governed checks', references: [] },
      randomUUID(),
    );
    const maintainer = manager(runtime, 'repository_maintainer');
    const blocked = protector.blockNextReveal();
    const review = service.getCandidateForReview(maintainer, candidate.id);
    await blocked.entered;

    await service.approveCandidate(maintainer, candidate.id, candidate.version);
    blocked.release();

    await expect(review).resolves.toBeNull();
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

  it('binds candidate idempotency to the opaque principal or repository scope', async () => {
    const firstRuntime = identity();
    const secondRuntime = identity('tenant-a', 'principal-a', 'repository-b');
    const { service } = fixture();
    const operationId = randomUUID();
    const input = {
      scope: 'repository' as const,
      summary: 'Run npm test before merge',
      references: [] as string[],
    };

    await service.propose(firstRuntime, input, operationId);

    await expect(
      service.propose(secondRuntime, input, operationId),
    ).rejects.toThrow('different candidate content');
    await expect(
      service.propose(
        identity('tenant-a', 'principal-b', 'repository-a'),
        input,
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

  it('rejects candidate summaries above the stored-content limit', async () => {
    const runtime = identity();
    const { service } = fixture();

    await expect(
      service.propose(
        runtime,
        {
          scope: 'repository',
          summary: `x${' '.repeat(1_000)}`,
          references: [],
        },
        randomUUID(),
      ),
    ).rejects.toThrow('1-1000 characters');
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

  it('keeps an ambiguous provider activation reserved until reconciliation', async () => {
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
    await expect(
      service.approveCandidate(maintainer, candidate.id, candidate.version),
    ).rejects.toThrow('already in progress');

    await store.releaseActivation(maintainer, candidate.id, candidate.version);
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
    expect(
      await ledger.getDeletion(runtime.tenantId, active.id, 1),
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

  it('does not resurrect an erased memory when its proposal is replayed', async () => {
    const runtime = identity();
    const { service } = fixture();
    const operationId = randomUUID();
    const input = {
      scope: 'repository' as const,
      summary: 'Keep the governed release process',
      references: [] as const,
    };
    const candidate = await service.propose(runtime, input, operationId);
    const active = await service.approveCandidate(
      manager(runtime, 'repository_maintainer'),
      candidate.id,
      candidate.version,
    );
    await service.eraseMemory(
      manager(runtime, 'repository_maintainer'),
      active.id,
      active.version,
      'repository',
      'maintainer_request',
    );

    await expect(service.propose(runtime, input, operationId)).rejects.toThrow(
      'already erased',
    );
  });

  it('rejects deletion reasons outside the caller authority and scope', async () => {
    const runtime = identity();
    const { service } = fixture();

    await expect(
      service.eraseMemory(
        manager(runtime, 'repository_maintainer'),
        randomUUID(),
        1,
        'repository',
        'user_request',
      ),
    ).rejects.toThrow('reason does not match');
    await expect(
      service.eraseMemory(
        manager(runtime, 'data_subject'),
        randomUUID(),
        1,
        'personal',
        'tenant_offboarding',
      ),
    ).rejects.toThrow('reason does not match');
  });

  it('does not label deletion of an active memory as candidate rejection', async () => {
    const runtime = identity();
    const { service, ledger } = fixture();
    const candidate = await service.propose(
      runtime,
      { scope: 'repository', summary: 'Use governed checks', references: [] },
      randomUUID(),
    );
    const active = await service.approveCandidate(
      manager(runtime, 'repository_maintainer'),
      candidate.id,
      candidate.version,
    );

    await expect(
      service.eraseMemory(
        manager(runtime, 'repository_maintainer'),
        active.id,
        active.version,
        'repository',
        'candidate_rejected',
      ),
    ).rejects.toThrow('requires a candidate');
    await expect(
      ledger.getDeletion(runtime.tenantId, active.id, active.version),
    ).resolves.toBeNull();
  });

  it('rechecks deletion intent after content reveal before returning memory', async () => {
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const ledger = new InMemoryAntiResurrectionLedger(
      new LedgerKeyFactory(randomBytes(32)),
    );
    const protector = new BlockingRevealProtector();
    const service = new MemoryService(
      store,
      ledger,
      protector,
      new FakeSemanticIndex(),
      new EntityIdMapper(randomBytes(32), 'v1'),
      new StaticPrivacyModeResolver(),
      new StaticPolicyResolver(),
      { idempotencySecret: randomBytes(32), now: () => now },
    );
    const candidate = await service.propose(
      runtime,
      { scope: 'repository', summary: 'Use governed checks', references: [] },
      randomUUID(),
    );
    const active = await service.approveCandidate(
      manager(runtime, 'repository_maintainer'),
      candidate.id,
      candidate.version,
    );
    const blocked = protector.blockNextReveal();

    const recall = service.get(runtime, active.id);
    await blocked.entered;
    await ledger.beginDeletion(
      runtime.tenantId,
      active.id,
      active.version,
      'repository',
      'maintainer_request',
      now,
    );
    blocked.release();

    await expect(recall).resolves.toBeNull();
  });

  it('rechecks personal expiry after content reveal before returning memory', async () => {
    let current = now;
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const privacy = new StaticPrivacyModeResolver();
    const protector = new BlockingRevealProtector();
    const service = new MemoryService(
      store,
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      protector,
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
      { scope: 'personal', summary: 'Prefer governed output', references: [] },
      randomUUID(),
    );
    const active = await service.approveCandidate(
      manager(runtime, 'data_subject'),
      candidate.id,
      candidate.version,
    );
    const blocked = protector.blockNextReveal();

    const recall = service.get(runtime, active.id);
    await blocked.entered;
    current = new Date(now.getTime() + 2);
    blocked.release();

    await expect(recall).resolves.toBeNull();
    await expect(
      service.approveCandidate(
        manager(runtime, 'data_subject'),
        candidate.id,
        candidate.version,
      ),
    ).rejects.toThrow('version conflict');
  });

  it('retains ciphertext until external erasure is durably confirmed', async () => {
    const runtime = identity();
    const ledger = new FailFirstMarkErasedLedger(
      new LedgerKeyFactory(randomBytes(32)),
    );
    const { service, store } = fixture(
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
      store.getAuthorized(maintainer, active.id),
    ).resolves.toMatchObject({ erasureState: 'pending_erasure' });
    await expect(
      service.eraseMemory(
        maintainer,
        active.id,
        active.version,
        'repository',
        'maintainer_request',
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.getAuthorized(maintainer, active.id),
    ).resolves.toBeNull();
    expect(
      await ledger.getDeletion(runtime.tenantId, active.id, active.version),
    ).toMatchObject({ state: 'erased' });
  });

  it('does not infer external erasure from a missing canonical row', async () => {
    const runtime = identity();
    const { service, ledger } = fixture();
    const memoryId = randomUUID();
    await ledger.beginDeletion(
      runtime.tenantId,
      memoryId,
      1,
      'repository',
      'maintainer_request',
      now,
    );

    await expect(
      service.eraseMemory(
        manager(runtime, 'repository_maintainer'),
        memoryId,
        1,
        'repository',
        'maintainer_request',
      ),
    ).rejects.toThrow('orphan reconciliation');
    await expect(
      ledger.getDeletion(runtime.tenantId, memoryId, 1),
    ).resolves.toMatchObject({ state: 'deletion_intent' });
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

  it('does not create a deletion intent when the version CAS loses to approval', async () => {
    const runtime = identity();
    const store = new BlockingReservationStore();
    const { service, ledger } = fixture(store);
    const candidate = await service.propose(
      runtime,
      {
        scope: 'repository',
        summary: 'Use the governed release process',
        references: [],
      },
      randomUUID(),
    );
    const maintainer = manager(runtime, 'repository_maintainer');
    const erasure = service.eraseMemory(
      maintainer,
      candidate.id,
      candidate.version,
      'repository',
      'candidate_rejected',
    );
    await store.reservationEntered;

    await service.approveCandidate(maintainer, candidate.id, candidate.version);
    store.continueReservation();

    await expect(erasure).rejects.toThrow('version conflict');
    await expect(
      ledger.getDeletion(runtime.tenantId, candidate.id, candidate.version),
    ).resolves.toBeNull();
  });

  it('does not accept erasure while an unbound provider write is in flight', async () => {
    const runtime = identity();
    const store = new InMemoryCanonicalStore();
    const index = new BlockingAddIndex();
    const { service, ledger } = fixture(store, index);
    const candidate = await service.propose(
      runtime,
      { scope: 'repository', summary: 'Use governed checks', references: [] },
      randomUUID(),
    );
    const maintainer = manager(runtime, 'repository_maintainer');
    const approval = service.approveCandidate(
      maintainer,
      candidate.id,
      candidate.version,
    );
    await index.entered;

    await expect(
      service.eraseMemory(
        maintainer,
        candidate.id,
        candidate.version,
        'repository',
        'candidate_rejected',
      ),
    ).rejects.toThrow('activation is in progress');
    await expect(
      ledger.getDeletion(runtime.tenantId, candidate.id, candidate.version),
    ).resolves.toBeNull();

    index.continue();
    await expect(approval).resolves.toMatchObject({
      lifecycleState: 'active',
      version: candidate.version + 1,
    });
  });

  it('discards provider IDs that are not authorized by the canonical store', async () => {
    const runtime = identity();
    const index = new ForeignResultIndex();
    const { service } = fixture(new InMemoryCanonicalStore(), index);

    expect((await service.search(runtime, 'anything')).memories).toEqual([]);
  });

  it('uses canonical IDs as a deterministic score tie-breaker', async () => {
    const runtime = identity();
    const { service } = fixture();
    const activeIds: string[] = [];
    for (const summary of ['shared build alpha', 'shared build beta']) {
      const candidate = await service.propose(
        runtime,
        { scope: 'repository', summary, references: [] },
        randomUUID(),
      );
      const active = await service.approveCandidate(
        manager(runtime, 'repository_maintainer'),
        candidate.id,
        candidate.version,
      );
      activeIds.push(active.id);
    }

    const result = await service.search(runtime, 'shared build');

    expect(result.memories.map((memory) => memory.id)).toEqual(
      activeIds.sort(),
    );
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
      service.openTurn(identity('tenant-a', 'principal-b'), request),
    ).rejects.toThrow('different content');
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

  it('keeps a raw-event key when the database commit result is uncertain', async () => {
    const runtime = identity();
    const store = new AmbiguousRawCommitStore();
    const { service, protector } = fixture(
      store,
      new FakeSemanticIndex(),
      new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
      true,
    );

    await expect(
      service.openTurn(runtime, {
        eventId: randomUUID(),
        sessionId: 'session-a',
        occurredAt: now,
        prompt: 'Preserve an ambiguous raw event',
      }),
    ).rejects.toThrow('ambiguous commit');

    await expect(
      protector.reveal(runtime.tenantId, store.committed.protectedPayload),
    ).resolves.toContain('Preserve an ambiguous raw event');
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
        identity('tenant-a', 'principal-b'),
        eventId,
        'session-a',
        active.id,
        'helpful',
        now,
      ),
    ).rejects.toThrow('different content');
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

  it('rejects new feedback after erasure reserves the canonical version', async () => {
    const runtime = identity();
    const { service, store } = fixture();
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
    await store.reserveErasure(
      runtime,
      active.id,
      active.version,
      'repository',
      'maintainer_request',
      now,
      null,
    );

    await expect(
      service.recordFeedback(
        runtime,
        randomUUID(),
        'session-a',
        active.id,
        'helpful',
        now,
      ),
    ).rejects.toThrow('Canonical memory not found');
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
    authorizationExpiresAt: Date | null,
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
      authorizationExpiresAt,
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

class DelayedAddIndex extends FakeSemanticIndex {
  constructor(private readonly afterAdd: () => void) {
    super();
  }

  override async add(request: Parameters<FakeSemanticIndex['add']>[0]) {
    const result = await super.add(request);
    this.afterAdd();
    return result;
  }
}

class BlockingAddIndex extends FakeSemanticIndex {
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private notifyEntered!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.notifyEntered = resolve;
  });

  continue(): void {
    this.release();
  }

  override async add(request: Parameters<FakeSemanticIndex['add']>[0]) {
    this.notifyEntered();
    await this.released;
    return super.add(request);
  }
}

class BlockingRevealProtector extends InMemoryContentProtector {
  private nextBlock:
    | {
        entered: () => void;
        wait: Promise<void>;
      }
    | undefined;

  blockNextReveal(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextBlock = { entered: markEntered, wait };
    return { entered, release };
  }

  override async reveal(
    tenantId: string,
    content: Parameters<InMemoryContentProtector['reveal']>[1],
  ): Promise<string> {
    const block = this.nextBlock;
    this.nextBlock = undefined;
    if (block) {
      block.entered();
      await block.wait;
    }
    return super.reveal(tenantId, content);
  }
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

class AmbiguousCandidateCommitStore extends InMemoryCanonicalStore {
  committed!: CanonicalMemoryRecord;

  override async insertCandidate(
    identity: RuntimeIdentity,
    record: CanonicalMemoryRecord,
  ): Promise<CanonicalMemoryRecord> {
    this.committed = await super.insertCandidate(identity, record);
    throw new Error('ambiguous commit');
  }
}

class AmbiguousRawCommitStore extends InMemoryCanonicalStore {
  committed!: RawEventInput;

  override async insertRawEvent(
    identity: RuntimeIdentity,
    event: RawEventInput,
    receipt: RawEventReceipt,
  ): Promise<boolean> {
    await super.insertRawEvent(identity, event, receipt);
    this.committed = event;
    throw new Error('ambiguous commit');
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

class BlockingReservationStore extends InMemoryCanonicalStore {
  private releaseReservation!: () => void;
  private readonly reservationRelease = new Promise<void>((resolve) => {
    this.releaseReservation = resolve;
  });
  private reservationStarted!: () => void;
  readonly reservationEntered = new Promise<void>((resolve) => {
    this.reservationStarted = resolve;
  });

  continueReservation(): void {
    this.releaseReservation();
  }

  override async reserveErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    scope: MemoryScope,
    reason: DeletionReason,
    createdAt: Date,
    authorizationExpiresAt: Date | null,
  ) {
    this.reservationStarted();
    await this.reservationRelease;
    return super.reserveErasure(
      context,
      memoryId,
      expectedVersion,
      scope,
      reason,
      createdAt,
      authorizationExpiresAt,
    );
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
