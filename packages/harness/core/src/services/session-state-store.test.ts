/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStateCryptoError } from './session-state-crypto.js';
import { SessionStateStore } from './session-state-store.js';
import type { SessionStateKeyProvider } from './session-state-crypto.js';

class StaticSessionStateKeyProvider implements SessionStateKeyProvider {
  constructor(private readonly key: Buffer = Buffer.alloc(32, 7)) {}

  async getMasterKey(): Promise<Buffer> {
    return this.key;
  }
}

describe('SessionStateStore', () => {
  let tempDir: string;
  let nowMs: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-session-state-'));
    nowMs = Date.parse('2026-04-24T00:00:00.000Z');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createStore(projectRoot = '/workspace/demo'): SessionStateStore {
    return new SessionStateStore({
      projectRoot,
      sessionId: 'session-123',
      configHomeDir: tempDir,
      keyProvider: new StaticSessionStateKeyProvider(),
      now: () => new Date(nowMs),
    });
  }

  it('returns null when the session state file does not exist', async () => {
    await expect(createStore().load()).resolves.toBeNull();
  });

  it('stores and loads private session state segments', async () => {
    const store = createStore();

    await store.setSegment('private', {
      total: {
        inputTokens: 100,
        outputTokens: 20,
      },
    });

    const raw = await fs.readFile(store.getSessionStatePath(), 'utf8');
    expect(raw).not.toContain('inputTokens');
    expect(raw).toContain('private');
    expect(raw).not.toContain('encryptedSegments');
    expect(raw).not.toContain('ciphertext');
    expect(raw).not.toContain('"alg"');
    expect(raw).not.toContain('"kid"');
    expect(raw).not.toContain('"aad"');

    const restored = await createStore().load();
    expect(restored).toMatchObject({
      sessionId: 'session-123',
      revision: 1,
      updatedAt: '2026-04-24T00:00:00.000Z',
      encryptedSegmentKeys: ['private'],
      segments: {
        private: {
          total: {
            inputTokens: 100,
            outputTokens: 20,
          },
        },
      },
    });
  });

  it('stores explicitly public session state segments as readable JSON', async () => {
    const store = createStore();

    await store.setSegment(
      'debug',
      {
        cliVersion: 'test-version',
        platform: 'test-platform',
      },
      { encrypted: false },
    );

    const raw = await fs.readFile(store.getSessionStatePath(), 'utf8');
    expect(raw).toContain('debug');
    expect(raw).toContain('test-version');

    const restored = await createStore().load();
    expect(restored?.encryptedSegmentKeys).toEqual([]);
    expect(restored?.segments['debug']).toEqual({
      cliVersion: 'test-version',
      platform: 'test-platform',
    });
  });

  it('stores workspace directories as top-level public session state', async () => {
    const store = createStore();

    await store.setSegment('private', { tokenCount: 42 });
    nowMs = Date.parse('2026-04-24T00:01:00.000Z');
    await store.setWorkspaceDirectories(['/workspace/demo', '/workspace/pkg']);

    const raw = await fs.readFile(store.getSessionStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as {
      workspaceDirectories?: string[];
      data: Record<string, unknown>;
      items: Record<string, unknown>;
    };

    expect(parsed.workspaceDirectories).toEqual([
      '/workspace/demo',
      '/workspace/pkg',
    ]);
    expect(parsed.data).not.toHaveProperty('workspaceDirectories');
    expect(parsed.items).toHaveProperty('private');
    await expect(createStore().getWorkspaceDirectories()).resolves.toEqual([
      '/workspace/demo',
      '/workspace/pkg',
    ]);
  });

  it('supports concurrent writes from separate store instances in one millisecond', async () => {
    const firstStore = createStore();
    const secondStore = createStore();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);

    try {
      await Promise.all([
        firstStore.setWorkspaceDirectories(['/workspace/first']),
        secondStore.setWorkspaceDirectories(['/workspace/second']),
      ]);
    } finally {
      dateNowSpy.mockRestore();
    }

    const restored = await createStore().getWorkspaceDirectories();
    expect([
      ['/workspace/first'],
      ['/workspace/second'],
    ]).toContainEqual(restored);

    const files = await fs.readdir(
      path.dirname(firstStore.getSessionStatePath()),
    );
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('can store private session state segments as readable JSON for local debugging', async () => {
    const store = new SessionStateStore({
      projectRoot: '/workspace/demo',
      sessionId: 'session-123',
      configHomeDir: tempDir,
      keyProvider: new StaticSessionStateKeyProvider(),
      now: () => new Date(nowMs),
      encryptPrivateSegments: false,
    });

    await store.setSegment('private', {
      total: {
        inputTokens: 100,
        outputTokens: 20,
      },
    });

    const raw = await fs.readFile(store.getSessionStatePath(), 'utf8');
    expect(raw).toContain('inputTokens');
    expect(raw).toContain('private');
    expect(raw).toContain('100');
    expect(raw).toContain('"items": {}');

    const restored = await store.load();
    expect(restored?.segments['private']).toEqual({
      total: {
        inputTokens: 100,
        outputTokens: 20,
      },
    });
  });

  it('updates revisions and preserves existing segments', async () => {
    const store = createStore();

    await store.setSegment('private', { flag: 'done' });
    nowMs += 1000;
    const updated = await store.setSegment('state', { totalTokens: 120 });

    expect(updated.revision).toBe(2);
    expect(updated.updatedAt).toBe('2026-04-24T00:00:01.000Z');
    expect(updated.encryptedSegmentKeys).toEqual(['private', 'state']);
    expect(updated.segments).toEqual({
      private: { flag: 'done' },
      state: { totalTokens: 120 },
    });
  });

  it('serializes concurrent writes from separate store instances for the same file', async () => {
    const writeCount = 20;

    await Promise.all(
      Array.from({ length: writeCount }, (_, index) =>
        createStore().setSegment(`segment-${index}`, { index }),
      ),
    );

    const restored = await createStore().load();
    expect(restored?.revision).toBe(writeCount);
    expect(Object.keys(restored?.segments ?? {}).sort()).toEqual(
      Array.from({ length: writeCount }, (_, index) => `segment-${index}`).sort(),
    );

    const stateDirectory = path.dirname(createStore().getSessionStatePath());
    const entries = await fs.readdir(stateDirectory);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects private state copied from another project', async () => {
    const store = createStore('/workspace/demo');
    await store.setSegment('private', { totalTokens: 120 });

    const copiedStore = createStore('/workspace/other');
    await fs.mkdir(path.dirname(copiedStore.getSessionStatePath()), {
      recursive: true,
    });
    await fs.copyFile(
      store.getSessionStatePath(),
      copiedStore.getSessionStatePath(),
    );

    await expect(copiedStore.load()).rejects.toBeInstanceOf(
      SessionStateCryptoError,
    );
  });

  it('deletes the session state file', async () => {
    const store = createStore();
    await store.setSegment('private', { totalTokens: 120 });

    await store.delete();

    await expect(fs.stat(store.getSessionStatePath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates state exclusively without replacing an existing session', async () => {
    const store = createStore();
    await store.createExclusive(['/workspace/demo']);

    await expect(createStore().createExclusive(['/workspace/other'])).rejects.toMatchObject(
      { code: 'EEXIST' },
    );
    await expect(createStore().getWorkspaceDirectories()).resolves.toEqual([
      '/workspace/demo',
    ]);
  });

  it('keeps new session state in memory when persistence is disabled', async () => {
    const store = new SessionStateStore({
      projectRoot: '/workspace/demo',
      sessionId: 'session-ephemeral',
      configHomeDir: tempDir,
      keyProvider: new StaticSessionStateKeyProvider(),
      now: () => new Date(nowMs),
      persist: false,
    });

    await store.setSegment('private', { totalTokens: 120 });
    await store.setWorkspaceDirectories(['/workspace/demo']);

    await expect(store.load()).resolves.toMatchObject({
      sessionId: 'session-ephemeral',
      revision: 2,
      workspaceDirectories: ['/workspace/demo'],
      segments: {
        private: { totalTokens: 120 },
      },
    });
    await expect(fs.stat(store.getSessionStatePath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('loads persisted state for an ephemeral resume without writing changes back', async () => {
    const persistentStore = createStore();
    await persistentStore.setSegment('private', { totalTokens: 120 });
    const persistedBefore = await fs.readFile(
      persistentStore.getSessionStatePath(),
      'utf8',
    );

    const ephemeralStore = new SessionStateStore({
      projectRoot: '/workspace/demo',
      sessionId: 'session-123',
      configHomeDir: tempDir,
      keyProvider: new StaticSessionStateKeyProvider(),
      now: () => new Date(nowMs),
      persist: false,
    });

    await expect(ephemeralStore.load()).resolves.toMatchObject({
      revision: 1,
      segments: {
        private: { totalTokens: 120 },
      },
    });
    await ephemeralStore.setSegment('ephemeral', { outputTokens: 30 });

    await expect(ephemeralStore.load()).resolves.toMatchObject({
      revision: 2,
      segments: {
        private: { totalTokens: 120 },
        ephemeral: { outputTokens: 30 },
      },
    });
    await expect(
      fs.readFile(persistentStore.getSessionStatePath(), 'utf8'),
    ).resolves.toBe(persistedBefore);
    await expect(createStore().load()).resolves.toMatchObject({
      revision: 1,
      segments: {
        private: { totalTokens: 120 },
      },
    });
  });

  it('clears only in-memory state when deleting an ephemeral resumed store', async () => {
    const persistentStore = createStore();
    await persistentStore.setSegment('private', { totalTokens: 120 });

    const ephemeralStore = new SessionStateStore({
      projectRoot: '/workspace/demo',
      sessionId: 'session-123',
      configHomeDir: tempDir,
      keyProvider: new StaticSessionStateKeyProvider(),
      persist: false,
    });
    await ephemeralStore.load();
    await ephemeralStore.delete();

    await expect(ephemeralStore.load()).resolves.toBeNull();
    await expect(createStore().load()).resolves.toMatchObject({
      segments: {
        private: { totalTokens: 120 },
      },
    });
  });
});
