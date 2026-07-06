/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch as watchFs, type FSWatcher } from 'chokidar';
import {
  createDebugLogger,
  isSubpath,
  Storage,
  type Config,
  type ExtensionMutationEvent,
} from '@qwen-code/qwen-code-core';
import { ExtensionRefreshState } from './extension-refresh-state.js';

const debugLogger = createDebugLogger('EXTENSION_FILE_WATCHER');

const TOP_LEVEL_FILES = new Set([
  'extension-enablement.json',
  'extension-preferences.json',
  'marketplaces.json',
]);

const EXTENSION_FILES = new Set([
  'qwen-extension.json',
  '.qwen-extension-install.json',
]);

const AUTO_REFRESH_DIRS = new Set(['commands', 'skills', 'agents']);
const STALE_DIRS = new Set(['hooks']);

type WatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
type RefreshAction = 'auto' | 'stale';

export class ExtensionFileWatcher {
  private watcher?: FSWatcher;
  private bootstrapWatcher?: FSWatcher;
  private mutationListenerDisposer?: () => void;
  private mutationSuppressionEnds = new Map<number, () => void>();
  private contextFiles = new Set<string>();
  private watching = false;
  private watchGeneration = 0;

  constructor(
    private readonly config: Config,
    private readonly extensionsDir = Storage.getUserExtensionsDir(),
    private readonly refreshState = new ExtensionRefreshState(),
  ) {}

  startWatching(): void {
    this.stopWatching();
    this.watching = true;
    const generation = ++this.watchGeneration;
    this.subscribeExtensionManagerMutations();
    this.contextFiles = this.getContextFiles();
    const roots = this.getWatchRoots();

    if (roots.length > 0) {
      this.watcher = watchFs(roots, {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 50,
        },
        ignored: (filePath: string) => this.isIgnored(filePath),
      })
        .on('all', (event: string, changedPath: string) => {
          if (generation !== this.watchGeneration) return;
          const resolvedPath = path.resolve(changedPath);
          const action = this.getRefreshAction(
            event as WatchEvent,
            resolvedPath,
          );
          let marked = false;
          if (action === 'auto') {
            marked = this.refreshState.markExtensionContentChanged(
              'extension content files changed',
            );
          } else if (action === 'stale') {
            marked = this.refreshState.markExtensionsChanged(
              'extension files changed',
            );
          }
          debugLogger.debug('Extension file event classified', {
            event,
            path: resolvedPath,
            action,
            marked,
          });
        })
        .on('error', (error: unknown) => {
          debugLogger.warn('Extension file watcher error:', error);
        });
    }

    if (!fs.existsSync(this.extensionsDir)) {
      this.watchExtensionsParent();
    }
  }

  stopWatching(): void {
    const watcher = this.watcher;
    const bootstrapWatcher = this.bootstrapWatcher;
    this.watcher = undefined;
    this.bootstrapWatcher = undefined;
    this.watching = false;
    this.watchGeneration++;
    this.mutationListenerDisposer?.();
    this.mutationListenerDisposer = undefined;
    this.endPendingMutationSuppressions();
    watcher?.close().catch((error: unknown) => {
      debugLogger.warn('Extension file watcher close error:', error);
    });
    bootstrapWatcher?.close().catch((error: unknown) => {
      debugLogger.warn('Extension bootstrap watcher close error:', error);
    });
  }

  restartWatching(): void {
    this.startWatching();
  }

  private getWatchRoots(): string[] {
    const roots = new Set<string>();
    if (fs.existsSync(this.extensionsDir)) {
      roots.add(this.extensionsDir);
    }
    for (const extension of this.config.getExtensions()) {
      if (extension.installMetadata?.type === 'link') {
        const rawSource = extension.installMetadata.source;
        const source = rawSource ? path.resolve(rawSource) : undefined;
        if (source && fs.existsSync(source)) {
          roots.add(source);
        }
      }
    }
    return [...roots];
  }

  private getContextFiles(): Set<string> {
    const files = new Set<string>();
    for (const extension of this.config.getExtensions()) {
      for (const filePath of extension.contextFiles) {
        files.add(path.resolve(filePath));
      }
      const configured = extension.config.contextFileName;
      const names =
        configured === undefined
          ? ['QWEN.md']
          : Array.isArray(configured)
            ? configured
            : [configured];
      for (const name of names) {
        files.add(path.resolve(extension.path, name));
      }
    }
    return files;
  }

  private watchExtensionsParent(): void {
    this.closeBootstrapWatcher();
    const parentDir = path.dirname(this.extensionsDir);
    const dirBasename = path.basename(this.extensionsDir);
    const generation = this.watchGeneration;
    this.bootstrapWatcher = watchFs(parentDir, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      ignored: (filePath: string) =>
        filePath !== parentDir && path.basename(filePath) !== dirBasename,
    })
      .on('all', (_event: string, changedPath: string) => {
        if (generation !== this.watchGeneration) return;
        if (path.basename(changedPath) !== dirBasename) return;
        if (!fs.existsSync(this.extensionsDir)) return;
        this.refreshState.markExtensionsChanged('extension directory created');
        queueMicrotask(() => {
          if (this.watching) {
            this.restartWatching();
          }
        });
      })
      .on('error', (error: unknown) => {
        debugLogger.warn('Extension bootstrap watcher error:', error);
      });
  }

  private getRefreshAction(
    event: WatchEvent,
    changedPath: string,
  ): RefreshAction | false {
    if (this.contextFiles.has(changedPath)) {
      return 'stale';
    }
    if (changedPath === path.resolve(this.extensionsDir)) {
      if (event === 'unlinkDir') {
        this.watchExtensionsParent();
        return 'stale';
      }
      return false;
    }
    if (isSubpath(this.extensionsDir, changedPath)) {
      return this.getUserExtensionRefreshAction(event, changedPath);
    }
    return this.getLinkedExtensionRefreshAction(changedPath);
  }

  private getUserExtensionRefreshAction(
    event: WatchEvent,
    changedPath: string,
  ): RefreshAction | false {
    const relative = path.relative(this.extensionsDir, changedPath);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length === 1) {
      if (TOP_LEVEL_FILES.has(parts[0])) return 'stale';
      if (event === 'addDir' || event === 'unlinkDir') return 'stale';
      return false;
    }
    if (
      !fs.existsSync(
        path.join(this.extensionsDir, parts[0], 'qwen-extension.json'),
      )
    ) {
      return 'stale';
    }
    const runtimePath = parts.slice(1);
    return this.getRuntimePathRefreshAction(runtimePath);
  }

  private getLinkedExtensionRefreshAction(
    changedPath: string,
  ): RefreshAction | false {
    for (const extension of this.config.getExtensions()) {
      if (extension.installMetadata?.type !== 'link') continue;
      const rawSource = extension.installMetadata.source;
      const source = rawSource ? path.resolve(rawSource) : undefined;
      if (!source || !isSubpath(source, changedPath)) continue;
      const relative = path.relative(source, changedPath);
      const parts = relative.split(path.sep).filter(Boolean);
      return parts.length === 0
        ? 'stale'
        : this.getRuntimePathRefreshAction(parts);
    }
    return false;
  }

  private getRuntimePathRefreshAction(parts: string[]): RefreshAction | false {
    if (EXTENSION_FILES.has(parts[0]) || STALE_DIRS.has(parts[0])) {
      return 'stale';
    }
    if (AUTO_REFRESH_DIRS.has(parts[0])) {
      return 'auto';
    }
    return false;
  }

  private isIgnored(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const searchablePath = `/${normalized}/`;
    if (
      searchablePath.includes('/node_modules/') ||
      searchablePath.includes('/.git/')
    ) {
      return true;
    }
    const basename = normalized.split('/').pop() ?? '';
    return (
      basename === '.DS_Store' ||
      basename.endsWith('~') ||
      basename.endsWith('.swp') ||
      basename.endsWith('.tmp')
    );
  }

  private subscribeExtensionManagerMutations(): void {
    const manager = this.config.getExtensionManager();
    this.mutationListenerDisposer = manager.addMutationListener(
      (event: ExtensionMutationEvent) => {
        if (event.phase === 'start') {
          this.mutationSuppressionEnds.set(
            event.id,
            this.refreshState.beginSuppression(() =>
              this.restartAfterMutation(),
            ),
          );
          return;
        }
        const endSuppression = this.mutationSuppressionEnds.get(event.id);
        if (!endSuppression) {
          return;
        }
        this.mutationSuppressionEnds.delete(event.id);
        endSuppression();
      },
    );
  }

  private endPendingMutationSuppressions(): void {
    const endSuppressions = [...this.mutationSuppressionEnds.values()];
    this.mutationSuppressionEnds.clear();
    for (const endSuppression of endSuppressions) {
      endSuppression();
    }
  }

  private restartAfterMutation(): void {
    if (this.watching) {
      this.restartWatching();
    }
  }

  private closeBootstrapWatcher(): void {
    const bootstrapWatcher = this.bootstrapWatcher;
    this.bootstrapWatcher = undefined;
    bootstrapWatcher?.close().catch((error: unknown) => {
      debugLogger.warn('Extension bootstrap watcher close error:', error);
    });
  }
}
