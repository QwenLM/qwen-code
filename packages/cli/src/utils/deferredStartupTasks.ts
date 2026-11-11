/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  startupProfiler,
  runLogger,
  Storage,
  cleanupOldSessionEnvDirs,
  isNodeError,
  type Config,
} from '@qwen-code/core';
import type { Settings } from '../config/settings.js';

export interface DeferredStartupCleanupOptions {
  delayMs?: number;
  ref?: boolean;
  includeProjectCleanup?: boolean;
}

export const DEFAULT_DEFERRED_CLEANUP_DELAY_MS = 5000;
export const STARTUP_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_CLEANUP_LOCK_STALE_MS = 60 * 60 * 1000;
const STARTUP_CLEANUP_SENTINEL = '.last-cleanup';
const STARTUP_CLEANUP_LOCK = '.cleanup.lock';

const cleanupPromises = new WeakMap<Settings, Promise<void>>();
const cleanupTimers = new WeakMap<Settings, ReturnType<typeof setTimeout>>();
const completedCleanupSettings = new WeakSet<Settings>();

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

export function startDeferredStartupCleanup(
  settings: Settings,
  config: Config | undefined,
  options: DeferredStartupCleanupOptions = {},
): void {
  if (
    completedCleanupSettings.has(settings) ||
    cleanupPromises.has(settings) ||
    cleanupTimers.has(settings)
  ) {
    return;
  }

  const delayMs = options.delayMs ?? DEFAULT_DEFERRED_CLEANUP_DELAY_MS;
  if (delayMs <= 0) {
    void runStartupCleanupNow(settings, config, options);
    return;
  }

  const timer = setTimeout(() => {
    cleanupTimers.delete(settings);
    void runStartupCleanupNow(settings, config, options);
  }, delayMs);
  cleanupTimers.set(settings, timer);
  if (options.ref === false) {
    timer.unref?.();
  }
}

export function cancelDeferredStartupCleanup(settings: Settings): void {
  const timer = cleanupTimers.get(settings);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  cleanupTimers.delete(settings);
}

export function runStartupCleanupNow(
  settings: Settings,
  config: Config | undefined,
  options: Pick<DeferredStartupCleanupOptions, 'includeProjectCleanup'> = {},
): Promise<void> {
  if (completedCleanupSettings.has(settings)) {
    return Promise.resolve();
  }

  const existing = cleanupPromises.get(settings);
  if (existing) {
    return existing;
  }

  const promise = runStartupCleanup(settings, config, options).finally(() => {
    cleanupPromises.delete(settings);
    completedCleanupSettings.add(settings);
  });
  cleanupPromises.set(settings, promise);
  return promise;
}

async function isStartupCleanupDue(
  sentinelPath: string,
  now: number,
): Promise<boolean> {
  try {
    const stat = await fs.stat(sentinelPath);
    return now - stat.mtimeMs >= STARTUP_CLEANUP_INTERVAL_MS;
  } catch (error) {
    if (isNotFound(error)) {
      return true;
    }
    runLogger.debug(
      `Deferred cleanup skipped because the last-cleanup marker could not be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function tryAcquireCleanupLock(
  cleanupDir: string,
  now: number,
): Promise<string | undefined> {
  const lockPath = path.join(cleanupDir, STARTUP_CLEANUP_LOCK);
  await fs.mkdir(cleanupDir, { recursive: true });

  const createLock = async (): Promise<boolean> => {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) {
        return false;
      }
      throw error;
    }
  };

  if (await createLock()) {
    return lockPath;
  }

  try {
    const stat = await fs.stat(lockPath);
    if (now - stat.mtimeMs < STARTUP_CLEANUP_LOCK_STALE_MS) {
      return undefined;
    }
    await fs.unlink(lockPath);
  } catch (error) {
    if (!isNotFound(error)) {
      return undefined;
    }
  }

  return (await createLock()) ? lockPath : undefined;
}

async function runCleanupGroup(
  label: 'global' | 'project',
  cleanupDir: string,
  operation: () => Promise<ReadonlyArray<{ failed: number }>>,
): Promise<void> {
  const sentinelPath = path.join(cleanupDir, STARTUP_CLEANUP_SENTINEL);
  const now = Date.now();
  let lockPath: string | undefined;

  try {
    if (!(await isStartupCleanupDue(sentinelPath, now))) {
      return;
    }

    lockPath = await tryAcquireCleanupLock(cleanupDir, now);
    if (!lockPath) {
      return;
    }

    // Another process may have completed cleanup while this process was
    // waiting to acquire the lock.
    if (!(await isStartupCleanupDue(sentinelPath, now))) {
      return;
    }

    const results = await operation();
    if (!results.every((result) => result.failed === 0)) {
      return;
    }
    await fs.writeFile(sentinelPath, `${new Date().toISOString()}\n`, 'utf8');
  } catch (e) {
    runLogger.error(`Deferred ${label} cleanup failed:`, e);
  } finally {
    if (lockPath) {
      await fs.unlink(lockPath).catch((error: unknown) => {
        if (!isNotFound(error)) {
          runLogger.debug(
            `Failed to release deferred cleanup lock: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });
    }
  }
}

async function runStartupCleanup(
  settings: Settings,
  config: Config | undefined,
  options: Pick<DeferredStartupCleanupOptions, 'includeProjectCleanup'>,
): Promise<void> {
  const cleanupOpsHandle = startupProfiler.start('cleanup_ops');

  try {
    const cleanupGroups = [
      runCleanupGroup('global', Storage.getGlobalConfigDir(), async () => {
        const [
          { cleanupDiagnosticLogs },
          { cleanupBackgroundLogs },
          { cleanupWebFetchSources },
        ] = await Promise.all([
          import('./diagnosticLogCleanup.js'),
          import('./logCleanup.js'),
          import('./sessionCleanup.js'),
        ]);
        return Promise.all([
          cleanupWebFetchSources(),
          cleanupDiagnosticLogs(),
          cleanupBackgroundLogs(),
          { failed: cleanupOldSessionEnvDirs() ? 0 : 1 },
        ]);
      }),
    ];

    if (config && options.includeProjectCleanup !== false) {
      const projectTempDir = config.storage.getProjectTempDir();
      cleanupGroups.push(
        runCleanupGroup('project', projectTempDir, async () => {
          const { cleanupExpiredSessions, cleanupToolOutputFiles } = await import(
            './sessionCleanup.js'
          );
          return Promise.all([
            cleanupExpiredSessions(config, settings),
            cleanupToolOutputFiles(
              settings,
              config.getDebugMode(),
              projectTempDir,
            ),
          ]);
        }),
      );
    }

    await Promise.all(cleanupGroups);
  } finally {
    cleanupOpsHandle?.end();
  }
}
