/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  Config,
  HistoryGap,
  SessionTranscriptCursorState,
  SessionTranscriptRecordPage,
} from '@qwen-code/qwen-code-core';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { HistoryReplayer } from './history-replayer.js';
import type { PendingReplayToolCall } from './history-replayer.js';
import type { CumulativeUsage, SessionEmitterContext } from './types.js';

interface ReplayLogger {
  warn(message: string, ...args: unknown[]): void;
}

export function createReplayCumulativeUsage(): CumulativeUsage {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    candidateTokens: 0,
    apiTimeMs: 0,
  };
}

export function copyCumulativeUsage(
  target: CumulativeUsage,
  source: CumulativeUsage,
): void {
  target.promptTokens = source.promptTokens;
  target.cachedTokens = source.cachedTokens;
  target.candidateTokens = source.candidateTokens;
  target.apiTimeMs = source.apiTimeMs;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCumulativeUsage(value: unknown): value is CumulativeUsage {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value['promptTokens'] === 'number' &&
    Number.isFinite(value['promptTokens']) &&
    typeof value['cachedTokens'] === 'number' &&
    Number.isFinite(value['cachedTokens']) &&
    typeof value['candidateTokens'] === 'number' &&
    Number.isFinite(value['candidateTokens']) &&
    typeof value['apiTimeMs'] === 'number' &&
    Number.isFinite(value['apiTimeMs'])
  );
}

function isPendingReplayToolCall(
  value: unknown,
): value is PendingReplayToolCall {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value['callId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    (value['timestamp'] === undefined ||
      typeof value['timestamp'] === 'string') &&
    typeof value['recordId'] === 'string'
  );
}

function parseTranscriptReplayState(
  replay: unknown,
  logger?: ReplayLogger,
): {
  pendingToolCalls: PendingReplayToolCall[];
  cumulativeUsage: CumulativeUsage;
} {
  if (!isObjectRecord(replay)) {
    return {
      pendingToolCalls: [],
      cumulativeUsage: createReplayCumulativeUsage(),
    };
  }
  const rawPending = replay['pendingToolCalls'];
  const pendingToolCalls = Array.isArray(rawPending)
    ? rawPending.filter(isPendingReplayToolCall)
    : [];
  if (
    logger &&
    Array.isArray(rawPending) &&
    pendingToolCalls.length !== rawPending.length
  ) {
    const dropped = rawPending.length - pendingToolCalls.length;
    logger.warn(
      `[transcript] replay state dropped ${dropped} of ${rawPending.length} malformed pending tool calls`,
    );
  }
  const cumulativeUsage = isCumulativeUsage(replay['cumulativeUsage'])
    ? { ...replay['cumulativeUsage'] }
    : createReplayCumulativeUsage();
  return { pendingToolCalls, cumulativeUsage };
}

function replayContext(
  sessionId: string,
  updates: SessionUpdate[],
  cumulativeUsage: CumulativeUsage,
  config?: Config,
): SessionEmitterContext {
  return {
    sessionId,
    sendUpdate: async (update) => {
      updates.push(update);
    },
    cumulativeUsage,
    ...(config ? { config } : {}),
  };
}

export async function collectHistoryReplayUpdates({
  sessionId,
  config,
  records,
  gaps,
  cumulativeUsage,
  logger,
}: {
  sessionId: string;
  config?: Config;
  records: ChatRecord[];
  gaps?: HistoryGap[];
  cumulativeUsage: CumulativeUsage;
  logger?: ReplayLogger;
}): Promise<{ updates: SessionUpdate[]; replayError?: string }> {
  const updates: SessionUpdate[] = [];
  try {
    await new HistoryReplayer(
      replayContext(sessionId, updates, cumulativeUsage, config),
    ).replay(records, gaps);
  } catch (error) {
    const replayError = error instanceof Error ? error.message : String(error);
    logger?.warn(
      '[historyReplay] History replay failed for session %s (partial updates: %d):',
      sessionId,
      updates.length,
      error,
    );
    return { updates: liftSessionUpdateTimestamps(updates), replayError };
  }
  return { updates: liftSessionUpdateTimestamps(updates) };
}

export function liftSessionUpdateTimestamps(
  updates: SessionUpdate[],
): SessionUpdate[] {
  return updates.map((update) => {
    const record = update as Record<string, unknown>;
    const meta = record['_meta'];
    const timestamp = isObjectRecord(meta) ? meta['timestamp'] : undefined;
    return typeof timestamp === 'number' || typeof timestamp === 'string'
      ? ({ ...record, timestamp } as unknown as SessionUpdate)
      : update;
  });
}

export interface ReplayedTranscriptPage {
  updates: SessionUpdate[];
  nextCursor?: string;
  hasMore: boolean;
  startTime: string;
  lastUpdated: string;
  partial?: true;
  replayError?: string;
}

export async function replayTranscriptRecordPage({
  sessionId,
  page,
  config,
  encodeCursor,
  logger,
}: {
  sessionId: string;
  page: SessionTranscriptRecordPage;
  config?: Config;
  encodeCursor: (state: SessionTranscriptCursorState) => string;
  logger?: ReplayLogger;
}): Promise<ReplayedTranscriptPage> {
  const state = parseTranscriptReplayState(page.replay, logger);
  const updates: SessionUpdate[] = [];
  const replayer = new HistoryReplayer(
    replayContext(sessionId, updates, state.cumulativeUsage, config),
  );
  let pendingToolCalls: PendingReplayToolCall[];
  let replayError: string | undefined;
  try {
    const replayState = await replayer.replayPage(page.records, {
      pendingToolCalls: state.pendingToolCalls,
      finalizeDangling: !page.hasMore,
      gaps: page.gaps,
    });
    pendingToolCalls = replayState.pendingToolCalls;
  } catch (error) {
    logger?.warn(
      '[historyReplay] Paged history replay failed for session %s (partial updates: %d):',
      sessionId,
      updates.length,
      error,
    );
    pendingToolCalls = replayer.getPendingToolCalls();
    replayError = 'Replay conversion failed for this page';
  }

  const nextCursor =
    page.nextCursorState && replayError === undefined
      ? encodeCursor({
          ...page.nextCursorState,
          replay: {
            pendingToolCalls,
            cumulativeUsage: state.cumulativeUsage,
          },
        })
      : undefined;

  return {
    updates: liftSessionUpdateTimestamps(updates),
    ...(nextCursor ? { nextCursor } : {}),
    hasMore: replayError === undefined && page.hasMore,
    startTime: page.startTime,
    lastUpdated: page.lastUpdated,
    ...(replayError ? { partial: true, replayError } : {}),
  };
}
