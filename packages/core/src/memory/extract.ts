/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { partToString } from '../utils/partUtils.js';
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryMetadataPath,
} from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { scheduleManagedAutoMemoryExtract } from './extractScheduler.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import {
  type AutoMemoryExtractCursor,
  type AutoMemoryMetadata,
  type AutoMemoryType,
} from './types.js';

const MIN_CANDIDATE_LENGTH = 12;
const debugLogger = createDebugLogger('AUTO_MEMORY_EXTRACT');

export interface AutoMemoryTranscriptMessage {
  offset: number;
  role: 'user' | 'model';
  text: string;
}

export interface AutoMemoryExtractPatch {
  topic: AutoMemoryType;
  summary: string;
  why?: string;
  howToApply?: string;
  sourceOffset: number;
}

export interface AutoMemoryExtractResult {
  patches: AutoMemoryExtractPatch[];
  touchedTopics: AutoMemoryType[];
  skippedReason?: 'already_running' | 'queued' | 'memory_tool';
  systemMessage?: string;
  cursor: AutoMemoryExtractCursor;
}

function normalizeSummary(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isTemporaryTask(text: string): boolean {
  return /\b(today|now|currently|for this task|this session|temporary|temporarily)\b/i.test(
    text,
  );
}

function normalizeExtractPatch(
  patch: AutoMemoryExtractPatch,
): AutoMemoryExtractPatch | null {
  const summary = normalizeSummary(
    patch.summary.replace(/^[-*]\s+/, '').trim(),
  );
  if (
    summary.length < MIN_CANDIDATE_LENGTH ||
    summary.endsWith('?') ||
    isTemporaryTask(summary)
  ) {
    return null;
  }

  return {
    topic: patch.topic,
    summary,
    why: patch.why ? normalizeSummary(patch.why) : undefined,
    howToApply: patch.howToApply
      ? normalizeSummary(patch.howToApply)
      : undefined,
    sourceOffset: patch.sourceOffset,
  };
}

function dedupeExtractPatches(
  patches: AutoMemoryExtractPatch[],
): AutoMemoryExtractPatch[] {
  const seen = new Set<string>();
  const deduped: AutoMemoryExtractPatch[] = [];

  for (const patch of patches) {
    const normalizedPatch = normalizeExtractPatch(patch);
    if (!normalizedPatch) {
      continue;
    }

    const dedupeKey = `${normalizedPatch.topic}:${normalizedPatch.summary.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(normalizedPatch);
  }

  return deduped;
}

export function buildTranscriptMessages(
  history: Content[],
): AutoMemoryTranscriptMessage[] {
  return history
    .map((message, index) => ({
      offset: index,
      role: message.role,
      text: normalizeSummary(partToString(message.parts ?? [])),
    }))
    .filter(
      (message): message is AutoMemoryTranscriptMessage =>
        (message.role === 'user' || message.role === 'model') &&
        message.text.length > 0,
    );
}

export function loadUnprocessedTranscriptSlice(
  sessionId: string,
  messages: AutoMemoryTranscriptMessage[],
  cursor: AutoMemoryExtractCursor,
): { messages: AutoMemoryTranscriptMessage[]; nextProcessedOffset: number } {
  const startOffset =
    cursor.sessionId === sessionId ? cursor.processedOffset ?? 0 : 0;
  return {
    messages: messages.filter((message) => message.offset >= startOffset),
    nextProcessedOffset: messages.length,
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
  await fs.writeFile(
    getAutoMemoryExtractCursorPath(projectRoot),
    `${JSON.stringify(cursor, null, 2)}\n`,
    'utf-8',
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
    metadata.lastExtractionStatus = touchedTopics.length > 0 ? 'updated' : 'noop';
    await fs.writeFile(
      getAutoMemoryMetadataPath(projectRoot),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf-8',
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
}): Promise<AutoMemoryExtractResult> {
  const now = params.now ?? new Date();
  await ensureAutoMemoryScaffold(params.projectRoot, now);

  const transcript = buildTranscriptMessages(params.history);
  const currentCursor = await readExtractCursor(params.projectRoot);
  const slice = loadUnprocessedTranscriptSlice(
    params.sessionId,
    transcript,
    currentCursor,
  );

  if (!params.config) {
    throw new Error(
      'Managed auto-memory extraction requires config for forked-agent execution.',
    );
  }

  const agentResult = await runAutoMemoryExtractionByAgent(
    params.config,
    params.projectRoot,
    slice.messages,
  );
  const patches = dedupeExtractPatches(agentResult.patches);

  if (agentResult.touchedTopics.length > 0) {
    await bumpMetadata(
      params.projectRoot,
      now,
      params.sessionId,
      agentResult.touchedTopics,
    );
    await rebuildManagedAutoMemoryIndex(params.projectRoot);
  }

  const cursor: AutoMemoryExtractCursor = {
    sessionId: params.sessionId,
    processedOffset: slice.nextProcessedOffset,
    updatedAt: now.toISOString(),
  };
  await writeExtractCursor(params.projectRoot, cursor);

  debugLogger.debug(
    `Managed auto-memory extract completed with ${patches.length} patch(es) and ${agentResult.touchedTopics.length} touched topic(s).`,
  );

  return {
    patches,
    touchedTopics: agentResult.touchedTopics,
    cursor,
    systemMessage: agentResult.systemMessage,
  };
}

export async function scheduleAutoMemoryExtract(params: {
  projectRoot: string;
  sessionId: string;
  history: Content[];
  now?: Date;
  config?: Config;
}): Promise<AutoMemoryExtractResult> {
  return scheduleManagedAutoMemoryExtract(params);
}