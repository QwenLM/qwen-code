/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { AUTO_MEMORY_TYPES, type AutoMemoryType } from './types.js';
import { getAutoMemoryTopicPath } from './paths.js';

export interface ScannedAutoMemoryDocument {
  type: AutoMemoryType;
  filePath: string;
  title: string;
  description: string;
  body: string;
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
    title: parseFrontmatterValue(frontmatter, 'title') ?? rawType,
    description: parseFrontmatterValue(frontmatter, 'description') ?? '',
    body: bodyContent.trim(),
  };
}

export async function scanAutoMemoryTopicDocuments(
  projectRoot: string,
): Promise<ScannedAutoMemoryDocument[]> {
  const docs = await Promise.all(
    AUTO_MEMORY_TYPES.map(async (type) => {
      const filePath = getAutoMemoryTopicPath(projectRoot, type);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return parseAutoMemoryTopicDocument(filePath, content);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    }),
  );

  return docs.filter((doc): doc is ScannedAutoMemoryDocument => doc !== null);
}