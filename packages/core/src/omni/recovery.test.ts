/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmniObjectStore } from './storage.js';
import { OmniUploadCache } from './upload-cache.js';
import {
  runStartupRecoveryOnce,
  resetRecoveryLatchForTests,
} from './recovery.js';

let qwenDir: string;
let store: OmniObjectStore;

beforeEach(async () => {
  resetRecoveryLatchForTests();
  qwenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-recovery-'));
  store = new OmniObjectStore(qwenDir);
  await store.ensureLayout();
});

afterEach(async () => {
  vi.useRealTimers();
  resetRecoveryLatchForTests();
  await fs.rm(qwenDir, { recursive: true, force: true });
});

async function putObject(
  content: string,
  dir = qwenDir,
  s = store,
): Promise<{
  sha256: string;
  objectPath: string;
}> {
  const src = path.join(dir, `src-${content.length}.bin`);
  await fs.writeFile(src, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const { objectPath } = await s.putFile(src, sha256, '.mp4');
  return { sha256, objectPath };
}

describe('runStartupRecoveryOnce', () => {
  it('removes expired .part files, keeps recent ones', async () => {
    const downloads = path.join(store.getOmniRootDir(), 'downloads');
    await fs.mkdir(downloads, { recursive: true });
    const oldPart = path.join(downloads, 'old.part');
    const newPart = path.join(downloads, 'new.part');
    await fs.writeFile(oldPart, 'x');
    await fs.writeFile(newPart, 'y');
    const old = new Date(Date.now() - 72 * 3600_000);
    await fs.utimes(oldPart, old, old);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(oldPart)).rejects.toThrow();
    await expect(fs.access(newPart)).resolves.toBeUndefined();
  });

  it('.part cutoff boundary: just older than 48h removed, just younger kept', async () => {
    const downloads = path.join(store.getOmniRootDir(), 'downloads');
    await fs.mkdir(downloads, { recursive: true });
    const justOlder = path.join(downloads, 'just-older.part');
    const justYounger = path.join(downloads, 'just-younger.part');
    await fs.writeFile(justOlder, 'x');
    await fs.writeFile(justYounger, 'y');
    // Straddle the retention cutoff by a minute either side — pins the
    // comparison direction (mtime < cutoff → remove), not the exact value.
    const older = new Date(Date.now() - 48 * 3600_000 - 60_000);
    const younger = new Date(Date.now() - 48 * 3600_000 + 60_000);
    await fs.utimes(justOlder, older, older);
    await fs.utimes(justYounger, younger, younger);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(justOlder)).rejects.toThrow();
    await expect(fs.access(justYounger)).resolves.toBeUndefined();
  });

  it('keeps a DIRECTORY named like a .part (isFile guard)', async () => {
    const downloads = path.join(store.getOmniRootDir(), 'downloads');
    const dirPart = path.join(downloads, 'stale-dir.part');
    await fs.mkdir(dirPart, { recursive: true });
    const old = new Date(Date.now() - 72 * 3600_000);
    await fs.utimes(dirPart, old, old);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(dirPart)).resolves.toBeUndefined();
  });

  it('removes aged promotion .tmp orphans, keeps fresh ones (grace window)', async () => {
    const { objectPath } = await putObject('real-object');
    const shard = path.dirname(objectPath);
    const aged = path.join(shard, '.tmp-deadbeef');
    const fresh = path.join(shard, '.tmp-inflight');
    await fs.writeFile(aged, 'partial');
    await fs.writeFile(fresh, 'partial');
    const old = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(aged, old, old);

    await runStartupRecoveryOnce(store);

    await expect(fs.access(aged)).rejects.toThrow();
    // A young .tmp may be another process's in-flight promotion.
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(objectPath)).resolves.toBeUndefined();
  });

  it('deletes corrupt objects and cascades their cache entries', async () => {
    const { sha256, objectPath } = await putObject('will-corrupt');
    await fs.writeFile(objectPath, 'tampered-bytes'); // break hash==name
    const cache = new OmniUploadCache(store.getOmniRootDir());
    await cache.put(sha256, 'm', 'oss://bucket/dead');

    await runStartupRecoveryOnce(store, cache);

    await expect(fs.access(objectPath)).rejects.toThrow();
    expect(await cache.get(sha256, 'm')).toBeNull();
  });

  it('keeps intact objects and runs only once per process', async () => {
    const { objectPath } = await putObject('intact');
    await runStartupRecoveryOnce(store);
    await expect(fs.access(objectPath)).resolves.toBeUndefined();

    // Second call must be the same latched promise (no re-scan): plant an
    // orphan after the first run — it must survive because the latch holds.
    const orphan = path.join(path.dirname(objectPath), '.tmp-late');
    await fs.writeFile(orphan, 'x');
    await runStartupRecoveryOnce(store);
    await expect(fs.access(orphan)).resolves.toBeUndefined();
  });

  it('latches per omni root: a second store with a different root still sweeps', async () => {
    // Sweep the first root…
    await runStartupRecoveryOnce(store);

    // …then a second store with its OWN root must get its own scan (a
    // process-global latch would silently skip it).
    const qwenDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-recov2-'));
    try {
      const store2 = new OmniObjectStore(qwenDir2);
      await store2.ensureLayout();
      const { objectPath } = await putObject('other-root', qwenDir2, store2);
      const orphan = path.join(path.dirname(objectPath), '.tmp-orphan2');
      await fs.writeFile(orphan, 'x');
      const old = new Date(Date.now() - 2 * 3600_000);
      await fs.utimes(orphan, old, old);

      await runStartupRecoveryOnce(store2);

      await expect(fs.access(orphan)).rejects.toThrow();
    } finally {
      await fs.rm(qwenDir2, { recursive: true, force: true });
    }
  });

  it('verifies exactly `limit` objects per run and rotates coverage across days', async () => {
    // 10 tiny objects, all corrupted: every verified object gets deleted,
    // so deletions == verifications.
    const objects: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { objectPath } = await putObject(`stride-object-${i}`);
      await fs.writeFile(objectPath, `tampered-${i}`);
      objects.push(objectPath);
    }
    const missing = async () => {
      const gone: string[] = [];
      for (const p of objects) {
        try {
          await fs.access(p);
        } catch {
          gone.push(p);
        }
      }
      return gone;
    };

    // Fake only Date: the verifier pipes streams, which need real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    await runStartupRecoveryOnce(store, undefined, { sampleVerifyLimit: 3 });
    const day1Deleted = await missing();
    expect(day1Deleted).toHaveLength(3);

    // Restore the deleted (still-corrupt) objects, advance one day, and
    // reset the latch: the day-seeded stride must pick DIFFERENT objects.
    for (const p of day1Deleted) await fs.writeFile(p, 'tampered-again');
    resetRecoveryLatchForTests();
    vi.setSystemTime(new Date('2025-06-02T12:00:00Z'));
    await runStartupRecoveryOnce(store, undefined, { sampleVerifyLimit: 3 });
    const day2Deleted = await missing();
    expect(day2Deleted).toHaveLength(3);
    for (const p of day2Deleted) {
      expect(day1Deleted).not.toContain(p);
    }
  });

  it('skips verification of objects above the size budget (object AND cache entry survive)', async () => {
    const content = 'corrupt-but-too-big-to-hash';
    const { sha256, objectPath } = await putObject(content);
    await fs.writeFile(objectPath, 'tampered-large-object-bytes');
    const cache = new OmniUploadCache(store.getOmniRootDir());
    await cache.put(sha256, 'm', 'oss://bucket/live');

    await runStartupRecoveryOnce(store, cache, {
      sampleVerifyLimit: 3,
      sampleVerifyMaxBytes: 4, // everything is "too big"
    });

    await expect(fs.access(objectPath)).resolves.toBeUndefined();
    expect(await cache.get(sha256, 'm')).toBe('oss://bucket/live');
  });

  it('never throws — even when getOmniRootDir() itself throws, and the latch is not poisoned', async () => {
    const throwingStore = {
      getOmniRootDir(): string {
        throw new Error('boom');
      },
      getObjectsDir(): string {
        throw new Error('boom');
      },
    } as unknown as OmniObjectStore;

    await expect(
      runStartupRecoveryOnce(throwingStore),
    ).resolves.toBeUndefined();
    // A second call must also resolve (no poisoned/cached rejection).
    await expect(
      runStartupRecoveryOnce(throwingStore),
    ).resolves.toBeUndefined();
    // And a healthy store afterwards still works.
    await expect(runStartupRecoveryOnce(store)).resolves.toBeUndefined();
  });

  describe('staging sweep (storage design §6.1: uncommitted work is deleted)', () => {
    /** Age a staging entry past the multi-process grace window (1h). */
    async function ageEntry(p: string): Promise<void> {
      const when = new Date(Date.now() - 2 * 3600_000);
      await fs.utimes(p, when, when);
    }

    it('deletes every stale staging entry, including nested artifact trees and stray files', async () => {
      const stagingDir = store.getStagingDir();
      const invocationDir = path.join(stagingDir, '0123456789abcdef');
      await fs.mkdir(path.join(invocationDir, 'nested'), { recursive: true });
      await fs.writeFile(
        path.join(invocationDir, 'nested', 'artifact.webp'),
        'half-written',
      );
      const stray = path.join(stagingDir, 'stray.tmp');
      await fs.writeFile(stray, 'stray');
      await ageEntry(invocationDir);
      await ageEntry(stray);

      await runStartupRecoveryOnce(store);

      await expect(fs.readdir(stagingDir)).resolves.toEqual([]);
    });

    it('keeps entries younger than the grace window (a concurrent process may still be transcoding into them)', async () => {
      const stagingDir = store.getStagingDir();
      const liveDir = path.join(stagingDir, 'fedcba9876543210');
      await fs.mkdir(liveDir, { recursive: true });
      await fs.writeFile(path.join(liveDir, 'artifact.mp4'), 'in-flight');

      await runStartupRecoveryOnce(store);

      await expect(
        fs.readFile(path.join(liveDir, 'artifact.mp4'), 'utf8'),
      ).resolves.toBe('in-flight');
    });

    it('removes a symlink ENTRY regardless of age without following it', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-stage-'));
      const victim = path.join(outside, 'victim.bin');
      await fs.writeFile(victim, 'external');
      try {
        const stagingDir = store.getStagingDir();
        const link = path.join(stagingDir, 'planted-link');
        await fs.symlink(outside, link);

        await runStartupRecoveryOnce(store);

        await expect(fs.lstat(link)).rejects.toThrow();
        await expect(fs.readFile(victim, 'utf8')).resolves.toBe('external');
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('a symlinked staging ROOT is never swept', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-stage-'));
      const victim = path.join(outside, 'victim.bin');
      await fs.writeFile(victim, 'external');
      try {
        const stagingDir = store.getStagingDir();
        await fs.rm(stagingDir, { recursive: true, force: true });
        await fs.symlink(outside, stagingDir);

        await runStartupRecoveryOnce(store);

        await expect(fs.readFile(victim, 'utf8')).resolves.toBe('external');
        expect((await fs.lstat(stagingDir)).isSymbolicLink()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('quarantine sweep (retention window + size budget)', () => {
    async function makeQuarantineEntry(
      name: string,
      content: string,
      ageMs: number,
    ): Promise<string> {
      const dir = path.join(store.getQuarantineDir(), name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'artifact.bin'), content);
      await fs.writeFile(path.join(dir, 'reason.json'), '{}');
      const when = new Date(Date.now() - ageMs);
      await fs.utimes(dir, when, when);
      return dir;
    }

    it('removes entries past the retention window, keeps younger ones', async () => {
      const expired = await makeQuarantineEntry(
        'aaaaaaaaaaaaaaaa',
        'old',
        8 * 86_400_000,
      );
      const fresh = await makeQuarantineEntry(
        'bbbbbbbbbbbbbbbb',
        'new',
        1 * 86_400_000,
      );

      await runStartupRecoveryOnce(store, undefined, {
        quarantineRetentionDays: 7,
      });

      await expect(fs.lstat(expired)).rejects.toThrow();
      await expect(fs.lstat(fresh)).resolves.toBeDefined();
    });

    it('removes oldest entries first when over the size budget', async () => {
      const oldest = await makeQuarantineEntry(
        'aaaaaaaaaaaaaaaa',
        'x'.repeat(100),
        3 * 3600_000,
      );
      const middle = await makeQuarantineEntry(
        'bbbbbbbbbbbbbbbb',
        'y'.repeat(100),
        2 * 3600_000,
      );
      const newest = await makeQuarantineEntry(
        'cccccccccccccccc',
        'z'.repeat(100),
        1 * 3600_000,
      );

      // ~300 bytes of artifacts (+ reason.json) against a 250-byte budget:
      // dropping the single oldest entry brings the area back under.
      await runStartupRecoveryOnce(store, undefined, {
        quarantineMaxBytes: 250,
      });

      await expect(fs.lstat(oldest)).rejects.toThrow();
      await expect(fs.lstat(middle)).resolves.toBeDefined();
      await expect(fs.lstat(newest)).resolves.toBeDefined();
    });

    it('keeps everything when under both retention and budget', async () => {
      const a = await makeQuarantineEntry('aaaaaaaaaaaaaaaa', 'a', 3600_000);
      const b = await makeQuarantineEntry('bbbbbbbbbbbbbbbb', 'b', 7200_000);

      await runStartupRecoveryOnce(store);

      await expect(fs.lstat(a)).resolves.toBeDefined();
      await expect(fs.lstat(b)).resolves.toBeDefined();
    });

    it('a symlinked quarantine ENTRY is never traversed, sized, or deleted', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-quar-'));
      const victim = path.join(outside, 'victim.bin');
      await fs.writeFile(victim, 'x'.repeat(10_000));
      const old = new Date(Date.now() - 30 * 86_400_000);
      await fs.utimes(outside, old, old);
      await fs.utimes(victim, old, old);
      try {
        const link = path.join(store.getQuarantineDir(), 'dddddddddddddddd');
        await fs.symlink(outside, link);

        // Aggressive limits: if the sweep treated the link as an entry it
        // would be expired AND over budget — external bytes must survive.
        await runStartupRecoveryOnce(store, undefined, {
          quarantineRetentionDays: 1,
          quarantineMaxBytes: 1,
        });

        await expect(fs.readFile(victim, 'utf8')).resolves.toBe(
          'x'.repeat(10_000),
        );
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('a symlinked quarantine ROOT is never swept', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-quar-'));
      const victimDir = path.join(outside, 'eeeeeeeeeeeeeeee');
      await fs.mkdir(victimDir);
      await fs.writeFile(path.join(victimDir, 'victim.bin'), 'external');
      const old = new Date(Date.now() - 30 * 86_400_000);
      await fs.utimes(victimDir, old, old);
      try {
        const quarantineDir = store.getQuarantineDir();
        await fs.rm(quarantineDir, { recursive: true, force: true });
        await fs.symlink(outside, quarantineDir);

        await runStartupRecoveryOnce(store, undefined, {
          quarantineRetentionDays: 1,
        });

        await expect(
          fs.readFile(path.join(victimDir, 'victim.bin'), 'utf8'),
        ).resolves.toBe('external');
        expect((await fs.lstat(quarantineDir)).isSymbolicLink()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('symlink containment (recovery must never leave the omni root)', () => {
    /** External dir with a victim file whose NAME makes recovery want to
     * delete it through every code path: hash-mismatched "object", expired
     * ".part", and aged ".tmp-*". Returns the paths for survival checks. */
    async function makeVictims(): Promise<{
      outside: string;
      victims: string[];
    }> {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-outside-'));
      const old = new Date(Date.now() - 72 * 3600_000);
      // Name shaped like a store object (64-hex sha) whose hash will NOT
      // match its content → the sampler would delete it if it reached it.
      const fakeObject = path.join(outside, `${'a'.repeat(64)}.mp4`);
      const expiredPart = path.join(outside, 'victim.part');
      const agedTmp = path.join(outside, '.tmp-victim');
      for (const p of [fakeObject, expiredPart, agedTmp]) {
        await fs.writeFile(p, 'external-bytes-recovery-must-not-touch');
        await fs.utimes(p, old, old);
      }
      return { outside, victims: [fakeObject, expiredPart, agedTmp] };
    }

    async function expectAllSurvive(victims: string[]): Promise<void> {
      for (const p of victims) {
        await expect(fs.access(p)).resolves.toBeUndefined();
        await expect(fs.readFile(p, 'utf8')).resolves.toBe(
          'external-bytes-recovery-must-not-touch',
        );
      }
    }

    it('a symlinked SHARD under objects/sha256 is never traversed', async () => {
      const { outside, victims } = await makeVictims();
      try {
        const objectsDir = store.getObjectsDir();
        await fs.mkdir(objectsDir, { recursive: true });
        // The reviewer's repro: shard name → symlink escaping the store.
        await fs.symlink(outside, path.join(objectsDir, 'aa'));

        await runStartupRecoveryOnce(store, undefined, {
          sampleVerifyLimit: 100,
        });

        await expectAllSurvive(victims);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('a symlinked downloads/ directory is never swept', async () => {
      const { outside, victims } = await makeVictims();
      try {
        const downloads = path.join(store.getOmniRootDir(), 'downloads');
        await fs.rm(downloads, { recursive: true, force: true });
        await fs.symlink(outside, downloads);

        await runStartupRecoveryOnce(store);

        await expectAllSurvive(victims);
        // The symlink itself must also survive (nothing rm'd through it).
        expect((await fs.lstat(downloads)).isSymbolicLink()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('a symlinked objects/sha256 ROOT is never traversed', async () => {
      const { outside, victims } = await makeVictims();
      try {
        // Give the external dir a shard-shaped inner layout so a traversal
        // WOULD find the victims if the root guard were missing.
        const innerShard = path.join(outside, 'aa');
        await fs.mkdir(innerShard);
        const old = new Date(Date.now() - 72 * 3600_000);
        const innerNames: string[] = [];
        for (const name of await fs.readdir(outside)) {
          const src = path.join(outside, name);
          if ((await fs.lstat(src)).isFile()) {
            await fs.copyFile(src, path.join(innerShard, name));
            await fs.utimes(path.join(innerShard, name), old, old);
            innerNames.push(name);
          }
        }
        expect(innerNames.length).toBeGreaterThan(0);
        const objectsDir = store.getObjectsDir();
        await fs.rm(objectsDir, { recursive: true, force: true });
        await fs.symlink(outside, objectsDir);

        await runStartupRecoveryOnce(store, undefined, {
          sampleVerifyLimit: 100,
        });

        await expectAllSurvive(victims);
        // Pin the EXACT surviving set — reading back "whatever remains"
        // would pass vacuously if the sweep had deleted entries.
        for (const name of innerNames) {
          await expect(
            fs.readFile(path.join(innerShard, name), 'utf8'),
          ).resolves.toBe('external-bytes-recovery-must-not-touch');
        }
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('a symlinked CANDIDATE inside a real shard is never hashed or deleted', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-outside-'));
      try {
        const victim = path.join(outside, 'victim.bin');
        await fs.writeFile(victim, 'external-candidate-bytes');
        // Real object pins the shard dir; the symlink poses as a second
        // object whose name can never hash-match the external content.
        const { objectPath } = await putObject('legit-neighbor');
        const shard = path.dirname(objectPath);
        const link = path.join(shard, `${'b'.repeat(64)}.mp4`);
        await fs.symlink(victim, link);

        await runStartupRecoveryOnce(store, undefined, {
          sampleVerifyLimit: 100,
        });

        // External target intact, and the link itself not removed either
        // (a hash of external bytes must never have happened).
        await expect(fs.readFile(victim, 'utf8')).resolves.toBe(
          'external-candidate-bytes',
        );
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    /** Build a full omni-shaped layout inside an external dir: victims in
     * downloads/, in an objects/sha256 shard, and .tmp orphans — so if a
     * root-level or intermediate-level symlink is followed, EVERY sweep
     * finds deletable-looking targets. */
    async function makeOmniShapedVictimTree(): Promise<{
      outside: string;
      victims: string[];
    }> {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-outside-'));
      const old = new Date(Date.now() - 72 * 3600_000);
      const downloads = path.join(outside, 'downloads');
      const shard = path.join(outside, 'objects', 'sha256', 'aa');
      await fs.mkdir(downloads, { recursive: true });
      await fs.mkdir(shard, { recursive: true });
      const victims = [
        path.join(downloads, 'movie.mp4.part'),
        path.join(shard, `${'a'.repeat(64)}.pdf`),
        path.join(shard, '.tmp-orphan'),
      ];
      for (const p of victims) {
        await fs.writeFile(p, 'external-bytes-recovery-must-not-touch');
        await fs.utimes(p, old, old);
      }
      return { outside, victims };
    }

    it('a symlinked OMNI ROOT is never swept (intermediate components must be real)', async () => {
      const { outside, victims } = await makeOmniShapedVictimTree();
      try {
        const root = store.getOmniRootDir();
        await fs.rm(root, { recursive: true, force: true });
        // The reviewer's probe: a repo ships `.qwen/omni` itself as a
        // symlink; every per-directory guard lstats only the final
        // component and would pass through this link.
        await fs.symlink(outside, root);

        await runStartupRecoveryOnce(store, undefined, {
          sampleVerifyLimit: 100,
        });

        await expectAllSurvive(victims);
        expect((await fs.lstat(root)).isSymbolicLink()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('a symlinked objects/ INTERMEDIATE directory is never traversed', async () => {
      const { outside, victims } = await makeOmniShapedVictimTree();
      try {
        // Link the `objects/` level (the parent of `objects/sha256`): the
        // sha256-root guard lstats only `objects/sha256` — resolved through
        // this link it IS a real directory, so only an explicit
        // intermediate-chain check stops the traversal.
        const objectsParent = path.join(store.getOmniRootDir(), 'objects');
        await fs.rm(objectsParent, { recursive: true, force: true });
        await fs.symlink(path.join(outside, 'objects'), objectsParent);

        await runStartupRecoveryOnce(store, undefined, {
          sampleVerifyLimit: 100,
        });

        await expectAllSurvive(victims);
        expect((await fs.lstat(objectsParent)).isSymbolicLink()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
});
