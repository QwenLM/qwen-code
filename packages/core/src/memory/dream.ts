/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { getAutoMemoryMetadataPath, getAutoMemoryTopicPath } from './paths.js';
import { parseAutoMemoryTopicDocument } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  AUTO_MEMORY_TYPES,
  type AutoMemoryMetadata,
  type AutoMemoryType,
} from './types.js';

export interface AutoMemoryDreamResult {
  touchedTopics: AutoMemoryType[];
  dedupedEntries: number;
  systemMessage?: string;
}

function normalizeBullet(line: string): string {
  return line.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
}

function buildDreamedBody(body: string): { body: string; dedupedEntries: number } {
  const lines = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const heading = lines.find((line) => line.startsWith('# ')) ?? '# Memory';
  const bullets = lines
    .filter((line) => /^[-*]\s+/.test(line))
    .map(normalizeBullet)
    .filter((line) => line.length > 0);

  const uniqueBullets = Array.from(
    new Map(bullets.map((line) => [line.toLowerCase(), line])).values(),
  ).sort((a, b) => a.localeCompare(b));

  return {
    body:
      uniqueBullets.length > 0
        ? [heading, '', ...uniqueBullets.map((line) => `- ${line}`)].join('\n')
        : [heading, '', '_No entries yet._'].join('\n'),
    dedupedEntries: Math.max(0, bullets.length - uniqueBullets.length),
  };
}

async function bumpMetadata(projectRoot: string, now: Date): Promise<void> {
  const metadataPath = getAutoMemoryMetadataPath(projectRoot);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as AutoMemoryMetadata;
    metadata.updatedAt = now.toISOString();
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  } catch {
    // Best-effort metadata bump.
  }
}

export async function runManagedAutoMemoryDream(
  projectRoot: string,
  now = new Date(),
): Promise<AutoMemoryDreamResult> {
  await ensureAutoMemoryScaffold(projectRoot, now);

  const touchedTopics = new Set<AutoMemoryType>();
  let dedupedEntries = 0;

  for (const topic of AUTO_MEMORY_TYPES) {
    const topicPath = getAutoMemoryTopicPath(projectRoot, topic);
    const current = await fs.readFile(topicPath, 'utf-8');
    const parsed = parseAutoMemoryTopicDocument(topicPath, current);
    if (!parsed) {
      continue;
    }

    const dreamed = buildDreamedBody(parsed.body);
    dedupedEntries += dreamed.dedupedEntries;
    if (dreamed.body === parsed.body.trim()) {
      continue;
    }

    const next = current.replace(parsed.body, dreamed.body);
    await fs.writeFile(topicPath, next, 'utf-8');
    touchedTopics.add(topic);
  }

  if (touchedTopics.size > 0) {
    await bumpMetadata(projectRoot, now);
  }

  return {
    touchedTopics: [...touchedTopics],
    dedupedEntries,
    systemMessage:
      touchedTopics.size > 0
        ? `Managed auto-memory dream updated: ${[...touchedTopics].map((topic) => `${topic}.md`).join(', ')}`
        : undefined,
  };
}