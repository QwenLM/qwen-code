/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
} from './paths.js';
import { listTrustedMemoryMarkdownFiles } from './trusted-memory-filesystem.js';
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { ensureAutoMemoryScaffold } from './store.js';
import type { AutoMemoryMetadata, AutoMemoryType } from './types.js';
import { logMemoryDream, MemoryDreamEvent } from '../telemetry/index.js';
import * as path from 'node:path';
import {
  parseAutoMemoryTopicDocument,
  validateStructuredAutoMemoryDocument,
} from './scan.js';
import { scanMemoryMetadataMigrationCandidates } from './metadata-migration.js';
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
  // Enumerate through the trusted helper every other memory scanner uses: a
  // directory named `*.md` or an unreadable file must not fail the whole
  // dream with EISDIR/EACCES, and a symlinked entry must never contribute
  // out-of-root bytes to the snapshot. Only the user-owned root may itself
  // be a symlink (dotfiles layout) — a symlinked in-repo project root is
  // refused, matching the scan and write paths.
  const files = await listTrustedMemoryMarkdownFiles(
    memoryRoot,
    getMemoryRootTrustedAnchor(memoryRoot),
    AUTO_MEMORY_INDEX_FILENAME,
    { followRootSymlink: scope === 'user' },
  );
  const snapshot = new Map<string, DreamSnapshotEntry>();
  await Promise.all(
    files.map(async ({ relativePath, resolvedPath }) => {
      let content: string;
      try {
        content = await fs.readFile(resolvedPath, 'utf-8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') return;
        throw error;
      }

      let parsed: ReturnType<typeof parseAutoMemoryTopicDocument> = null;
      try {
        parsed = parseAutoMemoryTopicDocument(
          path.join(memoryRoot, relativePath),
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
        valid: validateStructuredAutoMemoryDocument(content).valid,
      });
    }),
  );
  return snapshot;
}

export function diffDreamSnapshots(
  before: Map<string, DreamSnapshotEntry>,
  after: Map<string, DreamSnapshotEntry>,
  includedPaths?: ReadonlySet<string>,
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
    if (includedPaths && !includedPaths.has(relativePath)) continue;
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
    if (includedPaths && !includedPaths.has(relativePath)) continue;
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
  includedPaths?: ReadonlySet<string>,
): void {
  for (const [relativePath, entry] of after) {
    if (includedPaths && !includedPaths.has(relativePath)) continue;
    const previous = before.get(relativePath);
    if (previous?.content !== entry.content && !entry.valid) {
      throw new Error(
        `Dream produced an invalid memory document: ${relativePath}`,
      );
    }
  }
}

export function dreamRelativePaths(
  memoryRoot: string,
  filePaths: readonly string[],
): Set<string> {
  const relativePaths = new Set<string>();
  for (const filePath of filePaths) {
    const relativePath = path.relative(
      memoryRoot,
      path.resolve(memoryRoot, filePath),
    );
    if (
      relativePath !== '' &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    ) {
      relativePaths.add(relativePath.split(path.sep).join('/'));
    }
  }
  return relativePaths;
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
    const writtenPaths = dreamRelativePaths(
      memoryRoot,
      result.filesWritten ?? result.filesTouched,
    );
    validateDreamSnapshotChanges(before, written, writtenPaths);
    abortSignal?.throwIfAborted();
    operations = await applyDreamOperations(memoryRoot, before, abortSignal);
    after = await snapshotDreamFiles(memoryRoot);
    for (const deletedPath of operations.deletedPaths) {
      writtenPaths.add(deletedPath);
    }
    const changes = diffDreamSnapshots(before, after, writtenPaths);
    return {
      ...changes,
      dedupedEntries: operations.dedupedEntries,
      splitEntries: operations.splitEntries,
      systemMessage: `Managed auto-memory dream (agent): ${
        result.finalText
          ? result.finalText.trim().slice(0, 300)
          : `updated ${result.filesTouched.length} file(s)`
      }`,
    };
  } catch (error) {
    await fs
      .rm(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME), { force: true })
      .catch(() => {});
    throw error;
  }
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

  if (
    options.trigger === 'manual' &&
    // In structured mode the migration this message points at can never be
    // scheduled (scheduleMetadataMigration short-circuits 'complete') and
    // the mode cannot regress to legacy inside the process, so the gate's
    // remedy would be a dead end. The sibling schedulers deliberately skip
    // this gate in structured mode too.
    config.getMemoryRecallMode() !== 'structured' &&
    (
      await scanMemoryMetadataMigrationCandidates(
        getAutoMemoryRoot(projectRoot),
        'project',
      )
    ).length > 0
  ) {
    return {
      touchedTopics: [],
      createdEntries: 0,
      updatedEntries: 0,
      deletedEntries: 0,
      dedupedEntries: 0,
      splitEntries: 0,
      keywordBackfilled: 0,
      systemMessage:
        'Managed auto-memory dream skipped: memory metadata migration is pending.',
    };
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
  // Deleting a file whose frontmatter cannot be parsed yields no touched
  // topic, so gating on touchedTopics alone would skip the rebuild and leave
  // MEMORY.md pointing at deleted files (and record the run as a noop).
  const hasChanges =
    agentResult.createdEntries +
      agentResult.updatedEntries +
      agentResult.deletedEntries >
      0 || agentResult.touchedTopics.length > 0;
  if (hasChanges) {
    await rebuildManagedAutoMemoryIndex(projectRoot);
  }
  if (options.recordMetadata) {
    await updateDreamMetadataResult(
      projectRoot,
      now,
      agentResult.touchedTopics,
      undefined,
      hasChanges,
    );
  }

  logMemoryDream(
    config,
    new MemoryDreamEvent({
      trigger: options.trigger ?? 'auto',
      status: hasChanges ? 'updated' : 'noop',
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
  hasChanges = touchedTopics.length > 0,
): Promise<void> {
  const metadataPath = getAutoMemoryMetadataPath(projectRoot);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    metadata.lastDreamAt = now.toISOString();
    metadata.lastDreamTouchedTopics = touchedTopics;
    metadata.lastDreamStatus = hasChanges ? 'updated' : 'noop';
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
