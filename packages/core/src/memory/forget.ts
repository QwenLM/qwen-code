/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
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
): Promise<IndexedForgetCandidate[]> {
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  const candidates: IndexedForgetCandidate[] = [];

  for (const doc of docs) {
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
    // /forget acts on the selection without confirmation, so pin selection to
    // the main model rather than the runSideQuery fast-model default — a
    // weaker fast model could pick the wrong entries and silently delete.
    model: config.getModel(),
    abortSignal: AbortSignal.timeout(8_000),
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
  } = {},
): Promise<AutoMemoryForgetSelectionResult> {
  const limit = options.limit ?? 5;
  const candidates = await listIndexedForgetCandidates(projectRoot);
  if (candidates.length === 0) {
    return { matches: [], strategy: 'none' };
  }

  if (options.config) {
    try {
      return await selectByModel(candidates, query, options.config, limit);
    } catch {
      // Fall through to heuristic.
    }
  }

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
    await fs.writeFile(
      getAutoMemoryMetadataPath(projectRoot),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf-8',
    );
  } catch {
    // Best-effort metadata bump.
  }
}

export async function forgetManagedAutoMemoryMatches(
  projectRoot: string,
  matches: AutoMemoryForgetMatch[],
  now = new Date(),
): Promise<AutoMemoryForgetResult> {
  if (matches.length === 0) {
    return {
      query: '',
      removedEntries: [],
      touchedTopics: [],
      systemMessage: undefined,
    };
  }
  await ensureAutoMemoryScaffold(projectRoot, now);

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
      const rawContent = await fs.readFile(filePath, 'utf-8');
      const fmMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

      if (!fmMatch) {
        // No frontmatter — delete the whole file.
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
        await fs.unlink(filePath);
      } else {
        const heading = getAutoMemoryBodyHeading(rawBody);
        const newBody = renderAutoMemoryBody(heading, kept);
        await fs.writeFile(
          filePath,
          `---\n${frontmatter}\n---\n\n${newBody}\n`,
          'utf-8',
        );
      }

      // Record the entries that were actually removed (by summary match count).
      const removedCount = allEntries.length - kept.length;
      removedEntries.push(...fileMatches.slice(0, removedCount));
      for (const m of fileMatches.slice(0, removedCount)) {
        touchedTopics.add(m.topic);
      }
    } catch {
      // File may have already been removed; continue.
    }
  }

  if (touchedTopics.size > 0) {
    await bumpMetadata(projectRoot, now);
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
  options: { config?: Config } = {},
  now = new Date(),
): Promise<AutoMemoryForgetResult> {
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
  );
  return { ...result, query: trimmedQuery };
}
