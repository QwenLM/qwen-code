/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {
  BackgroundTaskDrainer,
  type DrainBackgroundTasksOptions,
} from '../background/taskDrainer.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskState,
} from '../background/taskRegistry.js';
import { BackgroundTaskScheduler } from '../background/taskScheduler.js';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryMetadataPath,
} from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { runManagedAutoMemoryDream } from './dream.js';
import type { AutoMemoryMetadata } from './types.js';

export const DEFAULT_AUTO_DREAM_MIN_HOURS = 24;
export const DEFAULT_AUTO_DREAM_MIN_SESSIONS = 5;

export interface ScheduleManagedAutoMemoryDreamParams {
  projectRoot: string;
  sessionId: string;
  now?: Date;
  minHoursBetweenDreams?: number;
  minSessionsBetweenDreams?: number;
}

export interface ManagedAutoMemoryDreamScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?:
    | 'same_session'
    | 'min_hours'
    | 'min_sessions'
    | 'locked'
    | 'running';
  promise?: Promise<BackgroundTaskState>;
}

async function readDreamMetadata(projectRoot: string): Promise<AutoMemoryMetadata> {
  const content = await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8');
  return JSON.parse(content) as AutoMemoryMetadata;
}

async function writeDreamMetadata(
  projectRoot: string,
  metadata: AutoMemoryMetadata,
): Promise<void> {
  await fs.writeFile(
    getAutoMemoryMetadataPath(projectRoot),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf-8',
  );
}

function hoursSince(lastDreamAt: string | undefined, now: Date): number | null {
  if (!lastDreamAt) {
    return null;
  }
  const timestamp = Date.parse(lastDreamAt);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return (now.getTime() - timestamp) / (1000 * 60 * 60);
}

async function lockExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.access(getAutoMemoryConsolidationLockPath(projectRoot));
    return true;
  } catch {
    return false;
  }
}

async function acquireDreamLock(projectRoot: string): Promise<void> {
  const handle = await fs.open(getAutoMemoryConsolidationLockPath(projectRoot), 'wx');
  await handle.close();
}

async function releaseDreamLock(projectRoot: string): Promise<void> {
  await fs.rm(getAutoMemoryConsolidationLockPath(projectRoot), {
    force: true,
  });
}

export class ManagedAutoMemoryDreamRuntime {
  readonly registry = new BackgroundTaskRegistry();
  readonly drainer = new BackgroundTaskDrainer();
  readonly scheduler = new BackgroundTaskScheduler(this.registry, this.drainer);

  async schedule(
    params: ScheduleManagedAutoMemoryDreamParams,
  ): Promise<ManagedAutoMemoryDreamScheduleResult> {
    const now = params.now ?? new Date();
    const minHoursBetweenDreams =
      params.minHoursBetweenDreams ?? DEFAULT_AUTO_DREAM_MIN_HOURS;
    const minSessionsBetweenDreams =
      params.minSessionsBetweenDreams ?? DEFAULT_AUTO_DREAM_MIN_SESSIONS;

    await ensureAutoMemoryScaffold(params.projectRoot, now);
    const metadata = await readDreamMetadata(params.projectRoot);

    if (metadata.lastDreamSessionId === params.sessionId) {
      return {
        status: 'skipped',
        skippedReason: 'same_session',
      };
    }

    const recentSessionIds = new Set(metadata.recentSessionIdsSinceDream ?? []);
    recentSessionIds.add(params.sessionId);
    metadata.recentSessionIdsSinceDream = [...recentSessionIds];
    metadata.updatedAt = now.toISOString();
    await writeDreamMetadata(params.projectRoot, metadata);

    const elapsedHours = hoursSince(metadata.lastDreamAt, now);
    if (elapsedHours !== null && elapsedHours < minHoursBetweenDreams) {
      return {
        status: 'skipped',
        skippedReason: 'min_hours',
      };
    }

    if (recentSessionIds.size < minSessionsBetweenDreams) {
      return {
        status: 'skipped',
        skippedReason: 'min_sessions',
      };
    }

    if (await lockExists(params.projectRoot)) {
      return {
        status: 'skipped',
        skippedReason: 'locked',
      };
    }

    const scheduled = this.scheduler.schedule({
      taskType: 'managed-auto-memory-dream',
      title: 'Managed auto-memory dream',
      projectRoot: params.projectRoot,
      sessionId: params.sessionId,
      dedupeKey: `managed-auto-memory-dream:${params.projectRoot}`,
      metadata: {
        sessionCount: recentSessionIds.size,
      },
      run: async () => {
        try {
          await acquireDreamLock(params.projectRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return {
              progressText: 'Skipped managed auto-memory dream because consolidation lock already exists.',
              metadata: { skippedReason: 'locked' },
            };
          }
          throw error;
        }

        try {
          const result = await runManagedAutoMemoryDream(params.projectRoot, now);
          const nextMetadata = await readDreamMetadata(params.projectRoot);
          nextMetadata.lastDreamAt = now.toISOString();
          nextMetadata.lastDreamSessionId = params.sessionId;
          nextMetadata.recentSessionIdsSinceDream = [];
          nextMetadata.updatedAt = now.toISOString();
          await writeDreamMetadata(params.projectRoot, nextMetadata);

          return {
            progressText:
              result.systemMessage ?? 'Managed auto-memory dream completed.',
            metadata: {
              touchedTopics: result.touchedTopics,
              dedupedEntries: result.dedupedEntries,
              lastDreamAt: now.toISOString(),
            },
          };
        } finally {
          await releaseDreamLock(params.projectRoot);
        }
      },
    });

    const initialTask = this.registry.get(scheduled.taskId);
    if (initialTask?.status === 'skipped') {
      return {
        status: 'skipped',
        skippedReason: 'running',
        taskId: scheduled.taskId,
        promise: scheduled.promise,
      };
    }

    return {
      status: 'scheduled',
      taskId: scheduled.taskId,
      promise: scheduled.promise,
    };
  }

  listTasks(projectRoot?: string): BackgroundTaskState[] {
    return this.registry.list(projectRoot);
  }

  drain(options?: DrainBackgroundTasksOptions): Promise<boolean> {
    return this.drainer.drain(options);
  }
}

const defaultManagedAutoMemoryDreamRuntime = new ManagedAutoMemoryDreamRuntime();

export async function scheduleManagedAutoMemoryDream(
  params: ScheduleManagedAutoMemoryDreamParams,
): Promise<ManagedAutoMemoryDreamScheduleResult> {
  return defaultManagedAutoMemoryDreamRuntime.schedule(params);
}

export function getManagedAutoMemoryDreamTaskRegistry(): BackgroundTaskRegistry {
  return defaultManagedAutoMemoryDreamRuntime.registry;
}

export async function drainManagedAutoMemoryDreamTasks(
  options?: DrainBackgroundTasksOptions,
): Promise<boolean> {
  return defaultManagedAutoMemoryDreamRuntime.drain(options);
}

export function createManagedAutoMemoryDreamRuntimeForTests(): ManagedAutoMemoryDreamRuntime {
  return new ManagedAutoMemoryDreamRuntime();
}
