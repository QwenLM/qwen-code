/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MediaMemoryService,
  MediaResourceRegistry,
} from '../services/media-memory/index.js';
import { MEDIA_MEMORY_FILE_NAME } from '../services/media-memory/store.js';
import { OmniObjectStore } from './storage.js';
import {
  isOmniDerivationSuspended,
  resetGcLatchForTests,
  runOmniGcOnce,
} from './gc.js';

const DAY_MS = 24 * 3600_000;

describe('runOmniGcOnce', () => {
  let qwenDir: string;
  let store: OmniObjectStore;
  let memory: MediaMemoryService;

  beforeEach(async () => {
    resetGcLatchForTests();
    qwenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-gc-'));
    store = new OmniObjectStore(qwenDir);
    memory = new MediaMemoryService(store.getOmniRootDir());
    await fs.mkdir(store.getObjectsDir(), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(qwenDir, { recursive: true, force: true });
  });

  /** Materialize one object file with controllable age and size. */
  async function writeObject(
    sha256: string,
    ageDays: number,
    sizeBytes = 4,
  ): Promise<string> {
    const shardDir = path.join(store.getObjectsDir(), sha256.slice(0, 2));
    await fs.mkdir(shardDir, { recursive: true });
    const filePath = path.join(shardDir, `${sha256}.bin`);
    await fs.writeFile(filePath, Buffer.alloc(sizeBytes, 1));
    const mtime = new Date(Date.now() - ageDays * DAY_MS);
    await fs.utimes(filePath, mtime, mtime);
    return filePath;
  }

  /** Record a policy execution whose media output references `sha256`,
   * making it a GC root through `entries[].artifactRef.managedId`. */
  async function referenceViaEntry(sha256: string): Promise<void> {
    const source = (await memory.recordFileRecognized({
      fileRef: '/movies/film.mkv',
      sha256: 'e'.repeat(64),
      mediaType: 'video',
      metadata: { durationMs: 1000 },
      sizeBytes: 10,
      mimeType: 'video/x-matroska',
      origin: 'user',
      source: { protocol: 'local', locator: 'film.mkv' },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    }))!;
    await memory.commitPolicySucceeded({
      invocationId: 'aabbccdd00112233',
      source,
      executionOrigin: {
        kind: 'fixed_policy',
        policyId: 'p',
        stage: 'preprocessing',
      },
      toolName: 'omni_downscale_video',
      finalArguments: {},
      omniConfigHash: 'fp-' + '0'.repeat(61),
      startedAt: '2026-08-13T00:00:00.000Z',
      completedAt: '2026-08-13T00:00:01.000Z',
      outputs: [
        {
          kind: 'media',
          objectPath: store.objectPathFor(sha256, '.bin'),
          sha256,
          mediaType: 'video',
          metadata: { durationMs: 1000 },
          sizeBytes: 4,
          mimeType: 'video/mp4',
        },
      ],
    });
  }

  function gcOptions(overrides?: Partial<Parameters<typeof runOmniGcOnce>[0]>) {
    return {
      store,
      memoryService: memory,
      retentionDays: 14,
      maxTotalBytes: 1024 * 1024,
      ...overrides,
    };
  }

  it('sweeps an expired unreferenced object and keeps a referenced one', async () => {
    const dead = 'a'.repeat(64);
    const kept = 'b'.repeat(64);
    const deadPath = await writeObject(dead, 30);
    const keptPath = await writeObject(kept, 30);
    await referenceViaEntry(kept);

    const result = await runOmniGcOnce(gcOptions());

    expect(result).toMatchObject({ ran: true, deletedObjects: 1 });
    await expect(fs.access(deadPath)).rejects.toThrow();
    await expect(fs.access(keptPath)).resolves.toBeUndefined();
  });

  it('keeps a young unreferenced object (retention grace)', async () => {
    // The window is what makes "promoted, memory commit still in flight"
    // and cross-process races safe — a fresh orphan must survive.
    const young = 'c'.repeat(64);
    const p = await writeObject(young, 2);

    const result = await runOmniGcOnce(gcOptions());

    expect(result.deletedObjects).toBe(0);
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it('treats a managed source locator as a root, not just artifactRefs', async () => {
    // Tool/URL media anchor their file identity in the object store —
    // their only reference is `versions[].source.locator`. A GC that only
    // reads artifactRefs would delete exactly the objects whose store copy
    // is the only copy.
    const anchored = 'd'.repeat(64);
    const p = await writeObject(anchored, 30);
    await memory.recordFileRecognized({
      fileRef: store.objectPathFor(anchored, '.bin'),
      sha256: anchored,
      mediaType: 'image',
      metadata: { width: 8, height: 8 },
      sizeBytes: 4,
      mimeType: 'image/png',
      origin: 'tool',
      source: { protocol: 'managed', locator: `sha256/${anchored}` },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    });

    const result = await runOmniGcOnce(gcOptions());

    expect(result.deletedObjects).toBe(0);
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it('protects objects the live session registry still points at', async () => {
    const live = 'f'.repeat(64);
    const p = await writeObject(live, 30);
    const registry = new MediaResourceRegistry();
    registry.bind({
      fileId: 'f1',
      fileVersionId: 'v1',
      rootFileId: 'f1',
      fileRef: store.objectPathFor(live, '.bin'),
      mediaType: 'image',
    });

    const result = await runOmniGcOnce(gcOptions({ registry }));

    expect(result.deletedObjects).toBe(0);
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it('deletes NOTHING when the memory snapshot is unreadable', async () => {
    // Fail-closed hard rule: an unreadable ledger must never read as an
    // empty one — that misread would sweep the entire store.
    await writeObject('a'.repeat(64), 400);
    await fs.writeFile(
      path.join(store.getOmniRootDir(), MEDIA_MEMORY_FILE_NAME),
      '{not json',
    );

    const result = await runOmniGcOnce(gcOptions());

    expect(result.ran).toBe(false);
    expect(result.deletedObjects).toBe(0);
    await expect(
      fs.access(
        path.join(store.getObjectsDir(), 'aa', `${'a'.repeat(64)}.bin`),
      ),
    ).resolves.toBeUndefined();
  });

  it('over budget: deletes oldest unreferenced objects regardless of age', async () => {
    const older = '1'.repeat(64);
    const newer = '2'.repeat(64);
    await writeObject(older, 5, 600); // younger than retention, but budget
    await writeObject(newer, 1, 600);

    const result = await runOmniGcOnce(gcOptions({ maxTotalBytes: 800 }));

    // Oldest goes first; once within budget the newer one survives.
    expect(result.deletedObjects).toBe(1);
    await expect(
      fs.access(path.join(store.getObjectsDir(), '11', `${older}.bin`)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(store.getObjectsDir(), '22', `${newer}.bin`)),
    ).resolves.toBeUndefined();
  });

  it('over budget with only referenced objects: suspends derivations, deletes nothing', async () => {
    const kept = 'b'.repeat(64);
    await writeObject(kept, 30, 2048);
    await referenceViaEntry(kept);
    const root = store.getOmniRootDir();
    expect(isOmniDerivationSuspended(root)).toBe(false);

    const result = await runOmniGcOnce(gcOptions({ maxTotalBytes: 100 }));

    expect(result.deletedObjects).toBe(0);
    expect(result.derivationsSuspended).toBe(true);
    expect(isOmniDerivationSuspended(root)).toBe(true);

    // A later run under a raised budget clears the suspension.
    resetGcLatchForTests();
    const relaxed = await runOmniGcOnce(gcOptions({ maxTotalBytes: 10_000 }));
    expect(relaxed.derivationsSuspended).toBe(false);
    expect(isOmniDerivationSuspended(root)).toBe(false);
  });

  it('cascades a deletion into the upload and degradation caches', async () => {
    const dead = 'a'.repeat(64);
    await writeObject(dead, 30);
    const uploadRemoved: string[] = [];
    const degradedRemoved: string[] = [];
    await runOmniGcOnce(
      gcOptions({
        uploadCache: {
          removeBySha256: async (sha: string) => {
            uploadRemoved.push(sha);
          },
        } as never,
        degradationCache: {
          removeByOriginalSha256: async (sha: string) => {
            degradedRemoved.push(`orig:${sha}`);
          },
          removeByDegradedSha256: async (sha: string) => {
            degradedRemoved.push(`deg:${sha}`);
          },
        } as never,
      }),
    );

    expect(uploadRemoved).toEqual([dead]);
    expect(degradedRemoved).toEqual([`orig:${dead}`, `deg:${dead}`]);
  });

  it('runs once per store root per process', async () => {
    await writeObject('a'.repeat(64), 30);
    const first = await runOmniGcOnce(gcOptions());
    // Second call returns the SAME settled run — no re-sweep.
    const again = await runOmniGcOnce(gcOptions());
    expect(first.deletedObjects).toBe(1);
    expect(again).toBe(first);
  });

  it('never descends into a symlinked shard', async () => {
    // A link planted inside objects/ must not redirect the sweep at
    // arbitrary external paths (same guard the recovery scan carries).
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-gc-out-'));
    const victim = path.join(outside, `${'9'.repeat(64)}.bin`);
    await fs.writeFile(victim, 'x');
    const old = new Date(Date.now() - 400 * DAY_MS);
    await fs.utimes(victim, old, old);
    await fs.symlink(outside, path.join(store.getObjectsDir(), '99'));

    const result = await runOmniGcOnce(gcOptions());

    expect(result.deletedObjects).toBe(0);
    await expect(fs.access(victim)).resolves.toBeUndefined();
    await fs.rm(outside, { recursive: true, force: true });
  });
});
