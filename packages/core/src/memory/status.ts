/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { globalBackgroundTaskHub } from '../background/taskHub.js';
import { EXTRACT_TASK_TYPE } from './extractScheduler.js';
import { DREAM_TASK_TYPE } from './dreamScheduler.js';
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
} from './paths.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
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
  entryCount: number;
  filePaths: string[];
}

export interface ManagedAutoMemoryStatus {
  root: string;
  indexPath: string;
  indexContent: string;
  cursor?: AutoMemoryExtractCursor;
  metadata?: AutoMemoryMetadata;
  extractionRunning: boolean;
  topics: ManagedAutoMemoryTopicStatus[];
  extractionTasks: BackgroundTaskState[];
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

  const [indexContent, cursor, metadata, docs] = await Promise.all([
    fs.readFile(indexPath, 'utf-8').catch(() => ''),
    readJsonFile<AutoMemoryExtractCursor>(
      getAutoMemoryExtractCursorPath(projectRoot),
    ),
    readJsonFile<AutoMemoryMetadata>(getAutoMemoryMetadataPath(projectRoot)),
    scanAutoMemoryTopicDocuments(projectRoot),
  ]);

  // Aggregate per-entry files by topic
  const byTopic = new Map<AutoMemoryType, string[]>();
  for (const doc of docs) {
    const list = byTopic.get(doc.type) ?? [];
    list.push(doc.filePath);
    byTopic.set(doc.type, list);
  }

  const topics = AUTO_MEMORY_TYPES.map((topic) => ({
    topic,
    entryCount: byTopic.get(topic)?.length ?? 0,
    filePaths: byTopic.get(topic) ?? [],
  }));

  return {
    root,
    indexPath,
    indexContent,
    cursor,
    metadata,
    extractionRunning: isExtractRunning(projectRoot),
    topics,
    extractionTasks: globalBackgroundTaskHub
      .listByType(EXTRACT_TASK_TYPE, projectRoot)
      .slice(0, 8),
    dreamTasks: globalBackgroundTaskHub
      .listByType(DREAM_TASK_TYPE, projectRoot)
      .slice(0, 5),
  };
}
