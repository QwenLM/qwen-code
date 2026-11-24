/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { partToString } from '../utils/partUtils.js';
import { getAutoMemoryRoot, type ProjectMemoryOwner } from './paths.js';
import {
  ensureAutoMemoryScaffold,
  ensureUserAutoMemoryScaffold,
} from './store.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import {
  rebuildProjectMemoryIndexLocked,
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import { getCacheSafeParamsSessionId } from '../agents/forkedAgent.js';
import { refreshMemoryInstruction } from './refresh.js';
import {
  readProjectMemoryCursor,
  updateProjectMemoryMetadata,
  withProjectMemoryCommit,
  writeProjectMemoryCursorLocked,
} from './project-commit.js';
import { type AutoMemoryExtractCursor, type AutoMemoryType } from './types.js';

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
  config: Config,
  now: Date,
): AutoMemoryExtractResult | null {
  const cachedSessionId = getCacheSafeParamsSessionId();
  if (
    config.getSessionId() === sessionId &&
    (cachedSessionId === undefined || cachedSessionId === sessionId)
  ) {
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

async function writeExtractCursor(
  root: string,
  cursor: AutoMemoryExtractCursor,
  flushReplay = false,
  owner?: ProjectMemoryOwner,
): Promise<void> {
  await withProjectMemoryCommit(
    root,
    async () => {
      const latest = (await readProjectMemoryCursor(root, owner)) ?? {
        updatedAt: cursor.updatedAt,
      };
      const sessions = new Map(Object.entries(latest.sessions ?? {}));
      if (latest.sessionId && !sessions.has(latest.sessionId)) {
        sessions.set(latest.sessionId, {
          processedOffset: latest.processedOffset,
          updatedAt: latest.updatedAt,
        });
      }
      const sessionId = cursor.sessionId!;
      const previous = sessions.get(sessionId);
      if (flushReplay && previous) {
        cursor.processedOffset = Math.max(
          cursor.processedOffset ?? 0,
          previous.processedOffset ?? 0,
        );
      }
      sessions.delete(sessionId);
      sessions.set(sessionId, {
        processedOffset: cursor.processedOffset,
        updatedAt: cursor.updatedAt,
      });
      await writeProjectMemoryCursorLocked(root, {
        ...cursor,
        sessions: Object.fromEntries([...sessions].slice(-64)),
        projectIndexRebuildPending: latest.projectIndexRebuildPending,
      });
    },
    owner,
  );
}

async function bumpMetadata(
  projectRoot: string,
  now: Date,
  sessionId: string,
  touchedTopics: AutoMemoryType[],
  owner?: ProjectMemoryOwner,
): Promise<void> {
  try {
    await updateProjectMemoryMetadata(
      projectRoot,
      now,
      (metadata) => {
        const iso = now.toISOString();
        if (metadata.lastExtractionAt && metadata.lastExtractionAt > iso)
          return;
        metadata.lastExtractionAt = iso;
        metadata.lastExtractionSessionId = sessionId;
        metadata.lastExtractionTouchedTopics = touchedTopics;
        metadata.lastExtractionStatus =
          touchedTopics.length > 0 ? 'updated' : 'noop';
      },
      owner,
    );
  } catch {
    // Scaffold creation already writes metadata; ignore non-critical update errors.
  }
}

interface ExtractParameters {
  projectRoot: string;
  projectMemoryOwner?: ProjectMemoryOwner;
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
}

export async function runAutoMemoryExtract(
  params: ExtractParameters,
): Promise<AutoMemoryExtractResult> {
  const now = params.now ?? new Date();
  const { config } = params;
  if (!config) {
    throw new Error(
      'Managed auto-memory extraction requires config for forked-agent execution.',
    );
  }
  params.abortSignal?.throwIfAborted();
  const earlyMismatch = getSessionMismatchResult(params.sessionId, config, now);
  if (earlyMismatch) return earlyMismatch;

  const owner = params.projectMemoryOwner ?? config.getProjectMemoryOwner?.();
  const memoryRoot = getAutoMemoryRoot(params.projectRoot, owner);
  // Per-project scaffold is required (extraction cursor + metadata live
  // there). User-level scaffold is optional — a brand-new user without
  // write access to `~/.qwen/memories/` should still be able to use
  // project-level memory, so swallow the failure and continue.
  await ensureAutoMemoryScaffold(params.projectRoot, now, owner);
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
    (await readProjectMemoryCursor(memoryRoot, owner)) ?? {
      updatedAt: now.toISOString(),
    };
  if (projectIndexRebuildPending) {
    await withProjectMemoryCommit(
      memoryRoot,
      async () => {
        if (
          (await readProjectMemoryCursor(memoryRoot, owner))
            ?.projectIndexRebuildPending
        ) {
          await rebuildProjectMemoryIndexLocked(memoryRoot, owner);
        }
      },
      owner,
    );
    await refreshMemoryInstruction(config, {
      logContext: 'managed auto-memory index repair',
    });
  }
  const rawOffset =
    currentCursor.sessions?.[params.sessionId]?.processedOffset ??
    (currentCursor.sessionId === params.sessionId
      ? currentCursor.processedOffset
      : 0) ??
    0;
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
    await writeExtractCursor(memoryRoot, cursor, params.flushReplay, owner);
    return { touchedTopics: [], cursor };
  }

  const lateMismatch = getSessionMismatchResult(params.sessionId, config, now);
  if (lateMismatch) return lateMismatch;

  const agentResult = await runAutoMemoryExtractionByAgent(
    config,
    params.projectRoot,
    params.skippedHistory,
    params.abortSignal,
    owner,
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
        ? rebuildManagedAutoMemoryIndex(params.projectRoot, owner)
        : Promise.resolve(),
      rebuildUser
        ? rebuildUserAutoMemoryIndex().catch((error: unknown) => {
            debugLogger.warn(`Auto-memory user index rebuild failed: ${error}`);
          })
        : Promise.resolve(),
    ]);

    if (projectResult.status === 'rejected') {
      if (!failure) throw projectResult.reason;
      debugLogger.warn(
        `Auto-memory project index repair failed: ${projectResult.reason}`,
      );
    }
    await refreshMemoryInstruction(config, {
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
      owner,
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
  await writeExtractCursor(memoryRoot, cursor, params.flushReplay, owner);

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
