/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, type Stats } from 'node:fs';
import { sep } from 'node:path';
import {
  watch as chokidarWatch,
  type FSWatcher as ChokidarWatcher,
} from 'chokidar';
import { anchorKey } from './anchorPlanner.js';
import { isInsideBun } from './watchBackendPolicy.js';
import type {
  FileChangeOperation,
  FileWatcherOptions,
} from './types.js';

// Per-entry traversal warnings do not prevent Chokidar from reaching ready.
const recoverableScanErrors = new Set([
  'ENOENT',
  'ENOTDIR',
  'ELOOP',
  'EACCES',
  'EPERM',
  'READDIRP_RECURSIVE_ERROR',
]);

const WATCHER_READY_TIMEOUT_MS = 5000;

async function closeWatcher(watcher: ChokidarWatcher): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Chokidar close can hang on macOS; bound cleanup without delaying failure.
    await Promise.race([
      watcher.close(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Shared Chokidar backends grouped by traversal depth, with per-anchor reference counts. */
export class ChokidarBackendPool {
  private readonly anchorCounts = new Map<string, number>();
  private readonly watchers = new Map<string, ChokidarWatcher>();
  private readonly readiness = new Map<
    ChokidarWatcher,
    {
      promise: Promise<void>;
      cancel: () => void;
      close: () => Promise<void>;
      anchors: Set<string>;
    }
  >();
  private started = false;

  constructor(
    private readonly options: FileWatcherOptions,
    private readonly onEvent: (
      operation: FileChangeOperation,
      path: string,
    ) => void,
    private readonly isIgnoredPath: (path: string) => boolean,
  ) {}

  start(): void {
    this.started = true;
  }

  async ready(): Promise<void> {
    const backends = [...this.watchers.values()];
    await Promise.all(
      backends.map((watcher) => this.readiness.get(watcher)!.promise),
    );
    // Give per-file OS watch handles a moment to attach; chokidar's ready
    // event can precede them on macOS.
    if (backends.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.anchorCounts.clear();
    const states = [...this.readiness.values()];
    this.watchers.clear();
    for (const state of states) state.cancel();
    this.readiness.clear();
    await Promise.all(states.map((state) => state.close()));
  }

  retain(anchor: string, flat: boolean, depth?: number): void {
    if (!existsSync(anchor)) return;
    const watcher = this.backend(flat, depth);
    if (!watcher) return;
    const key = `${this.backendKey(flat, depth)}:${anchorKey(anchor, flat)}`;
    const count = this.anchorCounts.get(key) ?? 0;
    this.anchorCounts.set(key, count + 1);
    if (count === 0) {
      this.readiness.get(watcher)!.anchors.add(anchor);
      watcher.add(anchor);
    }
  }

  release(anchor: string, flat: boolean, depth?: number): void {
    const key = `${this.backendKey(flat, depth)}:${anchorKey(anchor, flat)}`;
    const count = this.anchorCounts.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      this.anchorCounts.delete(key);
      const watcher = this.watchers.get(this.backendKey(flat, depth));
      if (watcher) {
        this.readiness.get(watcher)!.anchors.delete(anchor);
        void watcher.unwatch(anchor);
      }
    } else {
      this.anchorCounts.set(key, count - 1);
    }
  }

  private backendKey(flat: boolean, depth?: number): string {
    return flat ? 'flat' : `recursive:${depth ?? 'all'}`;
  }

  private backend(flat: boolean, depth?: number): ChokidarWatcher | undefined {
    if (!this.started) return undefined;
    const key = this.backendKey(flat, depth);
    let watcher = this.watchers.get(key);
    if (!watcher) {
      watcher = this.createWatcher(flat, depth);
      this.watchers.set(key, watcher);
    }
    return watcher;
  }

  private createWatcher(flat: boolean, depth?: number): ChokidarWatcher {
    const usePolling = this.options.usePolling ?? isInsideBun();
    const configuredInterval = this.options.pollingIntervalMs ?? 2000;
    const interval =
      Number.isFinite(configuredInterval) && configuredInterval > 0
        ? configuredInterval
        : 2000;
    const awaitWriteFinish =
      this.options.awaitWriteFinish === false
        ? false
        : (this.options.awaitWriteFinish ?? {
            stabilityThreshold: 1000,
            pollInterval: 500,
          });
    const watcher = chokidarWatch([], {
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
      // Content anchors are canonical and keep following nested symlinks.
      // Flat entry guards must observe the symlink itself instead.
      followSymlinks: !flat,
      usePolling,
      ...(usePolling ? { interval, binaryInterval: interval } : {}),
      awaitWriteFinish,
      ignored: (filePath: string, stats?: Stats) => {
        // Special files (sockets, FIFOs, devices) break fs.watch on some
        // platforms; .git trees are noise. Directories and stats-less
        // pre-checks must pass so traversal continues.
        if (
          stats &&
          !stats.isFile() &&
          !stats.isDirectory() &&
          !stats.isSymbolicLink()
        ) {
          return true;
        }
        return (
          filePath.split(sep).includes('.git') || this.isIgnoredPath(filePath)
        );
      },
      depth: flat ? 0 : depth,
    });
    // Bind before add() can start scanning. Cache the outcome because ready is
    // emitted only once; a later ready() call must not wait for a second event.
    let cancel!: () => void;
    const anchors = new Set<string>();
    let closing: Promise<void> | undefined;
    const close = () => closing ??= closeWatcher(watcher);
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        watcher.off('ready', onReady);
        watcher.off('error', onError);
      };
      const onReady = () => {
        if (settled) return;
        cleanup();
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error);
        void close().catch((closeError) => this.options.onError?.(closeError));
      };
      const onError = (error: unknown) => {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code && recoverableScanErrors.has(code)) return;
        fail(error);
      };
      cancel = () => {
        if (settled) return;
        cleanup();
        reject(new Error('Watcher stopped before ready'));
      };
      // Public Chokidar events expose ready, not per-directory scan progress.
      // Bound the first ready wait, including silent/ignored scanner failures.
      const timer = setTimeout(() => {
        const paths = [...anchors];
        const error = Object.assign(new Error(
          `Watcher did not become ready within ${WATCHER_READY_TIMEOUT_MS}ms: ${paths.join(', ')}`,
        ), { code: 'ETIMEDOUT', paths });
        fail(error);
        this.options.onError?.(error);
      }, WATCHER_READY_TIMEOUT_MS);
      watcher.once('ready', onReady);
      watcher.on('error', onError);
    });
    // Errors may arrive before ready() is awaited. Keep the rejection for that
    // caller without creating an unhandled rejection in the meantime.
    void promise.catch(() => undefined);
    this.readiness.set(watcher, { promise, cancel, close, anchors });
    watcher.on('add', (path) => this.onEvent('add', path));
    watcher.on('change', (path) => this.onEvent('change', path));
    watcher.on('unlink', (path) => this.onEvent('unlink', path));
    watcher.on('addDir', (path) => this.onEvent('add', path));
    watcher.on('unlinkDir', (path) => this.onEvent('unlink', path));
    watcher.on('error', (error) => this.options.onError?.(error));
    return watcher;
  }
}
