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

  it('keeps first display fields and only enriches missing metadata keys', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5',
      workspaceCwd: workspace,
    });

    await store.upsertMany([
      {
        title: 'Tool title',
        source: 'tool',
        toolName: 'first_tool',
        url: 'https://example.com/resource',
        metadata: { owner: 'first' },
      },
    ]);

    const clientUpdate = await store.upsertMany([
      {
        title: 'Client title',
        source: 'client',
        clientId: 'client-1',
        url: 'https://example.com/resource',
        metadata: { owner: 'client', retainedBy: 'client' },
      },
    ]);
    expect(clientUpdate.changes[0]?.artifact).toMatchObject({
      title: 'Tool title',
      source: 'tool',
      toolName: 'first_tool',
      clientRetained: true,
      metadata: { owner: 'first', retainedBy: 'client' },
    });
    expect(clientUpdate.changes[0]?.artifact).not.toHaveProperty('clientId');

    await store.upsertMany([
      {
        title: 'Hook title',
        source: 'hook',
        hookEventName: 'PostToolUse',
        url: 'https://example.com/resource',
        metadata: { hookKey: 'ignored' },
      },
    ]);

    const repeatedTool = await store.upsertMany([
      {
        title: 'Second tool title',
        source: 'tool',
        toolName: 'second_tool',
        url: 'https://example.com/resource',
        metadata: { toolKey: 'added' },
      },
    ]);
    expect(repeatedTool.changes[0]?.artifact).toMatchObject({
      title: 'Tool title',
      source: 'tool',
      toolName: 'first_tool',
      metadata: {
        owner: 'first',
        retainedBy: 'client',
        toolKey: 'added',
      },
    });
    expect(repeatedTool.changes[0]?.artifact?.metadata).not.toHaveProperty(
      'hookKey',
    );
  });

  it('rejects unsafe display markup in title and description', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-markup',
      workspaceCwd: workspace,
    });

    await expect(
      store.upsertMany(
        [{ title: '<img src=x onerror=alert(1)>', url: 'https://example.com' }],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Report',
            description: 'javascript:alert(1)',
            url: 'https://example.com',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'description' });
  });

  it('does not create empty metadata or emit ghost updates', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-empty-metadata',
      workspaceCwd: workspace,
    });

    const created = await store.upsertMany([
      {
        title: 'Link',
        url: 'https://example.com/resource',
        metadata: {},
      },
    ]);
    expect(created.changes[0]?.artifact).not.toHaveProperty('metadata');

    const repeated = await store.upsertMany([
      {
        title: 'Ignored later title',
        url: 'https://example.com/resource',
      },
    ]);

    expect(repeated.changes).toEqual([]);
  });

  it('rejects existing workspace symlinks that escape the workspace', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's6',
      workspaceCwd: workspace,
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
      await fs.symlink(
        path.join(outside, 'secret.txt'),
        path.join(workspace, 'escape.txt'),
      );

      await expect(
        store.upsertMany([{ title: 'Escape', workspacePath: 'escape.txt' }], {
          strict: true,
        }),
      ).rejects.toMatchObject({ field: 'workspacePath' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('clears size when a workspace artifact becomes missing', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's7',
      workspaceCwd: workspace,
    });
    await fs.writeFile(path.join(workspace, 'report.txt'), 'hello');
    await store.upsertMany([{ title: 'Report', workspacePath: 'report.txt' }]);

    expect((await store.list()).artifacts[0]).toMatchObject({
      status: 'available',
      sizeBytes: 5,
    });

    await fs.rm(path.join(workspace, 'report.txt'));
    const missing = (await store.list()).artifacts[0];
    expect(missing).toMatchObject({ status: 'missing' });
    expect(missing).not.toHaveProperty('sizeBytes');
  });

  it('refreshes stale missing candidates before eviction', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's8',
      workspaceCwd: workspace,
      maxArtifacts: 2,
    });
    const restored = await store.upsertMany([
      { title: 'Restored later', workspacePath: 'restored.txt' },
    ]);
    const stillMissing = await store.upsertMany([
      { title: 'Still missing', workspacePath: 'still-missing.txt' },
    ]);
    await fs.writeFile(path.join(workspace, 'restored.txt'), 'ok');

    const overflow = await store.upsertMany([
      { title: 'New link', url: 'https://example.com/new' },
    ]);

    expect(overflow.changes).toContainEqual(
      expect.objectContaining({
        action: 'removed',
        artifactId: stillMissing.changes[0]?.artifactId,
        reason: 'eviction',
      }),
    );
    expect(
      (await store.list()).artifacts.map((artifact) => artifact.id),
    ).toContain(restored.changes[0]?.artifactId);
  });

  it('evicts from over-reserved sources before older artifacts from other sources', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's9',
      workspaceCwd: workspace,
    });
    await store.upsertMany([
      ...Array.from({ length: 50 }, (_, index) => ({
        title: `Hook ${index}`,
        source: 'hook' as const,
        url: `https://example.com/hook/${index}`,
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        title: `Client ${index}`,
        source: 'client' as const,
        url: `https://example.com/client/${index}`,
      })),
      ...Array.from({ length: 100 }, (_, index) => ({
        title: `Tool ${index}`,
        source: 'tool' as const,
        url: `https://example.com/tool/${index}`,
      })),
    ]);

    const overflow = await store.upsertMany([
      {
        title: 'Tool overflow',
        source: 'tool',
        url: 'https://example.com/tool/overflow',
      },
    ]);

    expect(overflow.changes).toContainEqual(
      expect.objectContaining({
        action: 'removed',
        artifact: expect.objectContaining({
          source: 'tool',
          title: 'Tool 0',
        }),
        reason: 'eviction',
      }),
    );
    expect((await store.list()).artifacts).toHaveLength(200);
  });

  it('emits one net removed change when an updated artifact is evicted', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's10',
      workspaceCwd: workspace,
      maxArtifacts: 2,
    });

    const first = await store.upsertMany([
      { title: 'First', url: 'https://example.com/first' },
    ]);
    await store.upsertMany([
      { title: 'Second', url: 'https://example.com/second' },
    ]);

    const overflow = await store.upsertMany([
      {
        title: 'First renamed',
        url: 'https://example.com/first',
        metadata: { refreshed: true },
      },
      { title: 'Third', url: 'https://example.com/third' },
    ]);
    const firstId = first.changes[0]?.artifactId;

    expect(
      overflow.changes.filter((change) => change.artifactId === firstId),
    ).toEqual([
      expect.objectContaining({
        action: 'removed',
        artifactId: firstId,
        reason: 'eviction',
      }),
    ]);
    expect(overflow.changes).toContainEqual(
      expect.objectContaining({
        action: 'created',
        artifact: expect.objectContaining({ title: 'Third' }),
      }),
    );
  });
});
