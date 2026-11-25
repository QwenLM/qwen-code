/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Watches file system paths referenced by FileChanged hooks and fires
 * FileChanged events when external changes are detected.
 *
 * Uses chokidar for cross-platform file watching. Matcher fields on
 * FileChanged hook entries are parsed as pipe-separated file names
 * (e.g. ".envrc|.env") and resolved relative to the current working
 * directory.
 */

import { watch, type FSWatcher } from 'chokidar';
import { isAbsolute, join } from 'node:path';
import { runLogger } from '../utils/runLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import type { HookRegistry } from './hookRegistry.js';
import type { HookEventHandler } from './hookEventHandler.js';
import { HookEventName, type FileChangeEventType } from './types.js';

/** Each HookSystem owns its watcher state; no filesystem watcher starts without paths. */
export function createFileChangedWatcher() {
  let watcher: FSWatcher | null = null;
  let currentCwd = '';
  let dynamicWatchPaths: string[] = [];
  let dynamicWatchPathsSorted: string[] = [];
  let initialized = false;
  let revision = 0;

  // References held for the lifetime of the watcher
  let registryRef: HookRegistry | null = null;
  let eventHandlerRef: HookEventHandler | null = null;

  /**
   * Initialize the file changed watcher.
   * Reads FileChanged hooks from the registry, resolves matcher paths
   * relative to the given cwd, and starts watching for changes.
   */
  function initializeFileChangedWatcher(
    cwd: string,
    hookRegistry: HookRegistry,
    hookEventHandler: HookEventHandler,
  ): void {
    if (initialized) return;
    initialized = true;
    currentCwd = cwd;
    registryRef = hookRegistry;
    eventHandlerRef = hookEventHandler;

    const paths = resolveWatchPaths(hookRegistry);
    if (paths.length === 0) {
      runLogger.debug(
        '[FileChangedWatcher] No FileChanged hooks with matchers found, skipping watch.',
      );
      return;
    }

    startWatching(paths);
  }

  /**
   * Resolve watch paths from FileChanged hook matchers.
   * Matcher field is pipe-separated file names (e.g. ".envrc|.env").
   */
  function resolveWatchPaths(hookRegistry: HookRegistry): string[] {
    const entries = hookRegistry.getHooksForEvent(HookEventName.FileChanged);
    const staticPaths: string[] = [];

    for (const entry of entries) {
      if (!entry.matcher) continue;
      for (const name of entry.matcher.split('|').map((s) => s.trim())) {
        if (!name) continue;
        staticPaths.push(isAbsolute(name) ? name : join(currentCwd, name));
      }
    }

    // Combine static matcher paths with dynamic paths from hook output
    return [...new Set([...staticPaths, ...dynamicWatchPaths])];
  }

  /**
   * Start chokidar watcher on the given paths.
   */
  function startWatching(paths: string[]): void {
    runLogger.debug(
      `[FileChangedWatcher] Watching ${paths.length} paths: ${paths.join(', ')}`,
    );
    watcher = watch(paths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    });
    const watchRevision = revision;
    watcher.on('change', (p) => {
      if (watchRevision === revision) handleFileEvent(p, 'change');
    });
    watcher.on('add', (p) => {
      if (watchRevision === revision) handleFileEvent(p, 'add');
    });
    watcher.on('unlink', (p) => {
      if (watchRevision === revision) handleFileEvent(p, 'unlink');
    });
    watcher.on('error', (error) => {
      runLogger.error(
        `[FileChangedWatcher] Watcher error: ${getErrorMessage(error)}`,
      );
    });
  }

  /**
   * Handle a file system event by firing the FileChanged hook.
   */
  function handleFileEvent(filePath: string, event: FileChangeEventType): void {
    runLogger.debug(`[FileChangedWatcher] ${event}: ${filePath}`);
    if (!eventHandlerRef) return;

    const eventRevision = revision;
    void eventHandlerRef
      .fireFileChangedEvent(filePath, event, undefined, currentCwd)
      .then((result) => {
        if (!initialized || eventRevision !== revision) return;
        // Consume watchPaths from hook output — update dynamic watch list
        if (result?.finalOutput) {
          const watchPaths =
            result.finalOutput.hookSpecificOutput?.['watchPaths'];
          if (Array.isArray(watchPaths)) {
            updateWatchPaths(watchPaths as string[]);
          }
        }
      })
      .catch((error) => {
        runLogger.debug(
          `[FileChangedWatcher] FileChanged hook failed for ${filePath}:`,
          error,
        );
      });
  }

  /**
   * Update dynamic watch paths (e.g. from hook output `watchPaths` field).
   * Restarts the watcher if the path set has changed.
   */
  function updateWatchPaths(paths: string[]): void {
    if (!initialized) return;
    const sorted = paths.slice().sort();
    if (
      sorted.length === dynamicWatchPathsSorted.length &&
      sorted.every((p, i) => p === dynamicWatchPathsSorted[i])
    ) {
      return;
    }
    dynamicWatchPaths = paths;
    dynamicWatchPathsSorted = sorted;
    restartWatching();
  }

  /**
   * Update the current working directory and restart watching.
   * Called when CWD changes so matcher paths are resolved against the new CWD.
   */
  function updateFileWatcherCwd(newCwd: string): void {
    if (!initialized || newCwd === currentCwd) return;
    currentCwd = newCwd;
    restartWatching();
  }

  /**
   * Close the watcher and restart with re-resolved paths.
   */
  function restartWatching(): void {
    // Invalidate pending events even when no paths remain to start a watcher.
    revision++;
    if (watcher) {
      void watcher.close();
      watcher = null;
    }
    if (!registryRef) return;
    const paths = resolveWatchPaths(registryRef);
    if (paths.length > 0) {
      startWatching(paths);
    }
  }

  /**
   * Refresh the file changed watcher by re-resolving watch paths from the
   * registry and (re-)starting the watcher if new paths are found.
   *
   * This is needed when hooks are registered after initialization (e.g. SDK
   * runtime hooks registered via the `initialize` control request). At init
   * time no FileChanged hooks may exist yet, so the watcher skips starting.
   * Calling this after hook registration picks up the newly registered matchers.
   */
  function refreshFileChangedWatcher(): void {
    if (!initialized || !registryRef) return;
    restartWatching();
  }

  /**
   * Dispose the file changed watcher: close chokidar and reset all state.
   */
  function disposeFileChangedWatcher(): void {
    revision++;
    if (watcher) {
      void watcher.close();
      watcher = null;
    }
    dynamicWatchPaths = [];
    dynamicWatchPathsSorted = [];
    initialized = false;
    registryRef = null;
    eventHandlerRef = null;
  }

  return {
    initializeFileChangedWatcher,
    updateFileWatcherCwd,
    updateWatchPaths,
    refreshFileChangedWatcher,
    disposeFileChangedWatcher,
  };
}
