/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { partToString } from '../utils/partUtils.js';
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryMetadataPath,
} from './paths.js';
import {
  ensureAutoMemoryScaffold,
  ensureUserAutoMemoryScaffold,
} from './store.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { blocksAllMemoryWritesForConfig } from './write-access.js';
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import { getCacheSafeParamsSessionId } from '../agents/forkedAgent.js';
import { refreshMemoryInstruction } from './refresh.js';
import {
  type AutoMemoryExtractCursor,
  type AutoMemoryMetadata,
  type AutoMemoryType,
} from './types.js';

const debugLogger = createDebugLogger('AUTO_MEMORY_EXTRACT');

export interface AutoMemoryExtractResult {
  touchedTopics: AutoMemoryType[];
  touchedUserScope?: boolean;
  skippedReason?:
    | 'already_running'
    | 'queued'
    | 'memory_tool'
    | 'memory_pressure'
    | 'session_mismatch'
    | 'writes_denied'
    | 'cadence';
  systemMessage?: string;
  cursor: AutoMemoryExtractCursor;
  /** The extractor ran and used a tool (read or wrote memory files). */
  extractorEngaged?: boolean;
  /** Tool activity or a saved topic, independent of the replay cursor floor. */
  madeGenuineProgress?: boolean;
}

function getSessionMismatchResult(
  sessionId: string,
  expectedSessionId: string,
  now: Date,
): AutoMemoryExtractResult | null {
  const cachedSessionId = getCacheSafeParamsSessionId();
  if (cachedSessionId === undefined || cachedSessionId === expectedSessionId) {
    return null;
  }
  debugLogger.debug('Skipping auto-memory extract: session_mismatch.');
  return {
    touchedTopics: [],
    skippedReason: 'session_mismatch',
    cursor: {
      sessionId,
      updatedAt: now.toISOString(),
    },
  };
}

async function readExtractCursor(
  projectRoot: string,
): Promise<AutoMemoryExtractCursor> {
  try {
    const content = await fs.readFile(
      getAutoMemoryExtractCursorPath(projectRoot),
      'utf-8',
    );
    return JSON.parse(content) as AutoMemoryExtractCursor;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return { updatedAt: new Date(0).toISOString() };
    }
    throw error;
  }
}

async function writeExtractCursor(
  projectRoot: string,
  cursor: AutoMemoryExtractCursor,
): Promise<void> {
  await atomicWriteFile(
    getAutoMemoryExtractCursorPath(projectRoot),
    `${JSON.stringify(cursor, null, 2)}\n`,
    { encoding: 'utf-8' },
  );
}

async function bumpMetadata(
  projectRoot: string,
  now: Date,
  sessionId: string,
  touchedTopics: AutoMemoryType[],
): Promise<void> {
  try {
    const content = await fs.readFile(
      getAutoMemoryMetadataPath(projectRoot),
      'utf-8',
    );
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    metadata.lastExtractionAt = now.toISOString();
    metadata.lastExtractionSessionId = sessionId;
    metadata.lastExtractionTouchedTopics = touchedTopics;
    metadata.lastExtractionStatus =
      touchedTopics.length > 0 ? 'updated' : 'noop';
    await atomicWriteFile(
      getAutoMemoryMetadataPath(projectRoot),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf-8' },
    );
  } catch {
    // Scaffold creation already writes metadata; ignore non-critical update errors.
  }
}

export async function runAutoMemoryExtract(params: {
  projectRoot: string;
  sessionId: string;
  history: Content[];
  now?: Date;
  config?: Config;
  skippedHistory?: Content[];
  // Only the close-time cadence flush (#13004) sets this: an abandoned flush
  // run aborts here instead of keeping a fork alive past its boundary.
  abortSignal?: AbortSignal;
  // Only the close-time cadence flush (#13004) sets this: the replayed
  // snapshot's history can be shorter than the cursor a later run already
  // persisted, so this run's write must not move that cursor backwards.
  flushReplay?: boolean;
}): Promise<AutoMemoryExtractResult> {
  const now = params.now ?? new Date();
  if (!params.config) {
    throw new Error(
      'Managed auto-memory extraction requires config for forked-agent execution.',
    );
  }
  params.abortSignal?.throwIfAborted();
  const expectedSessionId = params.config.getSessionId();
  const earlyMismatch = getSessionMismatchResult(
    params.sessionId,
    expectedSessionId,
    now,
  );
  if (earlyMismatch) return earlyMismatch;

  // A deny list that covers every write tool cannot be worked around by this
  // agent: the scoped memory allow loses to a base deny, so each save would be
  // refused after the fork has already run. Report the skip instead of paying
  // for a run that is guaranteed to save nothing. The cursor stays put, so the
  // turns stay owed if the caller later allows writes.
  if (blocksAllMemoryWritesForConfig(params.config)) {
    debugLogger.debug('Skipping auto-memory extract: writes_denied.');
    return {
      touchedTopics: [],
      skippedReason: 'writes_denied',
      cursor: {
        sessionId: params.sessionId,
        updatedAt: now.toISOString(),
      },
    };
  }

  // Per-project scaffold is required (extraction cursor + metadata live
  // there). User-level scaffold is optional — a brand-new user without
  // write access to `~/.qwen/memories/` should still be able to use
  // project-level memory, so swallow the failure and continue.
  await ensureAutoMemoryScaffold(params.projectRoot, now);
  try {
    await ensureUserAutoMemoryScaffold();
  } catch (error) {
    debugLogger.warn(
      `User-level auto-memory scaffold failed (non-critical, will skip user-level writes this run): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Read the cursor first, then scan only the unprocessed slice. The old
  // code ran partToString().replace() over EVERY message but the resulting
  // text was never read — fork agent context comes from the session-scoped
  // cache-safe params lookup.
  const { projectIndexRebuildPending, ...currentCursor } =
    await readExtractCursor(params.projectRoot);
  if (projectIndexRebuildPending) {
    await rebuildManagedAutoMemoryIndex(params.projectRoot);
    await writeExtractCursor(params.projectRoot, currentCursor);
    await refreshMemoryInstruction(params.config, {
      logContext: 'managed auto-memory index repair',
    });
  }
  const rawOffset =
    currentCursor.sessionId === params.sessionId
      ? (currentCursor.processedOffset ?? 0)
      : 0;
  // History may shrink between extract calls (compression). Clamp to length
  // so new messages after compression are not permanently skipped.
  const startOffset = rawOffset > params.history.length ? 0 : rawOffset;

  // Skip if there are no new, non-empty user messages in the unprocessed
  // slice. partToString runs only on this small slice and without the
  // global whitespace regex — the .trim().length check preserves the old
  // behaviour of ignoring empty-text user turns. A parked supplement
  // (#13004) counts as new content on its own: the turns it holds are owed
  // to the extractor, and an image-only live tail must not let this run
  // advance the cursor past them without a fork.
  const hasNewUserMessages =
    (params.skippedHistory?.length ?? 0) > 0 ||
    params.history
      .slice(startOffset)
      .some(
        (m) =>
          m.role === 'user' && partToString(m.parts ?? []).trim().length > 0,
      );
  if (!hasNewUserMessages) {
    const cursor: AutoMemoryExtractCursor = {
      sessionId: params.sessionId,
      processedOffset: params.history.length,
      updatedAt: now.toISOString(),
    };
    await writeExtractCursor(params.projectRoot, cursor);
    return { touchedTopics: [], cursor };
  }

  const lateMismatch = getSessionMismatchResult(
    params.sessionId,
    expectedSessionId,
    now,
  );
  if (lateMismatch) return lateMismatch;

  const agentResult = await runAutoMemoryExtractionByAgent(
    params.config,
    params.projectRoot,
    params.skippedHistory,
    params.abortSignal,
  );

  const { failure, touchedTopics, touchedProjectScope, touchedUserScope } =
    agentResult;
  const rebuildProject =
    failure?.reconcileAll ||
    touchedProjectScope ||
    (touchedTopics.length > 0 && !touchedUserScope);
  const rebuildUser = failure?.reconcileAll || touchedUserScope;
  if (rebuildProject || rebuildUser) {
    const [projectResult] = await Promise.allSettled([
      rebuildProject
        ? rebuildManagedAutoMemoryIndex(params.projectRoot)
        : Promise.resolve(),
      rebuildUser
        ? rebuildUserAutoMemoryIndex().catch((error: unknown) => {
            debugLogger.warn(`Auto-memory user index rebuild failed: ${error}`);
          })
        : Promise.resolve(),
    ]);

    if (projectResult.status === 'rejected') {
      // The topic is already on disk. A retry can find it and skip writing,
      // so remember the index repair independently of the history offset.
      await writeExtractCursor(params.projectRoot, {
        ...currentCursor,
        projectIndexRebuildPending: true,
      }).catch((error: unknown) => {
        debugLogger.warn(
          `Could not record pending auto-memory index repair: ${error}`,
        );
      });
      if (!failure) throw projectResult.reason;
      debugLogger.warn(
        `Auto-memory project index repair failed: ${projectResult.reason}`,
      );
    }
    await refreshMemoryInstruction(params.config, {
      logContext: 'managed auto-memory extraction',
    });
  }
  if (failure) throw failure.error;

  if (touchedTopics.length > 0) {
    await bumpMetadata(
      params.projectRoot,
      now,
      params.sessionId,
      touchedTopics,
    );
  }

  const madeGenuineProgress =
    agentResult.touchedTopics.length > 0 || agentResult.hasToolActivity;

  const cursor: AutoMemoryExtractCursor = {
    sessionId: params.sessionId,
    // A flush replay runs a parked snapshot whose history a later non-forking
    // run may have already advanced the cursor past, so writing the snapshot's
    // own offset would move that project cursor backwards and make the next run
    // re-scan everything after it. Only the replay is floored: a genuine
    // post-compaction run must still be able to move the cursor down.
    processedOffset: Math.max(
      params.flushReplay ? rawOffset : 0,
      madeGenuineProgress ? params.history.length : startOffset,
    ),
    updatedAt: now.toISOString(),
  };
  await writeExtractCursor(params.projectRoot, cursor);

  debugLogger.debug(
    `Managed auto-memory extract completed with ${agentResult.touchedTopics.length} touched topic(s).`,
  );

  return {
    touchedTopics: agentResult.touchedTopics,
    touchedUserScope: agentResult.touchedUserScope,
    cursor,
    systemMessage: agentResult.systemMessage,
    extractorEngaged: agentResult.extractorEngaged === true,
    madeGenuineProgress,
  };
}
