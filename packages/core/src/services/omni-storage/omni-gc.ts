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
  const rootSet = await rootProvider.getReferencedManagedIds();
  const objects = await listObjects(paths.objectsDir);
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
  const sweptHashes: string[] = [];
  for (const obj of toSweep) {
    try {
      await fs.promises.unlink(obj.filePath);
      sweptBytes += obj.sizeBytes;
      sweptCount++;
      sweptHashes.push(obj.sha256);
      debugLogger.debug(`Swept object ${obj.sha256}`);
    } catch {
      // already gone or permission error — skip
    }
  }

  // Phase 2: if still over budget, sweep oldest unreferenced (within retention)
  const totalBytes =
    referenced.reduce((s, o) => s + o.sizeBytes, 0) +
    graceRetained.reduce((s, o) => s + o.sizeBytes, 0) +
    sweptBytes;
  let currentBytes = totalBytes - sweptBytes;

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
      } catch {
        // already gone
      }
    }
  }

  uploadCache.invalidateMany(sweptHashes);

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

  // 5. Sample-verify object hashes
  const objects = await listObjects(paths.objectsDir);
  const sampleSize = Math.min(objects.length, HASH_SAMPLE_SIZE);
  if (sampleSize > 0) {
    const step = Math.max(1, Math.floor(objects.length / sampleSize));
    for (let i = 0; i < objects.length; i += step) {
      const obj = objects[i]!;
      try {
        const hash = createHash('sha256');
        await pipeline(fs.createReadStream(obj.filePath), hash);
        const actual = hash.digest('hex');
        if (actual !== obj.sha256) {
          result.hashMismatches.push(obj.sha256);
          debugLogger.warn(
            `Hash mismatch for object ${obj.sha256}: actual ${actual}`,
          );
        }
      } catch {
        // unreadable object — skip
      }
    }
  }

  // 6. Prune expired upload cache entries
  uploadCache.pruneExpired();

  debugLogger.info(
    `Startup recovery: ${result.stagingDirsRemoved} staging, ` +
      `${result.partFilesRemoved} parts, ` +
      `${result.quarantineEntriesRemoved} quarantine, ` +
      `${result.tmpFilesRemoved} tmp, ` +
      `${result.hashMismatches.length} hash mismatches`,
  );

  return result;
}
