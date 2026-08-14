/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaMemoryService,
  MediaResourceRegistry,
} from '../services/media-memory/index.js';
import { MEDIA_MEMORY_FILE_NAME } from '../services/media-memory/store.js';
import { OmniObjectStore } from './storage.js';
import {
  effectiveOmniStorageMaxTotalBytes,
  isOmniDerivationSuspended,
  resetGcLatchForTests,
  runOmniGcOnce,
  settleOmniGc,
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

  it('roots a URL-origin version through its in-store fileRef', async () => {
    // URL media keep the ORIGINAL URL as source.locator (protocol 'url'),
    // but their staging download is deleted the turn it lands — the store
    // copy named by fileRef is the only persistent bytes. A root set that
    // only reads managed locators would delete exactly those objects
    // while the ledger still vouches for them (hard rule 2).
    const urlAnchored = '5'.repeat(64);
    const p = await writeObject(urlAnchored, 30);
    await memory.recordFileRecognized({
      fileRef: store.objectPathFor(urlAnchored, '.bin'),
      sha256: urlAnchored,
      mediaType: 'video',
      metadata: { durationMs: 1000 },
      sizeBytes: 4,
      mimeType: 'video/mp4',
      origin: 'user',
      source: { protocol: 'url', locator: 'https://example.com/clip.mp4' },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    });

    // Both passes must keep it: pass 1 (expired) and pass 2 (budget).
    const result = await runOmniGcOnce(gcOptions({ maxTotalBytes: 1 }));

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

  it('ignores a registry fileRef OUTSIDE the store, even with a matching name', async () => {
    // The registry-root scope guard: a handle on a user file protects
    // nothing — only locators inside objects/ count. A same-named file
    // outside the store must not shield the store copy.
    const sha = '6'.repeat(64);
    const p = await writeObject(sha, 30);
    const outside = path.join(qwenDir, `${sha}.bin`);
    await fs.writeFile(outside, 'user copy');
    const registry = new MediaResourceRegistry();
    registry.bind({
      fileId: 'f1',
      fileVersionId: 'v1',
      rootFileId: 'f1',
      fileRef: outside,
      mediaType: 'image',
    });

    const result = await runOmniGcOnce(gcOptions({ registry }));

    expect(result.deletedObjects).toBe(1);
    await expect(fs.access(p)).rejects.toThrow();
    await expect(fs.access(outside)).resolves.toBeUndefined();
  });

  it('deletes NOTHING when the ledger was corrupt (recovery-backup guard)', async () => {
    // A corrupt document does not read as null: the store SELF-HEALS it
    // (rename to `.corrupt-<ts>`, continue on empty). What blocks this
    // run is the corruption-recovery guard — an empty post-heal ledger
    // must not read as "nothing is referenced".
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

  it('deletes NOTHING when the root set is unknowable (refs === null)', async () => {
    // Hard rule 1 proper: a service that cannot READ the ledger (EACCES,
    // I/O error — distinct from corrupt-and-healed) reports null, and
    // null must never be treated as an empty root set.
    const p = await writeObject('a'.repeat(64), 400);
    const unreadableService = {
      collectManagedRefs: async () => null,
    } as unknown as MediaMemoryService;

    const result = await runOmniGcOnce(
      gcOptions({ memoryService: unreadableService }),
    );

    expect(result.ran).toBe(false);
    expect(result.deletedObjects).toBe(0);
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it('roots an entry artifactRef on its own (no version locator for it)', async () => {
    // `entries[].artifactRef.managedId` must be an independent root: a
    // hand-written ledger references the object ONLY through an entry —
    // no version record backs it up (the service's own commit would
    // double-root, masking a regression in this branch).
    const sha = '8'.repeat(64);
    const p = await writeObject(sha, 30);
    await fs.writeFile(
      path.join(store.getOmniRootDir(), MEDIA_MEMORY_FILE_NAME),
      JSON.stringify({
        schemaVersion: 1,
        files: {},
        versions: {},
        executions: {},
        entries: {
          'e-1': {
            kind: 'derived_media',
            artifactRef: { storage: 'managed', managedId: `sha256/${sha}` },
          },
        },
      }),
    );

    const result = await runOmniGcOnce(gcOptions());

    expect(result.deletedObjects).toBe(0);
    await expect(fs.access(p)).resolves.toBeUndefined();
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

  it('budget pass spares an object the FRESH ledger references (stale-snapshot race)', async () => {
    // The initial root snapshot goes stale while the sweep runs; a commit
    // landing in that gap must not lose its object. The budget pass
    // re-reads the ledger right before deleting — simulate the race with
    // a service whose second read knows the new reference.
    const contested = '7'.repeat(64);
    const p = await writeObject(contested, 5, 600);
    let reads = 0;
    const racingService = {
      collectManagedRefs: async () =>
        ++reads === 1 ? new Set<string>() : new Set([contested]),
    } as unknown as MediaMemoryService;

    const result = await runOmniGcOnce(
      gcOptions({ memoryService: racingService, maxTotalBytes: 100 }),
    );

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(result.deletedObjects).toBe(0);
    await expect(fs.access(p)).resolves.toBeUndefined();
    // Still over budget with (now-)referenced bytes only → suspended.
    expect(result.derivationsSuspended).toBe(true);
  });

  it('budget pass skips an object whose mtime was touched during the sweep', async () => {
    // putFile's dedup touch precedes every new commit; an object touched
    // after the sweep began signals an in-flight reference. The delete
    // loop re-stats each candidate — the touched one must survive even
    // though the budget still wants its bytes. (`first` is expired and
    // goes in pass 1; young `second` is only reachable by the budget
    // pass, whose cascade-triggered touch must spare it.)
    const first = '3'.repeat(64);
    const second = '4'.repeat(64);
    await writeObject(first, 30, 600);
    const secondPath = await writeObject(second, 5, 600);

    const result = await runOmniGcOnce(
      gcOptions({
        maxTotalBytes: 100,
        uploadCache: {
          // Fires while `first` is being deleted — before `second`'s turn.
          // A +10s timestamp keeps the assertion immune to filesystems
          // that truncate mtime to whole seconds (observed on the CI
          // runner: touch-with-now floored below the sweep start).
          removeBySha256: async () => {
            const future = new Date(Date.now() + 10_000);
            await fs.utimes(secondPath, future, future);
          },
        } as never,
      }),
    );

    expect(result.deletedObjects).toBe(1);
    await expect(fs.access(secondPath)).resolves.toBeUndefined();
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

    // A later run under a raised budget clears the suspension. Re-arm
    // ONLY the run latch — the flag must stand until the relaxed sweep
    // itself clears it, or this assertion proves nothing.
    resetGcLatchForTests({ keepSuspension: true });
    expect(isOmniDerivationSuspended(root)).toBe(true);
    const relaxed = await runOmniGcOnce(gcOptions({ maxTotalBytes: 10_000 }));
    expect(relaxed.derivationsSuspended).toBe(false);
    expect(isOmniDerivationSuspended(root)).toBe(false);
  });

  it('cascades a deletion into the upload and degradation caches', async () => {
    const dead = 'a'.repeat(64);
    const deadPath = await writeObject(dead, 30);
    const uploadRemoved: string[] = [];
    const degradedRemoved: string[] = [];
    let bytesGoneAtCascade: boolean | undefined;
    await runOmniGcOnce(
      gcOptions({
        uploadCache: {
          removeBySha256: async (sha: string) => {
            // Load-bearing ORDER: the bytes must be gone before the
            // cache entry — the reverse could re-serve a deleted object
            // from cache.
            bytesGoneAtCascade = await fs.access(deadPath).then(
              () => false,
              () => true,
            );
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
    expect(bytesGoneAtCascade).toBe(true);
  });

  it('accounts a failed rm as a survivor (budget keeps its bytes)', async () => {
    const stuck = 'a'.repeat(64);
    const p = await writeObject(stuck, 30, 600);
    const rmSpy = vi
      .spyOn(fs, 'rm')
      .mockRejectedValue(new Error('EPERM: operation not permitted'));
    try {
      const result = await runOmniGcOnce(gcOptions({ maxTotalBytes: 100 }));

      // Nothing was deleted, nothing was double-counted, and the
      // undeletable bytes still count against the budget.
      expect(result.ran).toBe(true);
      expect(result.deletedObjects).toBe(0);
      expect(result.deletedBytes).toBe(0);
      expect(result.remainingBytes).toBe(600);
      expect(result.derivationsSuspended).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it('keys the latch and the suspension per store root', async () => {
    // Two roots in ONE process: each gets its own sweep and its own
    // suspension verdict — the Map/Set keying is what this pins.
    const otherQwenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-gc2-'));
    try {
      const otherStore = new OmniObjectStore(otherQwenDir);
      const otherMemory = new MediaMemoryService(otherStore.getOmniRootDir());
      await fs.mkdir(otherStore.getObjectsDir(), { recursive: true });

      // Root A: over budget with only referenced bytes → suspended.
      const kept = 'b'.repeat(64);
      await writeObject(kept, 30, 2048);
      await referenceViaEntry(kept);
      const first = await runOmniGcOnce(gcOptions({ maxTotalBytes: 100 }));

      // Root B: one expired orphan, comfortable budget → swept, clean.
      const orphan = 'a'.repeat(64);
      const shard = path.join(otherStore.getObjectsDir(), orphan.slice(0, 2));
      await fs.mkdir(shard, { recursive: true });
      const orphanPath = path.join(shard, `${orphan}.bin`);
      await fs.writeFile(orphanPath, Buffer.alloc(4, 1));
      const old = new Date(Date.now() - 30 * 24 * 3600_000);
      await fs.utimes(orphanPath, old, old);
      const second = await runOmniGcOnce({
        store: otherStore,
        memoryService: otherMemory,
        retentionDays: 14,
        maxTotalBytes: 1024 * 1024,
      });

      // Distinct runs, not the first root's settled result.
      expect(second).not.toBe(first);
      expect(second.deletedObjects).toBe(1);
      expect(isOmniDerivationSuspended(store.getOmniRootDir())).toBe(true);
      expect(isOmniDerivationSuspended(otherStore.getOmniRootDir())).toBe(
        false,
      );
    } finally {
      await fs.rm(otherQwenDir, { recursive: true, force: true });
    }
  });

  it('effectiveOmniStorageMaxTotalBytes floors the budget at 10× the media limit', () => {
    const configFor = (budget: number, singleMedia?: number) =>
      ({
        getOmniStorageMaxTotalBytes: () => budget,
        getOmniMaxUploadFileBytes: () => singleMedia,
      }) as never;

    // Below the floor: clamped up (storage design §7 — the budget must
    // hold at least ten normal uploads or it reads as a broken pipeline).
    expect(effectiveOmniStorageMaxTotalBytes(configFor(1000, 500))).toBe(5000);
    // At or above the floor: honored verbatim.
    expect(effectiveOmniStorageMaxTotalBytes(configFor(5000, 500))).toBe(5000);
    expect(effectiveOmniStorageMaxTotalBytes(configFor(9999, 500))).toBe(9999);
    // No explicit media limit: the guard default (1 GiB) drives the floor.
    expect(effectiveOmniStorageMaxTotalBytes(configFor(1000))).toBe(
      10 * 1024 * 1024 * 1024,
    );
  });

  it('runs once per store root per process', async () => {
    await writeObject('a'.repeat(64), 30);
    const first = await runOmniGcOnce(gcOptions());
    // Second call returns the SAME settled run — no re-sweep.
    const again = await runOmniGcOnce(gcOptions());
    expect(first.deletedObjects).toBe(1);
    expect(again).toBe(first);
  });

  it('settleOmniGc waits out an in-flight sweep before the gate reads the flag', async () => {
    // The startup wiring is fire-and-forget; the budget gate must not
    // consult isOmniDerivationSuspended while the sweep is still running
    // (observed E2E: the first derivation of a fresh process slipped past
    // the budget because the verdict landed ~900ms later).
    const kept = 'b'.repeat(64);
    await writeObject(kept, 30, 2048);
    await referenceViaEntry(kept);
    const root = store.getOmniRootDir();

    // Fire-and-forget, exactly like the index.ts wiring — no await.
    void runOmniGcOnce(gcOptions({ maxTotalBytes: 100 }));
    await settleOmniGc(root);

    expect(isOmniDerivationSuspended(root)).toBe(true);
    // A root with no pending run settles immediately.
    await expect(settleOmniGc('/nonexistent')).resolves.toBeUndefined();
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
