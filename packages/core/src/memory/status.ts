/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { getManagedAutoMemoryDreamTaskRegistry } from './dreamScheduler.js';
import { buildAutoMemoryTopicHooks, countAutoMemoryTopicEntries } from './indexer.js';
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getAutoMemoryTopicPath,
} from './paths.js';
import { parseAutoMemoryTopicDocument } from './scan.js';
import { isExtractRunning } from './state.js';
import type {
  AutoMemoryExtractCursor,
  AutoMemoryMetadata,
  AutoMemoryType,
} from './types.js';
import { AUTO_MEMORY_TYPES } from './types.js';
import type { BackgroundTaskState } from '../background/taskRegistry.js';

export interface ManagedAutoMemoryTopicStatus {
  topic: AutoMemoryType;
  title: string;
  entryCount: number;
  hooks: string[];
  filePath: string;
}

export interface ManagedAutoMemoryStatus {
  root: string;
  indexPath: string;
  indexContent: string;
  cursor?: AutoMemoryExtractCursor;
  metadata?: AutoMemoryMetadata;
  extractionRunning: boolean;
  topics: ManagedAutoMemoryTopicStatus[];
  dreamTasks: BackgroundTaskState[];
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

export async function getManagedAutoMemoryStatus(
  projectRoot: string,
): Promise<ManagedAutoMemoryStatus> {
  const root = getAutoMemoryRoot(projectRoot);
  const indexPath = getAutoMemoryIndexPath(projectRoot);
  const [indexContent, cursor, metadata, topics] = await Promise.all([
    fs.readFile(indexPath, 'utf-8').catch(() => ''),
    readJsonFile<AutoMemoryExtractCursor>(getAutoMemoryExtractCursorPath(projectRoot)),
    readJsonFile<AutoMemoryMetadata>(getAutoMemoryMetadataPath(projectRoot)),
    Promise.all(
      AUTO_MEMORY_TYPES.map(async (topic) => {
        const filePath = getAutoMemoryTopicPath(projectRoot, topic);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = parseAutoMemoryTopicDocument(filePath, content);
          if (!parsed) {
            return {
              topic,
              title: topic,
              entryCount: 0,
              hooks: [],
              filePath,
            };
          }

          return {
            topic,
            title: parsed.title,
            entryCount: countAutoMemoryTopicEntries(parsed.body),
            hooks: buildAutoMemoryTopicHooks(parsed.body),
            filePath,
          } satisfies ManagedAutoMemoryTopicStatus;
        } catch {
          return {
            topic,
            title: topic,
            entryCount: 0,
            hooks: [],
            filePath,
          } satisfies ManagedAutoMemoryTopicStatus;
        }
      }),
    ),
  ]);

  return {
    root,
    indexPath,
    indexContent,
    cursor,
    metadata,
    extractionRunning: isExtractRunning(projectRoot),
    topics,
    dreamTasks: getManagedAutoMemoryDreamTaskRegistry().list(projectRoot).slice(0, 5),
  };
}
