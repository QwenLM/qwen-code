/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  InMemoryAntiResurrectionLedger,
  LedgerKeyFactory,
} from './anti-resurrection-ledger.js';
import { InMemoryCanonicalStore } from './canonical-store.js';
import { InMemoryContentProtector } from './content-protector.js';
import type { RuntimeIdentity } from './domain.js';
import {
  createManagementHandler,
  ManagementTokenVerifier,
  type RepositoryMaintainerAuthorizer,
  ScmMaintainerAuthorizer,
} from './management-server.js';
import {
  MemoryService,
  type PersonalMemoryMode,
  StaticPolicyResolver,
} from './memory-service.js';
import type {
  PersonalMemoryPreferenceStore,
  PersonalPreferenceIdentity,
} from './privacy-mode-store.js';
import { EntityIdMapper, FakeSemanticIndex } from './semantic-index.js';

const now = new Date('2026-07-22T00:00:00.000Z');
const issuer = 'https://identity.example.test';
const audience = 'qwen-memory-management';
const servers: ReturnType<typeof createServer>[] = [];
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let tokens: ManagementTokenVerifier;

beforeAll(async () => {
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  tokens = new ManagementTokenVerifier({
    issuer,
    audience,
    expectedTenantId: 'tenant-a',
    key: async () => keys.publicKey,
    now: () => now,
  });
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

class TestPreferences implements PersonalMemoryPreferenceStore {
  private readonly modes = new Map<string, PersonalMemoryMode>();

  async getPersonalMode(
    identity: PersonalPreferenceIdentity,
  ): Promise<PersonalMemoryMode> {
    return (
      this.modes.get(`${identity.tenantId}:${identity.principalId}`) ?? 'off'
    );
  }

  async setPersonalMode(
    identity: PersonalPreferenceIdentity,
    mode: PersonalMemoryMode,
  ): Promise<void> {
    this.modes.set(`${identity.tenantId}:${identity.principalId}`, mode);
  }
}

class RecordingMaintainers implements RepositoryMaintainerAuthorizer {
  readonly calls: {
    tenantId: string;
    principalId: string;
    repositoryId: string;
  }[] = [];

  async authorize(
    principal: { tenantId: string; principalId: string },
    repositoryId: string,
  ): Promise<void> {
    this.calls.push({ ...principal, repositoryId });
  }
}

function runtime(): RuntimeIdentity {
  return {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    workspaceId: 'workspace-a',
    repositoryId: 'repository-a',
    revocationEpoch: 0,
  };
}

async function managementToken(
  tokenIssuer = issuer,
  tokenAudience = audience,
  tenantId = 'tenant-a',
): Promise<string> {
  const seconds = Math.floor(now.getTime() / 1000);
  return new SignJWT({ tenant_id: tenantId })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(tokenIssuer)
    .setAudience(tokenAudience)
    .setSubject('principal-a')
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + 60)
    .sign(privateKey);
}

async function fixture() {
  const preferences = new TestPreferences();
  const maintainers = new RecordingMaintainers();
  const memory = new MemoryService(
    new InMemoryCanonicalStore(),
    new InMemoryAntiResurrectionLedger(new LedgerKeyFactory(randomBytes(32))),
    new InMemoryContentProtector(),
    new FakeSemanticIndex(),
    new EntityIdMapper(randomBytes(32), 'v1'),
    preferences,
    new StaticPolicyResolver(),
    { idempotencySecret: randomBytes(32), now: () => now, searchThreshold: 0 },
  );
  const server = createServer(
    createManagementHandler({ tokens, maintainers, preferences, memory }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    preferences,
    maintainers,
    memory,
  };
}

describe('management API', () => {
  it('lets only the authenticated data subject change personal memory mode', async () => {
    const { baseUrl, preferences } = await fixture();
    const response = await fetch(`${baseUrl}/v1/manage/personal-memory-mode`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await managementToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode: 'read_write' }),
    });

    expect(response.status).toBe(200);
    await expect(preferences.getPersonalMode(runtime())).resolves.toBe(
      'read_write',
    );
  });

  it('checks current SCM maintainership before repository approval', async () => {
    const { baseUrl, maintainers, memory } = await fixture();
    const candidate = await memory.propose(
      runtime(),
      {
        scope: 'repository',
        summary: 'Run targeted tests',
        references: [],
      },
      randomUUID(),
    );

    const response = await fetch(
      `${baseUrl}/v1/manage/repositories/repository-a/memories/${candidate.id}:approve`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await managementToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expected_version: candidate.version }),
      },
    );

    expect(response.status).toBe(200);
    expect(maintainers.calls).toEqual([
      {
        tenantId: 'tenant-a',
        principalId: 'principal-a',
        repositoryId: 'repository-a',
      },
    ]);
    await expect(memory.get(runtime(), candidate.id)).resolves.toMatchObject({
      id: candidate.id,
      authority: 'maintainer_approved',
    });
  });

  it('allows the current maintainer to review encrypted candidate content before approval', async () => {
    const { baseUrl, maintainers, memory } = await fixture();
    const candidate = await memory.propose(
      runtime(),
      {
        scope: 'repository',
        summary: 'Review this candidate first',
        references: ['docs/review.md'],
      },
      randomUUID(),
    );

    const response = await fetch(
      `${baseUrl}/v1/manage/repositories/repository-a/memories/${candidate.id}`,
      { headers: { authorization: `Bearer ${await managementToken()}` } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: candidate.id,
      summary: 'Review this candidate first',
      references: ['docs/review.md'],
      state: 'candidate',
    });
    expect(maintainers.calls).toHaveLength(1);
  });

  it('rejects a runtime-style token at every management route', async () => {
    const { baseUrl, preferences } = await fixture();
    const response = await fetch(`${baseUrl}/v1/manage/personal-memory-mode`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await managementToken(
          'https://broker.example.test',
          'qwen-memory-gateway',
        )}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode: 'read_write' }),
    });

    expect(response.status).toBe(401);
    await expect(preferences.getPersonalMode(runtime())).resolves.toBe('off');
  });

  it('rejects a management token from another tenant shard', async () => {
    const { baseUrl, preferences } = await fixture();
    const response = await fetch(`${baseUrl}/v1/manage/personal-memory-mode`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await managementToken(
          issuer,
          audience,
          'tenant-b',
        )}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode: 'read_write' }),
    });

    expect(response.status).toBe(401);
    await expect(preferences.getPersonalMode(runtime())).resolves.toBe('off');
  });

  it('rejects privileged deletion reasons on a data-subject route', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(
      `${baseUrl}/v1/manage/personal/memories/${randomUUID()}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${await managementToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expected_version: 1,
          reason: 'tenant_offboarding',
        }),
      },
    );

    expect(response.status).toBe(400);
  });

  it('accepts only a fresh SCM response bound to the exact identity tuple', async () => {
    const valid = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          authorized: true,
          tenant_id: 'tenant-a',
          principal_id: 'principal-a',
          repository_id: 'repository-a',
          expires_at: new Date(now.getTime() + 60_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const authorizer = new ScmMaintainerAuthorizer({
      baseUrl: 'https://scm.example.test',
      bearerToken: 'service-token',
      fetchImplementation: valid,
      now: () => now,
    });

    await expect(
      authorizer.authorize(
        { tenantId: 'tenant-a', principalId: 'principal-a' },
        'repository-a',
      ),
    ).resolves.toBeUndefined();

    const wrongIdentity = new ScmMaintainerAuthorizer({
      baseUrl: 'https://scm.example.test',
      bearerToken: 'service-token',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            authorized: true,
            tenant_id: 'tenant-b',
            principal_id: 'principal-a',
            repository_id: 'repository-a',
            expires_at: new Date(now.getTime() + 60_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
      now: () => now,
    });
    await expect(
      wrongIdentity.authorize(
        { tenantId: 'tenant-a', principalId: 'principal-a' },
        'repository-a',
      ),
    ).rejects.toThrow();
  });
});
