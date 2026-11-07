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
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import { getCacheSafeParamsSessionId } from '../agents/forkedAgent.js';
import { refreshMemoryInstruction } from './refresh.js';
import {
  isStableExtractionWindowEnabled,
  resolveExtractWindow,
  type ResolvedExtractWindow,
} from './extract-window.js';
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

/**
 * Cursor fields of the opt-in stable extraction window (#15493). They stay
 * absent before the experiment's first run, so a flag-OFF run writes exactly
 * the cursor main writes today and a pre-experiment cursor stays readable.
 */
function windowCursorFields(cursor: AutoMemoryExtractCursor): {
  epoch?: number;
  windowStartCurated?: number;
  coveredCurated?: number;
  windowHeadHash?: string;
  windowEpochId?: string;
} {
  return {
    epoch: cursor.epoch,
    windowStartCurated: cursor.windowStartCurated,
    coveredCurated: cursor.coveredCurated,
    windowHeadHash: cursor.windowHeadHash,
    windowEpochId: cursor.windowEpochId,
  };
}

interface RunAutoMemoryExtractParams {
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
  /**
   * Opt-in stable extraction window (#15493): returns the parent's CURATED
   * history. Stored as a closure and called once here, at extraction execution
   * time, only while the experiment flag is on — the per-turn schedule path
   * never materializes it.
   */
  getCuratedHistory?: () => Content[];
  /**
   * Opt-in stable extraction window (#15493): process + history-generation
   * identity for the window epoch. Supplied by the manager, so a restarted
   * process or a boundary that rewrote the curated history in place rebases
   * instead of reusing a prefix the live history no longer has.
   */
  extractWindowEpochId?: string;
}

interface StableExtractWindow {
  curatedHistory: Content[];
  resolved: ResolvedExtractWindow;
}

/**
 * Resolve the opt-in stable window for this run, or `undefined` to keep the
 * legacy last-40 capture path. The curated snapshot is materialized here, at
 * extraction execution time and only when the flag is on.
 */
function resolveStableExtractWindow(
  params: RunAutoMemoryExtractParams,
  currentCursor: AutoMemoryExtractCursor,
): StableExtractWindow | undefined {
  if (!isStableExtractionWindowEnabled()) return undefined;
  const getCuratedHistory = params.getCuratedHistory;
  if (!getCuratedHistory) return undefined;
  let curatedHistory: Content[];
  try {
    curatedHistory = getCuratedHistory();
  } catch (error) {
    debugLogger.warn(
      `Stable extraction window unavailable; falling back to the captured tail: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  return {
    curatedHistory,
    resolved: resolveExtractWindow({
      curatedHistory,
      sessionId: params.sessionId,
      previous: currentCursor,
      epochId: params.extractWindowEpochId,
    }),
  };
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

export async function runAutoMemoryExtract(
  params: RunAutoMemoryExtractParams,
): Promise<AutoMemoryExtractResult> {
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
  const currentCursor = await readExtractCursor(params.projectRoot);
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
      // A no-fork run leaves the pinned window untouched; dropping it would
      // slide the next run's start for no reason.
      ...(isStableExtractionWindowEnabled() &&
        windowCursorFields(currentCursor)),
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

  const stableWindow = resolveStableExtractWindow(params, currentCursor);
  if (stableWindow) {
    // Persist the pinned start before the fork. A failed or aborted run must
    // not slide the window on the next attempt, and the covered index only
    // advances after a completed run.
    await writeExtractCursor(params.projectRoot, {
      sessionId: params.sessionId,
      processedOffset:
        currentCursor.sessionId === params.sessionId
          ? currentCursor.processedOffset
          : undefined,
      updatedAt: now.toISOString(),
      epoch: stableWindow.resolved.epoch,
      windowStartCurated: stableWindow.resolved.windowStartCurated,
      coveredCurated: stableWindow.resolved.coveredCurated,
      windowHeadHash: stableWindow.resolved.windowHeadHash,
      windowEpochId: params.extractWindowEpochId,
    });
  }

  const agentResult = stableWindow
    ? await runAutoMemoryExtractionByAgent(
        params.config,
        params.projectRoot,
        params.skippedHistory,
        params.abortSignal,
        {
          curatedHistory: stableWindow.curatedHistory,
          windowStart: stableWindow.resolved.windowStartCurated,
        },
      )
    : await runAutoMemoryExtractionByAgent(
        params.config,
        params.projectRoot,
        params.skippedHistory,
        params.abortSignal,
      );

  if (agentResult.touchedTopics.length > 0) {
    await bumpMetadata(
      params.projectRoot,
      now,
      params.sessionId,
      agentResult.touchedTopics,
    );
    // Asymmetric failure isolation:
    //   * project-level rebuild MUST bubble its error up. The cursor advances
    //     only after rebuilds complete; a project rebuild failure that gets
    //     silently swallowed would leave the memory file written, the index
    //     stale, AND the cursor advanced — the memory becomes un-recallable
    //     until some later session happens to trigger another rebuild. The
    //     pre-existing `Promise.all` contract (throw → cursor stays → retry
    //     on next session) is the durability guarantee we must preserve.
    //   * user-level rebuild is best-effort. A read-only `~/.qwen/memories/`
    //     (EACCES) must not poison the project-level rebuild or block the
    //     cursor. Catch + warn, same shape as the user-level scaffold above.
    const projectRebuild =
      agentResult.touchedProjectScope || !agentResult.touchedUserScope
        ? // Either explicitly touched, or the defensive fallback when both
          // scope flags were unset (e.g. older planner) — both paths must
          // surface project-level rebuild failures.
          rebuildManagedAutoMemoryIndex(params.projectRoot)
        : Promise.resolve();
    const userRebuild = agentResult.touchedUserScope
      ? rebuildUserAutoMemoryIndex().catch((error: unknown) => {
          debugLogger.warn(
            `Auto-memory user-level index rebuild failed (non-critical, project-level rebuild unaffected): ${error instanceof Error ? error.message : String(error)}`,
          );
        })
      : Promise.resolve();
    await Promise.all([projectRebuild, userRebuild]);
    await refreshMemoryInstruction(params.config, {
      logContext: 'managed auto-memory extraction',
    });
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
    ...(stableWindow
      ? {
          epoch: stableWindow.resolved.epoch,
          windowStartCurated: stableWindow.resolved.windowStartCurated,
          // Only a run that actually covered its input may move this forward;
          // a no-op or failed extraction leaves the previous coverage intact
          // and the window is re-sent next time (at-least-once).
          coveredCurated: madeGenuineProgress
            ? stableWindow.curatedHistory.length
            : stableWindow.resolved.coveredCurated,
          windowHeadHash: stableWindow.resolved.windowHeadHash,
          windowEpochId: params.extractWindowEpochId,
        }
      : isStableExtractionWindowEnabled() && windowCursorFields(currentCursor)),
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
