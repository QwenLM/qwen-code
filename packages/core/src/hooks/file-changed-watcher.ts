/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { statSync } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import { closeFileWatcher } from '../utils/file-watcher-cleanup.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { FileChangeEvent } from './types.js';

const debugLogger = createDebugLogger('FILE_CHANGED_WATCHER');

function isWithin(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function discoveryRoot(filePath: string): string | undefined {
  let directory = path.dirname(filePath);
  while (true) {
    try {
      return statSync(directory).isDirectory() ? directory : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        debugLogger.warn(
          `Could not inspect watch directory ${directory}:`,
          error,
        );
        return undefined;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
}

export class FileChangedWatcher {
  private watcher?: FSWatcher;
  private paths: string[] = [];
  private staticFiles: string[] = [];
  private readonly lifetime = new AbortController();
  private changes: Array<{ filePath: string; event: FileChangeEvent }> = [];
  private draining?: Promise<void>;
  private reconfiguration: Promise<void> = Promise.resolve();
  private settleReady?: () => void;
  private closing?: Promise<void>;

  constructor(
    private readonly notify: (
      filePath: string,
      event: FileChangeEvent,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  setPaths(
    paths: readonly string[],
    staticFiles: readonly string[] = [],
  ): Promise<void> {
    const next = [
      ...new Set(paths.map((filePath) => path.resolve(filePath))),
    ].sort();
    const files = [...new Set(staticFiles.map((file) => path.resolve(file)))]
      .filter((file) => next.includes(file))
      .sort();
    const staticSet = new Set(files);
    const dynamic = next.filter((root) => !staticSet.has(root));
    this.reconfiguration = this.reconfiguration.then(async () => {
      if (
        this.lifetime.signal.aborted ||
        (next.length === this.paths.length &&
          next.every((filePath, index) => filePath === this.paths[index]) &&
          files.length === this.staticFiles.length &&
          files.every(
            (filePath, index) => filePath === this.staticFiles[index],
          ) &&
          (next.length > 0 || !this.watcher))
      ) {
        return;
      }
      await this.stopWatcher(next, staticSet);
      if (this.lifetime.signal.aborted) return;
      this.paths = next;
      this.staticFiles = files;
      if (next.length === 0) return;
      try {
        // Observe surviving ancestors so missing or replaced roots can reappear.
        const anchors = next.map(discoveryRoot);
        if (anchors.some((root) => root === undefined)) this.paths = [];
        const watchRoots = [
          ...new Set(anchors.filter((root) => root !== undefined)),
        ];
        if (watchRoots.length === 0) return;
        const watcher = watch(watchRoots, {
          ignoreInitial: true,
          ignored: (candidate, stats) => {
            if (stats && !stats.isFile() && !stats.isDirectory()) return true;
            const file = path.resolve(candidate);
            if (
              stats?.isFile() &&
              /\.[0-9a-f]{12}\.tmp$/.test(path.basename(file)) &&
              !next.includes(file)
            )
              return true;
            if (
              dynamic.some(
                (root) =>
                  isWithin(root, file) &&
                  !path
                    .relative(root, file)
                    .split(path.sep)
                    .some((part) => part === '.git' || part === 'node_modules'),
              )
            )
              return false;
            if (staticSet.has(file)) return stats?.isDirectory() ?? false;
            // Only ancestors of requested paths may lead discovery downward.
            return !next.some((root) => isWithin(file, root));
          },
          followSymlinks: false,
          awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        });
        this.watcher = watcher;
        await new Promise<void>((resolve) => {
          this.settleReady = resolve;
          watcher
            .on('all', (event, filePath) => {
              if (this.lifetime.signal.aborted || this.watcher !== watcher) {
                return;
              }
              const resolved = path.resolve(filePath);
              if (event === 'unlinkDir' && watchRoots.includes(resolved)) {
                this.paths = [];
                const parent = discoveryRoot(resolved);
                if (parent && !watchRoots.includes(parent)) {
                  watchRoots.push(parent);
                  // Keep the watcher alive so pending file unlinks still drain.
                  watcher.add(parent);
                }
                return;
              }
              if (event !== 'add' && event !== 'change' && event !== 'unlink')
                return;
              if (
                !staticSet.has(resolved) &&
                !dynamic.some((root) => isWithin(root, resolved))
              )
                return;
              this.changes.push({ filePath: resolved, event });
              this.drain();
            })
            .on('error', (error) => {
              if (this.watcher === watcher) this.paths = [];
              debugLogger.warn('File watcher failed:', error);
              resolve();
            })
            .once('ready', resolve);
        });
        this.settleReady = undefined;
      } catch (error) {
        this.paths = [];
        debugLogger.warn('Could not start file watcher:', error);
      }
    });
    return this.reconfiguration;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.changes = [];
    this.settleReady?.();
    this.closing = (async () => {
      await this.reconfiguration;
      await this.stopWatcher();
      await this.draining;
    })();
    return this.closing;
  }

  private async stopWatcher(
    retainedPaths: readonly string[] = [],
    staticFiles: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    this.changes = this.changes.filter(({ filePath }) =>
      retainedPaths.some((root) =>
        staticFiles.has(root) ? root === filePath : isWithin(root, filePath),
      ),
    );
    const watcher = this.watcher;
    this.watcher = undefined;
    // macOS exit cleanup may leave the native watcher open; keep its error handler.
    watcher?.removeAllListeners('all');
    watcher?.removeAllListeners('ready');
    try {
      await closeFileWatcher(watcher);
    } catch (error) {
      debugLogger.warn('Could not close file watcher:', error);
    }
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      while (!this.lifetime.signal.aborted) {
        const change = this.changes.shift();
        if (!change) break;
        try {
          await this.notify(
            change.filePath,
            change.event,
            this.lifetime.signal,
          );
        } catch (error) {
          if (!this.lifetime.signal.aborted) {
            debugLogger.warn('FileChanged hook failed:', error);
          }
        }
      }
    })().finally(() => {
      this.draining = undefined;
      if (this.changes.length > 0 && !this.lifetime.signal.aborted)
        this.drain();
    });
  }
}
