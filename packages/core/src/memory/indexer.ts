/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { parseAutoMemoryEntries } from './entries.js';
import { getAutoMemoryIndexPath, getAutoMemoryMetadataPath } from './paths.js';
import { scanAutoMemoryTopicDocuments, type ScannedAutoMemoryDocument } from './scan.js';
import type { AutoMemoryMetadata } from './types.js';

const MAX_TOPIC_HOOKS = 3;

function getBodyBulletLines(body: string): string[] {
  return parseAutoMemoryEntries(body)
    .map((entry) => entry.summary)
    .filter((summary) => summary.length > 0);
}

export function countAutoMemoryTopicEntries(body: string): number {
  return getBodyBulletLines(body).length;
}

export function buildAutoMemoryTopicHooks(body: string): string[] {
  const hooks = getBodyBulletLines(body);
  return Array.from(
    new Map(hooks.map((hook) => [hook.toLowerCase(), hook])).values(),
  ).slice(0, MAX_TOPIC_HOOKS);
}

export function buildManagedAutoMemoryIndex(
  docs: ScannedAutoMemoryDocument[],
  metadata?: Pick<AutoMemoryMetadata, 'updatedAt' | 'lastDreamAt' | 'lastDreamSessionId'>,
): string {
  const totalEntries = docs.reduce(
    (sum, doc) => sum + countAutoMemoryTopicEntries(doc.body),
    0,
  );

  const lines = [
    '# Managed Auto-Memory Index',
    '',
    'This index is maintained by Qwen Code. It summarizes durable topic files and short hooks for recall and manual review.',
    '',
    `Topics: ${docs.length} | Durable entries: ${totalEntries}`,
  ];

  if (metadata?.updatedAt) {
    lines.push(`Updated: ${metadata.updatedAt}`);
  }
  if (metadata?.lastDreamAt) {
    lines.push(`Last dream: ${metadata.lastDreamAt}${metadata.lastDreamSessionId ? ` (session ${metadata.lastDreamSessionId})` : ''}`);
  }

  lines.push('', '## Topics', '');

  for (const doc of docs) {
    const entryCount = countAutoMemoryTopicEntries(doc.body);
    const hooks = buildAutoMemoryTopicHooks(doc.body);
    lines.push(
      `- [${doc.title}](${doc.type}.md) — ${doc.description} (${entryCount} durable ${entryCount === 1 ? 'entry' : 'entries'})`,
    );
    if (hooks.length === 0) {
      lines.push('  - Hook: empty');
      continue;
    }
    for (const hook of hooks) {
      lines.push(`  - ${hook}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function readAutoMemoryMetadata(
  projectRoot: string,
): Promise<AutoMemoryMetadata | undefined> {
  try {
    const content = await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8');
    return JSON.parse(content) as AutoMemoryMetadata;
  } catch {
    return undefined;
  }
}

export async function rebuildManagedAutoMemoryIndex(
  projectRoot: string,
): Promise<string> {
  const [docs, metadata] = await Promise.all([
    scanAutoMemoryTopicDocuments(projectRoot),
    readAutoMemoryMetadata(projectRoot),
  ]);
  const content = buildManagedAutoMemoryIndex(docs, metadata);
  await fs.writeFile(getAutoMemoryIndexPath(projectRoot), content, 'utf-8');
  return content;
}
