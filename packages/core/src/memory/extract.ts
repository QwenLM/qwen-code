/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  getStartupContextLength,
  stripSystemReminderBlocks,
} from '../core/environmentContext.js';
import { isApiUserPrompt } from '../services/api-user-prompt.js';
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
import { CACHE_SAFE_HISTORY_TAIL_ENTRIES } from '../agents/cache-safe-history.js';
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
    | 'cooldown';
  systemMessage?: string;
  cursor: AutoMemoryExtractCursor;
  /**
   * True when the extraction agent actually ran and completed. Absent on every
   * early return (no new user messages, session mismatch), which otherwise
   * share a no-op's shape; the cooldown in `MemoryManager` must not treat
   * those as a completed no-op (#13004).
   */
  extractorRan?: true;
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

/**
 * Cut-safety predicates for the pending-window boundary. A cut is unsafe when
 * the last included entry is a model entry carrying a functionCall (its
 * response falls outside the window and the trailing repair would fabricate
 * one reusing the real call's id), or when the next entry is a user entry
 * that is all functionResponse parts (the next window would open on an
 * orphaned response whose call sits in already-processed history, and no
 * extraction run would ever see it — the cursor only advances).
 */
function endsOnOpenCall(
  history: readonly Content[],
  endOffset: number,
): boolean {
  const last = history[endOffset - 1];
  return (
    last?.role === 'model' &&
    (last.parts ?? []).some((part) => part.functionCall)
  );
}

function opensOnOrphanedResponse(
  history: readonly Content[],
  endOffset: number,
): boolean {
  const next = history[endOffset];
  return (
    next?.role === 'user' &&
    (next.parts ?? []).length > 0 &&
    (next.parts ?? []).every((part) => part.functionResponse)
  );
}

function hasUserText(content: Content): boolean {
  return (
    content.role === 'user' &&
    (content.parts ?? []).some(
      (part) =>
        !part.thought &&
        typeof part.text === 'string' &&
        stripSystemReminderBlocks(part.text).trim().length > 0,
    )
  );
}

function hashProcessedHistory(
  history: Content[],
  floor: number,
  offset: number,
): string {
  // ponytail: O(processed history); use a chat revision if hashing becomes costly.
  const hash = createHash('sha256').update(`${floor}\n`);
  for (let i = floor; i < offset; i++) {
    hash.update(JSON.stringify(history[i])).update('\n');
  }
  return hash.digest('hex');
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
  preserveUnprocessedHistory?: boolean;
}): Promise<AutoMemoryExtractResult> {
  const now = params.now ?? new Date();
  if (!params.config) {
    throw new Error(
      'Managed auto-memory extraction requires config for forked-agent execution.',
    );
  }
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
  let startOffset = rawOffset > params.history.length ? 0 : rawOffset;
  let historyFloor = 0;
  if (params.preserveUnprocessedHistory) {
    const prefixLength = getStartupContextLength(params.history, {
      includeCompressed: true,
    });
    // Compression can preserve an open call as the last prefix entry. Keep
    // it with its real response, while skipping synthetic user context.
    historyFloor =
      prefixLength - (endsOnOpenCall(params.history, prefixLength) ? 1 : 0);
    const sameSession = currentCursor.sessionId === params.sessionId;
    const matchesHistory =
      sameSession &&
      Number.isInteger(rawOffset) &&
      rawOffset >= historyFloor &&
      rawOffset <= params.history.length &&
      currentCursor.processedHistoryHash ===
        hashProcessedHistory(params.history, historyFloor, rawOffset);
    if (!matchesHistory) {
      const compressed = prefixLength > getStartupContextLength(params.history);
      startOffset =
        (sameSession && currentCursor.processedHistoryHash) || compressed
          ? historyFloor
          : Math.max(
              historyFloor,
              params.history.findLastIndex(
                (content, i) =>
                  i >= historyFloor &&
                  hasUserText(content) &&
                  isApiUserPrompt(content, { excludeTaskNotifications: true }),
              ),
            );
    }
  }
  // With turn-skipping enabled, a large ending turn can evict skipped facts
  // from the usual tail. Process the oldest pending window instead, and never
  // mark its unseen remainder as processed.
  let endOffset = params.preserveUnprocessedHistory
    ? Math.min(
        params.history.length,
        startOffset + CACHE_SAFE_HISTORY_TAIL_ENTRIES,
      )
    : params.history.length;
  // A plain index can split a model functionCall from its functionResponse:
  // the trailing repair would fabricate a response reusing the real call's
  // id, and the next window would open on the orphaned true output, which no
  // extraction run ever sees (the cursor only advances). Back the cut off to
  // a real turn boundary — but only while the window does not already reach
  // the end of history (a session ending on an open call must still be able
  // to arm the no-op cooldown at processedOffset === history.length), and
  // never past startOffset (a zero-length window still writes the cursor).
  if (params.preserveUnprocessedHistory) {
    while (
      endOffset < params.history.length &&
      endOffset > startOffset &&
      (endsOnOpenCall(params.history, endOffset) ||
        opensOnOrphanedResponse(params.history, endOffset))
    ) {
      endOffset--;
    }
  }
  const pendingHistory = params.history.slice(startOffset, endOffset);
  // Attest the selection before the fork awaits: the parent may mutate its
  // history while extraction runs. Holdback must retain the start identity.
  const startHistoryHash = params.preserveUnprocessedHistory
    ? hashProcessedHistory(params.history, historyFloor, startOffset)
    : undefined;
  const endHistoryHash = params.preserveUnprocessedHistory
    ? hashProcessedHistory(params.history, historyFloor, endOffset)
    : undefined;

  // Skip if there are no new, non-empty user messages in the unprocessed
  // slice. Strip runtime reminders per part as the planner does, so a
  // reminder-only tool response cannot trigger extraction after its text is removed.
  const hasNewUserMessages = pendingHistory.some(hasUserText);
  if (!hasNewUserMessages) {
    const cursor: AutoMemoryExtractCursor = {
      sessionId: params.sessionId,
      processedOffset: endOffset,
      ...(endHistoryHash && { processedHistoryHash: endHistoryHash }),
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
    params.preserveUnprocessedHistory ? pendingHistory : undefined,
    // A pending window that does not reach the end of history is a
    // historical segment: the planner drops the recency wording and the
    // anchor-to-today date claim, which would otherwise convert the
    // segment's relative dates against the drain day. The previous cursor's
    // write time is the nearest proxy for the segment's own date.
    endOffset < params.history.length
      ? { windowAsOf: currentCursor.updatedAt }
      : undefined,
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
  const advances = madeGenuineProgress || endOffset < params.history.length;

  const cursor: AutoMemoryExtractCursor = {
    sessionId: params.sessionId,
    // A capped window must advance even without genuine progress, or the
    // same slice freezes next turn. At the live end, keep the #6311 hold-back:
    // new turns grow this slice, and a zero-tool completion must not consume
    // it or arm the no-op cooldown.
    processedOffset: advances ? endOffset : startOffset,
    ...(endHistoryHash && {
      processedHistoryHash: advances ? endHistoryHash : startHistoryHash,
    }),
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
    extractorRan: true,
  };
}
