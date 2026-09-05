/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { getAutoMemoryMetadataPath, getAutoMemoryRoot } from './paths.js';
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { ensureAutoMemoryScaffold } from './store.js';
import type { AutoMemoryMetadata, AutoMemoryType } from './types.js';
import { logMemoryDream, MemoryDreamEvent } from '../telemetry/index.js';
import * as path from 'node:path';
import { parseAutoMemoryTopicDocument } from './scan.js';
import {
  applyDreamOperations,
  type AppliedDreamOperations,
  DREAM_OPERATIONS_FILENAME,
} from './dream-operations.js';

export interface AutoMemoryDreamResult {
  touchedTopics: AutoMemoryType[];
  createdEntries: number;
  updatedEntries: number;
  deletedEntries: number;
  dedupedEntries: number;
  splitEntries: number;
  keywordBackfilled: number;
  systemMessage?: string;
}

export interface DreamSnapshotEntry {
  content: string;
  type?: AutoMemoryType;
  keywordCount: number;
  valid: boolean;
}

export async function snapshotDreamFiles(
  memoryRoot: string,
  scope: 'project' | 'user' = 'project',
): Promise<Map<string, DreamSnapshotEntry>> {
  let entries: string[];
  try {
    entries = (await fs.readdir(memoryRoot, { recursive: true })).filter(
      (entry): entry is string =>
        typeof entry === 'string' &&
        entry.endsWith('.md') &&
        path.basename(entry) !== 'MEMORY.md',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }

  const snapshot = new Map<string, DreamSnapshotEntry>();
  await Promise.all(
    entries.map(async (entry) => {
      const relativePath = entry.replaceAll('\\', '/');
      const filePath = path.join(memoryRoot, entry);
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }

      let parsed: ReturnType<typeof parseAutoMemoryTopicDocument> = null;
      try {
        parsed = parseAutoMemoryTopicDocument(
          filePath,
          content,
          0,
          relativePath,
          scope,
        );
      } catch {
        parsed = null;
      }
      snapshot.set(relativePath, {
        content,
        type: parsed?.type,
        keywordCount: parsed?.keywords.length ?? 0,
        valid: parsed !== null,
      });
    }),
  );
  return snapshot;
}

export function diffDreamSnapshots(
  before: Map<string, DreamSnapshotEntry>,
  after: Map<string, DreamSnapshotEntry>,
): {
  touchedTopics: AutoMemoryType[];
  createdEntries: number;
  updatedEntries: number;
  deletedEntries: number;
  keywordBackfilled: number;
} {
  let createdEntries = 0;
  let updatedEntries = 0;
  let deletedEntries = 0;
  let keywordBackfilled = 0;
  const touchedTopics = new Set<AutoMemoryType>();

  for (const [relativePath, entry] of after) {
    const previous = before.get(relativePath);
    if (!previous) {
      createdEntries += 1;
      if (entry.type) touchedTopics.add(entry.type);
    } else if (previous.content !== entry.content) {
      updatedEntries += 1;
      if (entry.type) touchedTopics.add(entry.type);
      if (previous.keywordCount === 0 && entry.keywordCount > 0) {
        keywordBackfilled += 1;
      }
    }
  }
  for (const [relativePath, entry] of before) {
    if (!after.has(relativePath)) {
      deletedEntries += 1;
      if (entry.type) touchedTopics.add(entry.type);
    }
  }

  return {
    touchedTopics: [...touchedTopics],
    createdEntries,
    updatedEntries,
    deletedEntries,
    keywordBackfilled,
  };
}

export function validateDreamSnapshotChanges(
  before: Map<string, DreamSnapshotEntry>,
  after: Map<string, DreamSnapshotEntry>,
): void {
  for (const [relativePath, entry] of after) {
    const previous = before.get(relativePath);
    if (
      previous?.content !== entry.content &&
      (!entry.valid || entry.keywordCount === 0)
    ) {
      throw new Error(
        `Dream produced an invalid memory document: ${relativePath}`,
      );
    }
  }
}

async function runDreamByAgent(
  projectRoot: string,
  config: Config,
  abortSignal?: AbortSignal,
  options: { suppressChatRecording?: boolean } = {},
): Promise<AutoMemoryDreamResult> {
  const memoryRoot = getAutoMemoryRoot(projectRoot);
  await fs.rm(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME), {
    force: true,
  });
  const before = await snapshotDreamFiles(memoryRoot);
  let result;
  try {
    result = await planManagedAutoMemoryDreamByAgent(
      config,
      projectRoot,
      abortSignal,
      { suppressChatRecording: options.suppressChatRecording },
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
    const written = await snapshotDreamFiles(memoryRoot);
    validateDreamSnapshotChanges(before, written);
    abortSignal?.throwIfAborted();
    operations = await applyDreamOperations(memoryRoot, abortSignal);
    after = await snapshotDreamFiles(memoryRoot);
  } catch (error) {
    await fs
      .rm(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME), { force: true })
      .catch(() => {});
    throw error;
  }
  const changes = diffDreamSnapshots(before, after);

  const summary = result.finalText
    ? result.finalText.trim().slice(0, 300)
    : `updated ${result.filesTouched.length} file(s)`;

  return {
    ...changes,
    dedupedEntries: operations.dedupedEntries,
    splitEntries: operations.splitEntries,
    systemMessage: `Managed auto-memory dream (agent): ${summary}`,
  };
}

export async function runManagedAutoMemoryDream(
  projectRoot: string,
  now = new Date(),
  config?: Config,
  abortSignal?: AbortSignal,
  options: {
    trigger?: 'auto' | 'manual';
    recordMetadata?: boolean;
    suppressChatRecording?: boolean;
  } = {},
): Promise<AutoMemoryDreamResult> {
  await ensureAutoMemoryScaffold(projectRoot, now);
  const t0 = Date.now();

  if (!config) {
    throw new Error(
      'Managed auto-memory dream requires config for forked-agent execution.',
    );
  }

  const agentResult = await runDreamByAgent(projectRoot, config, abortSignal, {
    suppressChatRecording: options.suppressChatRecording,
  });
  // Cancel-aware ordering:
  //   1. If aborted before this point, return the agent's partial result
  //      WITHOUT rebuilding the index — index rebuild can be expensive
  //      and re-running a cancelled dream cycle next time will rebuild
  //      against the latest topic files anyway.
  //   2. If still alive, deterministically rebuild the generated index.
  // Scheduler-gating metadata (`lastDreamAt`, `lastDreamSessionId`,
  // `lastDreamTouchedTopics`, `lastDreamStatus`) is intentionally NOT
  // written here — `MemoryManager.runDream` owns the atomic
  // status-flip + metadata-write sequence to close the cancel race
  // window where a writeFile finishing concurrently with a cancel
  // could persist gating metadata for a record the manager is about
  // to mark `'cancelled'`.
  if (abortSignal?.aborted) return agentResult;
  if (agentResult.touchedTopics.length > 0) {
    await rebuildManagedAutoMemoryIndex(projectRoot);
  }
  if (options.recordMetadata) {
    await updateDreamMetadataResult(
      projectRoot,
      now,
      agentResult.touchedTopics,
    );
  }

  logMemoryDream(
    config,
    new MemoryDreamEvent({
      trigger: options.trigger ?? 'auto',
      status: agentResult.touchedTopics.length > 0 ? 'updated' : 'noop',
      deduped_entries: agentResult.dedupedEntries,
      created_entries: agentResult.createdEntries,
      updated_entries: agentResult.updatedEntries,
      deleted_entries: agentResult.deletedEntries,
      split_entries: agentResult.splitEntries,
      keyword_backfilled: agentResult.keywordBackfilled,
      touched_topics: agentResult.touchedTopics,
      duration_ms: Date.now() - t0,
    }),
  );
  return agentResult;
}

async function updateDreamMetadataResult(
  projectRoot: string,
  now: Date,
  touchedTopics: AutoMemoryType[],
  sessionId?: string,
): Promise<void> {
  const metadataPath = getAutoMemoryMetadataPath(projectRoot);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    metadata.lastDreamAt = now.toISOString();
    metadata.lastDreamTouchedTopics = touchedTopics;
    metadata.lastDreamStatus = touchedTopics.length > 0 ? 'updated' : 'noop';
    if (sessionId !== undefined) {
      metadata.lastDreamSessionId = sessionId;
      metadata.recentSessionIdsSinceDream = [];
    }
    await atomicWriteFile(
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf-8' },
    );
  } catch {
    // Best-effort metadata bump.
  }
}

/**
 * Record that the user manually ran /dream. Called from the CLI command's
 * onComplete callback after the main agent turn finishes writing memory files.
 * Writes lastDreamAt, lastDreamSessionId, and resets recentSessionIdsSinceDream
 * so that the scheduler's same-session dedupe check prevents a redundant
 * auto-dream from firing in the same session.
 */
export async function writeDreamManualRunToMetadata(
  projectRoot: string,
  sessionId: string,
  now = new Date(),
): Promise<void> {
  return updateDreamMetadataResult(projectRoot, now, [], sessionId);
}
