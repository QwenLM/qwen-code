/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { partToString } from '../utils/partUtils.js';
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryFilePath,
  getAutoMemoryMetadataPath,
} from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  mergeAutoMemoryEntry,
  parseAutoMemoryEntries,
  renderAutoMemoryBody,
} from './entries.js';
import {
  parseAutoMemoryTopicDocument,
  scanAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { planAutoMemoryExtractionPatchesByAgent } from './extractionAgentPlanner.js';
import { planAutoMemoryExtractionPatchesByModel } from './extractionPlanner.js';
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

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'memory'
  );
}

function buildMemoryTitle(summary: string): string {
  const trimmed = normalizeSummary(summary);
  if (trimmed.length <= 72) {
    return trimmed;
  }
  return `${trimmed.slice(0, 69).trimEnd()}...`;
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

function appendPatchToTopicContent(
  content: string,
  patch: AutoMemoryExtractPatch,
): string | null {
  const parsed = parseAutoMemoryTopicDocument('/virtual/topic.md', content);
  if (!parsed) {
    return null;
  }

  const entries = parseAutoMemoryEntries(parsed.body);
  const normalizedSummary = patch.summary.toLowerCase();
  const existingIndex = entries.findIndex(
    (entry) => entry.summary.toLowerCase() === normalizedSummary,
  );

  if (existingIndex >= 0) {
    const merged = mergeAutoMemoryEntry(entries[existingIndex], {
      summary: patch.summary,
      why: patch.why,
      howToApply: patch.howToApply,
    });
    const current = entries[existingIndex];
    if (
      current.summary === merged.summary &&
      current.why === merged.why &&
      current.howToApply === merged.howToApply
    ) {
      return null;
    }

    entries[existingIndex] = merged;
    return content.replace(parsed.body, renderAutoMemoryBody('', entries));
  }

  entries.push({
    summary: patch.summary,
    why: patch.why,
    howToApply: patch.howToApply,
  });

  return content.replace(parsed.body, renderAutoMemoryBody('', entries));
}

function buildMemoryDocumentContent(
  patch: AutoMemoryExtractPatch,
  title = buildMemoryTitle(patch.summary),
): string {
  return [
    '---',
    `name: ${title}`,
    `description: ${patch.summary}`,
    `type: ${patch.topic}`,
    '---',
    '',
    renderAutoMemoryBody('', [
      {
        summary: patch.summary,
        why: patch.why,
        howToApply: patch.howToApply,
      },
    ]),
    '',
  ].join('\n');
}

function findExistingMemoryDocument(
  docs: ScannedAutoMemoryDocument[],
  patch: AutoMemoryExtractPatch,
): ScannedAutoMemoryDocument | undefined {
  const targetSummary = patch.summary.toLowerCase();
  return docs.find((doc) => {
    if (doc.type !== patch.topic) {
      return false;
    }
    const [entry] = parseAutoMemoryEntries(doc.body);
    return entry?.summary.toLowerCase() === targetSummary;
  });
}

function allocateMemoryRelativePath(
  docs: ScannedAutoMemoryDocument[],
  patch: AutoMemoryExtractPatch,
): string {
  const baseSlug = slugify(patch.summary);
  const used = new Set(docs.map((doc) => doc.relativePath));

  for (let index = 0; index < 100; index += 1) {
    const filename = index === 0 ? `${baseSlug}.md` : `${baseSlug}-${index + 1}.md`;
    const relativePath = path.join(patch.topic, filename);
    if (!used.has(relativePath)) {
      return relativePath;
    }
  }

  return path.join(patch.topic, `${baseSlug}-${Date.now()}.md`);
}

export async function applyExtractedMemoryPatches(
  projectRoot: string,
  patches: AutoMemoryExtractPatch[],
  now = new Date(),
  sessionId?: string,
): Promise<AutoMemoryType[]> {
  const touchedTopics = new Set<AutoMemoryType>();
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);

  for (const patch of patches) {
    const existingDoc = findExistingMemoryDocument(docs, patch);

    if (existingDoc) {
      const current = await fs.readFile(existingDoc.filePath, 'utf-8');
      const next = appendPatchToTopicContent(current, patch);
      if (!next) {
        continue;
      }

      await fs.writeFile(existingDoc.filePath, next, 'utf-8');
      const updatedDoc = parseAutoMemoryTopicDocument(
        existingDoc.filePath,
        next,
        0,
        existingDoc.relativePath,
      );
      if (updatedDoc) {
        const existingIndex = docs.findIndex((doc) => doc.filePath === existingDoc.filePath);
        if (existingIndex >= 0) {
          docs[existingIndex] = updatedDoc;
        }
      }
      touchedTopics.add(patch.topic);
      continue;
    }

    const relativePath = allocateMemoryRelativePath(docs, patch);
    const absolutePath = getAutoMemoryFilePath(projectRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const content = buildMemoryDocumentContent(patch);
    await fs.writeFile(absolutePath, content, 'utf-8');
    const createdDoc = parseAutoMemoryTopicDocument(
      absolutePath,
      content,
      0,
      relativePath,
    );
    if (createdDoc) {
      docs.push(createdDoc);
    }
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
  return scheduleManagedAutoMemoryExtract(params);
}