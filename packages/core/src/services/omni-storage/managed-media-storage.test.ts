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

    it('rejects symlinked root', async () => {
      const realDir = path.join(tmpDir, 'real');
      const linkDir = path.join(tmpDir, 'link');
      await fs.promises.mkdir(realDir);
      await fs.promises.symlink(realDir, linkDir);
      const linkStorage = new ManagedMediaStorage(linkDir, testConfig());
      await expect(linkStorage.initialize()).rejects.toThrow('symlink');
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
    });

    it('rejects unsafe invocation IDs', async () => {
      await expect(storage.createStagingDir('../escape')).rejects.toThrow(
        'Unsafe',
      );
      await expect(storage.createStagingDir('a/b')).rejects.toThrow('Unsafe');
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

    // Oldest should be swept first
    expect(await storage.objectExists(ids[0]!)).toBe(false);
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

    // Create .tmp in objects prefix dir
    await fs.promises.mkdir(path.join(root, 'objects', 'ab'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(root, 'objects', 'ab', 'ab123.tmp'),
      'temp',
    );

    const result = await storage.runStartupRecovery();
    expect(result.stagingDirsRemoved).toBe(1);
    expect(result.partFilesRemoved).toBe(1);
    expect(result.tmpFilesRemoved).toBeGreaterThanOrEqual(1);

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

  it('rejects invalid managedId', () => {
    expect(() => managedIdToHash('md5:abc')).toThrow('Invalid managedId');
  });
});
