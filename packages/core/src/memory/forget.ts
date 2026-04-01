/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
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

function normalizeBullet(line: string): string {
  return line.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
}

function buildUpdatedBody(
  body: string,
  query: string,
): { body: string; removedEntries: string[] } {
  const queryLower = query.trim().toLowerCase();
  const lines = body.split('\n').map((line) => line.trimEnd());
  const removedEntries: string[] = [];

  const nextLines = lines.filter((line) => {
    if (!/^[-*]\s+/.test(line.trim())) {
      return true;
    }
    const normalized = normalizeBullet(line);
    const shouldRemove = normalized.toLowerCase().includes(queryLower);
    if (shouldRemove) {
      removedEntries.push(normalized);
      return false;
    }
    return true;
  });

  const hasBullets = nextLines.some((line) => /^[-*]\s+/.test(line.trim()));
  if (!hasBullets) {
    const headingIndex = nextLines.findIndex((line) => line.startsWith('# '));
    if (headingIndex >= 0) {
      return {
        body: [...nextLines.slice(0, headingIndex + 1), '', '_No entries yet._'].join('\n'),
        removedEntries,
      };
    }
  }

  return {
    body: nextLines.join('\n').trim(),
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

      for (const line of parsed.body.split('\n')) {
        if (!/^[-*]\s+/.test(line.trim())) {
          continue;
        }
        const summary = normalizeBullet(line);
        if (summary.toLowerCase().includes(normalizedQuery)) {
          matches.push({ topic, summary });
        }
      }
    } catch {
      // Ignore missing or invalid topic files.
    }
  }

  return matches;
}

export async function forgetManagedAutoMemoryEntries(
  projectRoot: string,
  query: string,
  now = new Date(),
): Promise<AutoMemoryForgetResult> {
  const trimmedQuery = query.trim();
  await ensureAutoMemoryScaffold(projectRoot, now);
  if (!trimmedQuery) {
    return {
      query: trimmedQuery,
      removedEntries: [],
      touchedTopics: [],
    };
  }

  const removedEntries: AutoMemoryForgetMatch[] = [];
  const touchedTopics = new Set<AutoMemoryType>();

  for (const topic of AUTO_MEMORY_TYPES) {
    const topicPath = getAutoMemoryTopicPath(projectRoot, topic);
    const current = await fs.readFile(topicPath, 'utf-8');
    const parsed = parseAutoMemoryTopicDocument(topicPath, current);
    if (!parsed) {
      continue;
    }

    const updated = buildUpdatedBody(parsed.body, trimmedQuery);
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
    query: trimmedQuery,
    removedEntries,
    touchedTopics: [...touchedTopics],
    systemMessage:
      removedEntries.length > 0
        ? `Managed auto-memory forgot ${removedEntries.length} entr${removedEntries.length === 1 ? 'y' : 'ies'} from ${[...touchedTopics].map((topic) => `${topic}.md`).join(', ')}`
        : undefined,
  };
}
