/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SessionArtifactAuthorizationError,
  SessionArtifactStore,
  SessionArtifactValidationError,
} from './sessionArtifacts.js';
import {
  stableSessionArtifactId,
  type RebuiltSessionArtifactSnapshot,
  type SessionArtifactEventRecordPayload,
  type SessionArtifactSnapshotRecordPayload,
} from '@qwen-code/qwen-code-core';

vi.mock('@xterm/headless', () => ({
  Terminal: class Terminal {},
  default: { Terminal: class Terminal {} },
}));

describe('SessionArtifactStore', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-artifacts-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function managedIdForWorkspacePath(workspacePath: string): string {
    return createHash('sha1')
      .update(path.resolve(workspace, workspacePath))
      .digest('hex')
      .slice(0, 16);
  }

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

    await expect(store.remove(artifactId!)).resolves.toMatchObject({
      changes: [{ action: 'removed', artifactId, reason: 'explicit' }],
    });
    await expect(store.remove(artifactId!)).resolves.toMatchObject({
      changes: [],
    });
  });

  it('gets artifacts and refreshes stale workspace status', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1-get',
      workspaceCwd: workspace,
    });
    await fs.writeFile(path.join(workspace, 'report.txt'), 'hello');
    const created = await store.upsertMany([
      { title: 'Report', workspacePath: 'report.txt' },
    ]);
    const artifactId = created.changes[0]!.artifactId;

    await expect(store.get(artifactId)).resolves.toMatchObject({
      id: artifactId,
      title: 'Report',
      status: 'available',
      sizeBytes: 5,
      metadata: {
        'qwen.workspace.sha256': createHash('sha256')
          .update('hello')
          .digest('hex'),
        'qwen.workspace.mtimeMs': expect.any(Number),
      },
    });
    await expect(store.get('missing')).resolves.toBeUndefined();

    await fs.writeFile(path.join(workspace, 'report.txt'), 'HELLO');
    await fs.utimes(
      path.join(workspace, 'report.txt'),
      new Date('2026-07-06T00:00:00.000Z'),
      new Date('2026-07-06T00:00:00.000Z'),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6_000));
    const changed = await store.get(artifactId);
    expect(changed).toMatchObject({ id: artifactId, status: 'changed' });
    expect(changed).toMatchObject({ sizeBytes: 5 });

    await fs.rm(path.join(workspace, 'report.txt'));
    vi.setSystemTime(new Date(Date.now() + 6_000));
    const missing = await store.get(artifactId);
    expect(missing).toMatchObject({ id: artifactId, status: 'missing' });
    expect(missing).not.toHaveProperty('sizeBytes');
  });

  it('does not count injected workspace hash metadata against the user metadata limit', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1-workspace-metadata-budget',
      workspaceCwd: workspace,
    });
    await fs.writeFile(path.join(workspace, 'budget.txt'), 'budget');
    const metadata = { payload: 'x'.repeat(4096) };
    while (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) {
      metadata.payload = metadata.payload.slice(0, -1);
    }

    const created = await store.upsertMany(
      [{ title: 'Budget', workspacePath: 'budget.txt', metadata }],
      { strict: true },
    );

    expect(created.changes[0]?.artifact).toMatchObject({
      metadata: {
        payload: metadata.payload,
        'qwen.workspace.sha256': createHash('sha256')
          .update('budget')
          .digest('hex'),
        'qwen.workspace.mtimeMs': expect.any(Number),
      },
    });
  });

  it('strips user-supplied reserved workspace metadata when the file is missing', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1-reserved-metadata',
      workspaceCwd: workspace,
    });

    const result = await store.upsertMany([
      {
        title: 'Missing workspace artifact',
        workspacePath: 'missing.txt',
        metadata: {
          'qwen.workspace.sha256': 'a'.repeat(64),
          'qwen.workspace.mtimeMs': 123,
          keep: true,
        },
      },
    ]);

    expect(result.changes[0]?.artifact?.metadata).toEqual({ keep: true });
    expect(result.changes[0]?.artifact?.status).toBe('missing');
  });

  it('prevents one client from removing another client retained artifact', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1-client-owner',
      workspaceCwd: workspace,
    });

    const created = await store.upsertMany([
      {
        title: 'Client link',
        source: 'client',
        clientId: 'client-a',
        url: 'https://example.com/client-a',
      },
    ]);
    const artifactId = created.changes[0]!.artifactId;

    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never);
    try {
      await expect(
        store.remove(artifactId, { clientId: 'client-b' }),
      ).rejects.toBeInstanceOf(SessionArtifactAuthorizationError);
      await expect(store.remove(artifactId)).rejects.toBeInstanceOf(
        SessionArtifactAuthorizationError,
      );
      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('remove_denied');
      expect(logged).toContain('client-a');
      expect(logged).toContain('client-b');
      expect(logged).toContain('<anonymous>');
    } finally {
      stderr.mockRestore();
    }
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [{ id: artifactId, clientId: 'client-a' }],
    });

    await expect(
      store.remove(artifactId, { clientId: 'client-a' }),
    ).resolves.toMatchObject({
      changes: [{ action: 'removed', artifactId, reason: 'explicit' }],
    });
  });

  it('prevents one client from upserting another client retained artifact', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1-client-upsert-owner',
      workspaceCwd: workspace,
    });

    const created = await store.upsertMany([
      {
        title: 'Client A link',
        source: 'client',
        clientId: 'client-a',
        url: 'https://example.com/client-owned',
        metadata: { owner: 'a' },
      },
    ]);
    const artifactId = created.changes[0]!.artifactId;

    await expect(
      store.upsertMany(
        [
          {
            title: 'Client B rewrite',
            source: 'client',
            clientId: 'client-b',
            url: 'https://example.com/client-owned',
            metadata: { owner: 'b' },
            retention: 'restorable',
          },
        ],
        { strict: true },
      ),
    ).rejects.toBeInstanceOf(SessionArtifactAuthorizationError);

    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: artifactId,
          title: 'Client A link',
          clientId: 'client-a',
          metadata: { owner: 'a' },
          retention: 'ephemeral',
        },
      ],
    });
  });

  it('skips cross-client upsert conflicts without dropping the batch', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1-client-upsert-owner-batch',
      workspaceCwd: workspace,
    });

    const owned = await store.upsertMany([
      {
        title: 'Client A link',
        source: 'client',
        clientId: 'client-a',
        url: 'https://example.com/client-owned-batch',
        metadata: { owner: 'a' },
      },
    ]);
    const ownedId = owned.changes[0]!.artifactId;

    const result = await store.upsertMany([
      {
        title: 'Client B rewrite',
        source: 'client',
        clientId: 'client-b',
        url: 'https://example.com/client-owned-batch',
        metadata: { owner: 'b' },
        retention: 'restorable',
      },
      {
        title: 'Tool output',
        url: 'https://example.com/tool-output',
      },
    ]);

    expect(result.changes).toMatchObject([
      {
        action: 'created',
        artifact: { title: 'Tool output' },
      },
    ]);
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: ownedId,
          title: 'Client A link',
          clientId: 'client-a',
          metadata: { owner: 'a' },
        },
        {
          title: 'Tool output',
        },
      ],
    });
  });

  it('writes client ids into durable artifact records', async () => {
    const events: SessionArtifactEventRecordPayload[] = [];
    const store = new SessionArtifactStore({
      sessionId: 's1-client-id-durable',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          events.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });

    const created = await store.upsertMany(
      [
        {
          title: 'Client artifact',
          url: 'https://example.com/client',
          source: 'client',
          clientId: 'client-a',
        },
      ],
      { strict: true },
    );

    expect(created.changes[0]?.artifact).toMatchObject({
      clientId: 'client-a',
    });
    expect(events[0]?.changes[0]?.artifact).toMatchObject({
      clientId: 'client-a',
    });
    expect(events[0]?.changes[0]?.artifact).not.toHaveProperty('restoreState');
    expect(events[0]?.changes[0]?.artifact).not.toHaveProperty(
      'persistenceWarning',
    );
  });

  it('restores client ownership from durable artifact records', async () => {
    const owner = 'client-a';
    const sessionId = 's1-restored-client-owner';
    const url = 'https://example.com/owned-restored-artifact';
    const artifactId = stableSessionArtifactId(sessionId, `url:${url}`);
    const store = new SessionArtifactStore({
      sessionId,
      workspaceCwd: workspace,
    });

    await store.restore({
      v: 2,
      sessionId,
      sequence: 1,
      artifacts: [
        {
          id: artifactId,
          kind: 'link',
          storage: 'external_url',
          source: 'client',
          status: 'available',
          title: 'Owned restored artifact',
          url,
          retention: 'restorable',
          clientRetained: true,
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
          clientId: owner,
        },
      ],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    } satisfies RebuiltSessionArtifactSnapshot);

    await expect(store.list()).resolves.toMatchObject({
      artifacts: [{ id: artifactId, clientId: owner }],
    });
    await expect(
      store.remove(artifactId, { clientId: 'client-b' }),
    ).rejects.toBeInstanceOf(SessionArtifactAuthorizationError);
    await expect(
      store.remove(artifactId, { clientId: owner }),
    ).resolves.toMatchObject({
      changes: [{ action: 'removed', artifactId }],
    });
  });

  it('rolls back received sequence when strict upsert persistence fails', async () => {
    let fail = false;
    const store = new SessionArtifactStore({
      sessionId: 's1-upsert-sequence-rollback',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {
          if (fail) throw new Error('persist failed');
        },
        recordSnapshot: async () => {},
      },
    });
    const sequenceState = store as unknown as { receivedSeq: number };

    await store.upsertMany(
      [{ title: 'First', url: 'https://example.com/first' }],
      { strict: true },
    );
    expect(sequenceState.receivedSeq).toBe(1);

    fail = true;
    await expect(
      store.upsertMany(
        [{ title: 'Second', url: 'https://example.com/second' }],
        { strict: true },
      ),
    ).rejects.toThrow('persist failed');
    expect(sequenceState.receivedSeq).toBe(1);

    fail = false;
    await store.upsertMany(
      [{ title: 'Third', url: 'https://example.com/third' }],
      { strict: true },
    );
    expect(sequenceState.receivedSeq).toBe(2);
  });

  it('serializes concurrent store operations', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's1-queue',
      workspaceCwd: workspace,
    });

    const first = store.upsertMany([
      { title: 'First', url: 'https://example.com/first' },
    ]);
    const second = store.upsertMany([
      { title: 'Second', url: 'https://example.com/second' },
    ]);
    const listed = store.list();

    await expect(first).resolves.toMatchObject({
      changes: [
        {
          action: 'created',
          artifact: { title: 'First' },
        },
      ],
    });
    await expect(second).resolves.toMatchObject({
      changes: [
        {
          action: 'created',
          artifact: { title: 'Second' },
        },
      ],
    });
    await expect(listed).resolves.toMatchObject({
      artifacts: [{ title: 'First' }, { title: 'Second' }],
    });

    const firstId = (await first).changes[0]?.artifactId;
    const removed = store.remove(firstId!);
    const afterRemove = store.list();

    await expect(removed).resolves.toMatchObject({
      changes: [
        {
          action: 'removed',
          artifactId: firstId,
          reason: 'explicit',
        },
      ],
    });
    await expect(afterRemove).resolves.toMatchObject({
      artifacts: [{ title: 'Second' }],
    });
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
    const upgraded = await store.upsertMany(
      [
        {
          title: 'Published',
          storage: 'published',
          url: 'https://example.com/artifact',
          managedId: 'managed-1',
        },
      ],
      { trustedPublisher: true },
    );

    expect(upgraded.changes).toHaveLength(1);
    expect(upgraded.changes[0]).toMatchObject({
      action: 'updated',
      artifact: {
        title: 'Published',
        storage: 'published',
        managedId: 'managed-1',
      },
    });
    expect(upgraded.changes[0]?.artifact).not.toHaveProperty('workspacePath');
  });

  it('uses managedId as identity when published artifacts also include a url', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's2-managed-identity',
      workspaceCwd: workspace,
    });

    const first = await store.upsertMany(
      [
        {
          title: 'Published A',
          storage: 'published',
          managedId: 'managed-a',
          url: 'https://example.com/shared',
        },
      ],
      { strict: true, trustedPublisher: true },
    );
    const second = await store.upsertMany(
      [
        {
          title: 'Published B',
          storage: 'published',
          managedId: 'managed-b',
          url: 'https://example.com/shared',
        },
      ],
      { strict: true, trustedPublisher: true },
    );

    expect(first.changes[0]?.action).toBe('created');
    expect(second.changes[0]?.action).toBe('created');
    expect((await store.list()).artifacts).toEqual([
      expect.objectContaining({ managedId: 'managed-a' }),
      expect.objectContaining({ managedId: 'managed-b' }),
    ]);
  });

  it('updates a republished managed artifact when its published url changes', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's2-published-refresh',
      workspaceCwd: workspace,
    });

    await store.upsertMany(
      [
        {
          title: 'Published A',
          storage: 'published',
          managedId: 'managed-a',
          url: 'https://old.example.com/artifact',
        },
      ],
      { strict: true, trustedPublisher: true },
    );
    const refreshed = await store.upsertMany(
      [
        {
          title: 'Published B',
          storage: 'published',
          managedId: 'managed-a',
          url: 'https://new.example.com/artifact',
        },
      ],
      { strict: true, trustedPublisher: true },
    );

    expect(refreshed.changes).toHaveLength(1);
    expect(refreshed.changes[0]).toMatchObject({
      action: 'updated',
      artifact: {
        title: 'Published B',
        url: 'https://new.example.com/artifact',
      },
    });
    expect((await store.list()).artifacts).toHaveLength(1);
  });

  it('upgrades a workspace artifact when the artifact tool publishes the same path', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's2-workspace-published',
      workspaceCwd: workspace,
    });
    await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
    const artifactPath = path.join(workspace, 'reports/dashboard.html');
    const artifactUrl = pathToFileURL(artifactPath).href;
    await fs.writeFile(artifactPath, 'hello');

    const created = await store.upsertMany(
      [{ title: 'Draft', workspacePath: 'reports/dashboard.html' }],
      { strict: true },
    );
    const upgraded = await store.upsertMany(
      [
        {
          title: 'Published dashboard',
          storage: 'published',
          managedId: managedIdForWorkspacePath('reports/dashboard.html'),
          url: artifactUrl,
          mimeType: 'text/html',
        },
      ],
      { strict: true, trustedPublisher: true },
    );

    const publishedId = upgraded.changes[0]?.artifact?.id;
    expect(publishedId).toBeDefined();
    expect(publishedId).not.toBe(created.changes[0]?.artifactId);
    expect(upgraded.changes).toHaveLength(1);
    expect(upgraded.changes[0]).toMatchObject({
      action: 'updated',
      artifactId: publishedId,
      artifact: {
        storage: 'published',
        title: 'Published dashboard',
        managedId: managedIdForWorkspacePath('reports/dashboard.html'),
        url: artifactUrl,
      },
    });
    expect(upgraded.changes[0]?.artifact).not.toHaveProperty('workspacePath');
    expect((await store.list()).artifacts).toMatchObject([{ id: publishedId }]);

    const republished = await store.upsertMany(
      [
        {
          title: 'Republished dashboard',
          storage: 'published',
          managedId: managedIdForWorkspacePath('reports/dashboard.html'),
          url: artifactUrl,
          mimeType: 'text/html',
        },
      ],
      { strict: true, trustedPublisher: true },
    );

    expect(republished.changes).toHaveLength(1);
    expect(republished.changes[0]).toMatchObject({
      action: 'updated',
      artifactId: publishedId,
      artifact: {
        id: publishedId,
        storage: 'published',
        title: 'Republished dashboard',
        managedId: managedIdForWorkspacePath('reports/dashboard.html'),
        url: artifactUrl,
      },
    });
    expect((await store.list()).artifacts).toHaveLength(1);
  });

  it('keeps published artifacts detached when their original workspace path is recorded again', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's2-published-rerecord-workspace',
      workspaceCwd: workspace,
    });
    await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
    const artifactPath = path.join(workspace, 'reports/dashboard.html');
    const artifactUrl = pathToFileURL(artifactPath).href;
    await fs.writeFile(artifactPath, 'hello');

    await store.upsertMany(
      [{ title: 'Draft', workspacePath: 'reports/dashboard.html' }],
      { strict: true },
    );
    const upgraded = await store.upsertMany(
      [
        {
          title: 'Published dashboard',
          storage: 'published',
          managedId: managedIdForWorkspacePath('reports/dashboard.html'),
          url: artifactUrl,
          mimeType: 'text/html',
        },
      ],
      { strict: true, trustedPublisher: true },
    );
    const publishedId = upgraded.changes[0]?.artifactId;

    const repeated = await store.upsertMany(
      [{ title: 'Draft again', workspacePath: 'reports/dashboard.html' }],
      { strict: true },
    );

    expect(repeated.changes).toEqual([]);
    const artifact = (await store.list()).artifacts[0];
    expect(artifact).toMatchObject({
      id: publishedId,
      storage: 'published',
      status: 'available',
      url: artifactUrl,
    });
    expect(artifact).not.toHaveProperty('workspacePath');

    await fs.rm(artifactPath);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6_000));
    try {
      await expect(store.list()).resolves.toMatchObject({
        artifacts: [
          expect.objectContaining({
            id: publishedId,
            storage: 'published',
            status: 'available',
          }),
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts trusted published file urls outside the workspace', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's2-published-file-url',
      workspaceCwd: workspace,
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.html'), 'secret');
      await expect(
        store.upsertMany(
          [
            {
              title: 'Outside file',
              storage: 'published',
              managedId: 'outside-file',
              url: pathToFileURL(path.join(outside, 'secret.html')).href,
            },
          ],
          { strict: true, trustedPublisher: true },
        ),
      ).resolves.toMatchObject({
        changes: [
          {
            artifact: {
              storage: 'published',
              url: pathToFileURL(path.join(outside, 'secret.html')).href,
            },
          },
        ],
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects untrusted file urls', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's2-untrusted-file-url',
      workspaceCwd: workspace,
    });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Local file',
            url: pathToFileURL(path.join(workspace, 'report.html')).href,
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'url' });
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

  it('evicts the oldest client-retained artifact when no other overflow candidate exists', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's3-retained',
      workspaceCwd: workspace,
      maxArtifacts: 2,
    });

    const first = await store.upsertMany([
      {
        title: 'Retained one',
        source: 'client',
        url: 'https://example.com/retained-one',
      },
    ]);
    const second = await store.upsertMany([
      {
        title: 'Retained two',
        source: 'client',
        url: 'https://example.com/retained-two',
      },
    ]);

    const overflow = await store.upsertMany([
      { title: 'Tool overflow', url: 'https://example.com/tool-overflow' },
    ]);

    expect(overflow.changes).toContainEqual(
      expect.objectContaining({
        action: 'removed',
        artifactId: first.changes[0]?.artifactId,
        reason: 'eviction',
      }),
    );
    expect(
      (await store.list()).artifacts.map((artifact) => artifact.id),
    ).toEqual([second.changes[0]?.artifactId, overflow.changes[0]?.artifactId]);
  });

  it('writes eviction removals to durable persistence', async () => {
    const events: SessionArtifactEventRecordPayload[] = [];
    const store = new SessionArtifactStore({
      sessionId: 's3-durable-eviction',
      workspaceCwd: workspace,
      maxArtifacts: 1,
      persistence: {
        recordEvent: async (payload) => {
          events.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    const first = await store.upsertMany(
      [{ title: 'First', url: 'https://example.com/first' }],
      { strict: true },
    );
    await store.upsertMany(
      [{ title: 'Second', url: 'https://example.com/second' }],
      { strict: true },
    );

    expect(events.at(-1)?.changes).toContainEqual(
      expect.objectContaining({
        action: 'removed',
        artifactId: first.changes[0]?.artifactId,
        reason: 'eviction',
      }),
    );
  });

  it('drops newest artifacts created in the same batch when no older eviction candidate exists', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's3-same-batch-overflow',
      workspaceCwd: workspace,
      maxArtifacts: 1,
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never);

    try {
      const overflow = await store.upsertMany([
        { title: 'First link', url: 'https://example.com/first' },
        { title: 'Second link', url: 'https://example.com/second' },
      ]);

      expect(overflow.changes).toHaveLength(1);
      expect(overflow.changes[0]?.artifact).toMatchObject({
        title: 'First link',
      });
      await expect(store.list()).resolves.toMatchObject({
        artifacts: [{ title: 'First link' }],
      });

      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('action=dropped');
      expect(logged).toContain('max artifacts exceeded');
    } finally {
      stderr.mockRestore();
    }
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

  it('accepts workspace entries whose names start with two dots', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's4-dot-prefix',
      workspaceCwd: workspace,
    });
    await fs.mkdir(path.join(workspace, '..data'), { recursive: true });
    await fs.writeFile(path.join(workspace, '..data/report.html'), 'hello');

    await expect(
      store.upsertMany(
        [{ title: 'Projected volume', workspacePath: '..data/report.html' }],
        { strict: true },
      ),
    ).resolves.toMatchObject({
      changes: [
        {
          artifact: {
            workspacePath: '..data/report.html',
            status: 'available',
          },
        },
      ],
    });
  });

  it('drops invalid artifacts in non-strict batches and keeps valid ones', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's4-non-strict',
      workspaceCwd: workspace,
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never);

    try {
      const result = await store.upsertMany([
        {
          title: 'Forged',
          storage: 'published',
          url: 'https://example.com/forged',
        },
        {
          title: 'Valid',
          url: 'https://example.com/valid',
        },
      ]);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]?.artifact).toMatchObject({ title: 'Valid' });
      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('published artifacts are reserved');
    } finally {
      stderr.mockRestore();
    }
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
      metadata: { owner: 'first' },
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
        metadata: { toolKey: 'added', toString: 'own-key' },
      },
    ]);
    expect(repeatedTool.changes[0]?.artifact).toMatchObject({
      title: 'Tool title',
      source: 'tool',
      toolName: 'first_tool',
      metadata: {
        owner: 'first',
        toolKey: 'added',
        toString: 'own-key',
      },
    });
    expect(
      Object.hasOwn(
        repeatedTool.changes[0]?.artifact?.metadata ?? {},
        'toString',
      ),
    ).toBe(true);
    expect(repeatedTool.changes[0]?.artifact?.metadata).not.toHaveProperty(
      'hookKey',
    );
  });

  it('logs and keeps existing metadata when a merge would exceed the limit', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-metadata-overflow',
      workspaceCwd: workspace,
    });
    const largeValue = 'x'.repeat(4070);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never);

    try {
      const created = await store.upsertMany(
        [
          {
            title: 'Link',
            url: 'https://example.com/resource',
            metadata: { blob: largeValue },
          },
        ],
        { strict: true },
      );
      const artifactId = created.changes[0]?.artifactId;

      const repeated = await store.upsertMany(
        [
          {
            title: 'Ignored title',
            url: 'https://example.com/resource',
            metadata: { extra: 'y'.repeat(20) },
          },
        ],
        { strict: true },
      );

      expect(repeated.changes).toEqual([]);
      expect((await store.list()).artifacts[0]?.metadata).toEqual({
        blob: largeValue,
      });
      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('metadata_merge_dropped');
      expect(logged).toContain(artifactId);
    } finally {
      stderr.mockRestore();
    }
  });

  it('does not count injected workspace hash metadata against the merge limit', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-workspace-metadata-merge-budget',
      workspaceCwd: workspace,
    });
    const workspacePath = 'merge-budget.txt';
    const metadata = { payload: 'x'.repeat(4096) };
    while (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) {
      metadata.payload = metadata.payload.slice(0, -1);
    }
    await fs.writeFile(path.join(workspace, workspacePath), 'before');
    const oldSha = createHash('sha256').update('before').digest('hex');

    await store.upsertMany([{ title: 'Budget', workspacePath, metadata }], {
      strict: true,
    });
    await fs.writeFile(path.join(workspace, workspacePath), 'after');
    const newSha = createHash('sha256').update('after').digest('hex');

    const updated = await store.upsertMany(
      [{ title: 'Budget update', workspacePath }],
      { strict: true },
    );

    expect(updated.changes[0]?.artifact).toMatchObject({
      metadata: {
        payload: metadata.payload,
        'qwen.workspace.sha256': newSha,
        'qwen.workspace.mtimeMs': expect.any(Number),
      },
      status: 'available',
    });
    expect(updated.changes[0]?.artifact?.metadata).not.toMatchObject({
      'qwen.workspace.sha256': oldSha,
    });
  });

  it('does not merge client metadata into a published tool artifact', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-published-metadata-source',
      workspaceCwd: workspace,
    });

    await store.upsertMany(
      [
        {
          title: 'Published',
          storage: 'published',
          url: 'https://example.com/published',
          metadata: { publisher: 'tool' },
        },
      ],
      { strict: true, trustedPublisher: true },
    );

    const clientUpdate = await store.upsertMany([
      {
        title: 'Client link',
        source: 'client',
        clientId: 'client-1',
        url: 'https://example.com/published',
        metadata: { injected: 'client' },
      },
    ]);

    expect(clientUpdate.changes[0]?.artifact).toMatchObject({
      source: 'tool',
      clientRetained: true,
      metadata: { publisher: 'tool' },
    });
    expect(clientUpdate.changes[0]?.artifact?.metadata).not.toHaveProperty(
      'injected',
    );
  });

  it('coalesces duplicate identities within one upsert batch', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-coalesce',
      workspaceCwd: workspace,
    });

    const result = await store.upsertMany([
      {
        title: 'Tool title',
        source: 'tool',
        toolName: 'first_tool',
        url: 'https://example.com/same',
        metadata: { owner: 'tool' },
      },
      {
        title: 'Client title',
        source: 'client',
        clientId: 'client-1',
        url: 'https://example.com/same',
        metadata: { retainedBy: 'client' },
      },
      {
        title: 'Hook title',
        source: 'hook',
        hookEventName: 'PostToolUse',
        url: 'https://example.com/same',
        metadata: { hookKey: 'ignored' },
      },
    ]);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.artifact).toMatchObject({
      title: 'Tool title',
      source: 'tool',
      toolName: 'first_tool',
      clientRetained: true,
      metadata: { owner: 'tool' },
    });
    expect(result.changes[0]?.artifact).not.toHaveProperty('clientId');
    expect(result.changes[0]?.artifact).not.toHaveProperty('hookEventName');
    expect(result.changes[0]?.artifact?.metadata).not.toHaveProperty('hookKey');
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [{ title: 'Tool title' }],
    });
  });

  it('keeps strongest retention when coalescing duplicate identities', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-coalesce-retention',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {},
        recordSnapshot: async () => {},
      },
    });

    const result = await store.upsertMany(
      [
        {
          title: 'Ephemeral',
          url: 'https://example.com/retention',
          retention: 'ephemeral',
        },
        {
          title: 'Restorable',
          url: 'https://example.com/retention',
          retention: 'restorable',
        },
      ],
      { strict: true },
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.artifact).toMatchObject({
      title: 'Ephemeral',
      retention: 'restorable',
    });
  });

  it('infers artifact kind from storage and workspace extensions', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-kind',
      workspaceCwd: workspace,
    });

    const result = await store.upsertMany([
      { title: 'Page', workspacePath: 'reports/index.html' },
      { title: 'Image', workspacePath: 'screenshots/app.png' },
      { title: 'Notebook', workspacePath: 'analysis/run.ipynb' },
      { title: 'Unknown file', workspacePath: 'artifacts/blob.unknown' },
      { title: 'Managed item', managedId: 'ext-123' },
    ]);

    expect(result.changes.map((change) => change.artifact?.kind)).toEqual([
      'html',
      'image',
      'notebook',
      'file',
      'other',
    ]);
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
        [{ title: 'onload=alert(1)', url: 'https://example.com/onload' }],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'conversation=value',
            description: 'configuration=value',
            url: 'https://example.com/benign',
          },
        ],
        { strict: true },
      ),
    ).resolves.toMatchObject({
      changes: [{ action: 'created' }],
    });

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

    await expect(
      store.upsertMany(
        [
          {
            title: '<style>body{background:url(https://example.com/x)}</style>',
            url: 'https://example.com/style',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Workspace payload',
            workspacePath: '<img src=x onerror=alert(1)>.html',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'workspacePath' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Managed payload',
            managedId: '<script>alert(1)</script>',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'managedId' });

    for (const managedId of ['../secret', 'folder/item', 'folder\\item']) {
      await expect(
        store.upsertMany([{ title: 'Managed path', managedId }], {
          strict: true,
        }),
      ).rejects.toMatchObject({ field: 'managedId' });
    }

    await expect(
      store.upsertMany(
        [
          {
            title: 'safe\u2028evil',
            url: 'https://example.com/line-separator',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'safe\u2066evil',
            url: 'https://example.com/bidi-isolate',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Report',
            description: '<a href="data:text/html,<script>alert(1)</script>">',
            url: 'https://example.com/data',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'description' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Report',
            description: 'data:text/javascript,alert(1)',
            url: 'https://example.com/data-js',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'description' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Report',
            description:
              'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
            url: 'https://example.com/data-svg',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'description' });

    await expect(
      store.upsertMany(
        [
          {
            title: '&lt;script&gt;alert(1)&lt;/script&gt;',
            url: 'https://example.com/entity',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'safe\u202eevil',
            url: 'https://example.com/bidi',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Report',
            url: 'https://example.com/metadata',
            metadata: { preview: '<iframe src="https://example.com">' },
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'metadata' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Report',
            url: 'https://example.com/metadata-key',
            metadata: { '<script>': 'unsafe key' },
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'metadata' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Report',
            url: 'https://example.com/mime',
            mimeType: 'text/html<script>',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'mimeType' });
  });

  it('rejects external urls with credentials', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-url-credentials',
      workspaceCwd: workspace,
    });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Credentialed link',
            url: 'https://user:pass@example.com/report',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'url' });
  });

  it('accepts line whitespace in descriptions but not titles', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-line-whitespace',
      workspaceCwd: workspace,
    });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Multiline report',
            description: 'Line one\nLine two\tindented\r\nLine three',
            url: 'https://example.com/multiline',
          },
        ],
        { strict: true },
      ),
    ).resolves.toMatchObject({
      changes: [
        {
          artifact: {
            description: 'Line one\nLine two\tindented\r\nLine three',
          },
        },
      ],
    });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Bad\nTitle',
            url: 'https://example.com/bad-title',
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'title' });
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

  it('filters prototype metadata keys without changing object prototype', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-prototype-metadata',
      workspaceCwd: workspace,
    });
    const metadata = JSON.parse(
      '{"__proto__":null,"constructor":"blocked","prototype":"blocked","safe":"ok"}',
    ) as Record<string, string | number | boolean | null>;

    const created = await store.upsertMany([
      {
        title: 'Link',
        url: 'https://example.com/prototype-metadata',
        metadata,
      },
    ]);
    const normalized = created.changes[0]?.artifact?.metadata;

    expect(normalized).toEqual({ safe: 'ok' });
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(normalized, 'constructor'),
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(normalized, 'prototype')).toBe(
      false,
    );
  });

  it('rejects non-finite metadata numbers', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-finite-metadata',
      workspaceCwd: workspace,
    });

    await expect(
      store.upsertMany(
        [
          {
            title: 'NaN metadata',
            url: 'https://example.com/nan',
            metadata: { score: Number.NaN },
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'metadata' });

    await expect(
      store.upsertMany(
        [
          {
            title: 'Infinite metadata',
            url: 'https://example.com/infinity',
            metadata: { score: Number.POSITIVE_INFINITY },
          },
        ],
        { strict: true },
      ),
    ).rejects.toMatchObject({ field: 'metadata' });
  });

  it('ignores metadata key order when detecting updates', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's5-metadata-order',
      workspaceCwd: workspace,
    });

    const created = await store.upsertMany([
      {
        title: 'Link',
        url: 'https://example.com/resource',
        metadata: { a: 1, b: 2 },
      },
    ]);
    const firstUpdatedAt = created.changes[0]?.artifact?.updatedAt;

    const repeated = await store.upsertMany([
      {
        title: 'Ignored later title',
        url: 'https://example.com/resource',
        metadata: { b: 2, a: 1 },
      },
    ]);

    expect(repeated.changes).toEqual([]);
    expect((await store.list()).artifacts[0]?.updatedAt).toBe(firstUpdatedAt);
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
      vi.useRealTimers();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects workspace symlinks that resolve to the workspace root', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's6-root-symlink',
      workspaceCwd: workspace,
    });
    await fs.symlink(workspace, path.join(workspace, 'root-link'));

    await expect(
      store.upsertMany([{ title: 'Root', workspacePath: 'root-link' }], {
        strict: true,
      }),
    ).rejects.toMatchObject({ field: 'workspacePath' });
  });

  it('rejects dangling symlinks that point outside the workspace', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's6-dangling-symlink',
      workspaceCwd: workspace,
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outside-'));
    try {
      await fs.symlink(
        path.join(outside, 'missing.txt'),
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

  it('marks dangling symlinks that point inside the workspace as missing', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's6-dangling-internal-symlink',
      workspaceCwd: workspace,
    });
    await fs.symlink(
      'missing.txt',
      path.join(workspace, 'internal-missing.txt'),
    );

    await expect(
      store.upsertMany(
        [
          {
            title: 'Missing internal link',
            workspacePath: 'internal-missing.txt',
          },
        ],
        { strict: true },
      ),
    ).resolves.toMatchObject({
      changes: [
        {
          artifact: {
            status: 'missing',
            workspacePath: 'internal-missing.txt',
          },
        },
      ],
    });
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6_000));
    const missing = (await store.list()).artifacts[0];
    expect(missing).toMatchObject({ status: 'missing' });
    expect(missing).not.toHaveProperty('sizeBytes');
  });

  it('marks a stored workspace artifact missing if it later escapes by symlink', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's7-symlink-refresh',
      workspaceCwd: workspace,
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outside-'));
    try {
      await fs.writeFile(path.join(workspace, 'report.txt'), 'hello');
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
      await store.upsertMany(
        [{ title: 'Report', workspacePath: 'report.txt' }],
        { strict: true },
      );

      await fs.rm(path.join(workspace, 'report.txt'));
      await fs.symlink(
        path.join(outside, 'secret.txt'),
        path.join(workspace, 'report.txt'),
      );

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 6_000));
      const artifact = (await store.list()).artifacts[0];
      expect(artifact).toMatchObject({
        status: 'missing',
        storage: 'workspace',
      });
      expect(artifact).not.toHaveProperty('workspacePath');
      expect(artifact).not.toHaveProperty('sizeBytes');
    } finally {
      vi.useRealTimers();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('restores workspacePath when a healed artifact is recorded again', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's7-symlink-healed',
      workspaceCwd: workspace,
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outside-'));
    try {
      await fs.writeFile(path.join(workspace, 'report.txt'), 'hello');
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
      const created = await store.upsertMany(
        [{ title: 'Report', workspacePath: 'report.txt' }],
        { strict: true },
      );

      await fs.rm(path.join(workspace, 'report.txt'));
      await fs.symlink(
        path.join(outside, 'secret.txt'),
        path.join(workspace, 'report.txt'),
      );

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 6_000));
      expect((await store.list()).artifacts[0]).not.toHaveProperty(
        'workspacePath',
      );

      await fs.rm(path.join(workspace, 'report.txt'));
      await fs.writeFile(path.join(workspace, 'report.txt'), 'healed');
      const healed = await store.upsertMany([
        { title: 'Report', workspacePath: 'report.txt' },
      ]);

      expect(healed.changes).toContainEqual(
        expect.objectContaining({
          action: 'updated',
          artifactId: created.changes[0]?.artifactId,
          artifact: expect.objectContaining({
            status: 'available',
            workspacePath: 'report.txt',
            sizeBytes: 6,
          }),
        }),
      );
      expect((await store.list()).artifacts[0]).toMatchObject({
        status: 'available',
        workspacePath: 'report.txt',
      });
    } finally {
      vi.useRealTimers();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('resets cached workspace realpath after a refresh failure', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's7-realpath-error',
      workspaceCwd: workspace,
    });
    const realpathSpy = vi
      .spyOn(fs, 'realpath')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

    try {
      await expect(
        store.upsertMany([{ title: 'Denied', workspacePath: 'denied.txt' }], {
          strict: true,
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        field: 'workspacePath',
        message: 'workspacePath could not be inspected: permission denied',
      });

      await expect(
        store.upsertMany([{ title: 'Denied', workspacePath: 'denied.txt' }], {
          strict: true,
        }),
      ).resolves.toMatchObject({
        changes: [expect.objectContaining({ action: 'created' })],
      });
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('marks workspace artifact missing when list refresh hits a transient fs error', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's7-list-refresh-error',
      workspaceCwd: workspace,
    });
    await fs.writeFile(path.join(workspace, 'report.txt'), 'hello');
    await store.upsertMany([{ title: 'Report', workspacePath: 'report.txt' }], {
      strict: true,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6_000));
    const realpathSpy = vi
      .spyOn(fs, 'realpath')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never);

    try {
      const artifact = (await store.list()).artifacts[0];
      expect(artifact).toMatchObject({ status: 'missing' });
      expect(artifact).not.toHaveProperty('sizeBytes');
      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('status_refresh_failed');
      expect(logged).toContain('permission denied');
    } finally {
      vi.useRealTimers();
      realpathSpy.mockRestore();
      stderr.mockRestore();
    }
  });

  it('caches the workspace root realpath across artifact refreshes', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's7-realpath-cache',
      workspaceCwd: workspace,
    });
    await fs.writeFile(path.join(workspace, 'one.txt'), 'one');
    await fs.writeFile(path.join(workspace, 'two.txt'), 'two');
    const realpathSpy = vi.spyOn(fs, 'realpath');

    try {
      await store.upsertMany([
        { title: 'One', workspacePath: 'one.txt' },
        { title: 'Two', workspacePath: 'two.txt' },
      ]);
      await store.list();

      expect(
        realpathSpy.mock.calls.filter(([target]) => target === workspace),
      ).toHaveLength(1);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('uses cached workspace status while the refresh ttl is fresh', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's7-status-cache',
      workspaceCwd: workspace,
    });
    await fs.writeFile(path.join(workspace, 'report.txt'), 'hello');
    await store.upsertMany([{ title: 'Report', workspacePath: 'report.txt' }], {
      strict: true,
    });

    const realpathSpy = vi.spyOn(fs, 'realpath');
    try {
      await store.list();
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6_000));

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

  it('keeps fresh cached workspace status during overflow eviction', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's8-fresh-overflow-cache',
      workspaceCwd: workspace,
      maxArtifacts: 2,
    });
    const restored = await store.upsertMany([
      { title: 'Restored later', workspacePath: 'restored.txt' },
    ]);
    await store.upsertMany([
      { title: 'Still missing', workspacePath: 'still-missing.txt' },
    ]);
    await fs.writeFile(path.join(workspace, 'restored.txt'), 'ok');

    const overflow = await store.upsertMany([
      { title: 'New link', url: 'https://example.com/new' },
    ]);

    expect(overflow.changes).toContainEqual(
      expect.objectContaining({
        action: 'removed',
        artifactId: restored.changes[0]?.artifactId,
        reason: 'eviction',
      }),
    );
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

  it('records durable artifact events through the persistence hook', async () => {
    const events: SessionArtifactEventRecordPayload[] = [];
    const store = new SessionArtifactStore({
      sessionId: 's11-persist',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          events.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });

    const created = await store.upsertMany(
      [{ title: 'Durable', url: 'https://example.com/durable' }],
      { strict: true },
    );

    expect(created.changes[0]?.artifact).toMatchObject({
      retention: 'restorable',
      restoreState: 'live',
    });
    expect(created.changes[0]?.artifact?.persistedAt).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's11-persist',
      sequence: 1,
      changes: [
        {
          action: 'created',
          artifact: expect.objectContaining({
            title: 'Durable',
            retention: 'restorable',
          }),
        },
      ],
    });

    const artifactId = created.changes[0]!.artifactId;
    await store.remove(artifactId);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      sequence: 2,
      changes: [
        {
          action: 'removed',
          artifactId,
          reason: 'explicit',
        },
      ],
    });
  });

  it('records periodic snapshots after durable artifact events', async () => {
    const events: SessionArtifactEventRecordPayload[] = [];
    const snapshots: SessionArtifactSnapshotRecordPayload[] = [];
    const store = new SessionArtifactStore({
      sessionId: 's11-snapshot',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          events.push(payload);
        },
        recordSnapshot: async (payload) => {
          snapshots.push(payload);
        },
      },
    });

    for (let index = 0; index < 50; index++) {
      await store.upsertMany(
        [
          {
            title: `Durable ${index}`,
            url: `https://example.com/durable-${index}`,
          },
        ],
        { strict: true },
      );
    }

    expect(events).toHaveLength(50);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      sessionId: 's11-snapshot',
      sequence: 51,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          title: 'Durable 0',
          retention: 'restorable',
        }),
        expect.objectContaining({
          title: 'Durable 49',
          retention: 'restorable',
        }),
      ]),
    });
    expect(snapshots[0]?.artifacts).toHaveLength(50);

    await store.upsertMany(
      [{ title: 'Durable 50', url: 'https://example.com/durable-50' }],
      { strict: true },
    );

    expect(events).toHaveLength(51);
    expect(snapshots).toHaveLength(1);
    expect(events[50]).toMatchObject({ sequence: 52 });
  });

  it('backs off snapshot retries after a write failure and resets after success', async () => {
    let snapshotAttempts = 0;
    const snapshots: SessionArtifactSnapshotRecordPayload[] = [];
    const store = new SessionArtifactStore({
      sessionId: 's11-snapshot-failure',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {},
        recordSnapshot: async (payload) => {
          snapshotAttempts++;
          if (snapshotAttempts === 1) {
            throw new Error('disk full');
          }
          snapshots.push(payload);
        },
      },
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never);

    try {
      for (let index = 0; index < 50; index++) {
        await store.upsertMany(
          [
            {
              title: `Durable ${index}`,
              url: `https://example.com/snapshot-failure-${index}`,
            },
          ],
          { strict: true },
        );
      }
      expect(snapshotAttempts).toBe(1);
      expect(snapshots).toHaveLength(0);

      await store.upsertMany(
        [
          {
            title: 'Durable after failure',
            url: 'https://example.com/snapshot-after-failure',
          },
        ],
        { strict: true },
      );
      expect(snapshotAttempts).toBe(1);
      expect(snapshots).toHaveLength(0);

      for (let index = 51; index < 100; index++) {
        await store.upsertMany(
          [
            {
              title: `Durable retry ${index}`,
              url: `https://example.com/snapshot-retry-${index}`,
            },
          ],
          { strict: true },
        );
      }
      expect(snapshotAttempts).toBe(2);
      expect(snapshots).toHaveLength(1);

      for (let index = 100; index < 149; index++) {
        await store.upsertMany(
          [
            {
              title: `Durable reset ${index}`,
              url: `https://example.com/snapshot-reset-${index}`,
            },
          ],
          { strict: true },
        );
      }
      expect(snapshotAttempts).toBe(2);

      await store.upsertMany(
        [
          {
            title: 'Durable after reset',
            url: 'https://example.com/snapshot-after-reset',
          },
        ],
        { strict: true },
      );
      expect(snapshotAttempts).toBe(3);
      expect(snapshots).toHaveLength(2);

      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('snapshot_failed');
    } finally {
      stderr.mockRestore();
    }
  });

  it('keeps explicit tombstones in periodic snapshots', async () => {
    const snapshots: SessionArtifactSnapshotRecordPayload[] = [];
    const store = new SessionArtifactStore({
      sessionId: 's11-tombstone-snapshot',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {},
        recordSnapshot: async (payload) => {
          snapshots.push(payload);
        },
      },
    });
    const created = await store.upsertMany(
      [{ title: 'Deleted', url: 'https://example.com/deleted' }],
      { strict: true },
    );
    const deletedId = created.changes[0]!.artifactId;
    await store.remove(deletedId);
    for (let index = 0; index < 48; index++) {
      await store.upsertMany(
        [
          {
            title: `Durable ${index}`,
            url: `https://example.com/tombstone-${index}`,
          },
        ],
        { strict: true },
      );
    }

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      tombstonedIds: [deletedId],
      stickyEphemeralIds: [],
    });
    expect(
      snapshots[0]?.artifacts.some((artifact) => artifact.id === deletedId),
    ).toBe(false);

    const suppressed = await store.upsertMany([
      { title: 'Deleted', url: 'https://example.com/deleted' },
    ]);
    expect(suppressed.changes).toEqual([]);
  });

  it('suppresses implicit upserts for restored tombstones', async () => {
    const sessionId = 's11-restored-tombstone';
    const input = {
      title: 'Old tool result',
      url: 'https://example.com/tombstoned',
    };
    const seed = new SessionArtifactStore({
      sessionId,
      workspaceCwd: workspace,
    });
    const artifactId = (await seed.upsertMany([input])).changes[0]!.artifactId;
    const store = new SessionArtifactStore({
      sessionId,
      workspaceCwd: workspace,
    });

    await store.restore({
      v: 2,
      sessionId,
      sequence: 1,
      artifacts: [],
      tombstonedIds: [artifactId],
      stickyEphemeralIds: [],
      warnings: [],
    });
    const suppressed = await store.upsertMany([input]);
    expect(suppressed.changes).toEqual([]);

    const explicitClient = await store.upsertMany([
      {
        ...input,
        source: 'client',
        clientId: 'client-a',
        retention: 'restorable',
      },
    ]);
    expect(explicitClient.changes).toEqual([]);
  });

  it('keeps restore warnings visible on the artifact list', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's11-restore-warnings',
      workspaceCwd: workspace,
    });

    await store.restore({
      v: 2,
      sessionId: 's11-restore-warnings',
      sequence: 1,
      artifacts: [],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: ['skipped corrupt artifact record'],
    });

    await expect(store.list()).resolves.toMatchObject({
      warnings: ['skipped corrupt artifact record'],
    });
  });

  it('keeps live artifacts when rewind restore has no snapshot', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's11-restore-empty-rewind',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {},
        recordSnapshot: async () => {},
      },
    });

    const durable = await store.upsertMany(
      [{ title: 'Durable', url: 'https://example.com/durable-rewind' }],
      { strict: true },
    );
    const ephemeral = await store.upsertMany([
      {
        title: 'Live only',
        url: 'https://example.com/live-only-rewind',
        retention: 'ephemeral',
      },
    ]);

    await expect(
      store.restore(undefined, { preserveLiveEphemeral: true }),
    ).resolves.toEqual([]);
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: durable.changes[0]?.artifactId,
          title: 'Durable',
          retention: 'restorable',
        },
        {
          id: ephemeral.changes[0]?.artifactId,
          title: 'Live only',
          retention: 'ephemeral',
        },
      ],
    });
  });

  it('resets durable event snapshot cadence after restore', async () => {
    const snapshots: SessionArtifactSnapshotRecordPayload[] = [];
    const store = new SessionArtifactStore({
      sessionId: 's11-restore-snapshot-cadence',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {},
        recordSnapshot: async (payload) => {
          snapshots.push(payload);
        },
      },
    });

    for (let index = 0; index < 49; index++) {
      await store.upsertMany(
        [
          {
            title: `Before restore ${index}`,
            url: `https://example.com/before-restore-${index}`,
          },
        ],
        { strict: true },
      );
    }
    expect(snapshots).toHaveLength(0);

    await store.restore({
      v: 2,
      sessionId: 's11-restore-snapshot-cadence',
      sequence: 100,
      artifacts: [],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    });
    await store.upsertMany(
      [
        {
          title: 'After restore',
          url: 'https://example.com/after-restore',
        },
      ],
      { strict: true },
    );

    expect(snapshots).toHaveLength(0);
  });

  it('drops stale sticky markers when durable eviction removes an artifact', async () => {
    const sourceEvents: SessionArtifactEventRecordPayload[] = [];
    const source = new SessionArtifactStore({
      sessionId: 's11-eviction-sticky',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          sourceEvents.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    await source.upsertMany(
      [{ title: 'Sticky', url: 'https://example.com/sticky' }],
      { strict: true },
    );
    const evictedArtifact = sourceEvents[0]!.changes[0]!.artifact!;
    const snapshots: SessionArtifactSnapshotRecordPayload[] = [];
    const restored = new SessionArtifactStore({
      sessionId: 's11-eviction-sticky',
      workspaceCwd: workspace,
      maxArtifacts: 1,
      persistence: {
        recordEvent: async () => {},
        recordSnapshot: async (payload) => {
          snapshots.push(payload);
        },
      },
    });
    await restored.restore({
      v: 2,
      sessionId: 's11-eviction-sticky',
      sequence: 1,
      artifacts: [evictedArtifact],
      tombstonedIds: [],
      stickyEphemeralIds: [evictedArtifact.id],
      warnings: [],
    });

    for (let index = 0; index < 50; index++) {
      await restored.upsertMany(
        [
          {
            title: `Replacement ${index}`,
            url: `https://example.com/replacement-${index}`,
          },
        ],
        { strict: true },
      );
    }

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.stickyEphemeralIds).not.toContain(evictedArtifact.id);
  });

  it('applies sticky ephemeral markers while restoring durable artifacts', async () => {
    const sourceEvents: SessionArtifactEventRecordPayload[] = [];
    const source = new SessionArtifactStore({
      sessionId: 's11-restore-sticky',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          sourceEvents.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    await source.upsertMany(
      [{ title: 'Sticky', url: 'https://example.com/sticky-restore' }],
      { strict: true },
    );
    const artifact = sourceEvents[0]!.changes[0]!.artifact!;
    const restored = new SessionArtifactStore({
      sessionId: 's11-restore-sticky',
      workspaceCwd: workspace,
    });

    await expect(
      restored.restore({
        v: 2,
        sessionId: 's11-restore-sticky',
        sequence: 1,
        artifacts: [artifact],
        tombstonedIds: [],
        stickyEphemeralIds: [artifact.id],
        warnings: [],
      }),
    ).resolves.toEqual([]);

    await expect(restored.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: artifact.id,
          retention: 'ephemeral',
          persistenceWarning: 'sticky_override_active',
        },
      ],
    });
  });

  it('downgrades non-strict durable artifacts when persistence is unavailable', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's11-unavailable',
      workspaceCwd: workspace,
    });

    const result = await store.upsertMany([
      {
        title: 'Requested durable',
        url: 'https://example.com/durable',
        retention: 'restorable',
      },
    ]);

    expect(result.warnings).toEqual([
      'artifact persistence unavailable; durable artifacts kept ephemeral',
    ]);
    expect(result.changes[0]?.artifact).toMatchObject({
      retention: 'ephemeral',
      persistenceWarning: 'persistence_unavailable',
    });
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        expect.objectContaining({
          retention: 'ephemeral',
          persistenceWarning: 'persistence_unavailable',
        }),
      ],
    });
  });

  it('rolls back strict mutations when persistence fails', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's11-rollback',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {
          throw new Error('disk full');
        },
        recordSnapshot: async () => {},
      },
    });

    await expect(
      store.upsertMany(
        [{ title: 'Rollback', url: 'https://example.com/rollback' }],
        { strict: true },
      ),
    ).rejects.toThrow('disk full');
    await expect(store.list()).resolves.toMatchObject({ artifacts: [] });
  });

  it('keeps live removal when explicit tombstone persistence fails', async () => {
    let calls = 0;
    const store = new SessionArtifactStore({
      sessionId: 's11-remove-live-first',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {
          calls++;
          if (calls > 1) {
            throw new Error('disk full');
          }
        },
        recordSnapshot: async () => {},
      },
    });
    const created = await store.upsertMany(
      [{ title: 'Sensitive', url: 'https://example.com/sensitive' }],
      { strict: true },
    );

    await expect(store.remove(created.changes[0]!.artifactId)).resolves.toEqual(
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            action: 'removed',
            artifactId: created.changes[0]?.artifactId,
          }),
        ],
        warnings: ['artifact removal not persisted; live removal kept'],
      }),
    );
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [],
    });
    const replay = await store.upsertMany([
      { title: 'Sensitive', url: 'https://example.com/sensitive' },
    ]);
    expect(replay.changes).toEqual([]);
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [],
    });
  });

  it('writes a tombstone when deleting a downgraded durable artifact', async () => {
    const events: SessionArtifactEventRecordPayload[] = [];
    let failNext = false;
    const store = new SessionArtifactStore({
      sessionId: 's11-downgraded-tombstone',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          if (failNext) {
            failNext = false;
            throw new Error('disk full');
          }
          events.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    const created = await store.upsertMany(
      [{ title: 'Durable', url: 'https://example.com/downgraded' }],
      { strict: true },
    );

    failNext = true;
    const downgraded = await store.upsertMany([
      {
        title: 'Durable',
        url: 'https://example.com/downgraded',
        metadata: { phase: 'updated' },
      },
    ]);
    expect(downgraded.changes[0]?.artifact).toMatchObject({
      retention: 'ephemeral',
      persistenceWarning: 'persistence_unavailable',
    });

    await store.remove(created.changes[0]!.artifactId);

    expect(events.at(-1)?.changes).toEqual([
      expect.objectContaining({
        action: 'removed',
        artifactId: created.changes[0]?.artifactId,
        reason: 'explicit',
      }),
    ]);
  });

  it('restores rebuilt durable artifacts as metadata-only restored entries', async () => {
    const events: SessionArtifactEventRecordPayload[] = [];
    const source = new SessionArtifactStore({
      sessionId: 's11-restore',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          events.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    await source.upsertMany(
      [{ title: 'Restored', url: 'https://example.com/restored' }],
      { strict: true },
    );
    const persisted = events[0]!.changes[0]!.artifact!;
    const snapshot: RebuiltSessionArtifactSnapshot = {
      v: 2,
      sessionId: 's11-restore',
      sequence: 1,
      artifacts: [persisted],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    };

    const restored = new SessionArtifactStore({
      sessionId: 's11-restore',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async () => {
          throw new Error('restore must not write records');
        },
        recordSnapshot: async () => {},
      },
    });

    await expect(restored.restore(snapshot)).resolves.toEqual([]);
    await expect(restored.list()).resolves.toMatchObject({
      artifacts: [
        expect.objectContaining({
          id: persisted.id,
          title: 'Restored',
          retention: 'restorable',
          restoreState: 'restored',
        }),
      ],
    });
  });

  it('keeps live artifacts when a non-empty restore snapshot fully fails', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's11-restore-fail-closed',
      workspaceCwd: workspace,
    });
    const live = await store.upsertMany([
      { title: 'Live', url: 'https://example.com/live' },
    ]);
    const liveId = live.changes[0]!.artifactId;

    const warnings = await store.restore({
      v: 2,
      sessionId: 's11-restore-fail-closed',
      sequence: 8,
      artifacts: [
        {
          id: 'bad-id',
          kind: 'link',
          storage: 'external_url',
          source: 'client',
          status: 'available',
          title: 'Bad',
          url: 'https://example.com/bad',
          retention: 'restorable',
          clientRetained: false,
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
        },
      ],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    });

    expect(warnings).toEqual([
      'skipped artifact with mismatched id bad-id',
      'artifact snapshot restore failed; kept existing live artifacts',
    ]);
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: liveId,
          title: 'Live',
        },
      ],
    });
  });

  it('keeps live artifacts when a non-empty restore snapshot partially fails', async () => {
    const sourceEvents: SessionArtifactEventRecordPayload[] = [];
    const source = new SessionArtifactStore({
      sessionId: 's11-restore-partial',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          sourceEvents.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    await source.upsertMany(
      [
        { title: 'Good', url: 'https://example.com/restore-good' },
        { title: 'Bad', url: 'https://example.com/restore-bad' },
      ],
      { strict: true },
    );
    const good = sourceEvents[0]!.changes[0]!.artifact!;
    const bad = {
      ...sourceEvents[0]!.changes[1]!.artifact!,
      id: 'bad-id',
    };
    const store = new SessionArtifactStore({
      sessionId: 's11-restore-partial',
      workspaceCwd: workspace,
    });
    const live = await store.upsertMany([
      { title: 'Live', url: 'https://example.com/live-partial' },
    ]);
    const liveId = live.changes[0]!.artifactId;

    const warnings = await store.restore({
      v: 2,
      sessionId: 's11-restore-partial',
      sequence: 8,
      artifacts: [good, bad],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    });

    expect(warnings).toEqual([
      'skipped artifact with mismatched id bad-id',
      'artifact snapshot restore partially failed; restored 1/2 artifacts; kept existing live artifacts',
    ]);
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: liveId,
          title: 'Live',
        },
      ],
    });
  });

  it('does not trust persisted published file urls during restore', async () => {
    const store = new SessionArtifactStore({
      sessionId: 's11-restore-published-file',
      workspaceCwd: workspace,
    });
    const live = await store.upsertMany([
      { title: 'Live', url: 'https://example.com/live' },
    ]);
    const liveId = live.changes[0]!.artifactId;

    const warnings = await store.restore({
      v: 2,
      sessionId: 's11-restore-published-file',
      sequence: 8,
      artifacts: [
        {
          id: 'tampered-published-file',
          kind: 'link',
          storage: 'published',
          source: 'client',
          status: 'available',
          title: 'Tampered',
          url: 'file:///tmp/secret.html',
          retention: 'restorable',
          clientRetained: false,
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
        },
      ],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    });

    expect(warnings[0]).toContain('url must use http or https');
    expect(warnings).toContain(
      'artifact snapshot restore failed; kept existing live artifacts',
    );
    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: liveId,
          title: 'Live',
        },
      ],
    });
  });

  it('prunes over-limit restored artifacts and records eviction tombstones', async () => {
    const sourceEvents: SessionArtifactEventRecordPayload[] = [];
    const source = new SessionArtifactStore({
      sessionId: 's11-restore-prune',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          sourceEvents.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    await source.upsertMany(
      [
        { title: 'One', url: 'https://example.com/one' },
        { title: 'Two', url: 'https://example.com/two' },
      ],
      { strict: true },
    );
    const prunedEvents: SessionArtifactEventRecordPayload[] = [];
    const restored = new SessionArtifactStore({
      sessionId: 's11-restore-prune',
      workspaceCwd: workspace,
      maxArtifacts: 1,
      persistence: {
        recordEvent: async (payload) => {
          prunedEvents.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    const snapshot: RebuiltSessionArtifactSnapshot = {
      v: 2,
      sessionId: 's11-restore-prune',
      sequence: 1,
      artifacts: sourceEvents[0]!.changes.map((change) => change.artifact!),
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    };

    await expect(restored.restore(snapshot)).resolves.toContain(
      'restored artifact list pruned to live limit',
    );

    await expect(restored.list()).resolves.toMatchObject({
      artifacts: [{ title: 'Two' }],
    });
    expect(prunedEvents[0]?.changes).toContainEqual(
      expect.objectContaining({
        action: 'removed',
        artifactId: sourceEvents[0]?.changes[0]?.artifactId,
        reason: 'eviction',
      }),
    );
  });

  it('downgrades legacy pinned content refs to metadata-only restore', async () => {
    const events: SessionArtifactEventRecordPayload[] = [];
    const source = new SessionArtifactStore({
      sessionId: 's11-restore-legacy-pinned',
      workspaceCwd: workspace,
      persistence: {
        recordEvent: async (payload) => {
          events.push(payload);
        },
        recordSnapshot: async () => {},
      },
    });
    const created = await source.upsertMany(
      [{ title: 'Legacy pinned', url: 'https://example.com/legacy-pinned' }],
      { strict: true },
    );
    const artifactId = created.changes[0]!.artifactId;
    const persisted = {
      ...events[0]!.changes[0]!.artifact!,
      retention: 'pinned' as const,
      contentRef: {
        kind: 'managed_copy' as const,
        contentId: `${'e'.repeat(64)}-${'f'.repeat(16)}`,
        sha256: 'e'.repeat(64),
        sizeBytes: 12,
        createdAt: '2026-07-04T00:00:00.000Z',
      },
      expiresAt: '2026-08-01T00:00:00.000Z',
    };
    const snapshot: RebuiltSessionArtifactSnapshot = {
      v: 2,
      sessionId: 's11-restore-legacy-pinned',
      sequence: 2,
      artifacts: [persisted],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    };
    const restored = new SessionArtifactStore({
      sessionId: 's11-restore-legacy-pinned',
      workspaceCwd: workspace,
    });

    await expect(restored.restore(snapshot)).resolves.toEqual([]);

    await expect(restored.list()).resolves.toMatchObject({
      artifacts: [
        expect.objectContaining({
          id: artifactId,
          retention: 'restorable',
          restoreState: 'restored',
          status: 'available',
        }),
      ],
    });
    const restoredArtifact = (await restored.list()).artifacts[0];
    expect(restoredArtifact).not.toHaveProperty('contentRef');
    expect(restoredArtifact).not.toHaveProperty('expiresAt');
  });

  it('restores workspace metadata near the user budget without replacing the persisted hash', async () => {
    const sessionId = 's11-restore-workspace-baseline';
    const workspacePath = 'baseline.txt';
    await fs.writeFile(path.join(workspace, workspacePath), 'HELLO');
    const persistedSha = createHash('sha256').update('hello').digest('hex');
    const metadata = {
      payload: 'x'.repeat(4096),
      'qwen.workspace.sha256': persistedSha,
      'qwen.workspace.mtimeMs': 0,
    };
    while (
      Buffer.byteLength(JSON.stringify({ payload: metadata.payload }), 'utf8') >
      4096
    ) {
      metadata.payload = metadata.payload.slice(0, -1);
    }
    const artifactId = stableSessionArtifactId(
      sessionId,
      `workspace:${workspacePath}`,
    );
    const store = new SessionArtifactStore({
      sessionId,
      workspaceCwd: workspace,
    });

    await expect(
      store.restore({
        v: 2,
        sessionId,
        sequence: 1,
        artifacts: [
          {
            id: artifactId,
            kind: 'file',
            storage: 'workspace',
            source: 'tool',
            status: 'available',
            title: 'Baseline',
            workspacePath,
            sizeBytes: 5,
            metadata,
            retention: 'restorable',
            clientRetained: false,
            createdAt: '2026-07-04T00:00:00.000Z',
            updatedAt: '2026-07-04T00:00:00.000Z',
          },
        ],
        tombstonedIds: [],
        stickyEphemeralIds: [],
        warnings: [],
      }),
    ).resolves.toEqual([]);

    await expect(store.list()).resolves.toMatchObject({
      artifacts: [
        {
          id: artifactId,
          status: 'changed',
          metadata: {
            payload: metadata.payload,
            'qwen.workspace.sha256': persistedSha,
            'qwen.workspace.mtimeMs': 0,
          },
        },
      ],
    });
  });
});
