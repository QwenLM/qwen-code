/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type {
  BudgetStatus,
  CommitResult,
  GcResult,
  GcRootProvider,
  ManagedId,
  OmniStorageConfig,
  OmniStoragePaths,
  PromoteResult,
  QuarantineReason,
  RecoveryResult,
  UploadCacheEntry,
} from './types.js';
import { hashToManagedId, managedIdToHash } from './types.js';
import { OmniUploadCache } from './omni-upload-cache.js';
import { dirSize, runGc, runStartupRecovery } from './omni-gc.js';

const debugLogger = createDebugLogger('OMNI_STORAGE');

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_EXT = /^\.[a-zA-Z0-9]+$/;

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Unsafe ${label}: "${id}". Only alphanumeric, hyphen, and underscore are allowed.`,
    );
  }
}

function sanitizeExtension(extension: string): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  if (!SAFE_EXT.test(ext) || ext === '.tmp') {
    return '.bin';
  }
  return ext;
}

/**
 * Content-addressed object store for Omni-managed media files.
 *
 * Directory layout under `rootDir`:
 *   objects/      – immutable, content-addressed by SHA-256
 *   downloads/    – in-progress .part files
 *   staging/      – per-invocation work directories (pre-commit)
 *   quarantine/   – failed invocation artifacts (debuggable, bounded)
 *
 * See docs/design/2026-07-30-omni-managed-media-storage.md for the full
 * specification.
 */
export class ManagedMediaStorage {
  private readonly paths: OmniStoragePaths;
  private readonly uploadCache: OmniUploadCache;
  private initialized = false;

  constructor(
    private readonly rootDir: string,
    private readonly config: OmniStorageConfig,
  ) {
    this.paths = {
      objectsDir: path.join(rootDir, 'objects'),
      downloadsDir: path.join(rootDir, 'downloads'),
      stagingDir: path.join(rootDir, 'staging'),
      quarantineDir: path.join(rootDir, 'quarantine'),
    };
    this.uploadCache = new OmniUploadCache(
      path.join(rootDir, 'upload-cache.json'),
    );
  }

  getRootDir(): string {
    return this.rootDir;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.assertNoSymlink(this.rootDir);

    for (const dir of [
      this.rootDir,
      this.paths.objectsDir,
      this.paths.downloadsDir,
      this.paths.stagingDir,
      this.paths.quarantineDir,
    ]) {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    }

    // mkdir does not disturb a pre-existing symlinked region, so re-check
    // each one after creation.
    for (const dir of [
      this.paths.objectsDir,
      this.paths.downloadsDir,
      this.paths.stagingDir,
      this.paths.quarantineDir,
    ]) {
      await this.assertNoSymlink(dir);
    }

    // mkdir's mode only applies when creating; tighten adopted dirs too.
    // Runs after the symlink checks so chmod never follows a planted link.
    for (const dir of [
      this.rootDir,
      this.paths.objectsDir,
      this.paths.downloadsDir,
      this.paths.stagingDir,
      this.paths.quarantineDir,
    ]) {
      await fs.promises.chmod(dir, 0o700).catch((err) => {
        debugLogger.warn(`Could not tighten ${dir} to 0700:`, err);
      });
    }

    const gitignorePath = path.join(this.rootDir, '.gitignore');
    try {
      await fs.promises.writeFile(gitignorePath, '*\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    this.initialized = true;
    debugLogger.info(`Initialized at ${this.rootDir}`);
  }

  // ── Object operations ─────────────────────────────────────────────

  /**
   * Commit a file on disk into the content-addressed object store.
   * Streams through SHA-256, writes a .tmp, then atomic-renames.
   * Deduplication: if the target hash already exists, the temp file is
   * discarded and the existing object is returned.
   */
  async commitObject(
    sourcePath: string,
    extension: string,
  ): Promise<CommitResult> {
    await this.assertNoSymlink(sourcePath);

    const tmpName = `.commit-${randomBytes(8).toString('hex')}.tmp`;
    const tmpPath = path.join(this.paths.objectsDir, tmpName);
    const hash = createHash('sha256');

    await fs.promises.mkdir(this.paths.objectsDir, {
      recursive: true,
      mode: 0o700,
    });

    // Open once and trust the fd from then on: reopening by path after the
    // check would let a racing writer swap in a symlink or special file.
    const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    const handle = await fs.promises.open(
      sourcePath,
      fs.constants.O_RDONLY | noFollow,
    );
    try {
      const sourceStat = await handle.stat();
      if (!sourceStat.isFile()) {
        throw new Error(
          `Refusing non-regular file in commitObject: ${sourcePath}. ` +
            'Symlinks and special files are not allowed.',
        );
      }
      const readStream = handle.createReadStream();
      const writeStream = fs.createWriteStream(tmpPath, { mode: 0o600 });

      readStream.on('data', (chunk) => {
        hash.update(chunk);
      });
      try {
        await pipeline(readStream, writeStream);
      } catch (err) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw err;
      }

      return this.finalizeCommit(
        tmpPath,
        hash.digest('hex'),
        extension,
        sourceStat.size,
      );
    } finally {
      await handle.close();
    }
  }

  /**
   * Commit an in-memory buffer into the object store.
   */
  async commitBuffer(data: Buffer, extension: string): Promise<CommitResult> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    await this.assertNoSymlink(this.objectPathFor(sha256, extension));
    const existing = await this.findByHash(sha256);

    if (existing) {
      const stat = await fs.promises.stat(existing);
      return {
        managedId: hashToManagedId(sha256),
        sha256,
        objectPath: existing,
        deduplicated: true,
        sizeBytes: stat.size,
      };
    }

    const objectPath = this.objectPathFor(sha256, extension);
    const prefixDir = path.dirname(objectPath);
    await fs.promises.mkdir(prefixDir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(
      prefixDir,
      `.commit-${randomBytes(8).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.writeFile(tmpPath, data, { mode: 0o600 });
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
    await fs.promises.rename(tmpPath, objectPath);

    return {
      managedId: hashToManagedId(sha256),
      sha256,
      objectPath,
      deduplicated: false,
      sizeBytes: data.length,
    };
  }

  /**
   * Find the actual path of an object (with extension). Returns undefined
   * if the object does not exist.
   */
  async findObjectPath(managedId: ManagedId): Promise<string | undefined> {
    return this.findByHash(managedIdToHash(managedId));
  }

  async objectExists(managedId: ManagedId): Promise<boolean> {
    return (await this.findObjectPath(managedId)) !== undefined;
  }

  async deleteObject(managedId: ManagedId): Promise<boolean> {
    const objPath = await this.findObjectPath(managedId);
    if (!objPath) return false;
    try {
      await fs.promises.unlink(objPath);
      const sha256 = managedIdToHash(managedId);
      this.uploadCache.invalidate(sha256);
      return true;
    } catch {
      return false;
    }
  }

  // ── Staging ────────────────────────────────────────────────────────

  async createStagingDir(invocationId: string): Promise<string> {
    assertSafeId(invocationId, 'invocationId');
    const dir = path.join(this.paths.stagingDir, invocationId);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  getStagingDir(invocationId: string): string {
    assertSafeId(invocationId, 'invocationId');
    return path.join(this.paths.stagingDir, invocationId);
  }

  /**
   * Promote all files in a staging directory to the object store.
   * Commit order: all artifacts promoted FIRST, then the caller commits
   * the Memory transaction. This ensures active Memory records never
   * reference missing objects.
   */
  async promoteStaging(invocationId: string): Promise<PromoteResult> {
    assertSafeId(invocationId, 'invocationId');
    const stagingPath = path.join(this.paths.stagingDir, invocationId);
    const files = await fs.promises.readdir(stagingPath);
    const objects: CommitResult[] = [];

    for (const file of files) {
      const filePath = path.join(stagingPath, file);
      const stat = await fs.promises.lstat(filePath);
      if (stat.isDirectory()) {
        debugLogger.warn(
          `Refusing subdirectory in staging ${invocationId}: ${filePath}`,
        );
        throw new Error(
          `Unexpected subdirectory in staging ${invocationId}: "${file}". ` +
            'Policy tools must write flat files only.',
        );
      }
      if (!stat.isFile()) {
        debugLogger.warn(
          `Refusing non-regular file in staging ${invocationId}: ${filePath}`,
        );
        throw new Error(
          `Refusing non-regular file in staging ${invocationId}: "${file}". ` +
            'Symlinks and special files are not allowed.',
        );
      }
      const ext = path.extname(file) || '.bin';
      const result = await this.commitObject(filePath, ext);
      objects.push(result);
    }

    await fs.promises.rm(stagingPath, { recursive: true, force: true });
    debugLogger.info(
      `Promoted staging ${invocationId}: ${objects.length} object(s)`,
    );
    return { objects };
  }

  /**
   * Move a staging directory to quarantine with a reason.json.
   */
  async quarantineStaging(
    invocationId: string,
    reason: QuarantineReason,
  ): Promise<void> {
    assertSafeId(invocationId, 'invocationId');
    const stagingPath = path.join(this.paths.stagingDir, invocationId);
    const quarantinePath = path.join(this.paths.quarantineDir, invocationId);

    await fs.promises.mkdir(this.paths.quarantineDir, {
      recursive: true,
      mode: 0o700,
    });
    await fs.promises.rename(stagingPath, quarantinePath);
    await fs.promises.writeFile(
      path.join(quarantinePath, 'reason.json'),
      JSON.stringify(reason, null, 2),
      { mode: 0o600 },
    );
    debugLogger.info(`Quarantined staging ${invocationId}: ${reason.reason}`);
  }

  // ── Downloads ──────────────────────────────────────────────────────

  getDownloadPartPath(downloadId: string): string {
    assertSafeId(downloadId, 'downloadId');
    return path.join(this.paths.downloadsDir, `${downloadId}.part`);
  }

  /**
   * Finalize a completed download: commit the .part file to objects and
   * remove the .part.
   */
  async finalizeDownload(
    partPath: string,
    extension: string,
  ): Promise<CommitResult> {
    const result = await this.commitObject(partPath, extension);
    try {
      await fs.promises.unlink(partPath);
    } catch {
      // already cleaned up
    }
    return result;
  }

  // ── GC & Recovery ─────────────────────────────────────────────────

  async runGc(rootProvider: GcRootProvider): Promise<GcResult> {
    return runGc(this.paths, this.config, this.uploadCache, rootProvider);
  }

  async runStartupRecovery(): Promise<RecoveryResult> {
    return runStartupRecovery(this.paths, this.config, this.uploadCache);
  }

  // ── Budget ─────────────────────────────────────────────────────────

  async getBudgetStatus(): Promise<BudgetStatus> {
    let totalBytes = 0;
    let objectCount = 0;

    try {
      const prefixDirs = await fs.promises.readdir(this.paths.objectsDir);
      for (const prefix of prefixDirs) {
        const prefixPath = path.join(this.paths.objectsDir, prefix);
        let stat: fs.Stats;
        try {
          stat = await fs.promises.lstat(prefixPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        let files: string[];
        try {
          files = await fs.promises.readdir(prefixPath);
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.endsWith('.tmp')) continue;
          let fileStat: fs.Stats;
          try {
            // lstat + isFile mirrors GC's listObjects; stat would follow a
            // planted symlink into the budget with no cleanup path for it.
            fileStat = await fs.promises.lstat(path.join(prefixPath, file));
          } catch {
            continue;
          }
          if (!fileStat.isFile()) continue;
          totalBytes += fileStat.size;
          objectCount++;
        }
      }
    } catch {
      // objects dir may not exist
    }

    let quarantineBytes = 0;
    try {
      const qEntries = await fs.promises.readdir(this.paths.quarantineDir);
      for (const entry of qEntries) {
        quarantineBytes += await dirSize(
          path.join(this.paths.quarantineDir, entry),
        );
      }
    } catch {
      // quarantine dir may not exist
    }

    return {
      totalBytes,
      maxTotalBytes: this.config.maxTotalBytes,
      objectCount,
      overBudget: totalBytes > this.config.maxTotalBytes,
      quarantineBytes,
      quarantineMaxBytes: this.config.quarantine.maxBytes,
      quarantineOverBudget: quarantineBytes > this.config.quarantine.maxBytes,
    };
  }

  // ── Upload cache ───────────────────────────────────────────────────

  getUploadEntry(sha256: string, model: string): UploadCacheEntry | undefined {
    return this.uploadCache.get(sha256, model);
  }

  setUploadEntry(sha256: string, model: string, entry: UploadCacheEntry): void {
    this.uploadCache.set(sha256, model, entry);
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private objectPathFor(sha256: string, extension: string): string {
    const ext = sanitizeExtension(extension);
    return path.join(
      this.paths.objectsDir,
      sha256.slice(0, 2),
      `${sha256}${ext}`,
    );
  }

  private async finalizeCommit(
    tmpPath: string,
    sha256: string,
    extension: string,
    sizeBytes: number,
  ): Promise<CommitResult> {
    await this.assertNoSymlink(this.objectPathFor(sha256, extension));
    const existing = await this.findByHash(sha256);

    if (existing) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      return {
        managedId: hashToManagedId(sha256),
        sha256,
        objectPath: existing,
        deduplicated: true,
        sizeBytes,
      };
    }

    const objectPath = this.objectPathFor(sha256, extension);
    const prefixDir = path.dirname(objectPath);
    await fs.promises.mkdir(prefixDir, { recursive: true, mode: 0o700 });
    await fs.promises.rename(tmpPath, objectPath);

    return {
      managedId: hashToManagedId(sha256),
      sha256,
      objectPath,
      deduplicated: false,
      sizeBytes,
    };
  }

  private async findByHash(sha256: string): Promise<string | undefined> {
    const prefixDir = path.join(this.paths.objectsDir, sha256.slice(0, 2));
    try {
      const files = await fs.promises.readdir(prefixDir);
      const match = files.find(
        (f) => f.startsWith(sha256) && !f.endsWith('.tmp'),
      );
      if (!match) return undefined;
      const candidatePath = path.join(prefixDir, match);
      // Refuse a planted symlink at lookup time instead of serving the
      // link target's bytes (§9: do not follow).
      const st = await fs.promises.lstat(candidatePath);
      if (!st.isFile()) return undefined;
      return candidatePath;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve symlinks in the existing prefix of `p`; nonexistent suffix
   * components cannot be symlinks and are kept as-is.
   */
  private async physicalPath(p: string): Promise<string> {
    let existing = p;
    for (;;) {
      try {
        await fs.promises.lstat(existing);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const parent = path.dirname(existing);
        if (parent === existing) return p;
        existing = parent;
      }
    }
    const real = await fs.promises.realpath(existing);
    return existing === p ? real : path.join(real, p.slice(existing.length));
  }

  /**
   * §3 scopes symlink refusal to the managed tree itself. Symlinks
   * strictly above the storage root are system-managed (macOS
   * /var -> /private/var, relocated home dirs) and are normalized, not
   * refused; anything at or below the root must stay symlink-free. For a
   * path outside the tree (e.g. an external commit source) only the
   * target's own component is checked.
   */
  private async assertNoSymlink(targetPath: string): Promise<void> {
    const resolved = path.resolve(targetPath);
    const root = path.resolve(this.rootDir);
    const rel = path.relative(root, resolved);
    const inside =
      rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    const floor = inside ? root : resolved;

    const floorParent = path.dirname(floor);
    const expectedFloor =
      floorParent === floor
        ? floor
        : path.join(await this.physicalPath(floorParent), path.basename(floor));

    let floorExists = true;
    try {
      await fs.promises.lstat(floor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      floorExists = false;
    }
    if (floorExists && (await fs.promises.realpath(floor)) !== expectedFloor) {
      throw new Error(
        `Symlink detected at "${floor}". Omni storage refuses symlinks ` +
          'at or below the storage root.',
      );
    }

    if (resolved !== floor) {
      const expectedTarget = path.join(expectedFloor, rel);
      if ((await this.physicalPath(resolved)) !== expectedTarget) {
        throw new Error(
          `Symlink detected in path ${targetPath}. Omni storage refuses ` +
            'symlinks at or below the storage root.',
        );
      }
    }
  }
}
