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
import { getAutoMemoryExtractCursorPath, getAutoMemoryMetadataPath, getAutoMemoryTopicPath } from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { parseAutoMemoryTopicDocument } from './scan.js';
import { planAutoMemoryExtractionPatchesByAgent } from './extractionAgentPlanner.js';
import { planAutoMemoryExtractionPatchesByModel } from './extractionPlanner.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import {
  type AutoMemoryExtractCursor,
  type AutoMemoryMetadata,
  type AutoMemoryType,
} from './types.js';
import {
  clearExtractRunning,
  isExtractRunning,
  markExtractRunning,
} from './state.js';

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
  sourceOffset: number;
}

export interface AutoMemoryExtractResult {
  patches: AutoMemoryExtractPatch[];
  touchedTopics: AutoMemoryType[];
  skippedReason?: 'already_running';
  systemMessage?: string;
  cursor: AutoMemoryExtractCursor;
}

function normalizeSummary(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripRememberLead(text: string): string {
  return text
    .replace(/^please\s+/i, '')
    .replace(/^(remember|save|note)\s+(that\s+)?/i, '')
    .replace(/^[:\-\s]+/, '')
    .trim();
}

function isTemporaryTask(text: string): boolean {
  return /\b(today|now|currently|for this task|this session|temporary|temporarily)\b/i.test(
    text,
  );
}

function classifyTopic(text: string): AutoMemoryType | null {
  if (/https?:\/\/|\b(grafana|dashboard|runbook|ticket|docs?|wiki|notion|jira)\b/i.test(text)) {
    return 'reference';
  }
  if (/\b(i|we)\s+(prefer|like|need|want)\b|\bmy\s+(preferred|favorite)\b/i.test(text)) {
    return 'user';
  }
  if (/\b(please|always|never|avoid|respond|format|style|terse|concise|detailed)\b/i.test(text)) {
    return 'feedback';
  }
  if (/\b(project|repo|repository|service|release|deadline|freeze|incident|environment|stack)\b/i.test(text)) {
    return 'project';
  }
  return null;
}

function extractCandidateSummary(text: string): string | null {
  const trimmed = normalizeSummary(text);
  if (trimmed.length < MIN_CANDIDATE_LENGTH || trimmed.endsWith('?')) {
    return null;
  }

  if (isTemporaryTask(trimmed)) {
    return null;
  }

  const explicitRemember = trimmed.match(
    /^(?:please\s+)?(?:remember|save|note)\s+(?:that\s+)?(.+)$/i,
  );
  if (explicitRemember?.[1]) {
    return normalizeSummary(stripRememberLead(explicitRemember[1]));
  }

  if (
    /\b(i|we)\s+(prefer|like|need|want)\b/i.test(trimmed) ||
    /\bmy\s+(preferred|favorite)\b/i.test(trimmed) ||
    /https?:\/\//i.test(trimmed) ||
    /\b(grafana|dashboard|runbook|ticket|docs?|wiki|notion|jira|release|deadline|freeze|incident)\b/i.test(trimmed)
  ) {
    return trimmed;
  }

  if (/\b(please|always|never|avoid|respond)\b/i.test(trimmed)) {
    return trimmed;
  }

  return null;
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
  const startOffset = cursor.sessionId === sessionId ? cursor.processedOffset ?? 0 : 0;
  return {
    messages: messages.filter((message) => message.offset >= startOffset),
    nextProcessedOffset: messages.length,
  };
}

export function extractMemoryPatchesFromTranscript(
  messages: AutoMemoryTranscriptMessage[],
): AutoMemoryExtractPatch[] {
  const seen = new Set<string>();
  const patches: AutoMemoryExtractPatch[] = [];

  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }

    const summary = extractCandidateSummary(message.text);
    if (!summary) {
      continue;
    }

    const topic = classifyTopic(summary);
    if (!topic) {
      continue;
    }

    const dedupeKey = `${topic}:${summary.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    patches.push({
      topic,
      summary,
      sourceOffset: message.offset,
    });
  }

  return patches;
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

async function planAutoMemoryExtractPatches(params: {
  projectRoot: string;
  messages: AutoMemoryTranscriptMessage[];
  config?: Config;
}): Promise<AutoMemoryExtractPatch[]> {
  if (params.messages.length === 0) {
    return [];
  }

  if (params.config) {
    try {
        const plannedPatches = await planAutoMemoryExtractionPatchesByAgent(
          params.config,
          params.projectRoot,
          params.messages,
        );
        return dedupeExtractPatches(plannedPatches);
      } catch (error) {
        debugLogger.warn(
          'Agent-driven auto-memory extraction failed; falling back to side-query extraction.',
          error,
        );
      }

      try {
      const plannedPatches = await planAutoMemoryExtractionPatchesByModel(
        params.config,
        params.projectRoot,
        params.messages,
      );
      return dedupeExtractPatches(plannedPatches);
    } catch (error) {
      debugLogger.warn(
        'Model-driven auto-memory extraction failed; falling back to heuristic extraction.',
        error,
      );
    }
  }

  return dedupeExtractPatches(extractMemoryPatchesFromTranscript(params.messages));
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
    const content = await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8');
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

function appendSummaryToTopicContent(content: string, summary: string): string | null {
  const parsed = parseAutoMemoryTopicDocument('/virtual/topic.md', content);
  if (!parsed) {
    return null;
  }

  const normalizedSummary = summary.toLowerCase();
  const hasDuplicate = parsed.body
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim().toLowerCase())
    .some((line) => line === normalizedSummary);

  if (hasDuplicate) {
    return null;
  }

  const replacement = parsed.body.includes('_No entries yet._')
    ? `- ${summary}`
    : `${parsed.body.trimEnd()}\n- ${summary}`;

  return content.replace(parsed.body, replacement);
}

export async function applyExtractedMemoryPatches(
  projectRoot: string,
  patches: AutoMemoryExtractPatch[],
  now = new Date(),
  sessionId?: string,
): Promise<AutoMemoryType[]> {
  const touchedTopics = new Set<AutoMemoryType>();

  for (const patch of patches) {
    const topicPath = getAutoMemoryTopicPath(projectRoot, patch.topic);
    const current = await fs.readFile(topicPath, 'utf-8');
    const next = appendSummaryToTopicContent(current, patch.summary);
    if (!next) {
      continue;
    }

    await fs.writeFile(topicPath, next, 'utf-8');
    touchedTopics.add(patch.topic);
  }

  if (sessionId) {
    await bumpMetadata(projectRoot, now, sessionId, [...touchedTopics]);
  } else if (touchedTopics.size > 0) {
    await bumpMetadata(projectRoot, now, 'unknown', [...touchedTopics]);
  }

  if (touchedTopics.size > 0) {
    await rebuildManagedAutoMemoryIndex(projectRoot);
  }

  return [...touchedTopics];
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
  const patches = await planAutoMemoryExtractPatches({
    projectRoot: params.projectRoot,
    messages: slice.messages,
    config: params.config,
  });
  const touchedTopics = await applyExtractedMemoryPatches(
    params.projectRoot,
    patches,
    now,
    params.sessionId,
  );

  const cursor: AutoMemoryExtractCursor = {
    sessionId: params.sessionId,
    processedOffset: slice.nextProcessedOffset,
    updatedAt: now.toISOString(),
  };
  await writeExtractCursor(params.projectRoot, cursor);

  return {
    patches,
    touchedTopics,
    cursor,
    systemMessage:
      touchedTopics.length > 0
        ? `Managed auto-memory updated: ${touchedTopics.map((topic) => `${topic}.md`).join(', ')}`
        : undefined,
  };
}

export async function scheduleAutoMemoryExtract(params: {
  projectRoot: string;
  sessionId: string;
  history: Content[];
  now?: Date;
  config?: Config;
}): Promise<AutoMemoryExtractResult> {
  if (isExtractRunning(params.projectRoot)) {
    return {
      patches: [],
      touchedTopics: [],
      skippedReason: 'already_running',
      cursor: {
        sessionId: params.sessionId,
        updatedAt: (params.now ?? new Date()).toISOString(),
      },
    };
  }

  markExtractRunning(params.projectRoot);
  try {
    return await runAutoMemoryExtract(params);
  } finally {
    clearExtractRunning(params.projectRoot);
  }
}