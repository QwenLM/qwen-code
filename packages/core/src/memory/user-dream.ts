/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import {
  diffDreamSnapshots,
  snapshotDreamFiles,
  validateDreamSnapshotChanges,
  type AutoMemoryDreamResult,
  type DreamSnapshotEntry,
} from './dream.js';
import {
  applyDreamOperations,
  type AppliedDreamOperations,
  DREAM_OPERATIONS_FILENAME,
} from './dream-operations.js';
import { rebuildUserAutoMemoryIndex } from './indexer.js';
import {
  getMemoryBaseDir,
  getUserAutoMemoryMetadataPath,
  getUserAutoMemoryRoot,
} from './paths.js';
import { scanUserAutoMemoryTopicDocuments } from './scan.js';
import { ensureUserAutoMemoryScaffold } from './store.js';
import {
  AUTO_MEMORY_SCHEMA_VERSION,
  type UserAutoMemoryDreamStatus,
  type UserAutoMemoryMetadata,
} from './types.js';
import { planUserAutoMemoryDreamByAgent } from './user-dream-agent-planner.js';

const DEFAULT_USER_DREAM_DIRTY_MUTATIONS = 10;
export const DEFAULT_USER_DREAM_MIN_HOURS = 24;
const DEFAULT_USER_DREAM_DOCUMENT_LIMIT = 120;

const METADATA_LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: { retries: 8, minTimeout: 25, maxTimeout: 500, factor: 2 },
  stale: 10_000,
};

interface UserMemoryMutationState {
  metadata: UserAutoMemoryMetadata;
  documentCount: number;
}

const USER_DREAM_STATUSES = new Set<UserAutoMemoryDreamStatus>([
  'idle',
  'pending',
  'running',
  'updated',
  'noop',
  'failed',
  'cancelled',
]);

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function defaultUserMetadata(now: Date): UserAutoMemoryMetadata {
  const timestamp = now.toISOString();
  return {
    version: AUTO_MEMORY_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    dirtyMutations: 0,
    status: 'idle',
  };
}

async function ensureUserMetadata(now: Date): Promise<void> {
  await fs.mkdir(getMemoryBaseDir(), { recursive: true });
  try {
    await fs.writeFile(
      getUserAutoMemoryMetadataPath(),
      `${JSON.stringify(defaultUserMetadata(now), null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export async function readUserAutoMemoryMetadata(
  now = new Date(),
): Promise<UserAutoMemoryMetadata> {
  await ensureUserMetadata(now);
  const metadataPath = getUserAutoMemoryMetadataPath();
  const raw = await fs.readFile(metadataPath, 'utf-8');
  let value: Partial<UserAutoMemoryMetadata>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    value =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Partial<UserAutoMemoryMetadata>)
        : {};
  } catch {
    value = {};
  }
  if (
    value.version !== AUTO_MEMORY_SCHEMA_VERSION ||
    !isValidTimestamp(value.createdAt) ||
    !isValidTimestamp(value.updatedAt) ||
    !Number.isSafeInteger(value.dirtyMutations) ||
    value.dirtyMutations! < 0 ||
    typeof value.status !== 'string' ||
    !USER_DREAM_STATUSES.has(value.status as UserAutoMemoryDreamStatus) ||
    (value.pendingReason !== undefined &&
      value.pendingReason !== 'dirty_mutations' &&
      value.pendingReason !== 'document_limit') ||
    (value.lastDreamAt !== undefined && !isValidTimestamp(value.lastDreamAt))
  ) {
    const replacement = defaultUserMetadata(now);
    await atomicWriteFile(
      metadataPath,
      `${JSON.stringify(replacement, null, 2)}\n`,
      { encoding: 'utf-8' },
    );
    return replacement;
  }
  return value as UserAutoMemoryMetadata;
}

async function mutateUserMetadata(
  now: Date,
  mutate: (metadata: UserAutoMemoryMetadata) => void,
): Promise<UserAutoMemoryMetadata> {
  await ensureUserMetadata(now);
  const metadataPath = getUserAutoMemoryMetadataPath();
  const release = await lockfile.lock(metadataPath, METADATA_LOCK_OPTIONS);
  try {
    const metadata = await readUserAutoMemoryMetadata(now);
    mutate(metadata);
    metadata.updatedAt = now.toISOString();
    await atomicWriteFile(
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf-8' },
    );
    return metadata;
  } finally {
    await release().catch(() => {});
  }
}

async function countUserDocuments(): Promise<number> {
  return (await scanUserAutoMemoryTopicDocuments()).length;
}

function pendingReason(
  dirtyMutations: number,
  documentCount: number,
): UserAutoMemoryMetadata['pendingReason'] {
  if (documentCount >= DEFAULT_USER_DREAM_DOCUMENT_LIMIT) {
    return 'document_limit';
  }
  if (dirtyMutations >= DEFAULT_USER_DREAM_DIRTY_MUTATIONS) {
    return 'dirty_mutations';
  }
  return undefined;
}

export async function recordUserAutoMemoryMutation(
  now = new Date(),
): Promise<UserMemoryMutationState> {
  const documentCount = await countUserDocuments();
  const metadata = await mutateUserMetadata(now, (current) => {
    current.dirtyMutations += 1;
    current.pendingReason = pendingReason(
      current.dirtyMutations,
      documentCount,
    );
    if (current.status !== 'running') {
      current.status = current.pendingReason ? 'pending' : 'idle';
    }
  });
  return { metadata, documentCount };
}

export async function markUserAutoMemoryDreamRunning(
  now = new Date(),
): Promise<UserAutoMemoryMetadata> {
  return mutateUserMetadata(now, (metadata) => {
    metadata.status = 'running';
  });
}

export async function completeUserAutoMemoryDream(
  dirtyAtStart: number,
  result: AutoMemoryDreamResult,
  now = new Date(),
): Promise<UserAutoMemoryMetadata> {
  const documentCount = await countUserDocuments();
  return mutateUserMetadata(now, (metadata) => {
    metadata.dirtyMutations = Math.max(
      0,
      metadata.dirtyMutations - dirtyAtStart,
    );
    metadata.lastDreamAt = now.toISOString();
    metadata.pendingReason = pendingReason(
      metadata.dirtyMutations,
      documentCount,
    );
    metadata.status = metadata.pendingReason
      ? 'pending'
      : result.touchedTopics.length > 0
        ? 'updated'
        : 'noop';
  });
}

export async function failUserAutoMemoryDream(
  status: 'failed' | 'cancelled',
  now = new Date(),
): Promise<UserAutoMemoryMetadata> {
  return mutateUserMetadata(now, (metadata) => {
    metadata.status = status;
  });
}

export async function runManagedUserAutoMemoryDream(
  projectRoot: string,
  config: Config,
  abortSignal?: AbortSignal,
): Promise<AutoMemoryDreamResult> {
  await ensureUserAutoMemoryScaffold();
  const memoryRoot = getUserAutoMemoryRoot();
  await fs.rm(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME), {
    force: true,
  });
  const before = await snapshotDreamFiles(memoryRoot, 'user');
  let agent;
  try {
    agent = await planUserAutoMemoryDreamByAgent(
      config,
      projectRoot,
      abortSignal,
    );
  } catch (error) {
    await fs
      .rm(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME), { force: true })
      .catch(() => {});
    throw error;
  }
  let operations: AppliedDreamOperations;
  let after: Map<string, DreamSnapshotEntry>;
  try {
    const written = await snapshotDreamFiles(memoryRoot, 'user');
    validateDreamSnapshotChanges(before, written);
    abortSignal?.throwIfAborted();
    operations = await applyDreamOperations(memoryRoot, abortSignal);
    after = await snapshotDreamFiles(memoryRoot, 'user');
  } catch (error) {
    await fs
      .rm(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME), { force: true })
      .catch(() => {});
    throw error;
  }
  const changes = diffDreamSnapshots(before, after);
  if (!abortSignal?.aborted) {
    await rebuildUserAutoMemoryIndex();
  }
  const summary = agent.finalText?.trim().slice(0, 300) ?? 'completed';
  const result: AutoMemoryDreamResult = {
    ...changes,
    dedupedEntries: operations.dedupedEntries,
    splitEntries: operations.splitEntries,
    systemMessage: `Managed User Memory dream: ${summary}`,
  };

  return result;
}
