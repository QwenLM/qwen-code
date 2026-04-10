/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AUTO_MEMORY_TYPES, type AutoMemoryType } from './types.js';
import { AUTO_MEMORY_INDEX_FILENAME, getAutoMemoryRoot } from './paths.js';

const MAX_SCANNED_MEMORY_FILES = 200;

export interface ScannedAutoMemoryDocument {
  type: AutoMemoryType;
  filePath: string;
  relativePath: string;
  filename: string;
  title: string;
  description: string;
  body: string;
  mtimeMs: number;
}

function parseFrontmatterValue(
  frontmatter: string,
  key: string,
): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

export function parseAutoMemoryTopicDocument(
  filePath: string,
  content: string,
  mtimeMs = 0,
  relativePath = path.basename(filePath),
): ScannedAutoMemoryDocument | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }

  const [, frontmatter, bodyContent] = frontmatterMatch;
  const rawType = parseFrontmatterValue(frontmatter, 'type');
  if (!rawType || !AUTO_MEMORY_TYPES.includes(rawType as AutoMemoryType)) {
    return null;
  }

  return {
    type: rawType as AutoMemoryType,
    filePath,
    relativePath,
    filename: path.basename(filePath),
    title:
      parseFrontmatterValue(frontmatter, 'name') ??
      parseFrontmatterValue(frontmatter, 'title') ??
      rawType,
    description: parseFrontmatterValue(frontmatter, 'description') ?? '',
    body: bodyContent.trim(),
    mtimeMs,
  };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { recursive: true });
    return (
      entries
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' &&
            entry.endsWith('.md') &&
            path.basename(entry) !== AUTO_MEMORY_INDEX_FILENAME,
        )
        // Normalize to forward slashes so relative paths are valid URL segments
        // on all platforms (Windows readdir returns backslash-separated paths).
        .map((entry) => entry.replaceAll('\\', '/'))
        .sort()
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function scanAutoMemoryTopicDocuments(
  projectRoot: string,
): Promise<ScannedAutoMemoryDocument[]> {
  const root = getAutoMemoryRoot(projectRoot);
  const relativePaths = await listMarkdownFiles(root);
  const docs = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(root, relativePath);
      const [content, stats] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ]);
      return parseAutoMemoryTopicDocument(
        filePath,
        content,
        stats.mtimeMs,
        relativePath,
      );
    }),
  );

  return docs
    .filter((doc): doc is ScannedAutoMemoryDocument => doc !== null)
    .filter((doc) => AUTO_MEMORY_TYPES.includes(doc.type))
    .sort(
      (a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename),
    )
    .slice(0, MAX_SCANNED_MEMORY_FILES);
}
