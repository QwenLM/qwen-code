/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../core/sideQuery.js';
import { type ScannedAutoMemoryDocument } from './types.js';

const SELECT_MEMORIES_SYSTEM_PROMPT = `
You are an expert at information retrieval. Your goal is to select which of the provided background documents (memories) are relevant to the user's latest query.

Rules:
1. Return a list of relative paths for documents that provide useful context or instructions for answering the user's request.
2. If multiple documents are relevant, return all of them.
3. If no documents are relevant, return an empty list.
4. Only return relative paths from the provided document list.
`.trim();

const RESPONSE_SCHEMA = z.object({
  selected_memories: z.array(z.string()),
});

type RecallSelectorResponse = z.infer<typeof RESPONSE_SCHEMA>;

/**
 * Uses a lighter "fast" model to select which background documents are relevant
 * to the current user query.
 *
 * @param config The application config.
 * @param query The user's query.
 * @param docs The candidate documents.
 * @param limit Maximum number of documents to return.
 * @param callerAbortSignal Optional abort signal from the caller.
 * @returns A filtered list of documents.
 */
export async function selectRelevantAutoMemoryDocumentsByModel(
  config: Config,
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit: number,
  callerAbortSignal?: AbortSignal,
): Promise<ScannedAutoMemoryDocument[]> {
  if (!query || docs.length === 0) {
    return [];
  }

  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: `User query: ${query}\n\nDocuments:\n${docs
            .map(
              (doc) =>
                `- Path: ${doc.relativePath}\n  Content Summary: ${doc.content.slice(0, 500)}`,
            )
            .join('\n\n')}`,
        },
      ],
    },
  ];

  const validRelativePaths = new Set(docs.map((doc) => doc.relativePath));
  const byRelativePath = new Map(docs.map((doc) => [doc.relativePath, doc]));

  const response = await runSideQuery<RecallSelectorResponse>(config, {
    purpose: 'auto-memory-recall',
    contents,
    schema: RESPONSE_SCHEMA,
    abortSignal: callerAbortSignal
      ? AbortSignal.any([AbortSignal.timeout(1_000), callerAbortSignal])
      : AbortSignal.timeout(1_000),
    // Use the fast model for this background side-query to reduce latency and
    // cost. Falls back to the main session model if no fast model is configured.
    model: config.getFastModel(),
    systemInstruction: SELECT_MEMORIES_SYSTEM_PROMPT,
    config: {
      temperature: 0,
    },
    validate: (value) => {
      if (!Array.isArray(value.selected_memories)) {
        return 'Recall selector must return selected_memories array';
      }
      for (const path of value.selected_memories) {
        if (!validRelativePaths.has(path)) {
          return `Recall selector returned unknown relative path: ${path}`;
        }
      }
      return null;
    },
  });

  return response.selected_memories
    .map((relativePath) => byRelativePath.get(relativePath))
    .filter((doc): doc is ScannedAutoMemoryDocument => doc !== undefined)
    .slice(0, limit);
}
