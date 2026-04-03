/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../auxiliary/sideQuery.js';
import {
  buildAutoMemoryEntrySearchText,
  getAutoMemoryBodyHeading,
  parseAutoMemoryEntries,
  renderAutoMemoryBody,
  type ManagedAutoMemoryEntryStability,
} from './entries.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { getAutoMemoryMetadataPath, getAutoMemoryTopicPath } from './paths.js';
import { parseAutoMemoryTopicDocument } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import type { AutoMemoryMetadata, AutoMemoryType } from './types.js';
import { AUTO_MEMORY_TYPES } from './types.js';

export interface AutoMemoryForgetMatch {
  topic: AutoMemoryType;
  summary: string;
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
  stability?: ManagedAutoMemoryEntryStability;
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
  const matches: IndexedForgetCandidate[] = [];
  for (const topic of AUTO_MEMORY_TYPES) {
    const topicPath = getAutoMemoryTopicPath(projectRoot, topic);
    try {
      const current = await fs.readFile(topicPath, 'utf-8');
      const parsed = parseAutoMemoryTopicDocument(topicPath, current);
      if (!parsed) {
        continue;
      }

      for (const entry of parseAutoMemoryEntries(parsed.body)) {
        matches.push({
          id: `${topic}:${entry.summary}`,
          topic,
          summary: entry.summary,
          why: entry.why,
          howToApply: entry.howToApply,
          stability: entry.stability,
        });
      }
    } catch {
      // Ignore missing or invalid topic files.
    }
  }

  return matches;
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
        `stability: ${candidate.stability ?? '(none)'}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function buildUpdatedBodyForMatches(
  body: string,
  summariesToRemove: Set<string>,
): { body: string; removedEntries: string[] } {
  const entries = parseAutoMemoryEntries(body);
  const removedEntries: string[] = [];
  const nextEntries = entries.filter((entry) => {
    if (summariesToRemove.has(entry.summary.toLowerCase())) {
      removedEntries.push(entry.summary);
      return false;
    }
    return true;
  });

  return {
    body: renderAutoMemoryBody(getAutoMemoryBodyHeading(body), nextEntries),
    removedEntries,
  };
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
    // Best-effort metadata update.
  }
}

export async function findManagedAutoMemoryForgetCandidates(
  projectRoot: string,
  query: string,
): Promise<AutoMemoryForgetMatch[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const matches: AutoMemoryForgetMatch[] = [];
  for (const topic of AUTO_MEMORY_TYPES) {
    const topicPath = getAutoMemoryTopicPath(projectRoot, topic);
    try {
      const current = await fs.readFile(topicPath, 'utf-8');
      const parsed = parseAutoMemoryTopicDocument(topicPath, current);
      if (!parsed) {
        continue;
      }

      for (const entry of parseAutoMemoryEntries(parsed.body)) {
        if (buildAutoMemoryEntrySearchText(entry).includes(normalizedQuery)) {
          matches.push({ topic, summary: entry.summary });
        }
      }
    } catch {
      // Ignore missing or invalid topic files.
    }
  }

  return matches;
}

export async function selectManagedAutoMemoryForgetCandidates(
  projectRoot: string,
  query: string,
  options: {
    config?: Config;
    limit?: number;
  } = {},
): Promise<AutoMemoryForgetSelectionResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { matches: [], strategy: 'none' };
  }

  const candidates = await listIndexedForgetCandidates(projectRoot);
  if (candidates.length === 0) {
    return { matches: [], strategy: 'none' };
  }

  const limit = Math.max(1, Math.min(options.limit ?? 10, candidates.length));
  if (options.config) {
    try {
      const candidateIds = new Set(candidates.map((candidate) => candidate.id));
      const contents: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: buildForgetSelectionPrompt(normalizedQuery, candidates, limit),
            },
          ],
        },
      ];
      const response = await runSideQuery<ForgetSelectionResponse>(options.config, {
        purpose: 'auto-memory-forget-select',
        contents,
        schema: FORGET_SELECTION_RESPONSE_SCHEMA,
        abortSignal: AbortSignal.timeout(7_500),
        config: {
          temperature: 0,
        },
        validate: (value) => {
          if (value.selectedCandidateIds.length > limit) {
            return 'Forget selector returned too many candidates';
          }
          if (value.selectedCandidateIds.some((id) => !candidateIds.has(id))) {
            return 'Forget selector returned an unknown candidate id';
          }
          return null;
        },
      });

      const selectedIds = new Set(response.selectedCandidateIds);
      return {
        matches: candidates
          .filter((candidate) => selectedIds.has(candidate.id))
          .map(({ topic, summary }) => ({ topic, summary })),
        strategy: selectedIds.size > 0 ? 'model' : 'none',
        reasoning: response.reasoning,
      };
    } catch {
      // Fall back to heuristic matching.
    }
  }

  const queryLower = normalizedQuery.toLowerCase();
  const matches = candidates
    .filter((candidate) =>
      buildAutoMemoryEntrySearchText(candidate).includes(queryLower),
    )
    .slice(0, limit)
    .map(({ topic, summary }) => ({ topic, summary }));

  return {
    matches,
    strategy: matches.length > 0 ? 'heuristic' : 'none',
  };
}

export async function forgetManagedAutoMemoryMatches(
  projectRoot: string,
  matches: AutoMemoryForgetMatch[],
  now = new Date(),
): Promise<AutoMemoryForgetResult> {
  await ensureAutoMemoryScaffold(projectRoot, now);

  const removalsByTopic = new Map<AutoMemoryType, Set<string>>();
  for (const match of matches) {
    const existing = removalsByTopic.get(match.topic) ?? new Set<string>();
    existing.add(match.summary.toLowerCase());
    removalsByTopic.set(match.topic, existing);
  }

  const removedEntries: AutoMemoryForgetMatch[] = [];
  const touchedTopics = new Set<AutoMemoryType>();

  for (const topic of AUTO_MEMORY_TYPES) {
    const summariesToRemove = removalsByTopic.get(topic);
    if (!summariesToRemove || summariesToRemove.size === 0) {
      continue;
    }

    const topicPath = getAutoMemoryTopicPath(projectRoot, topic);
    const current = await fs.readFile(topicPath, 'utf-8');
    const parsed = parseAutoMemoryTopicDocument(topicPath, current);
    if (!parsed) {
      continue;
    }

    const updated = buildUpdatedBodyForMatches(parsed.body, summariesToRemove);
    if (updated.removedEntries.length === 0 || updated.body === parsed.body.trim()) {
      continue;
    }

    for (const summary of updated.removedEntries) {
      removedEntries.push({ topic, summary });
    }
    await fs.writeFile(topicPath, current.replace(parsed.body, updated.body), 'utf-8');
    touchedTopics.add(topic);
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
        ? `Managed auto-memory forgot ${removedEntries.length} entr${removedEntries.length === 1 ? 'y' : 'ies'} from ${[...touchedTopics].map((topic) => `${topic}.md`).join(', ')}`
        : undefined,
  };
}

export async function forgetManagedAutoMemoryEntries(
  projectRoot: string,
  query: string,
  now = new Date(),
): Promise<AutoMemoryForgetResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      query: trimmedQuery,
      removedEntries: [],
      touchedTopics: [],
    };
  }

  const selection = await selectManagedAutoMemoryForgetCandidates(projectRoot, trimmedQuery, {
    limit: Number.MAX_SAFE_INTEGER,
  });
  const result = await forgetManagedAutoMemoryMatches(
    projectRoot,
    selection.matches,
    now,
  );
  return {
    ...result,
    query: trimmedQuery,
  };
}
