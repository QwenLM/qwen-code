/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type {
  GcResult,
  GcRootProvider,
  OmniStorageConfig,
  OmniStoragePaths,
  RecoveryResult,
} from './types.js';
import { hashToManagedId } from './types.js';
import type { OmniUploadCache } from './omni-upload-cache.js';

const debugLogger = createDebugLogger('OMNI_GC');

const HASH_SAMPLE_SIZE = 20;

interface ObjectEntry {
  sha256: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

async function listObjects(objectsDir: string): Promise<ObjectEntry[]> {
  const entries: ObjectEntry[] = [];
  let prefixDirs: string[];
  try {
    prefixDirs = await fs.promises.readdir(objectsDir);
  } catch {
    return entries;
  }
  for (const prefix of prefixDirs) {
    const prefixPath = path.join(objectsDir, prefix);
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
      const filePath = path.join(prefixPath, file);
      try {
        const fileStat = await fs.promises.lstat(filePath);
        if (!fileStat.isFile()) continue;
        const dotIndex = file.indexOf('.');
        const sha256 = dotIndex > 0 ? file.slice(0, dotIndex) : file;
        entries.push({
          sha256,
          filePath,
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }
  return entries;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(fullPath);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.promises.stat(fullPath);
        total += stat.size;
      } catch {
        // skip
      }
    }
  }
  return total;
}

export async function runGc(
  paths: OmniStoragePaths,
  config: OmniStorageConfig,
  uploadCache: OmniUploadCache,
  rootProvider: GcRootProvider,
): Promise<GcResult> {
  // Enumerate objects BEFORE snapshotting roots: the commit protocol puts
  // bytes on disk before the Memory transaction registers its reference,
  // so an object committed during the walk must not classify as
  // unreferenced in this pass (it would simply miss this enumeration).
  const objects = await listObjects(paths.objectsDir);
  const rootSet = await rootProvider.getReferencedManagedIds();
  const retentionCutoff = Date.now() - config.retentionDays * 86_400_000;

  const referenced: ObjectEntry[] = [];
  const unreferenced: ObjectEntry[] = [];

  for (const obj of objects) {
    if (rootSet.has(hashToManagedId(obj.sha256))) {
      referenced.push(obj);
    } else {
      unreferenced.push(obj);
    }
  }

  // Phase 1: sweep unreferenced objects past retention
  const toSweep: ObjectEntry[] = [];
  const graceRetained: ObjectEntry[] = [];
  for (const obj of unreferenced) {
    if (obj.mtimeMs < retentionCutoff) {
      toSweep.push(obj);
    } else {
      graceRetained.push(obj);
    }
  }

  let sweptBytes = 0;
  let sweptCount = 0;
  let failedSweepBytes = 0;
  const sweptHashes: string[] = [];
  for (const obj of toSweep) {
    try {
      await fs.promises.unlink(obj.filePath);
      sweptBytes += obj.sizeBytes;
      sweptCount++;
      sweptHashes.push(obj.sha256);
      debugLogger.debug(`Swept object ${obj.sha256}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        failedSweepBytes += obj.sizeBytes;
      }
    }
  }

  // Phase 2: if still over budget, sweep oldest unreferenced (within retention)
  let currentBytes =
    referenced.reduce((s, o) => s + o.sizeBytes, 0) +
    graceRetained.reduce((s, o) => s + o.sizeBytes, 0) +
    failedSweepBytes;

  if (currentBytes > config.maxTotalBytes) {
    graceRetained.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const obj of graceRetained) {
      if (currentBytes <= config.maxTotalBytes) break;
      try {
        await fs.promises.unlink(obj.filePath);
        currentBytes -= obj.sizeBytes;
        sweptBytes += obj.sizeBytes;
        sweptCount++;
        sweptHashes.push(obj.sha256);
        debugLogger.debug(`Budget-swept object ${obj.sha256}`);
      } catch (err) {
        // ENOENT: deleted concurrently — the bytes are already free, so
        // drop them from the accounting (and invalidate the cache entry,
        // since the remover may not have been deleteObject). Genuine
        // failures keep the bytes counted, as in phase 1.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          currentBytes -= obj.sizeBytes;
          sweptHashes.push(obj.sha256);
        }
      }
    }
  }

  try {
    uploadCache.invalidateMany(sweptHashes);
  } catch (err) {
    // Cache invalidation must not discard the GcResult after the sweep
    // already ran; stale entries degrade to a delivery miss (§9) and age
    // out via pruneExpired.
    debugLogger.warn('Failed to invalidate upload cache after GC:', err);
  }

  const overBudget = currentBytes > config.maxTotalBytes;
  const result: GcResult = {
    sweptCount,
    sweptBytes,
    retainedCount: referenced.length,
    retainedBytes: referenced.reduce((s, o) => s + o.sizeBytes, 0),
    overBudget,
  };

  if (overBudget) {
    result.budgetWarning = `Objects store at ${currentBytes} bytes exceeds budget ${config.maxTotalBytes}; all remaining objects are referenced and cannot be deleted. New derivations should be stopped.`;
    debugLogger.warn(result.budgetWarning);
  }

  return result;
}

export async function runStartupRecovery(
  paths: OmniStoragePaths,
  config: OmniStorageConfig,
  uploadCache: OmniUploadCache,
): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    stagingDirsRemoved: 0,
    partFilesRemoved: 0,
    quarantineEntriesRemoved: 0,
    tmpFilesRemoved: 0,
    hashMismatches: [],
  };

  // 1. Remove all staging directories
  try {
    const stagingEntries = await fs.promises.readdir(paths.stagingDir);
    for (const entry of stagingEntries) {
      try {
        await fs.promises.rm(path.join(paths.stagingDir, entry), {
          recursive: true,
          force: true,
        });
        result.stagingDirsRemoved++;
      } catch {
        // best effort
      }
    }
  } catch {
    // staging dir may not exist
  }

  // 2. Remove expired .part files
  const partCutoff = Date.now() - config.partRetentionHours * 3_600_000;
  try {
    const partFiles = await fs.promises.readdir(paths.downloadsDir);
    for (const file of partFiles) {
      if (!file.endsWith('.part')) continue;
      const filePath = path.join(paths.downloadsDir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < partCutoff) {
          await fs.promises.unlink(filePath);
          result.partFilesRemoved++;
        }
      } catch {
        // best effort
      }
    }
  } catch {
    // downloads dir may not exist
  }

  // 3. Clean quarantine by retention and budget
  try {
    const quarantineEntries = await fs.promises.readdir(paths.quarantineDir);
    const quarantineCutoff =
      Date.now() - config.quarantine.retentionDays * 86_400_000;

    const quarantineDirs: Array<{
      name: string;
      mtimeMs: number;
      size: number;
    }> = [];
    for (const entry of quarantineEntries) {
      const entryPath = path.join(paths.quarantineDir, entry);
      try {
        const stat = await fs.promises.stat(entryPath);
        if (!stat.isDirectory()) continue;
        const size = await dirSize(entryPath);
        quarantineDirs.push({ name: entry, mtimeMs: stat.mtimeMs, size });
      } catch {
        continue;
      }
    }

    // Remove expired
    for (const dir of quarantineDirs) {
      if (dir.mtimeMs < quarantineCutoff) {
        try {
          await fs.promises.rm(path.join(paths.quarantineDir, dir.name), {
            recursive: true,
            force: true,
          });
          result.quarantineEntriesRemoved++;
        } catch {
          // best effort
        }
      }
    }

    // Remove oldest if over budget
    let quarantineBytes = quarantineDirs
      .filter((d) => d.mtimeMs >= quarantineCutoff)
      .reduce((s, d) => s + d.size, 0);
    if (quarantineBytes > config.quarantine.maxBytes) {
      const remaining = quarantineDirs
        .filter((d) => d.mtimeMs >= quarantineCutoff)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const dir of remaining) {
        if (quarantineBytes <= config.quarantine.maxBytes) break;
        try {
          await fs.promises.rm(path.join(paths.quarantineDir, dir.name), {
            recursive: true,
            force: true,
          });
          quarantineBytes -= dir.size;
          result.quarantineEntriesRemoved++;
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // quarantine dir may not exist
  }

  // 4. Remove .tmp files in objects/
  try {
    const prefixDirs = await fs.promises.readdir(paths.objectsDir);
    for (const prefix of prefixDirs) {
      const prefixPath = path.join(paths.objectsDir, prefix);
      try {
        const stat = await fs.promises.lstat(prefixPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      let files: string[];
      try {
        files = await fs.promises.readdir(prefixPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.tmp')) continue;
        try {
          await fs.promises.unlink(path.join(prefixPath, file));
          result.tmpFilesRemoved++;
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // objects dir may not exist
  }

  // Also clean .tmp files directly in objects/ root (from commit protocol)
  try {
    const rootFiles = await fs.promises.readdir(paths.objectsDir);
    for (const file of rootFiles) {
      if (!file.endsWith('.tmp')) continue;
      try {
        await fs.promises.unlink(path.join(paths.objectsDir, file));
        result.tmpFilesRemoved++;
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }

  // 5. Sample-verify object hashes (random sample per design §6.1 — a fixed
  // stride would never reach a corrupted object at an off-stride index)
  const objects = await listObjects(paths.objectsDir);
  const sampleSize = Math.min(objects.length, HASH_SAMPLE_SIZE);
  if (sampleSize > 0) {
    const indices = objects.map((_, i) => i);
    for (let i = 0; i < sampleSize; i++) {
      const j = i + Math.floor(Math.random() * (indices.length - i));
      [indices[i], indices[j]] = [indices[j]!, indices[i]!];
    }
    for (let i = 0; i < sampleSize; i++) {
      const obj = objects[indices[i]!]!;
      try {
        const hash = createHash('sha256');
        await pipeline(fs.createReadStream(obj.filePath), hash);
        const actual = hash.digest('hex');
        if (actual !== obj.sha256) {
          result.hashMismatches.push(obj.sha256);
          debugLogger.warn(
            `Hash mismatch for object ${obj.sha256}: actual ${actual}`,
          );
          await fs.promises.unlink(obj.filePath).catch(() => {});
        }
      } catch {
        // unreadable object — skip
      }
    }
  }

  // 6. Prune expired upload cache entries (best-effort, like every other
  // recovery step: an unreadable cache file must not abort startup after
  // cleanup already ran).
  try {
    uploadCache.pruneExpired();
  } catch (err) {
    debugLogger.warn('Failed to prune expired upload cache entries:', err);
  }

  debugLogger.info(
    `Startup recovery: ${result.stagingDirsRemoved} staging, ` +
      `${result.partFilesRemoved} parts, ` +
      `${result.quarantineEntriesRemoved} quarantine, ` +
      `${result.tmpFilesRemoved} tmp, ` +
      `${result.hashMismatches.length} hash mismatches`,
  );

  return result;
}
