/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionArtifactStore,
  SessionArtifactValidationError,
} from './sessionArtifacts.js';

describe('SessionArtifactStore', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-artifacts-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('lists, removes, and idempotently ignores missing artifact deletes', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1',
      workspaceCwd: workspace,
    });

    const created = await store.upsertMany(
      [
        {
          title: 'Lineage',
          source: 'client',
          url: 'https://example.com/lineage',
        },
      ],
      { strict: true },
    );
    const artifactId = created.changes[0]?.artifactId;

    expect(created.changes).toHaveLength(1);
    await expect(store.list()).resolves.toMatchObject({
      v: 1,
      sessionId: 's1',
      artifacts: [
        {
          id: artifactId,
          storage: 'external_url',
          source: 'client',
          clientRetained: true,
        },
      ],
    });

    expect(store.remove(artifactId!).changes).toMatchObject([
      { action: 'removed', artifactId, reason: 'explicit' },
    ]);
    expect(store.remove(artifactId!).changes).toEqual([]);
  });

  it('rejects untrusted published artifacts and allows trusted published upgrades', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's2',
      workspaceCwd: workspace,
    });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Forged',
            storage: 'published',
            url: 'https://example.com/artifact',
          },
        ],
        { strict: true },
      ),
    ).rejects.toBeInstanceOf(SessionArtifactValidationError);

    await store.upsertMany([
      { title: 'Link', url: 'https://example.com/artifact' },
    ]);
    const upgraded = await store.upsertMany([
      {
        title: 'Published',
        storage: 'published',
        url: 'https://example.com/artifact',
        managedId: 'managed-1',
        trustedPublisher: true,
      },
    ]);

    expect(upgraded.changes).toHaveLength(1);
    expect(upgraded.changes[0]).toMatchObject({
      action: 'updated',
      artifact: {
        title: 'Published',
        storage: 'published',
        managedId: 'managed-1',
      },
    });
  });

  it('evicts non-retained old artifacts before client-retained artifacts', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's3',
      workspaceCwd: workspace,
      maxArtifacts: 2,
    });

    const client = await store.upsertMany([
      {
        title: 'Client link',
        source: 'client',
        url: 'https://example.com/client',
      },
    ]);
    const tool = await store.upsertMany([
      { title: 'Tool link', url: 'https://example.com/tool' },
    ]);
    const overflow = await store.upsertMany([
      { title: 'New link', url: 'https://example.com/new' },
    ]);

    expect(overflow.changes).toContainEqual(
      expect.objectContaining({
        action: 'removed',
        artifactId: tool.changes[0]?.artifactId,
        reason: 'eviction',
      }),
    );
    expect((await store.list()).artifacts.map((a) => a.id)).toContain(
      client.changes[0]?.artifactId,
    );
  });

  it('rejects workspace path traversal', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's4',
      workspaceCwd: workspace,
    });

    await expect(
      store.upsertMany([{ title: 'Escape', workspacePath: '../outside.txt' }], {
        strict: true,
      }),
    ).rejects.toMatchObject({ field: 'workspacePath' });
  });
});
