/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import {
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getUserAutoMemoryIndexPath,
} from './paths.js';
import {
  scanAutoMemoryTopicDocuments,
  scanUserAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import type { AutoMemoryMetadata } from './types.js';

const MAX_INDEX_LINE_CHARS = 150;
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

function truncateIndexLine(text: string): string {
  if (text.length <= MAX_INDEX_LINE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_INDEX_LINE_CHARS - 1).trimEnd()}…`;
}

export function buildManagedAutoMemoryIndex(
  docs: ScannedAutoMemoryDocument[],
  _metadata?: Pick<
    AutoMemoryMetadata,
    'updatedAt' | 'lastDreamAt' | 'lastDreamSessionId'
  >,
): string {
  const raw = docs
    .map((doc) =>
      truncateIndexLine(
        `- [${doc.title}](${doc.relativePath}) — ${doc.description || doc.type}`,
      ),
    )
    .join('\n');

  const lines = raw.split('\n');
  const wasLineTruncated = lines.length > MAX_INDEX_LINES;
  let truncated = wasLineTruncated
    ? lines.slice(0, MAX_INDEX_LINES).join('\n')
    : raw;

  if (truncated.length > MAX_INDEX_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_INDEX_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_INDEX_BYTES);
  }

  if (!wasLineTruncated && truncated.length === raw.length) {
    return truncated;
  }

  return `${truncated}\n\n> WARNING: MEMORY.md is too large; only part of it was written. Keep index entries concise and move detail into topic files.`;
}

async function readAutoMemoryMetadata(
  projectRoot: string,
): Promise<AutoMemoryMetadata | undefined> {
  try {
    const content = await fs.readFile(
      getAutoMemoryMetadataPath(projectRoot),
      'utf-8',
    );
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
  await atomicWriteFile(getAutoMemoryIndexPath(projectRoot), content, {
    encoding: 'utf-8',
  });
  return content;
}

/**
 * Rebuild the MEMORY.md index for the user-level (cross-project) memory dir.
 * Mirrors {@link rebuildManagedAutoMemoryIndex} but uses the global root
 * and skips metadata (user memory has no per-project state file).
 */
export async function rebuildUserAutoMemoryIndex(): Promise<string> {
  const docs = await scanUserAutoMemoryTopicDocuments();
  const content = buildManagedAutoMemoryIndex(docs);
  await atomicWriteFile(getUserAutoMemoryIndexPath(), content, {
    encoding: 'utf-8',
  });
  return content;
}
