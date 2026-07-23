/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EntityIdMapper,
  FakeSemanticIndex,
  sanitizeRetrievalQuery,
} from './semantic-index.js';

describe('EntityIdMapper', () => {
  it('uses provider-neutral, tenant-scoped derivation domains', () => {
    const secret = Buffer.alloc(32, 7);
    const tenantKey = createHmac('sha256', secret)
      .update(JSON.stringify(['semantic-index-tenant-key-v1', 'tenant-a']))
      .digest();
    const digest = createHmac('sha256', tenantKey)
      .update(
        JSON.stringify([
          'semantic-index-entity-v1',
          'repository',
          'repository-a',
        ]),
      )
      .digest('base64url');

    expect(
      new EntityIdMapper(secret, 'v1').repository('tenant-a', 'repository-a'),
    ).toBe(`em_v1_${digest}`);
    expect(
      new EntityIdMapper(secret, 'v1').repository('tenant-b', 'repository-a'),
    ).not.toBe(`em_v1_${digest}`);
  });
});

describe('FakeSemanticIndex', () => {
  it('is idempotent and searches only the requested tenant entity', async () => {
    const index = new FakeSemanticIndex();
    const first = await index.add({
      tenantId: 'tenant-a',
      scope: 'repository',
      entityId: 'entity-a',
      canonicalMemoryId: 'memory-a',
      canonicalVersion: 1,
      summary: 'Build the repository with npm',
    });
    const retry = await index.add({
      tenantId: 'tenant-a',
      scope: 'repository',
      entityId: 'entity-a',
      canonicalMemoryId: 'memory-a',
      canonicalVersion: 1,
      summary: 'Build the repository with npm',
    });
    await index.add({
      tenantId: 'tenant-b',
      scope: 'repository',
      entityId: 'entity-a',
      canonicalMemoryId: 'memory-b',
      canonicalVersion: 1,
      summary: 'Build the repository with pnpm',
    });

    expect(retry).toBe(first);
    await expect(
      index.search({
        tenantId: 'tenant-a',
        scope: 'repository',
        entityId: 'entity-a',
        query: 'build npm',
        limit: 5,
        threshold: 0.5,
      }),
    ).resolves.toEqual([{ providerMemoryId: first, score: 1 }]);
  });

  it('rejects deletion through a binding owned by another tenant', async () => {
    const index = new FakeSemanticIndex();
    const providerMemoryId = await index.add({
      tenantId: 'tenant-a',
      scope: 'personal',
      entityId: 'entity-a',
      canonicalMemoryId: 'memory-a',
      canonicalVersion: 1,
      summary: 'Use npm',
    });

    await expect(
      index.delete({
        tenantId: 'tenant-b',
        canonicalMemoryId: 'memory-a',
        canonicalVersion: 1,
        providerMemoryId,
        scope: 'personal',
        entityId: 'entity-a',
        state: 'active',
      }),
    ).rejects.toThrow('does not own');
  });
});

describe('sanitizeRetrievalQuery', () => {
  it('removes code, credentials, JWTs, and long high-entropy tokens', () => {
    const value = sanitizeRetrievalQuery(
      [
        'How should this repository build?',
        '```ts\nconst secret = true;\n```',
        'ghp_abcdefghijklmnopqrstuvwxyz123456',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123',
        'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z',
      ].join(' '),
    );

    expect(value).toBe('How should this repository build?');
  });
});
