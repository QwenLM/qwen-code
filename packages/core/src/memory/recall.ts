/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  scanAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';

const MAX_RELEVANT_DOCS = 3;
const MAX_DOC_BODY_CHARS = 1_200;
const debugLogger = createDebugLogger('AUTO_MEMORY_RECALL');

const TYPE_KEYWORDS: Record<string, string[]> = {
  user: ['user', 'preference', 'preferences', 'background', 'role', 'terse'],
  feedback: ['feedback', 'rule', 'rules', 'avoid', 'style', 'summary'],
  project: ['project', 'goal', 'goals', 'incident', 'deadline', 'release'],
  reference: ['reference', 'dashboard', 'ticket', 'docs', 'doc', 'link'],
};

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  );
}

function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '_No entries yet._') {
    return '';
  }
  return trimmed;
}

function scoreDocument(
  queryTokens: string[],
  doc: ScannedAutoMemoryDocument,
): number {
  const normalizedBody = normalizeBody(doc.body);
  const haystack = [doc.type, doc.title, doc.description, normalizedBody]
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
    if (TYPE_KEYWORDS[doc.type]?.includes(token)) {
      score += 1;
    }
  }

  if (normalizedBody.length > 0) {
    score += 1;
  }

  return score;
}

export function selectRelevantAutoMemoryDocuments(
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit = MAX_RELEVANT_DOCS,
): ScannedAutoMemoryDocument[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  return docs
    .map((doc) => ({ doc, score: scoreDocument(queryTokens, doc) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.type.localeCompare(b.doc.type))
    .slice(0, limit)
    .map(({ doc }) => doc);
}

function truncateBody(body: string): string {
  const normalized = normalizeBody(body);
  if (normalized.length <= MAX_DOC_BODY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_DOC_BODY_CHARS).trimEnd()}\n\n> NOTE: Relevant memory truncated for prompt budget.`;
}

export function buildRelevantAutoMemoryPrompt(
  docs: ScannedAutoMemoryDocument[],
): string {
  if (docs.length === 0) {
    return '';
  }

  return [
    '## Relevant Managed Auto-Memory',
    '',
    'Use the following project memory only when it is directly relevant to the current request.',
    '',
    ...docs.flatMap((doc) => {
      const body = truncateBody(doc.body);
      return [
        `### ${doc.title} (${path.basename(doc.filePath)})`,
        doc.description,
        '',
        body || '_No detailed entries yet._',
        '',
      ];
    }),
  ].join('\n');
}

export interface ResolveRelevantAutoMemoryPromptOptions {
  config?: Config;
  excludedFilePaths?: Iterable<string>;
  limit?: number;
}

export interface RelevantAutoMemoryPromptResult {
  prompt: string;
  selectedDocs: ScannedAutoMemoryDocument[];
  strategy: 'none' | 'heuristic' | 'model';
}

function filterExcludedAutoMemoryDocuments(
  docs: ScannedAutoMemoryDocument[],
  excludedFilePaths?: Iterable<string>,
): ScannedAutoMemoryDocument[] {
  if (!excludedFilePaths) {
    return docs;
  }

  const excluded = new Set(excludedFilePaths);
  if (excluded.size === 0) {
    return docs;
  }

  return docs.filter((doc) => !excluded.has(doc.filePath));
}

export async function resolveRelevantAutoMemoryPromptForQuery(
  projectRoot: string,
  query: string,
  options: ResolveRelevantAutoMemoryPromptOptions = {},
): Promise<RelevantAutoMemoryPromptResult> {
  const docs = filterExcludedAutoMemoryDocuments(
    await scanAutoMemoryTopicDocuments(projectRoot),
    options.excludedFilePaths,
  );
  const limit = options.limit ?? MAX_RELEVANT_DOCS;

  if (query.trim().length === 0 || docs.length === 0 || limit <= 0) {
    return {
      prompt: '',
      selectedDocs: [],
      strategy: 'none',
    };
  }

  if (options.config) {
    try {
      const selectedDocs = await selectRelevantAutoMemoryDocumentsByModel(
        options.config,
        query,
        docs,
        limit,
      );
      return {
        prompt: buildRelevantAutoMemoryPrompt(selectedDocs),
        selectedDocs,
        strategy: selectedDocs.length > 0 ? 'model' : 'none',
      };
    } catch (error) {
      debugLogger.warn(
        'Model-driven auto-memory recall failed; falling back to heuristic selection.',
        error,
      );
    }
  }

  const selectedDocs = selectRelevantAutoMemoryDocuments(query, docs, limit);
  return {
    prompt: buildRelevantAutoMemoryPrompt(selectedDocs),
    selectedDocs,
    strategy: selectedDocs.length > 0 ? 'heuristic' : 'none',
  };
}

export async function buildRelevantAutoMemoryPromptForQuery(
  projectRoot: string,
  query: string,
  options: ResolveRelevantAutoMemoryPromptOptions = {},
): Promise<string> {
  const result = await resolveRelevantAutoMemoryPromptForQuery(
    projectRoot,
    query,
    options,
  );
  return result.prompt;
}