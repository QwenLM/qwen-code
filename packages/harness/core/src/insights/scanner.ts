/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { getTranscriptProjectDir } from '../services/transcript-paths.js';
import { TranscriptRepository } from '../services/transcript/repository.js';
import {
  isHiddenUserMessageInDefaultHistory,
  getRealUserPromptText,
  getUserPromptFallbackText,
} from '../protocol/transcript/message-utils.js';
import type { Message } from '../protocol/transcript/message.js';
import { readCache, writeCache, isCacheFresh } from './cache.js';
import type { SessionMeta } from './types.js';
import { runLogger } from '../utils/runLogger.js';

export interface ScanOptions {
  config: Config;
  cwd: string;
  lookbackDays: number;
  abortSignal: AbortSignal;
}

/**
 * Scans the current project's transcript directory and loads session metadata.
 * Results are cached; stale entries are refreshed automatically.
 */
export async function scanProjectSessions(
  options: ScanOptions,
): Promise<SessionMeta[]> {
  const { cwd, lookbackDays, abortSignal } = options;

  const projectDir = getTranscriptProjectDir(cwd);

  let fileNames: string[];
  try {
    fileNames = await fs.readdir(projectDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const jsonlFiles = fileNames.filter((f) => f.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) {
    return [];
  }

  const cutoffTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const results: SessionMeta[] = [];

  for (const fileName of jsonlFiles) {
    if (abortSignal.aborted) {
      break;
    }

    const filePath = path.join(projectDir, fileName);
    const sessionId = path.basename(fileName, '.jsonl');

    try {
      const stat = await fs.stat(filePath);
      const lastUpdated = stat.mtime.getTime();

      // Skip sessions older than the lookback window
      if (lastUpdated < cutoffTime) {
        continue;
      }

      // Check cache freshness
      const cacheKey = sessionId;
      const cacheFresh = await isCacheFresh('meta', cacheKey, lastUpdated);
      if (cacheFresh) {
        const cached = await readCache<SessionMeta>('meta', cacheKey);
        if (cached) {
          results.push(cached);
          continue;
        }
      }

      // Cache miss — load transcript metadata
      const meta = await loadSessionMeta(sessionId, filePath, cwd, lastUpdated);
      if (meta) {
        await writeCache('meta', cacheKey, meta);
        results.push(meta);
      }
    } catch (err) {
      runLogger.debug(
        `[insights/scanner] Failed to process "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Sort by lastUpdated descending (most recent first)
  results.sort((a, b) => b.lastUpdated - a.lastUpdated);

  return results;
}

async function loadSessionMeta(
  sessionId: string,
  filePath: string,
  projectRoot: string,
  lastUpdated: number,
): Promise<SessionMeta | null> {
  const loadResult = await new TranscriptRepository().resolveSession(filePath);
  const messages = [...(loadResult?.messages ?? [])];

  if (messages.length === 0) {
    return null;
  }

  const userMessages = messages.filter(
    (m) =>
      m.type === 'user' &&
      !isHiddenUserMessageInDefaultHistory(m) &&
      m.isCompactSummary !== true,
  );

  if (userMessages.length === 0) {
    return null;
  }

  const firstTimestamp = messages[0]?.timestamp;
  const startTime = firstTimestamp
    ? new Date(firstTimestamp).getTime()
    : lastUpdated;

  const firstUserMessage = getFirstUserMessage(messages);

  return {
    id: sessionId,
    projectRoot,
    filePath,
    startTime,
    messageCount: messages.length,
    userMessageCount: userMessages.length,
    lastUpdated,
    displayName: firstUserMessage,
    firstUserMessage,
  };
}

function getFirstUserMessage(messages: readonly Message[]): string {
  let fallback: string | null = null;

  for (const message of messages) {
    const prompt = getRealUserPromptText(message);
    if (prompt) {
      return prompt.slice(0, 200);
    }
    fallback ??= getUserPromptFallbackText(message);
  }

  return fallback?.slice(0, 200) ?? 'Empty conversation';
}
