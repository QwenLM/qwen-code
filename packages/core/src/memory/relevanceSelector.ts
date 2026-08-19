/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../utils/sideQuery.js';
import type { ScannedAutoMemoryDocument } from './scan.js';

/**
 * System prompt for the selector side-query.
 */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to the assistant as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference, API documentation, parameter schemas, field mappings, guessed call formats, or failed-call transcripts for those tools. Live tool definitions are the source of truth. Do still select durable operational context that cannot be obtained from the live schema, such as credentials location, ownership, external escalation paths, known gotchas, warnings, or confirmed workarounds.`;

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

const MAX_MODEL_MANIFEST_BYTES = 25_000;

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filePath (ISO-timestamp): description.
 *
 * Uses the absolute filePath (never relativePath) so docs from the two
 * memory scopes — per-project under `~/.qwen/projects/<hash>/memory/`
 * and user-level under `~/.qwen/memories/` — that happen to share the
 * same relativePath (e.g. `user/role.md` in both) remain individually
 * addressable. Keying by relativePath caused the selector's Map dedupe
 * to silently drop one scope.
 *
 * Selector sees only the header (type, path, age, description), not the
 * body content.
 */
function formatMemoryManifest(docs: ScannedAutoMemoryDocument[]): {
  manifest: string;
  includedDocs: ScannedAutoMemoryDocument[];
} {
  const lines: string[] = [];
  const includedDocs: ScannedAutoMemoryDocument[] = [];
  let bytes = 0;

  for (const doc of docs) {
    const tag = `[${doc.type}] `;
    const ts = new Date(doc.mtimeMs).toISOString();
    const line = doc.description
      ? `- ${tag}${doc.filePath} (${ts}): ${doc.description.slice(0, 512).replace(/[\uD800-\uDBFF]$/, '')}`
      : `- ${tag}${doc.filePath} (${ts})`;
    const nextBytes = Buffer.byteLength(
      `${lines.length > 0 ? '\n' : ''}${line}`,
    );
    if (bytes + nextBytes > MAX_MODEL_MANIFEST_BYTES) {
      continue;
    }
    lines.push(line);
    includedDocs.push(doc);
    bytes += nextBytes;
  }

  return { manifest: lines.join('\n'), includedDocs };
}

export async function selectRelevantAutoMemoryDocumentsByModel(
  config: Config,
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit: number,
  recentTools: readonly string[] = [],
  callerAbortSignal?: AbortSignal,
): Promise<ScannedAutoMemoryDocument[]> {
  if (docs.length === 0 || limit <= 0 || query.trim().length === 0) {
    return [];
  }

  const { manifest, includedDocs } = formatMemoryManifest(docs);
  if (includedDocs.length === 0) {
    return [];
  }

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

  const validFilePaths = new Set(includedDocs.map((doc) => doc.filePath));
  const byFilePath = new Map(includedDocs.map((doc) => [doc.filePath, doc]));

  const response = await runSideQuery<RecallSelectorResponse>(config, {
    purpose: 'auto-memory-recall',
    contents,
    schema: RESPONSE_SCHEMA,
    skipOutputLanguagePreference: true,
    // Caller (`GeminiClient.MemoryPrefetchHandle`) owns lifecycle and aborts
    // via its controller on cleanup paths. The 30 s ceiling is a generous
    // safety net that only fires if the model API hangs (network partition,
    // server stall, runaway retry) AND the caller never aborts. Normal
    // recalls take ~1 s; 30 s is far above the long tail so this doesn't
    // re-introduce the 1 s timeout regression that motivated this redesign.
    // Without this ceiling, a callerless invocation would use an
    // unsignalled AbortController and run indefinitely.
    abortSignal: callerAbortSignal
      ? AbortSignal.any([AbortSignal.timeout(30_000), callerAbortSignal])
      : AbortSignal.timeout(30_000),

    // Uses runSideQuery's default side-query model policy: fast model first,
    // then main session model when no fast model is configured.
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
          (filePath) => !validFilePaths.has(filePath),
        )
      ) {
        return 'Recall selector returned unknown file path';
      }
      return null;
    },
  });

  return response.selected_memories
    .map((filePath) => byFilePath.get(filePath))
    .filter((doc): doc is ScannedAutoMemoryDocument => doc !== undefined)
    .slice(0, limit);
}
