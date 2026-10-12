/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { closeFileWatcher } from '../utils/file-watcher-cleanup.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { FileChangeEvent } from './types.js';

const debugLogger = createDebugLogger('FILE_CHANGED_WATCHER');

export class FileChangedWatcher {
  private watcher?: FSWatcher;
  private paths: string[] = [];
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

  setPaths(paths: readonly string[]): Promise<void> {
    const next = [
      ...new Set(paths.map((filePath) => path.resolve(filePath))),
    ].sort();
    this.reconfiguration = this.reconfiguration.then(async () => {
      if (
        this.lifetime.signal.aborted ||
        (next.length === this.paths.length &&
          next.every((filePath, index) => filePath === this.paths[index]))
      ) {
        return;
      }
      await this.stopWatcher();
      if (this.lifetime.signal.aborted) return;
      this.paths = next;
      if (next.length === 0) return;
      try {
        const watcher = watch(next, {
          ignoreInitial: true,
          followSymlinks: false,
          awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        });
        this.watcher = watcher;
        await new Promise<void>((resolve) => {
          this.settleReady = resolve;
          watcher
            .on('all', (event, filePath) => {
              if (
                this.lifetime.signal.aborted ||
                this.watcher !== watcher ||
                (event !== 'add' && event !== 'change' && event !== 'unlink')
              ) {
                return;
              }
              this.changes.push({ filePath: path.resolve(filePath), event });
              this.drain();
            })
            .on('error', (error) => {
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

  private async stopWatcher(): Promise<void> {
    this.changes = [];
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
