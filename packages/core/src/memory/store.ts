/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getAutoMemoryTopicPath,
} from './paths.js';
import {
  AUTO_MEMORY_SCHEMA_VERSION,
  AUTO_MEMORY_TYPES,
  type AutoMemoryExtractCursor,
  type AutoMemoryMetadata,
  type AutoMemoryType,
} from './types.js';

const TOPIC_DESCRIPTIONS: Record<AutoMemoryType, string> = {
  user: 'User profile, preferences, background, and stable collaboration context.',
  feedback:
    'Corrections and validated guidance about how the assistant should work with this user/project.',
  project:
    'Non-derivable project facts, goals, constraints, incidents, and coordination context.',
  reference:
    'Pointers to durable external systems, dashboards, tickets, and reference resources.',
};

function buildTopicTitle(type: AutoMemoryType): string {
  switch (type) {
    case 'user':
      return 'User Memory';
    case 'feedback':
      return 'Feedback Memory';
    case 'project':
      return 'Project Memory';
    case 'reference':
      return 'Reference Memory';
  }
}

export function createDefaultAutoMemoryMetadata(
  now = new Date(),
): AutoMemoryMetadata {
  const iso = now.toISOString();
  return {
    version: AUTO_MEMORY_SCHEMA_VERSION,
    createdAt: iso,
    updatedAt: iso,
  };
}

export function createDefaultAutoMemoryExtractCursor(
  now = new Date(),
): AutoMemoryExtractCursor {
  return {
    updatedAt: now.toISOString(),
  };
}

export function createDefaultAutoMemoryIndex(): string {
  const lines = [
    '# Managed Auto-Memory Index',
    '',
    'This index is maintained by Qwen Code. Keep entries concise and store durable details in topic files.',
    '',
    ...AUTO_MEMORY_TYPES.map(
      (type) =>
        `- [${buildTopicTitle(type)}](${type}.md) — ${TOPIC_DESCRIPTIONS[type]}`,
    ),
    '',
  ];
  return lines.join('\n');
}

export function createDefaultAutoMemoryTopic(type: AutoMemoryType): string {
  const title = buildTopicTitle(type);
  return [
    '---',
    `type: ${type}`,
    `title: ${title}`,
    `description: ${TOPIC_DESCRIPTIONS[type]}`,
    '---',
    '',
    `# ${title}`,
    '',
    '_No entries yet._',
    '',
  ].join('\n');
}

async function writeFileIfMissing(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EEXIST') {
      throw error;
    }
  }
}

export async function ensureAutoMemoryScaffold(
  projectRoot: string,
  now = new Date(),
): Promise<void> {
  const root = getAutoMemoryRoot(projectRoot);
  await fs.mkdir(root, { recursive: true });

  await writeFileIfMissing(
    getAutoMemoryIndexPath(projectRoot),
    createDefaultAutoMemoryIndex(),
  );
  await writeFileIfMissing(
    getAutoMemoryMetadataPath(projectRoot),
    JSON.stringify(createDefaultAutoMemoryMetadata(now), null, 2) + '\n',
  );
  await writeFileIfMissing(
    getAutoMemoryExtractCursorPath(projectRoot),
    JSON.stringify(createDefaultAutoMemoryExtractCursor(now), null, 2) + '\n',
  );

  await Promise.all(
    AUTO_MEMORY_TYPES.map((type) =>
      writeFileIfMissing(
        getAutoMemoryTopicPath(projectRoot, type),
        createDefaultAutoMemoryTopic(type),
      ),
    ),
  );
}

export async function readAutoMemoryIndex(
  projectRoot: string,
): Promise<string | null> {
  try {
    return await fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export {
  AUTO_MEMORY_INDEX_FILENAME,
};