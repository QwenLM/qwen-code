/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { parseAutoMemoryEntries } from './entries.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import type { AutoMemoryType } from './types.js';

export type AutoMemoryGovernanceSuggestionType =
  | 'duplicate'
  | 'conflict'
  | 'outdated'
  | 'promote'
  | 'migrate'
  | 'forget';

export interface AutoMemoryGovernanceSuggestion {
  type: AutoMemoryGovernanceSuggestionType;
  topic: AutoMemoryType;
  summary: string;
  rationale: string;
  relatedTopic?: AutoMemoryType;
  relatedSummary?: string;
  suggestedTargetTopic?: AutoMemoryType;
}

export interface AutoMemoryGovernanceReview {
  suggestions: AutoMemoryGovernanceSuggestion[];
  strategy: 'none' | 'heuristic' | 'model';
}

interface IndexedGovernanceEntry {
  /** Relative path of the file (used as stable ID). */
  id: string;
  filePath: string;
  topic: AutoMemoryType;
  summary: string;
  why?: string;
  howToApply?: string;
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'duplicate',
              'conflict',
              'outdated',
              'promote',
              'migrate',
              'forget',
            ],
          },
          entryId: { type: 'string' },
          relatedEntryId: { type: 'string' },
          suggestedTargetTopic: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
          },
          rationale: { type: 'string' },
        },
        required: ['type', 'entryId', 'rationale'],
      },
    },
  },
  required: ['suggestions'],
};

interface GovernanceResponse {
  suggestions: Array<{
    type: AutoMemoryGovernanceSuggestionType;
    entryId: string;
    relatedEntryId?: string;
    suggestedTargetTopic?: AutoMemoryType;
    rationale: string;
  }>;
}

async function listGovernanceEntries(
  projectRoot: string,
): Promise<IndexedGovernanceEntry[]> {
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  const entries: IndexedGovernanceEntry[] = [];

  for (const doc of docs) {
    const docEntries = parseAutoMemoryEntries(doc.body);
    for (const entry of docEntries) {
      entries.push({
        id: doc.relativePath,
        filePath: doc.filePath,
        topic: doc.type,
        summary: entry.summary,
        why: entry.why,
        howToApply: entry.howToApply,
      });
    }
  }

  return entries;
}

function classifyExpectedTopic(summary: string): AutoMemoryType | null {
  if (
    /https?:\/\/|\b(grafana|dashboard|runbook|ticket|docs?|wiki|notion|jira)\b/i.test(
      summary,
    )
  ) {
    return 'reference';
  }
  if (
    /\b(i|we)\s+(prefer|like|need|want)\b|\bmy\s+(preferred|favorite)\b/i.test(
      summary,
    )
  ) {
    return 'user';
  }
  if (
    /\b(please|always|never|avoid|respond|format|style|terse|concise|detailed)\b/i.test(
      summary,
    )
  ) {
    return 'feedback';
  }
  if (
    /\b(project|repo|repository|service|release|deadline|freeze|incident|environment|stack)\b/i.test(
      summary,
    )
  ) {
    return 'project';
  }
  return null;
}

function maybeConflict(a: string, b: string): boolean {
  const pairChecks: Array<[RegExp, RegExp]> = [
    [/\balways\b/i, /\bnever\b/i],
    [/\bterse|concise\b/i, /\bdetailed\b/i],
  ];
  return pairChecks.some(
    ([left, right]) =>
      (left.test(a) && right.test(b)) || (left.test(b) && right.test(a)),
  );
}

function buildModelPrompt(entries: IndexedGovernanceEntry[]): string {
  return [
    'Review managed auto-memory entries and emit governance suggestions.',
    'Only suggest duplicate, conflict, outdated, promote, migrate, or forget when the case is strong.',
    'Prefer promote suggestions for entries that are durable but still missing why/howToApply context.',
    '',
    'Entries:',
    ...entries.map((entry, index) =>
      [
        `Entry ${index + 1}`,
        `id: ${entry.id}`,
        `topic: ${entry.topic}`,
        `summary: ${entry.summary}`,
        `why: ${entry.why ?? '(none)'}`,
        `howToApply: ${entry.howToApply ?? '(none)'}`,
      ].join('\n'),
    ),
    '',
    'Return JSON matching the response schema.',
  ].join('\n');
}

function buildHeuristicSuggestions(
  entries: IndexedGovernanceEntry[],
): AutoMemoryGovernanceSuggestion[] {
  const suggestions: AutoMemoryGovernanceSuggestion[] = [];

  // Duplicate detection: same summary (case-insensitive) in same topic
  const summaryByTopic = new Map<string, IndexedGovernanceEntry>();
  for (const entry of entries) {
    const key = `${entry.topic}:${entry.summary.toLowerCase()}`;
    const existing = summaryByTopic.get(key);
    if (existing) {
      suggestions.push({
        type: 'duplicate',
        topic: entry.topic,
        summary: entry.summary,
        relatedTopic: existing.topic,
        relatedSummary: existing.summary,
        rationale: 'Two entries share the same summary text.',
      });
    } else {
      summaryByTopic.set(key, entry);
    }
  }

  for (const entry of entries) {
    // Migration suggestion: entry may belong in a different topic
    const expectedTopic = classifyExpectedTopic(entry.summary);
    if (expectedTopic && expectedTopic !== entry.topic) {
      suggestions.push({
        type: 'migrate',
        topic: entry.topic,
        summary: entry.summary,
        suggestedTargetTopic: expectedTopic,
        rationale: `Entry heuristically belongs in '${expectedTopic}' rather than '${entry.topic}'.`,
      });
    }

    // Outdated markers
    if (
      /\b(today|now|currently|for this task|this session|temporary|temporarily)\b/i.test(
        entry.summary,
      )
    ) {
      suggestions.push({
        type: 'outdated',
        topic: entry.topic,
        summary: entry.summary,
        rationale: 'The entry appears temporary rather than durable.',
      });
    }

    if (/\b(deprecated|obsolete|sunset|legacy|old)\b/i.test(entry.summary)) {
      suggestions.push({
        type: 'outdated',
        topic: entry.topic,
        summary: entry.summary,
        rationale:
          'The entry contains wording that suggests it may be outdated.',
      });
    }

    // Promote: durable entry missing why/howToApply metadata
    if (!entry.why || !entry.howToApply) {
      suggestions.push({
        type: 'promote',
        topic: entry.topic,
        summary: entry.summary,
        rationale:
          'This durable entry could be upgraded with why/howToApply metadata.',
      });
    }
  }

  // Conflict detection: entries in the same topic that contradict each other
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i];
      const right = entries[j];
      if (left.topic !== right.topic) {
        continue;
      }
      if (maybeConflict(left.summary, right.summary)) {
        suggestions.push({
          type: 'conflict',
          topic: right.topic,
          summary: right.summary,
          relatedTopic: left.topic,
          relatedSummary: left.summary,
          rationale: 'These entries may encode conflicting guidance.',
        });
      }
    }
  }

  return suggestions.slice(0, 20);
}

export async function reviewManagedAutoMemoryGovernance(
  projectRoot: string,
  options: {
    config?: Config;
  } = {},
): Promise<AutoMemoryGovernanceReview> {
  const entries = await listGovernanceEntries(projectRoot);
  if (entries.length === 0) {
    return { suggestions: [], strategy: 'none' };
  }

  if (options.config) {
    try {
      const entryById = new Map(entries.map((entry) => [entry.id, entry]));
      const response = await runSideQuery<GovernanceResponse>(options.config, {
        purpose: 'auto-memory-governance-review',
        contents: [
          {
            role: 'user',
            parts: [{ text: buildModelPrompt(entries) }],
          },
        ] as Content[],
        schema: RESPONSE_SCHEMA,
        abortSignal: AbortSignal.timeout(8_000),
        config: {
          temperature: 0,
        },
        validate: (value) => {
          if (
            value.suggestions.some(
              (suggestion) => !entryById.has(suggestion.entryId),
            )
          ) {
            return 'Governance reviewer returned an unknown entry id';
          }
          if (
            value.suggestions.some(
              (suggestion) =>
                suggestion.relatedEntryId &&
                !entryById.has(suggestion.relatedEntryId),
            )
          ) {
            return 'Governance reviewer returned an unknown related entry id';
          }
          return null;
        },
      });

      return {
        suggestions: response.suggestions.map((suggestion) => {
          const entry = entryById.get(suggestion.entryId)!;
          const related = suggestion.relatedEntryId
            ? entryById.get(suggestion.relatedEntryId)
            : undefined;
          return {
            type: suggestion.type,
            topic: entry.topic,
            summary: entry.summary,
            rationale: suggestion.rationale,
            relatedTopic: related?.topic,
            relatedSummary: related?.summary,
            suggestedTargetTopic: suggestion.suggestedTargetTopic,
          } satisfies AutoMemoryGovernanceSuggestion;
        }),
        strategy: response.suggestions.length > 0 ? 'model' : 'none',
      };
    } catch {
      // Fall back to heuristics.
    }
  }

  const suggestions = buildHeuristicSuggestions(entries);
  return {
    suggestions,
    strategy: suggestions.length > 0 ? 'heuristic' : 'none',
  };
}
