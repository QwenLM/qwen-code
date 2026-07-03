/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { runSideQuery } from '../utils/sideQuery.js';
import {
  buildAutoMemoryEntrySearchText,
  getAutoMemoryBodyHeading,
  parseAutoMemoryEntries,
  renderAutoMemoryBody,
} from './entries.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { getAutoMemoryMetadataPath } from './paths.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import type { AutoMemoryMetadata, AutoMemoryType } from './types.js';

export interface AutoMemoryForgetMatch {
  topic: AutoMemoryType;
  summary: string;
  filePath: string;
}

export interface AutoMemoryForgetResult {
  query: string;
  removedEntries: AutoMemoryForgetMatch[];
  touchedTopics: AutoMemoryType[];
  systemMessage?: string;
}

export interface AutoMemoryForgetSelectionResult {
  matches: AutoMemoryForgetMatch[];
  strategy: 'none' | 'heuristic' | 'model';
  reasoning?: string;
}

interface IndexedForgetCandidate extends AutoMemoryForgetMatch {
  id: string;
  why?: string;
  howToApply?: string;
}

const FORGET_SELECTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    selectedCandidateIds: {
      type: 'array',
      items: { type: 'string' },
    },
    reasoning: {
      type: 'string',
    },
  },
  required: ['selectedCandidateIds'],
};

interface ForgetSelectionResponse {
  selectedCandidateIds: string[];
  reasoning?: string;
}

async function listIndexedForgetCandidates(
  projectRoot: string,
  abortSignal?: AbortSignal,
): Promise<IndexedForgetCandidate[]> {
  abortSignal?.throwIfAborted();
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  abortSignal?.throwIfAborted();
  const candidates: IndexedForgetCandidate[] = [];

  for (const doc of docs) {
    abortSignal?.throwIfAborted();
    const entries = parseAutoMemoryEntries(doc.body);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      candidates.push({
        // Use a stable per-entry ID so the model can target individual entries
        // in multi-entry files without accidentally removing siblings.
        id:
          entries.length === 1 ? doc.relativePath : `${doc.relativePath}:${i}`,
        topic: doc.type,
        summary: entry.summary,
        filePath: doc.filePath,
        why: entry.why,
        howToApply: entry.howToApply,
      });
    }
  }

  return candidates;
}

function buildForgetSelectionPrompt(
  query: string,
  candidates: IndexedForgetCandidate[],
  limit: number,
): string {
  return [
    'Select the managed auto-memory entries that most likely match the user request to forget something.',
    `Return at most ${limit} candidate ids.`,
    'Prefer semantically matching entries even if the wording differs slightly.',
    'If nothing should be forgotten, return an empty array.',
    '',
    `Forget request: ${query.trim()}`,
    '',
    'Candidates:',
    ...candidates.map((candidate, index) =>
      [
        `Candidate ${index + 1}`,
        `id: ${candidate.id}`,
        `topic: ${candidate.topic}`,
        `summary: ${candidate.summary}`,
        `why: ${candidate.why ?? '(none)'}`,
        `howToApply: ${candidate.howToApply ?? '(none)'}`,
      ].join('\n'),
    ),
  ].join('\n');
}

async function selectByModel(
  candidates: IndexedForgetCandidate[],
  query: string,
  config: Config,
  limit: number,
  callerAbortSignal?: AbortSignal,
): Promise<AutoMemoryForgetSelectionResult> {
  const response = await runSideQuery<ForgetSelectionResponse>(config, {
    purpose: 'auto-memory-forget-selection',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: buildForgetSelectionPrompt(query, candidates, limit),
          },
        ],
      },
    ] as Content[],
    schema: FORGET_SELECTION_RESPONSE_SCHEMA,
    skipOutputLanguagePreference: true,
    // /forget acts on the selection without confirmation, so pin selection to
    // the main model rather than the runSideQuery fast-model default — a
    // weaker fast model could pick the wrong entries and silently delete.
    model: config.getModel(),
    abortSignal: callerAbortSignal
      ? AbortSignal.any([AbortSignal.timeout(8_000), callerAbortSignal])
      : AbortSignal.timeout(8_000),
    config: {
      temperature: 0,
    },
    validate: (value) => {
      const candidateIds = new Set(candidates.map((c) => c.id));
      for (const id of value.selectedCandidateIds) {
        if (!candidateIds.has(id)) {
          return `Unknown candidate id: ${id}`;
        }
      }
      return null;
    },
  });

  const selectedIds = new Set(response.selectedCandidateIds);
  const matches = candidates
    .filter((candidate) => selectedIds.has(candidate.id))
    .slice(0, limit)
    .map(({ topic, summary, filePath }) => ({ topic, summary, filePath }));

  return {
    matches,
    strategy: matches.length > 0 ? 'model' : 'none',
    reasoning: response.reasoning,
  };
}

function selectByHeuristic(
  candidates: IndexedForgetCandidate[],
  query: string,
  limit: number,
): AutoMemoryForgetSelectionResult {
  const normalizedQuery = query.replace(/\s+/g, ' ').trim();
  const queryLower = normalizedQuery.toLowerCase();
  const matches = candidates
    .filter((candidate) =>
      buildAutoMemoryEntrySearchText(candidate).includes(queryLower),
    )
    .slice(0, limit)
    .map(({ topic, summary, filePath }) => ({ topic, summary, filePath }));

  return {
    matches,
    strategy: matches.length > 0 ? 'heuristic' : 'none',
  };
}

export async function selectManagedAutoMemoryForgetCandidates(
  projectRoot: string,
  query: string,
  options: {
    config?: Config;
    limit?: number;
    abortSignal?: AbortSignal;
  } = {},
): Promise<AutoMemoryForgetSelectionResult> {
  options.abortSignal?.throwIfAborted();
  const limit = options.limit ?? 5;
  const candidates = await listIndexedForgetCandidates(
    projectRoot,
    options.abortSignal,
  );
  if (candidates.length === 0) {
    return { matches: [], strategy: 'none' };
  }

  if (options.config) {
    try {
      return await selectByModel(
        candidates,
        query,
        options.config,
        limit,
        options.abortSignal,
      );
    } catch (err) {
      if (options.abortSignal?.aborted) throw err;
      // Fall through to heuristic.
    }
  }

  options.abortSignal?.throwIfAborted();
  return selectByHeuristic(candidates, query, limit);
}

async function bumpMetadata(projectRoot: string, now: Date): Promise<void> {
  try {
    const content = await fs.readFile(
      getAutoMemoryMetadataPath(projectRoot),
      'utf-8',
    );
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    await atomicWriteFile(
      getAutoMemoryMetadataPath(projectRoot),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf-8' },
    );
  } catch {
    // Best-effort metadata bump.
  }
}

export async function forgetManagedAutoMemoryMatches(
  projectRoot: string,
  matches: AutoMemoryForgetMatch[],
  now = new Date(),
  options: { abortSignal?: AbortSignal } = {},
): Promise<AutoMemoryForgetResult> {
  options.abortSignal?.throwIfAborted();
  if (matches.length === 0) {
    return {
      query: '',
      removedEntries: [],
      touchedTopics: [],
      systemMessage: undefined,
    };
  }
  await ensureAutoMemoryScaffold(projectRoot, now);
  options.abortSignal?.throwIfAborted();

  const removedEntries: AutoMemoryForgetMatch[] = [];
  const touchedTopics = new Set<AutoMemoryType>();

  // Group matches by file so we can do per-entry removal rather than
  // blindly deleting entire files (which would destroy unrelated entries in
  // legacy multi-entry files).
  const matchesByFile = new Map<string, AutoMemoryForgetMatch[]>();
  for (const match of matches) {
    const existing = matchesByFile.get(match.filePath) ?? [];
    existing.push(match);
    matchesByFile.set(match.filePath, existing);
  }

  for (const [filePath, fileMatches] of matchesByFile) {
    try {
      options.abortSignal?.throwIfAborted();
      const rawContent = await fs.readFile(filePath, 'utf-8');
      options.abortSignal?.throwIfAborted();
      const fmMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

      if (!fmMatch) {
        // No frontmatter — delete the whole file.
        options.abortSignal?.throwIfAborted();
        await fs.unlink(filePath);
        removedEntries.push(...fileMatches);
        for (const m of fileMatches) touchedTopics.add(m.topic);
        continue;
      }

      const [, frontmatter, rawBody] = fmMatch;
      const allEntries = parseAutoMemoryEntries(rawBody.trim());
      const matchedSummaries = new Set(
        fileMatches.map((m) => m.summary.toLowerCase()),
      );
      const kept = allEntries.filter(
        (e) => !matchedSummaries.has(e.summary.toLowerCase()),
      );

      if (kept.length === 0) {
        options.abortSignal?.throwIfAborted();
        await fs.unlink(filePath);
      } else {
        const heading = getAutoMemoryBodyHeading(rawBody);
        const newBody = renderAutoMemoryBody(heading, kept);
        options.abortSignal?.throwIfAborted();
        await atomicWriteFile(
          filePath,
          `---\n${frontmatter}\n---\n\n${newBody}\n`,
          { encoding: 'utf-8' },
        );
      }

      // Record the entries that were actually removed (by summary match count).
      const removedCount = allEntries.length - kept.length;
      removedEntries.push(...fileMatches.slice(0, removedCount));
      for (const m of fileMatches.slice(0, removedCount)) {
        touchedTopics.add(m.topic);
      }
    } catch (err) {
      if (options.abortSignal?.aborted) throw err;
      // File may have already been removed; continue.
    }
  }

  if (touchedTopics.size > 0) {
    options.abortSignal?.throwIfAborted();
    await bumpMetadata(projectRoot, now);
    options.abortSignal?.throwIfAborted();
    await rebuildManagedAutoMemoryIndex(projectRoot);
  }

  return {
    query: '',
    removedEntries,
    touchedTopics: [...touchedTopics],
    systemMessage:
      removedEntries.length > 0
        ? `Managed auto-memory forgot ${removedEntries.length} entr${removedEntries.length === 1 ? 'y' : 'ies'} from: ${[...touchedTopics].map((topic) => `${topic}/`).join(', ')}`
        : undefined,
  };
}

export async function forgetManagedAutoMemoryEntries(
  projectRoot: string,
  query: string,
  options: { config?: Config; abortSignal?: AbortSignal } = {},
  now = new Date(),
): Promise<AutoMemoryForgetResult> {
  options.abortSignal?.throwIfAborted();
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { query: trimmedQuery, removedEntries: [], touchedTopics: [] };
  }

  const selection = await selectManagedAutoMemoryForgetCandidates(
    projectRoot,
    trimmedQuery,
    { ...options, limit: Number.MAX_SAFE_INTEGER },
  );
  const result = await forgetManagedAutoMemoryMatches(
    projectRoot,
    selection.matches,
    now,
    { abortSignal: options.abortSignal },
  );
  return { ...result, query: trimmedQuery };
}
