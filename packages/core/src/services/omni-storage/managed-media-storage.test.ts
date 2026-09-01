/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ManagedMediaStorage } from './managed-media-storage.js';
import { OmniUploadCache } from './omni-upload-cache.js';
import {
  DEFAULT_OMNI_STORAGE_CONFIG,
  hashToManagedId,
  managedIdToHash,
} from './types.js';
import type { GcRootProvider, OmniStorageConfig } from './types.js';

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function testConfig(overrides?: Partial<OmniStorageConfig>): OmniStorageConfig {
  return {
    ...DEFAULT_OMNI_STORAGE_CONFIG,
    ...overrides,
    quarantine: {
      ...DEFAULT_OMNI_STORAGE_CONFIG.quarantine,
      ...overrides?.quarantine,
    },
  };
}

describe('ManagedMediaStorage', () => {
  let tmpDir: string;
  let storage: ManagedMediaStorage;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'omni-test-'));
    storage = new ManagedMediaStorage(path.join(tmpDir, 'omni'), testConfig());
    await storage.initialize();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates directory structure', async () => {
      const root = path.join(tmpDir, 'omni');
      for (const sub of ['objects', 'downloads', 'staging', 'quarantine']) {
        const stat = await fs.promises.stat(path.join(root, sub));
        expect(stat.isDirectory()).toBe(true);
      }
    });

    it('writes .gitignore with *', async () => {
      const content = await fs.promises.readFile(
        path.join(tmpDir, 'omni', '.gitignore'),
        'utf8',
      );
      expect(content).toBe('*\n');
    });

    it('is idempotent', async () => {
      await storage.initialize();
      const stat = await fs.promises.stat(path.join(tmpDir, 'omni', 'objects'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('initializes a fresh instance over an existing store (restart case)', async () => {
      const second = new ManagedMediaStorage(
        path.join(tmpDir, 'omni'),
        testConfig(),
      );
      await expect(second.initialize()).resolves.toBeUndefined();
      const stat = await fs.promises.stat(path.join(tmpDir, 'omni', 'objects'));
      expect(stat.isDirectory()).toBe(true);
      const gitignore = await fs.promises.readFile(
        path.join(tmpDir, 'omni', '.gitignore'),
        'utf8',
      );
      expect(gitignore).toBe('*\n');
    });

    // Windows applies only the read-only bit from mode and libuv reports
    // fabricated permissions, so mode assertions can never hold there.
    it.skipIf(process.platform === 'win32')(
      'enforces 0700 dirs and 0600 files',
      async () => {
        const root = path.join(tmpDir, 'omni');
        for (const sub of ['objects', 'downloads', 'staging', 'quarantine']) {
          const stat = await fs.promises.stat(path.join(root, sub));
          expect(stat.mode & 0o777).toBe(0o700);
        }
        const result = await storage.commitBuffer(Buffer.from('perms'), '.bin');
        const fileStat = await fs.promises.stat(result.objectPath);
        expect(fileStat.mode & 0o777).toBe(0o600);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'tightens pre-existing permissive region dirs on adoption',
      async () => {
        const root = path.join(tmpDir, 'omni-adopted');
        for (const sub of [
          '',
          'objects',
          'downloads',
          'staging',
          'quarantine',
        ]) {
          const dir = path.join(root, sub);
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.chmod(dir, 0o755);
        }
        const adopted = new ManagedMediaStorage(root, testConfig());
        await adopted.initialize();
        for (const sub of [
          '',
          'objects',
          'downloads',
          'staging',
          'quarantine',
        ]) {
          const stat = await fs.promises.stat(path.join(root, sub));
          expect(stat.mode & 0o777).toBe(0o700);
        }
      },
    );

    it('does not clobber a pre-existing .gitignore', async () => {
      const root = path.join(tmpDir, 'omni2');
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.writeFile(path.join(root, '.gitignore'), 'custom\n');
      const second = new ManagedMediaStorage(root, testConfig());
      await second.initialize();
      const content = await fs.promises.readFile(
        path.join(root, '.gitignore'),
        'utf8',
      );
      expect(content).toBe('custom\n');
    });

    it('rejects symlinked root', async () => {
      const realDir = path.join(tmpDir, 'real');
      const linkDir = path.join(tmpDir, 'link');
      await fs.promises.mkdir(realDir);
      await fs.promises.symlink(realDir, linkDir);
      const linkStorage = new ManagedMediaStorage(linkDir, testConfig());
      await expect(linkStorage.initialize()).rejects.toThrow('symlink');
    });

    it('tolerates a symlinked ancestor above the storage root', async () => {
      // System-managed symlinks above the root (macOS /var -> /private/var,
      // relocated homes) are not the threat §3 targets; refusing them would
      // break every store under os.tmpdir() on macOS.
      const realParent = path.join(tmpDir, 'real-parent');
      const linkParent = path.join(tmpDir, 'link-parent');
      await fs.promises.mkdir(realParent);
      await fs.promises.symlink(realParent, linkParent);
      const nested = new ManagedMediaStorage(
        path.join(linkParent, 'omni'),
        testConfig(),
      );
      await expect(nested.initialize()).resolves.toBeUndefined();
      const data = Buffer.from('under a symlinked ancestor');
      const result = await nested.commitBuffer(data, '.bin');
      expect((await fs.promises.readFile(result.objectPath)).equals(data)).toBe(
        true,
      );
      const realRoot = await fs.promises.realpath(
        path.join(linkParent, 'omni'),
      );
      expect(
        (await fs.promises.lstat(path.join(realRoot, 'objects'))).isDirectory(),
      ).toBe(true);
    });

    it('rejects a pre-symlinked region directory', async () => {
      const root = path.join(tmpDir, 'omni3');
      const outside = path.join(tmpDir, 'outside');
      await fs.promises.mkdir(outside);
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.symlink(outside, path.join(root, 'objects'));
      const regionStorage = new ManagedMediaStorage(root, testConfig());
      await expect(regionStorage.initialize()).rejects.toThrow('symlink');
    });
  });

  describe('commitBuffer', () => {
    it('commits data and returns correct managedId', async () => {
      const data = Buffer.from('hello world');
      const result = await storage.commitBuffer(data, '.txt');

      expect(result.sha256).toBe(sha256(data));
      expect(result.managedId).toBe(`sha256:${sha256(data)}`);
      expect(result.deduplicated).toBe(false);
      expect(result.sizeBytes).toBe(data.length);

      const onDisk = await fs.promises.readFile(result.objectPath);
      expect(onDisk.equals(data)).toBe(true);
    });

    it('deduplicates identical content', async () => {
      const data = Buffer.from('duplicate me');
      const first = await storage.commitBuffer(data, '.bin');
      const second = await storage.commitBuffer(data, '.bin');

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(first.objectPath).toBe(second.objectPath);
      expect(first.managedId).toBe(second.managedId);
    });

    it('uses content hash for path regardless of extension', async () => {
      const data = Buffer.from('same content');
      const asTxt = await storage.commitBuffer(data, '.txt');
      const asMp4 = await storage.commitBuffer(data, '.mp4');

      // Same hash → same managedId, but first commit wins the extension
      expect(asTxt.sha256).toBe(asMp4.sha256);
      expect(asMp4.deduplicated).toBe(true);
      expect(asMp4.objectPath).toBe(asTxt.objectPath);
      await expect(fs.promises.stat(asMp4.objectPath)).resolves.toBeDefined();
    });

    it('sanitizes .tmp extension to .bin', async () => {
      const data = Buffer.from('tmp ext test');
      const result = await storage.commitBuffer(data, '.tmp');
      expect(result.objectPath).toMatch(/\.bin$/);
      expect(result.objectPath).not.toMatch(/\.tmp$/);
      expect(await storage.objectExists(result.managedId)).toBe(true);
    });
  });

  describe('commitObject', () => {
    it('commits a file from disk', async () => {
      const srcPath = path.join(tmpDir, 'source.bin');
      const data = Buffer.from('file content here');
      await fs.promises.writeFile(srcPath, data);

      const result = await storage.commitObject(srcPath, '.bin');
      expect(result.sha256).toBe(sha256(data));
      expect(result.deduplicated).toBe(false);

      const onDisk = await fs.promises.readFile(result.objectPath);
      expect(onDisk.equals(data)).toBe(true);
    });

    it('rejects symlinked source', async () => {
      const realFile = path.join(tmpDir, 'real.bin');
      const linkFile = path.join(tmpDir, 'link.bin');
      await fs.promises.writeFile(realFile, 'data');
      await fs.promises.symlink(realFile, linkFile);

      await expect(storage.commitObject(linkFile, '.bin')).rejects.toThrow(
        'symlink',
      );
    });

    it('rejects a non-regular commit source', async () => {
      // The fd-based check must catch special files even when the path
      // check passes (directories on POSIX; the open itself fails on
      // Windows) — either way the commit must not proceed.
      const dirSource = path.join(tmpDir, 'dir-source');
      await fs.promises.mkdir(dirSource);
      await expect(storage.commitObject(dirSource, '.bin')).rejects.toThrow();
    });

    it('deduplicates when content already exists', async () => {
      const data = Buffer.from('dedup via commitObject');
      const first = await storage.commitBuffer(data, '.bin');

      const srcPath = path.join(tmpDir, 'dup-source.bin');
      await fs.promises.writeFile(srcPath, data);
      const second = await storage.commitObject(srcPath, '.bin');

      expect(second.deduplicated).toBe(true);
      expect(second.managedId).toBe(first.managedId);
    });
  });

  describe('object lookup', () => {
    it('findObjectPath returns path for existing object', async () => {
      const data = Buffer.from('findable');
      const { managedId, objectPath } = await storage.commitBuffer(
        data,
        '.dat',
      );

      const found = await storage.findObjectPath(managedId);
      expect(found).toBe(objectPath);
    });

    it('findObjectPath returns undefined for missing object', async () => {
      const missing = hashToManagedId('a'.repeat(64));
      expect(await storage.findObjectPath(missing)).toBeUndefined();
    });

    it('objectExists reflects actual state', async () => {
      const data = Buffer.from('exists check');
      const { managedId } = await storage.commitBuffer(data, '.bin');

      expect(await storage.objectExists(managedId)).toBe(true);
      await storage.deleteObject(managedId);
      expect(await storage.objectExists(managedId)).toBe(false);
    });
  });

  describe('deleteObject', () => {
    it('deletes object and cascades upload cache', async () => {
      const data = Buffer.from('to delete');
      const { managedId, sha256: hash } = await storage.commitBuffer(
        data,
        '.bin',
      );

      storage.setUploadEntry(hash, 'model-a', {
        ossUrl: 'oss://bucket/obj',
        uploadedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(storage.getUploadEntry(hash, 'model-a')).toBeDefined();

      const deleted = await storage.deleteObject(managedId);
      expect(deleted).toBe(true);
      expect(await storage.objectExists(managedId)).toBe(false);
      expect(storage.getUploadEntry(hash, 'model-a')).toBeUndefined();
    });

    it('returns false for non-existent object', async () => {
      const missing = hashToManagedId('b'.repeat(64));
      expect(await storage.deleteObject(missing)).toBe(false);
    });
  });

  describe('staging', () => {
    it('creates and promotes staging directory', async () => {
      const stagingDir = await storage.createStagingDir('inv-001');
      await fs.promises.writeFile(
        path.join(stagingDir, 'output.wav'),
        Buffer.from('audio data'),
      );
      await fs.promises.writeFile(
        path.join(stagingDir, 'transcript.txt'),
        Buffer.from('hello'),
      );

      const result = await storage.promoteStaging('inv-001');
      expect(result.objects).toHaveLength(2);

      for (const obj of result.objects) {
        expect(await storage.objectExists(obj.managedId)).toBe(true);
      }

      // Verify content is preserved
      const wavObj = result.objects.find((o) => o.objectPath.endsWith('.wav'));
      const txtObj = result.objects.find((o) => o.objectPath.endsWith('.txt'));
      expect(wavObj).toBeDefined();
      expect(txtObj).toBeDefined();
      const wavData = await fs.promises.readFile(wavObj!.objectPath);
      const txtData = await fs.promises.readFile(txtObj!.objectPath);
      expect(wavData.toString()).toBe('audio data');
      expect(txtData.toString()).toBe('hello');

      // staging dir should be removed
      await expect(fs.promises.stat(stagingDir)).rejects.toThrow();
    });

    it('quarantines staging with reason', async () => {
      const stagingDir = await storage.createStagingDir('inv-fail');
      await fs.promises.writeFile(
        path.join(stagingDir, 'broken.bin'),
        Buffer.from('bad'),
      );

      await storage.quarantineStaging('inv-fail', {
        invocationId: 'inv-fail',
        tool: 'omni_extract_audio',
        reason: 'ffmpeg crashed',
        timestamp: new Date().toISOString(),
      });

      // staging removed
      await expect(fs.promises.stat(stagingDir)).rejects.toThrow();

      // quarantine exists with reason.json
      const reasonPath = path.join(
        tmpDir,
        'omni',
        'quarantine',
        'inv-fail',
        'reason.json',
      );
      const reason = JSON.parse(await fs.promises.readFile(reasonPath, 'utf8'));
      expect(reason.reason).toBe('ffmpeg crashed');

      // original artifact is preserved in quarantine
      const artifactPath = path.join(
        tmpDir,
        'omni',
        'quarantine',
        'inv-fail',
        'broken.bin',
      );
      const artifact = await fs.promises.readFile(artifactPath);
      expect(artifact.toString()).toBe('bad');
    });

    it('rejects unsafe invocation IDs', async () => {
      await expect(storage.createStagingDir('../escape')).rejects.toThrow(
        'Unsafe',
      );
      await expect(storage.createStagingDir('a/b')).rejects.toThrow('Unsafe');
    });

    it('rejects symlinked artifacts in staging', async () => {
      const stagingDir = await storage.createStagingDir('inv-symlink');
      const targetPath = path.join(tmpDir, 'outside.bin');
      await fs.promises.writeFile(targetPath, Buffer.from('target'));
      await fs.promises.symlink(
        targetPath,
        path.join(stagingDir, 'linked.bin'),
      );

      await expect(storage.promoteStaging('inv-symlink')).rejects.toThrow(
        /non-regular file/,
      );
      // staging must survive the refusal so the orchestrator can quarantine it
      await expect(fs.promises.stat(stagingDir)).resolves.toBeDefined();
    });

    it('rejects subdirectories in staging', async () => {
      const stagingDir = await storage.createStagingDir('inv-subdir');
      await fs.promises.mkdir(path.join(stagingDir, 'frames'));
      await fs.promises.writeFile(
        path.join(stagingDir, 'frames', 'keyframe.png'),
        Buffer.from('x'),
      );

      await expect(storage.promoteStaging('inv-subdir')).rejects.toThrow(
        /subdirectory/,
      );
    });
  });

  describe('downloads', () => {
    it('finalizes download and removes .part', async () => {
      const partPath = storage.getDownloadPartPath('dl-001');
      const data = Buffer.from('downloaded content');
      await fs.promises.mkdir(path.dirname(partPath), { recursive: true });
      await fs.promises.writeFile(partPath, data);

      const result = await storage.finalizeDownload(partPath, '.mp4');
      expect(result.sha256).toBe(sha256(data));
      expect(await storage.objectExists(result.managedId)).toBe(true);

      // .part removed
      await expect(fs.promises.stat(partPath)).rejects.toThrow();
    });
  });

  describe('budget', () => {
    it('reports correct status', async () => {
      const data = Buffer.from('budget test data');
      await storage.commitBuffer(data, '.bin');

      const status = await storage.getBudgetStatus();
      expect(status.objectCount).toBe(1);
      expect(status.totalBytes).toBe(data.length);
      expect(status.overBudget).toBe(false);
    });

    it('detects over-budget with tiny maxTotalBytes', async () => {
      const smallStorage = new ManagedMediaStorage(
        path.join(tmpDir, 'omni-small'),
        testConfig({ maxTotalBytes: 10 }),
      );
      await smallStorage.initialize();
      await smallStorage.commitBuffer(Buffer.from('x'.repeat(100)), '.bin');

      const status = await smallStorage.getBudgetStatus();
      expect(status.overBudget).toBe(true);
    });

    it('budget and lookup refuse a planted symlink inside objects/', async () => {
      const data = Buffer.from('replace me');
      const result = await storage.commitBuffer(data, '.bin');

      // Swap the committed object for a symlink to a larger outside file.
      const outside = path.join(tmpDir, 'outside-target.txt');
      await fs.promises.writeFile(outside, 'x'.repeat(5000));
      await fs.promises.unlink(result.objectPath);
      await fs.promises.symlink(outside, result.objectPath);

      // Lookup must not serve the link target's bytes (§9: do not follow),
      // and the budget must not count a link GC can never reclaim.
      expect(await storage.objectExists(result.managedId)).toBe(false);
      expect(await storage.findObjectPath(result.managedId)).toBeUndefined();
      const status = await storage.getBudgetStatus();
      expect(status.objectCount).toBe(0);
      expect(status.totalBytes).toBe(0);
      expect(status.overBudget).toBe(false);
    });
  });
});

describe('GC', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'omni-gc-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function emptyRootProvider(): GcRootProvider {
    return { getReferencedManagedIds: async () => new Set() };
  }

  function rootProviderWith(ids: string[]): GcRootProvider {
    return { getReferencedManagedIds: async () => new Set(ids) };
  }

  it('sweeps unreferenced objects past retention', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({ retentionDays: 0 }),
    );
    await storage.initialize();

    const { managedId } = await storage.commitBuffer(
      Buffer.from('old object'),
      '.bin',
    );

    // Backdate the object mtime
    const objPath = await storage.findObjectPath(managedId);
    const past = new Date(Date.now() - 86_400_000);
    await fs.promises.utimes(objPath!, past, past);

    const result = await storage.runGc(emptyRootProvider());
    expect(result.sweptCount).toBe(1);
    expect(await storage.objectExists(managedId)).toBe(false);
  });

  it('retains unreferenced objects within retention period', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({ retentionDays: 14 }),
    );
    await storage.initialize();

    const { managedId } = await storage.commitBuffer(
      Buffer.from('recent object'),
      '.bin',
    );

    const result = await storage.runGc(emptyRootProvider());
    expect(result.sweptCount).toBe(0);
    expect(await storage.objectExists(managedId)).toBe(true);
  });

  it('never deletes referenced objects', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({ retentionDays: 0 }),
    );
    await storage.initialize();

    const { managedId } = await storage.commitBuffer(
      Buffer.from('referenced object'),
      '.bin',
    );

    const objPath = await storage.findObjectPath(managedId);
    const past = new Date(Date.now() - 86_400_000);
    await fs.promises.utimes(objPath!, past, past);

    const result = await storage.runGc(rootProviderWith([managedId]));
    expect(result.sweptCount).toBe(0);
    expect(result.retainedCount).toBe(1);
    expect(await storage.objectExists(managedId)).toBe(true);
  });

  it('budget-sweeps oldest unreferenced when over maxTotalBytes', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({ maxTotalBytes: 50, retentionDays: 14 }),
    );
    await storage.initialize();

    // Create 3 objects of ~30 bytes each (total ~90 > 50 budget)
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { managedId } = await storage.commitBuffer(
        Buffer.from(`object-${i}-${'x'.repeat(20)}`),
        '.bin',
      );
      ids.push(managedId);
      // Stagger mtimes
      const objPath = await storage.findObjectPath(managedId);
      const t = new Date(Date.now() - (3 - i) * 1000);
      await fs.promises.utimes(objPath!, t, t);
    }

    const result = await storage.runGc(emptyRootProvider());
    expect(result.sweptCount).toBeGreaterThan(0);

    // Oldest should be swept first, newest should survive
    expect(await storage.objectExists(ids[0]!)).toBe(false);
    expect(await storage.objectExists(ids[2]!)).toBe(true);
  });

  it('cascades upload cache invalidation on GC sweep', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({ retentionDays: 0 }),
    );
    await storage.initialize();

    const { managedId, sha256: hash } = await storage.commitBuffer(
      Buffer.from('cached object'),
      '.bin',
    );
    storage.setUploadEntry(hash, 'model-a', {
      ossUrl: 'oss://bucket/cached',
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(storage.getUploadEntry(hash, 'model-a')).toBeDefined();

    const objPath = await storage.findObjectPath(managedId);
    const past = new Date(Date.now() - 86_400_000);
    await fs.promises.utimes(objPath!, past, past);

    await storage.runGc(emptyRootProvider());
    expect(await storage.objectExists(managedId)).toBe(false);
    expect(storage.getUploadEntry(hash, 'model-a')).toBeUndefined();
  });

  it('reports overBudget when all remaining objects are referenced', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({ maxTotalBytes: 10, retentionDays: 14 }),
    );
    await storage.initialize();

    const { managedId } = await storage.commitBuffer(
      Buffer.from('x'.repeat(100)),
      '.bin',
    );

    const result = await storage.runGc(rootProviderWith([managedId]));
    expect(result.overBudget).toBe(true);
    expect(result.budgetWarning).toBeDefined();
    expect(await storage.objectExists(managedId)).toBe(true);
  });
});

describe('startup recovery', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'omni-recovery-'),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('cleans staging dirs, .part files, and .tmp files', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig(),
    );
    await storage.initialize();

    const root = path.join(tmpDir, 'omni');

    // Create orphan staging dir
    await fs.promises.mkdir(path.join(root, 'staging', 'orphan-inv'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(root, 'staging', 'orphan-inv', 'file.bin'),
      'data',
    );

    // Create expired .part file
    const partPath = path.join(root, 'downloads', 'old.part');
    await fs.promises.writeFile(partPath, 'partial');
    const past = new Date(Date.now() - 72 * 3_600_000);
    await fs.promises.utimes(partPath, past, past);

    // Create a FRESH .part file (in-progress download inside the
    // partRetentionHours resume window — must survive recovery)
    const freshPart = path.join(root, 'downloads', 'fresh.part');
    await fs.promises.writeFile(freshPart, 'in progress');

    // Create .tmp in objects prefix dir
    await fs.promises.mkdir(path.join(root, 'objects', 'ab'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(root, 'objects', 'ab', 'ab123.tmp'),
      'temp',
    );

    // Create .tmp in objects root (from commitObject protocol)
    await fs.promises.writeFile(
      path.join(root, 'objects', '.commit-deadbeef.tmp'),
      'leaked temp',
    );

    const result = await storage.runStartupRecovery();
    expect(result.stagingDirsRemoved).toBe(1);
    expect(result.partFilesRemoved).toBe(1);
    expect(result.tmpFilesRemoved).toBeGreaterThanOrEqual(2);

    // Fresh .part must survive (download-resume window)
    await expect(fs.promises.stat(freshPart)).resolves.toBeDefined();

    // Verify cleaned
    const stagingEntries = await fs.promises.readdir(
      path.join(root, 'staging'),
    );
    expect(stagingEntries).toHaveLength(0);
  });

  it('detects hash mismatches in sample verification', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig(),
    );
    await storage.initialize();

    // Commit a valid object
    const data = Buffer.from('valid data');
    const { sha256: hash } = await storage.commitBuffer(data, '.bin');

    // Corrupt it
    const objPath = await storage.findObjectPath(hashToManagedId(hash));
    await fs.promises.writeFile(objPath!, 'corrupted!');

    const result = await storage.runStartupRecovery();
    expect(result.hashMismatches).toContain(hash);
    // The corrupt object must be removed, not left servable
    expect(await storage.objectExists(hashToManagedId(hash))).toBe(false);
    expect(await storage.findObjectPath(hashToManagedId(hash))).toBeUndefined();
  });

  it('cleans quarantine by retention', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({ quarantine: { retentionDays: 1, maxBytes: 5_368_709_120 } }),
    );
    await storage.initialize();

    const root = path.join(tmpDir, 'omni');
    const qDir = path.join(root, 'quarantine', 'old-inv');
    await fs.promises.mkdir(qDir, { recursive: true });
    await fs.promises.writeFile(path.join(qDir, 'artifact.bin'), 'old data');
    const past = new Date(Date.now() - 3 * 86_400_000);
    await fs.promises.utimes(qDir, past, past);

    const result = await storage.runStartupRecovery();
    expect(result.quarantineEntriesRemoved).toBe(1);
  });

  it('cleans quarantine by budget (oldest first)', async () => {
    const storage = new ManagedMediaStorage(
      path.join(tmpDir, 'omni'),
      testConfig({
        quarantine: { retentionDays: 30, maxBytes: 100 },
      }),
    );
    await storage.initialize();

    const root = path.join(tmpDir, 'omni');

    // Create two quarantine dirs, each ~60 bytes (total ~120 > 100 budget)
    for (const [name, age] of [
      ['q-old', 2000],
      ['q-new', 1000],
    ] as const) {
      const dir = path.join(root, 'quarantine', name);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, 'artifact.bin'),
        'x'.repeat(60),
      );
      const t = new Date(Date.now() - age);
      await fs.promises.utimes(dir, t, t);
    }

    const result = await storage.runStartupRecovery();
    // Oldest should be removed to get under budget
    expect(result.quarantineEntriesRemoved).toBeGreaterThanOrEqual(1);

    const remaining = await fs.promises.readdir(path.join(root, 'quarantine'));
    expect(remaining).toContain('q-new');
  });
});

describe('OmniUploadCache', () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'omni-cache-'));
    cachePath = path.join(tmpDir, 'upload-cache.json');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves entries', () => {
    const cache = new OmniUploadCache(cachePath);
    const entry = {
      ossUrl: 'oss://bucket/obj1',
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    cache.set('abc123', 'model-a', entry);

    const retrieved = cache.get('abc123', 'model-a');
    expect(retrieved?.ossUrl).toBe('oss://bucket/obj1');
    // model is part of the key (design §8: switching models re-uploads)
    expect(cache.get('abc123', 'model-b')).toBeUndefined();
  });

  it('survives a transient non-ENOENT read failure without data loss', () => {
    // A directory at the cache path makes readFileSync throw EISDIR —
    // load must propagate instead of resetting to an empty map.
    fs.mkdirSync(cachePath);
    const cache = new OmniUploadCache(cachePath);
    expect(() => cache.get('h', 'm')).toThrow();
    // The failure must not be memoized as an empty cache either
    expect(() => cache.get('h', 'm')).toThrow();
  });

  it('merges foreign entries instead of clobbering another session', () => {
    const entry = (url: string) => ({
      ossUrl: url,
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const sessionA = new OmniUploadCache(cachePath);
    sessionA.set('hash-a', 'm', entry('oss://b/a'));
    const sessionB = new OmniUploadCache(cachePath);
    expect(sessionB.get('hash-a', 'm')).toBeDefined();
    sessionB.set('hash-b', 'm', entry('oss://b/b'));
    // session A still holds its stale memoized map; its save must merge
    sessionA.set('hash-c', 'm', entry('oss://b/c'));

    const check = new OmniUploadCache(cachePath);
    expect(check.get('hash-a', 'm')).toBeDefined();
    expect(check.get('hash-b', 'm')).toBeDefined();
    expect(check.get('hash-c', 'm')).toBeDefined();
  });

  it('removes the temp file when persistence fails', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return; // root ignores permission bits
    }
    const cache = new OmniUploadCache(cachePath);
    cache.set('h', 'm', {
      ossUrl: 'oss://b/o',
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    fs.chmodSync(tmpDir, 0o500);
    try {
      cache.set('h2', 'm', {
        ossUrl: 'oss://b/o2',
        uploadedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const leftovers = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('.upload-cache-'));
      expect(leftovers).toHaveLength(0);
    } finally {
      fs.chmodSync(tmpDir, 0o700);
    }
  });

  it('returns undefined for expired entries', () => {
    const cache = new OmniUploadCache(cachePath);
    cache.set('abc123', 'model-a', {
      ossUrl: 'oss://bucket/obj1',
      uploadedAt: new Date(Date.now() - 100_000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect(cache.get('abc123', 'model-a')).toBeUndefined();
  });

  it('persists across instances', () => {
    const cache1 = new OmniUploadCache(cachePath);
    cache1.set('hash1', 'model-x', {
      ossUrl: 'oss://bucket/persisted',
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const cache2 = new OmniUploadCache(cachePath);
    expect(cache2.get('hash1', 'model-x')?.ossUrl).toBe(
      'oss://bucket/persisted',
    );
  });

  it('invalidates all models for a sha256', () => {
    const cache = new OmniUploadCache(cachePath);
    const entry = {
      ossUrl: 'oss://b/o',
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    cache.set('hash1', 'model-a', entry);
    cache.set('hash1', 'model-b', entry);
    cache.set('hash2', 'model-a', entry);

    cache.invalidate('hash1');

    expect(cache.get('hash1', 'model-a')).toBeUndefined();
    expect(cache.get('hash1', 'model-b')).toBeUndefined();
    expect(cache.get('hash2', 'model-a')).toBeDefined();
  });

  it('prunes expired entries', () => {
    const cache = new OmniUploadCache(cachePath);
    cache.set('old', 'model-a', {
      ossUrl: 'oss://b/old',
      uploadedAt: new Date(Date.now() - 200_000).toISOString(),
      expiresAt: new Date(Date.now() - 100_000).toISOString(),
    });
    cache.set('fresh', 'model-a', {
      ossUrl: 'oss://b/fresh',
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const pruned = cache.pruneExpired();
    expect(pruned).toBe(1);
    expect(cache.get('old', 'model-a')).toBeUndefined();
    expect(cache.get('fresh', 'model-a')).toBeDefined();
  });
});

describe('managedId helpers', () => {
  it('round-trips hash ↔ managedId', () => {
    const hash = 'a'.repeat(64);
    const id = hashToManagedId(hash);
    expect(id).toBe(`sha256:${hash}`);
    expect(managedIdToHash(id)).toBe(hash);
  });

  it('rejects invalid managedId prefix', () => {
    expect(() => managedIdToHash('md5:abc')).toThrow('Invalid managedId');
  });

  it('rejects truncated hash', () => {
    expect(() => managedIdToHash('sha256:ab12')).toThrow('Invalid managedId');
  });

  it('rejects non-hex hash', () => {
    expect(() => managedIdToHash(`sha256:${'g'.repeat(64)}`)).toThrow(
      'Invalid managedId',
    );
  });
});
