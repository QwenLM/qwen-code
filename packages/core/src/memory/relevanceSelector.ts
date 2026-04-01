/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../auxiliary/sideQuery.js';
import type { ScannedAutoMemoryDocument } from './scan.js';

const MAX_SELECTOR_EXCERPT_CHARS = 240;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    relevantFilePaths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Exact file paths of the managed memory topic documents that are directly relevant to the request.',
    },
    reasoning: {
      type: 'string',
      description: 'Short explanation for the selection.',
    },
  },
  required: ['relevantFilePaths'],
};

interface RecallSelectorResponse {
  relevantFilePaths: string[];
  reasoning?: string;
}

function truncateExcerpt(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_SELECTOR_EXCERPT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SELECTOR_EXCERPT_CHARS).trimEnd()}…`;
}

function buildSelectorPrompt(
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit: number,
): string {
  const candidateBlock = docs
    .map(
      (doc, index) =>
        [
          `Candidate ${index + 1}`,
          `filePath: ${doc.filePath}`,
          `type: ${doc.type}`,
          `title: ${doc.title}`,
          `description: ${doc.description || '(none)'}`,
          `excerpt: ${truncateExcerpt(doc.body) || '(empty)'}`,
        ].join('\n'),
    )
    .join('\n\n');

  return [
    'Select the managed memory topic files that are directly relevant to the current user request.',
    `Return at most ${limit} file paths.`,
    'If none are clearly relevant, return an empty array.',
    'Only return file paths from the provided candidates.',
    '',
    `User request:\n${query.trim()}`,
    '',
    `Candidates:\n${candidateBlock}`,
  ].join('\n');
}

export async function selectRelevantAutoMemoryDocumentsByModel(
  config: Config,
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit: number,
): Promise<ScannedAutoMemoryDocument[]> {
  if (docs.length === 0 || limit <= 0 || query.trim().length === 0) {
    return [];
  }

  const contents: Content[] = [
    {
      role: 'user',
      parts: [{ text: buildSelectorPrompt(query, docs, limit) }],
    },
  ];

  const allowedPaths = new Set(docs.map((doc) => doc.filePath));
  const response = await runSideQuery<RecallSelectorResponse>(config, {
    purpose: 'auto-memory-recall',
    contents,
    schema: RESPONSE_SCHEMA,
    abortSignal: AbortSignal.timeout(5_000),
    config: {
      temperature: 0,
    },
    validate: (value) => {
      if (!Array.isArray(value.relevantFilePaths)) {
        return 'Recall selector must return relevantFilePaths array';
      }
      if (value.relevantFilePaths.length > limit) {
        return `Recall selector returned too many documents: ${value.relevantFilePaths.length}`;
      }
      if (value.relevantFilePaths.some((filePath) => !allowedPaths.has(filePath))) {
        return 'Recall selector returned unknown file path';
      }
      return null;
    },
  });

  const selectedPathSet = new Set(response.relevantFilePaths);
  return docs.filter((doc) => selectedPathSet.has(doc.filePath)).slice(0, limit);
}
