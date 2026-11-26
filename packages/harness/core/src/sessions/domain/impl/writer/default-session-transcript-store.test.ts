/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { DefaultSessionTranscriptStore } from './default-session-transcript-store.js';
import type { DefaultSessionTranscriptStoreOptions } from './default-session-transcript-store.js';
import { buildSession } from '../../../factory/session-factory.js';
import { buildMessage } from '../../../factory/message-factory.js';
import { decodeTranscriptLine } from '../../../infra/codec/transcript-entry-codec.js';
import type { AppendChannelLease } from '../../../infra/writer/append-channel-lease.js';
import type { WriterCoordinator } from '../../../infra/writer/writer-coordinator.js';
import type { TranscriptEntry } from '../../../infra/entry/transcript-entry.js';

async function makeTempBucket(): Promise<{
  bucketDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'test-sessions-'));
  const bucketDir = nodePath.join(tmpDir, 'buckets', 'project');
  await fs.mkdir(bucketDir, { recursive: true });
  return {
    bucketDir,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function makeStore(
  options?: DefaultSessionTranscriptStoreOptions,
): Promise<{
  store: DefaultSessionTranscriptStore;
  bucketDir: string;
  cleanup: () => Promise<void>;
}> {
  const { bucketDir, cleanup } = await makeTempBucket();
  const store = new DefaultSessionTranscriptStore(options);
  return {
    store,
    bucketDir,
    cleanup,
  };
}

interface MockLease extends AppendChannelLease {
  entries: TranscriptEntry[];
  failNext: boolean;
}

function createMockLease(filePath: string): MockLease {
  const entries: TranscriptEntry[] = [];
  const lease: MockLease = {
    filePath,
    entries,
    failNext: false,
    append: vi.fn(async (e) => {
      if (lease.failNext) {
        lease.failNext = false;
        throw new Error('channel poisoned');
      }
      entries.push(...e);
    }),
    barrier: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    readTail: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    readAll: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return lease;
}

interface MockCoordinator extends WriterCoordinator {
  leases: MockLease[];
  failNextAcquire: boolean;
}

function createMockCoordinator(): MockCoordinator {
  const leases: MockLease[] = [];
  const coordinator = {
    leases,
    failNextAcquire: false,
    acquire: vi.fn(async (filePath: string) => {
      if (coordinator.failNextAcquire) {
        coordinator.failNextAcquire = false;
        throw new Error('coordinator acquire failed');
      }
      const lease = createMockLease(filePath);
      leases.push(lease);
      return lease;
    }),
    flushAll: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    addCommitObserver: vi.fn().mockReturnValue(() => {}),
    canonicalizePath: vi.fn(async (p) => p),
    barrier: vi.fn().mockResolvedValue(undefined),
    publishCommittedEntries: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    createFileExclusive: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  return coordinator as unknown as MockCoordinator;
}

function createSession(sessionId: string, projectDir: string, bucketDir: string) {
  return buildSession({
    sessionId,
    projectDir,
    transcriptBucketDir: bucketDir,
    cwd: projectDir,
  });
}

async function readEntries(filePath: string) {
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const decoded = decodeTranscriptLine(line);
      if (decoded.kind !== 'entry') {
        throw new Error(`Unexpected line kind: ${decoded.kind}`);
      }
      return decoded.entry;
    });
}

describe('DefaultSessionTranscriptStore', () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    ctx = await makeStore();
  });

  afterEach(async () => {
    await ctx.store.close();
    await ctx.cleanup();
  });

  it('writes messages and metadata to the transcript file', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);
    const writer = await ctx.store.acquireWriter(session);

    await writer.recordCustomTitle('My Title');
    await writer.recordLastPrompt('last prompt');
    await writer.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        payload: { content: 'hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      buildMessage({
        uuid: 'a1',
        role: 'assistant',
        payload: { content: 'hi' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
    ]);
    await writer.close();

    const filePath = nodePath.join(ctx.bucketDir, 's1.jsonl');
    const entries = await readEntries(filePath);
    const types = entries.map((e) => e.type);

    // Buffered metadata is flushed before the first user message; after the
    // assistant message the cached metadata tail is refreshed at the end of
    // the file, matching the legacy SessionTranscriptWriter behaviour.
    expect(types).toEqual([
      'last-prompt',
      'custom-title',
      'user',
      'assistant',
      'active-leaf',
      'last-prompt',
      'custom-title',
      'active-leaf',
    ]);

    const userEntry = entries.find((e) => e.type === 'user');
    expect(userEntry).toMatchObject({
      uuid: 'u1',
      sessionId: 's1',
      parentUuid: null,
      message: { content: 'hello' },
    });
  });

  it('restores state when re-acquiring an existing transcript', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);

    const writer1 = await ctx.store.acquireWriter(session);
    await writer1.recordCustomTitle('Original Title');
    await writer1.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        payload: { content: 'hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await writer1.close();

    const writer2 = await ctx.store.acquireWriter(session);
    await writer2.recordMessages([
      buildMessage({
        uuid: 'a1',
        role: 'assistant',
        payload: { content: 'hi again' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
    ]);
    await writer2.close();

    const filePath = nodePath.join(ctx.bucketDir, 's1.jsonl');
    const entries = await readEntries(filePath);
    // The writer restored the parent cursor from the existing transcript so
    // the new assistant message is linked to the previous user message.
    const assistant = entries.find((e) => e.type === 'assistant');
    expect(assistant).toMatchObject({
      uuid: 'a1',
      parentUuid: 'u1',
    });
  });

  it('deduplicates already-written messages', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);
    const writer = await ctx.store.acquireWriter(session);

    const message = buildMessage({
      uuid: 'u1',
      role: 'user',
      payload: { content: 'hello' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    await writer.recordMessages([message]);
    await writer.recordMessages([message]);
    await writer.close();

    const filePath = nodePath.join(ctx.bucketDir, 's1.jsonl');
    const entries = await readEntries(filePath);
    expect(entries.filter((e) => e.type === 'user').length).toBe(1);
  });

  it('flushes all active writers on flushAll', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);
    const writer = await ctx.store.acquireWriter(session);

    await writer.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        payload: { content: 'hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await ctx.store.flushAll();

    const filePath = nodePath.join(ctx.bucketDir, 's1.jsonl');
    const entries = await readEntries(filePath);
    expect(entries.some((e) => e.type === 'user')).toBe(true);

    await writer.close();
  });

  it('returns independent leases that share the same underlying writer', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);

    const writer1 = await ctx.store.acquireWriter(session);
    const writer2 = await ctx.store.acquireWriter(session);

    expect(writer1.filePath).toBe(writer2.filePath);
    expect(writer1.sessionId).toBe(writer2.sessionId);

    await writer1.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        payload: { content: 'hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await writer1.close();

    await writer2.recordMessages([
      buildMessage({
        uuid: 'a1',
        role: 'assistant',
        payload: { content: 'hi' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
    ]);
    await writer2.close();

    const filePath = nodePath.join(ctx.bucketDir, 's1.jsonl');
    const entries = await readEntries(filePath);
    expect(entries.filter((e) => e.type === 'user').length).toBe(1);
    expect(entries.filter((e) => e.type === 'assistant').length).toBe(1);
  });

  it('throws when acquiring a writer after the store is closed', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);

    await ctx.store.close();
    await expect(ctx.store.acquireWriter(session)).rejects.toThrow(
      'SessionTranscriptStore is closed',
    );
  });

  it('closes all active writers when the store is closed', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);
    const writer = await ctx.store.acquireWriter(session);

    await writer.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        payload: { content: 'hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await ctx.store.close();

    const filePath = nodePath.join(ctx.bucketDir, 's1.jsonl');
    const entries = await readEntries(filePath);
    expect(entries.some((e) => e.type === 'user')).toBe(true);

    await expect(writer.recordMessages([])).rejects.toThrow('SessionTranscriptWriter is closed');
  });

  it('uses options.bucketDir to override the session bucket directory', async () => {
    const { bucketDir: overrideBucketDir, cleanup: overrideCleanup } = await makeTempBucket();
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session = createSession('s1', projectDir, ctx.bucketDir);

    const writer = await ctx.store.acquireWriter(session, {
      bucketDir: overrideBucketDir,
    });
    await writer.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        payload: { content: 'hello' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await writer.close();

    const overridePath = nodePath.join(overrideBucketDir, 's1.jsonl');
    const originalPath = nodePath.join(ctx.bucketDir, 's1.jsonl');
    expect(await fs.stat(overridePath).then(() => true, () => false)).toBe(true);
    expect(await fs.stat(originalPath).then(() => true, () => false)).toBe(false);

    await overrideCleanup();
  });

  it('writes different sessions to different transcript files', async () => {
    const projectDir = nodePath.join(nodePath.dirname(ctx.bucketDir), 'project');
    const session1 = createSession('s1', projectDir, ctx.bucketDir);
    const session2 = createSession('s2', projectDir, ctx.bucketDir);

    const writer1 = await ctx.store.acquireWriter(session1);
    const writer2 = await ctx.store.acquireWriter(session2);

    await writer1.recordMessages([
      buildMessage({
        uuid: 'u1',
        role: 'user',
        payload: { content: 'one' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await writer2.recordMessages([
      buildMessage({
        uuid: 'u2',
        role: 'user',
        payload: { content: 'two' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await writer1.close();
    await writer2.close();

    const entries1 = await readEntries(nodePath.join(ctx.bucketDir, 's1.jsonl'));
    const entries2 = await readEntries(nodePath.join(ctx.bucketDir, 's2.jsonl'));
    expect(entries1.some((e) => e.type === 'user' && (e as { uuid: string }).uuid === 'u1')).toBe(true);
    expect(entries2.some((e) => e.type === 'user' && (e as { uuid: string }).uuid === 'u2')).toBe(true);
  });

  it('recovers from a poisoned channel by evicting and rebuilding on next acquire', async () => {
    const coordinator = createMockCoordinator();
    const store = new DefaultSessionTranscriptStore({ coordinator });
    const projectDir = '/project';
    const session = buildSession({
      sessionId: 's1',
      projectDir,
      transcriptBucketDir: '/project/.qwen/buckets',
      cwd: projectDir,
    });

    const writer1 = await store.acquireWriter(session);
    await writer1.recordMessages([
      buildMessage({ uuid: 'u1', role: 'user', payload: { content: 'hello' } }),
    ]);

    // Force the underlying channel to fail on the next append.
    const lease1 = coordinator.leases[0] as ReturnType<typeof createMockLease>;
    lease1.failNext = true;

    await expect(
      writer1.recordMessages([
        buildMessage({ uuid: 'a1', role: 'assistant', payload: { content: 'hi' } }),
      ]),
    ).rejects.toThrow('channel poisoned');
    await writer1.close();

    // A new acquire should create a fresh channel lease.
    const writer2 = await store.acquireWriter(session);
    await writer2.recordMessages([
      buildMessage({ uuid: 'a1', role: 'assistant', payload: { content: 'hi' } }),
    ]);
    await writer2.close();

    expect(coordinator.leases.length).toBeGreaterThanOrEqual(2);
    await store.close();
  });

  it('propagates coordinator acquire failures without leaking state entries', async () => {
    const coordinator = createMockCoordinator();
    const store = new DefaultSessionTranscriptStore({ coordinator });
    const projectDir = '/project';
    const session = buildSession({
      sessionId: 's1',
      projectDir,
      transcriptBucketDir: '/project/.qwen/buckets',
      cwd: projectDir,
    });

    coordinator.failNextAcquire = true;
    await expect(store.acquireWriter(session)).rejects.toThrow('coordinator acquire failed');

    coordinator.failNextAcquire = true;
    await expect(store.acquireWriter(session)).rejects.toThrow('coordinator acquire failed');

    await store.close();
  });
});
