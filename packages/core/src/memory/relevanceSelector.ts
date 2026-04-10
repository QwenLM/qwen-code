/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../auxiliary/sideQuery.js';
import type { ScannedAutoMemoryDocument } from './scan.js';

/**
 * System prompt for the selector side-query.
 */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to the assistant as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the assistant is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    selected_memories: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['selected_memories'],
  additionalProperties: false,
};

interface RecallSelectorResponse {
  selected_memories: string[];
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] relativePath (ISO-timestamp): description.
 * Selector sees only the header (type, path, age, description), not the body content.
 */
function formatMemoryManifest(docs: ScannedAutoMemoryDocument[]): string {
  return docs
    .map((doc) => {
      const tag = `[${doc.type}] `;
      const ts = new Date(doc.mtimeMs).toISOString();
      return doc.description
        ? `- ${tag}${doc.relativePath} (${ts}): ${doc.description}`
        : `- ${tag}${doc.relativePath} (${ts})`;
    })
    .join('\n');
}

export async function selectRelevantAutoMemoryDocumentsByModel(
  config: Config,
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit: number,
  recentTools: readonly string[] = [],
): Promise<ScannedAutoMemoryDocument[]> {
  if (docs.length === 0 || limit <= 0 || query.trim().length === 0) {
    return [];
  }

  const manifest = formatMemoryManifest(docs);

  // When the assistant is actively using a tool, surfacing that tool's
  // reference docs is noise.  Pass the tool list so the selector can skip them.
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : '';

  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text: `Query: ${query.trim()}\n\nAvailable memories:\n${manifest}${toolsSection}`,
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
    abortSignal: AbortSignal.timeout(5_000),
    systemInstruction: SELECT_MEMORIES_SYSTEM_PROMPT,
    config: {
      temperature: 0,
    },
    validate: (value) => {
      if (!Array.isArray(value.selected_memories)) {
        return 'Recall selector must return selected_memories array';
      }
      if (value.selected_memories.length > limit) {
        return `Recall selector returned too many documents: ${value.selected_memories.length}`;
      }
      if (
        value.selected_memories.some(
          (relativePath) => !validRelativePaths.has(relativePath),
        )
      ) {
        return 'Recall selector returned unknown relative path';
      }
      return null;
    },
  });

  return response.selected_memories
    .map((relativePath) => byRelativePath.get(relativePath))
    .filter((doc): doc is ScannedAutoMemoryDocument => doc !== undefined)
    .slice(0, limit);
}
