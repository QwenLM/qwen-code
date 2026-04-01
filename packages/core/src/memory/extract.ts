/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Content } from '@google/genai';
import { partToString } from '../utils/partUtils.js';
import { getAutoMemoryExtractCursorPath, getAutoMemoryMetadataPath, getAutoMemoryTopicPath } from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { parseAutoMemoryTopicDocument } from './scan.js';
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

async function bumpMetadata(projectRoot: string, now: Date): Promise<void> {
  try {
    const content = await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8');
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
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

  if (touchedTopics.size > 0) {
    await bumpMetadata(projectRoot, now);
  }

  return [...touchedTopics];
}

export async function runAutoMemoryExtract(params: {
  projectRoot: string;
  sessionId: string;
  history: Content[];
  now?: Date;
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
  const patches = extractMemoryPatchesFromTranscript(slice.messages);
  const touchedTopics = await applyExtractedMemoryPatches(
    params.projectRoot,
    patches,
    now,
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