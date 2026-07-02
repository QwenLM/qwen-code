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
  SessionArtifactStore,
  SessionArtifactValidationError,
} from './sessionArtifacts.js';

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
      ).resolves.toMatchObject({ changes: [] });
      await expect(store.remove(artifactId)).resolves.toMatchObject({
        changes: [],
      });
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

    expect(upgraded.changes).toHaveLength(1);
    expect(upgraded.changes[0]).toMatchObject({
      action: 'updated',
      artifactId: created.changes[0]?.artifactId,
      artifact: {
        storage: 'published',
        title: 'Published dashboard',
        managedId: managedIdForWorkspacePath('reports/dashboard.html'),
        url: artifactUrl,
      },
    });
    expect(upgraded.changes[0]?.artifact).not.toHaveProperty('workspacePath');
    expect((await store.list()).artifacts).toHaveLength(1);
  });

  it('rejects trusted published file urls outside the workspace', async () => {
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
      ).rejects.toMatchObject({ field: 'url' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
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
        metadata: { toolKey: 'added', toString: 'own-key' },
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
        workspacePath: 'report.txt',
      });
      expect(artifact).not.toHaveProperty('sizeBytes');
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
        message: 'workspacePath could not be inspected',
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

  it('marks workspace artifacts missing when list refresh hits an fs error', async () => {
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
