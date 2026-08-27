/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseAutoMemoryTopicDocument } from './scan.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  AUTO_MEMORY_PINNED_DIRNAME,
} from './paths.js';

export const DREAM_OPERATIONS_FILENAME = '.dream-operations.json';

interface DedupeOperation {
  type: 'dedupe';
  sources: string[];
  target: string;
}

interface SplitOperation {
  type: 'split';
  source: string;
  targets: string[];
}

type DreamOperation = DedupeOperation | SplitOperation;

interface DreamOperationsManifest {
  version: 1;
  delete: string[];
  operations: DreamOperation[];
}

export interface AppliedDreamOperations {
  deletedPaths: string[];
  dedupedEntries: number;
  splitEntries: number;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function parseManifest(value: unknown): DreamOperationsManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Dream operations manifest must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    !isStringArray(record['delete']) ||
    !Array.isArray(record['operations'])
  ) {
    throw new Error('Dream operations manifest has an invalid schema.');
  }

  const operations: DreamOperation[] = record['operations'].map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Dream operation must be an object.');
    }
    const operation = item as Record<string, unknown>;
    if (
      operation['type'] === 'dedupe' &&
      isStringArray(operation['sources']) &&
      operation['sources'].length > 0 &&
      typeof operation['target'] === 'string'
    ) {
      return {
        type: 'dedupe',
        sources: operation['sources'],
        target: operation['target'],
      };
    }
    if (
      operation['type'] === 'split' &&
      typeof operation['source'] === 'string' &&
      isStringArray(operation['targets']) &&
      operation['targets'].length >= 2
    ) {
      return {
        type: 'split',
        source: operation['source'],
        targets: operation['targets'],
      };
    }
    throw new Error('Dream operation has an invalid schema.');
  });

  return { version: 1, delete: record['delete'], operations };
}

function normalizeRelativeMarkdownPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const canonical = path.posix.normalize(normalized);
  const protectedPath = canonical.toLowerCase();
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..') ||
    protectedPath.split('/')[0] === AUTO_MEMORY_PINNED_DIRNAME.toLowerCase() ||
    path.posix.basename(protectedPath) ===
      AUTO_MEMORY_INDEX_FILENAME.toLowerCase() ||
    !normalized.endsWith('.md')
  ) {
    throw new Error(`Dream operation contains an unsafe path: ${value}`);
  }
  return canonical;
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveExistingFile(
  memoryRoot: string,
  relativePath: string,
): Promise<string> {
  const realRoot = await fs.realpath(memoryRoot);
  let literalFile = realRoot;
  for (const segment of relativePath.split('/')) {
    literalFile = path.join(literalFile, segment);
    const stats = await fs.lstat(literalFile);
    if (stats.isSymbolicLink()) {
      throw new Error(`Dream operation cannot use symlinks: ${relativePath}`);
    }
  }

  const realFile = await fs.realpath(literalFile);
  if (!isWithinRoot(realFile, realRoot)) {
    throw new Error(`Dream operation escapes memory root: ${relativePath}`);
  }
  const stats = await fs.lstat(realFile);
  if (!stats.isFile()) {
    throw new Error(`Dream operation path is not a file: ${relativePath}`);
  }
  return realFile;
}

async function validateTarget(
  memoryRoot: string,
  relativePath: string,
): Promise<void> {
  const filePath = await resolveExistingFile(memoryRoot, relativePath);
  const content = await fs.readFile(filePath, 'utf-8');
  if (
    !parseAutoMemoryTopicDocument(filePath, content, 0, relativePath, 'project')
  ) {
    throw new Error(`Dream target is not a valid memory: ${relativePath}`);
  }
}

export async function applyDreamOperations(
  memoryRoot: string,
  abortSignal?: AbortSignal,
): Promise<AppliedDreamOperations> {
  const manifestPath = path.join(memoryRoot, DREAM_OPERATIONS_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deletedPaths: [], dedupedEntries: 0, splitEntries: 0 };
    }
    throw error;
  }

  try {
    const manifest = parseManifest(JSON.parse(raw) as unknown);
    const deletePaths = manifest.delete.map(normalizeRelativeMarkdownPath);
    if (new Set(deletePaths).size !== deletePaths.length) {
      throw new Error('Dream operations manifest contains duplicate deletes.');
    }
    const deleteSet = new Set(deletePaths);
    const dedupedSources = new Set<string>();
    const claimedSources = new Set<string>();
    let splitEntries = 0;

    for (const operation of manifest.operations) {
      if (operation.type === 'dedupe') {
        const target = normalizeRelativeMarkdownPath(operation.target);
        if (deleteSet.has(target)) {
          throw new Error('Dream dedupe target cannot also be deleted.');
        }
        await validateTarget(memoryRoot, target);
        for (const sourceValue of operation.sources) {
          const source = normalizeRelativeMarkdownPath(sourceValue);
          if (!deleteSet.has(source) || source === target) {
            throw new Error('Dream dedupe sources must be deleted files.');
          }
          if (claimedSources.has(source)) {
            throw new Error('Dream source cannot belong to two operations.');
          }
          claimedSources.add(source);
          dedupedSources.add(source);
        }
      } else {
        const source = normalizeRelativeMarkdownPath(operation.source);
        if (!deleteSet.has(source)) {
          throw new Error('Dream split source must be deleted.');
        }
        if (claimedSources.has(source)) {
          throw new Error('Dream source cannot belong to two operations.');
        }
        claimedSources.add(source);
        const targets = operation.targets.map(normalizeRelativeMarkdownPath);
        if (
          new Set(targets).size !== targets.length ||
          targets.some((target) => deleteSet.has(target))
        ) {
          throw new Error(
            'Dream split targets must be unique surviving files.',
          );
        }
        await Promise.all(
          targets.map((target) => validateTarget(memoryRoot, target)),
        );
        splitEntries += 1;
      }
    }

    const resolvedDeletes = await Promise.all(
      deletePaths.map(async (relativePath) => ({
        relativePath,
        filePath: await resolveExistingFile(memoryRoot, relativePath),
      })),
    );
    for (const { filePath } of resolvedDeletes) {
      abortSignal?.throwIfAborted();
      await fs.unlink(filePath);
    }

    return {
      deletedPaths: resolvedDeletes.map(({ relativePath }) => relativePath),
      dedupedEntries: dedupedSources.size,
      splitEntries,
    };
  } finally {
    await fs.rm(manifestPath, { force: true });
  }
}
