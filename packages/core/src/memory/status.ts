/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { type MemoryManager, type MemoryTaskRecord } from './manager.js';
import { getAutoMemoryIndexPath, getAutoMemoryRoot } from './paths.js';
import {
  readProjectMemoryCursor,
  readProjectMemoryMetadata,
} from './project-commit.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import type {
  AutoMemoryExtractCursor,
  AutoMemoryMetadata,
  AutoMemoryType,
} from './types.js';
import { AUTO_MEMORY_TYPES } from './types.js';

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
  migrationRunning: boolean;
  topics: ManagedAutoMemoryTopicStatus[];
  extractionTasks: MemoryTaskRecord[];
  dreamTasks: MemoryTaskRecord[];
  migrationTasks: MemoryTaskRecord[];
}

export async function getManagedAutoMemoryStatus(
  projectRoot: string,
  manager: MemoryManager,
): Promise<ManagedAutoMemoryStatus> {
  const root = getAutoMemoryRoot(projectRoot);
  const indexPath = getAutoMemoryIndexPath(projectRoot);

  const [indexContent, cursor, metadata, docs] = await Promise.all([
    fs.readFile(indexPath, 'utf-8').catch(() => ''),
    readProjectMemoryCursor(root).catch(() => undefined),
    readProjectMemoryMetadata(projectRoot).catch(() => undefined),
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

  const extractTaskType = 'extract' as const;
  const dreamTaskType = 'dream' as const;
  const migrationTaskType = 'migration' as const;
  const allMigrationTasks = manager.listTasksByType(
    migrationTaskType,
    projectRoot,
  );
  const migrationTasks = allMigrationTasks.slice(0, 8);

  return {
    root,
    indexPath,
    indexContent,
    cursor,
    metadata,
    extractionRunning: manager
      .listTasksByType(extractTaskType, projectRoot)
      .some((t) => t.status === 'running'),
    migrationRunning: allMigrationTasks.some(
      (task) => task.status === 'running',
    ),
    topics,
    extractionTasks: manager
      .listTasksByType(extractTaskType, projectRoot)
      .slice(0, 8),
    dreamTasks: manager.listTasksByType(dreamTaskType, projectRoot).slice(0, 5),
    migrationTasks,
  };
}
