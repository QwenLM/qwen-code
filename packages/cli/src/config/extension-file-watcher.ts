/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeFileWatcher } from '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch as watchFs, type FSWatcher } from 'chokidar';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type { ExtensionMutationEvent } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { isSubpath } from '@qwen-code/qwen-code-core/utils/paths.js';
import { ExtensionRefreshState } from './extension-refresh-state.js';

const debugLogger = createDebugLogger('EXTENSION_FILE_WATCHER');

const TOP_LEVEL_FILES = new Set(['extension-enablement.json']);

const EXTENSION_FILES = new Set([
  'qwen-extension.json',
  '.qwen-extension-install.json',
]);

// Keep these sets in sync with extension directory conventions. New runtime
// directories must be classified here as either content-auto-refreshable or
// package-stale.
const AUTO_REFRESH_DIRS = new Set([
  'commands',
  'skills',
  'agents',
  'workflows',
]);
const STALE_DIRS = new Set(['hooks']);

type WatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
type RefreshAction = 'auto' | 'stale';

export class ExtensionFileWatcher {
  private watcher?: FSWatcher;
  private bootstrapWatcher?: FSWatcher;
  private stateWatcher?: fs.FSWatcher;
  private watcherReady = false;
  private watcherHealthy = false;
  private stateWatcherHealthy = false;
  private watchIdentity?: string;
  private watchedManager?: ReturnType<Config['getExtensionManager']>;
  private mutationListenerDisposer?: () => void;
  private mutationSuppressionEnds = new Map<number, () => void>();
  private staleFiles = new Set<string>();
  private watching = false;
  private watchGeneration = 0;
  private readonly storeStatePath: string;
  private generationPoller?: ReturnType<typeof setInterval>;
  private observedStoreGeneration?: number;

  constructor(
    private readonly config: Config,
    private readonly extensionsDir = Storage.getUserExtensionsDir(),
    private readonly refreshState = new ExtensionRefreshState(),
    storeStatePath?: string,
  ) {
    this.storeStatePath =
      storeStatePath ??
      path.join(
        path.dirname(this.extensionsDir),
        'extension-store',
        'state.json',
      );
    this.observedStoreGeneration = this.readStoreGeneration();
  }

  startWatching(): void {
    this.startWatchingResources(false);
  }

  private startWatchingResources(preserveMutations: boolean): void {
    this.stopWatchingResources(preserveMutations);
    this.watching = true;
    const generation = ++this.watchGeneration;
    this.subscribeExtensionManagerMutations();
    this.staleFiles = this.getStaleFiles();
    const roots = this.getWatchRoots();
    const stateRoot = this.getStateWatchRoot();
    this.watchIdentity = this.getWatchIdentity(roots, stateRoot);
    this.watcherReady = roots.length === 0;
    this.watcherHealthy = true;

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
          if (
            generation !== this.watchGeneration ||
            !this.watching ||
            this.watchedManager !== this.config.getExtensionManager()
          )
            return;
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
        .on('ready', () => {
          if (
            generation === this.watchGeneration &&
            this.watching &&
            this.watchedManager === this.config.getExtensionManager()
          )
            this.watcherReady = true;
        })
        .on('error', (error: unknown) => {
          if (
            generation !== this.watchGeneration ||
            !this.watching ||
            this.watchedManager !== this.config.getExtensionManager()
          )
            return;
          this.watcherHealthy = false;
          debugLogger.warn('Extension file watcher error:', error);
        });
    }

    this.watchStoreParent(stateRoot, generation);
    if (!fs.existsSync(this.extensionsDir)) {
      this.watchExtensionsParent();
    }
    this.startGenerationPolling();
  }

  stopWatching(): void {
    this.stopWatchingResources(false);
  }

  private stopWatchingResources(preserveMutations: boolean): void {
    const watcher = this.watcher;
    const bootstrapWatcher = this.bootstrapWatcher;
    const stateWatcher = this.stateWatcher;
    this.watcher = undefined;
    this.bootstrapWatcher = undefined;
    this.stateWatcher = undefined;
    this.watchIdentity = undefined;
    this.watchedManager = undefined;
    this.watcherReady = false;
    this.watcherHealthy = false;
    this.stateWatcherHealthy = false;
    this.watching = false;
    this.watchGeneration++;
    if (this.generationPoller) clearInterval(this.generationPoller);
    this.generationPoller = undefined;
    this.mutationListenerDisposer?.();
    this.mutationListenerDisposer = undefined;
    if (!preserveMutations) this.endPendingMutationSuppressions();
    closeFileWatcher(watcher).catch((error: unknown) => {
      debugLogger.warn('Extension file watcher close error:', error);
    });
    closeFileWatcher(bootstrapWatcher).catch((error: unknown) => {
      debugLogger.warn('Extension bootstrap watcher close error:', error);
    });
    closeFileWatcher(stateWatcher).catch((error: unknown) => {
      debugLogger.warn('Extension store watcher close error:', error);
    });
  }

  restartWatching(): void {
    const roots = this.getWatchRoots();
    const identity = this.getWatchIdentity(roots, this.getStateWatchRoot());
    if (
      this.watching &&
      this.watcherReady &&
      this.watcherHealthy &&
      this.stateWatcherHealthy &&
      identity !== undefined &&
      identity === this.watchIdentity &&
      this.watchedManager === this.config.getExtensionManager()
    ) {
      this.staleFiles = this.getStaleFiles();
      this.pollStoreGeneration();
      return;
    }
    this.startWatchingResources(
      this.watching &&
        this.watchedManager === this.config.getExtensionManager(),
    );
  }

  private getStateWatchRoot(): string | undefined {
    let directory = path.dirname(this.storeStatePath);
    while (!fs.existsSync(directory)) {
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
    try {
      return fs.statSync(directory).isDirectory() ? directory : undefined;
    } catch {
      return undefined;
    }
  }

  private getWatchIdentity(
    roots: string[],
    stateRoot?: string,
  ): string | undefined {
    if (!stateRoot) return undefined;
    const directories = new Set([...roots, stateRoot]);
    if (!fs.existsSync(this.extensionsDir))
      directories.add(path.dirname(this.extensionsDir));
    try {
      return JSON.stringify(
        [...directories].sort().map((directory) => {
          const stat = fs.lstatSync(directory);
          if (
            !stat.isDirectory() ||
            !Number.isSafeInteger(stat.dev) ||
            !Number.isSafeInteger(stat.ino) ||
            stat.ino <= 0
          )
            throw new Error('Watch root identity unavailable');
          return [
            directory,
            fs.realpathSync(directory),
            stat.dev,
            stat.ino,
            stat.mode,
          ];
        }),
      );
    } catch {
      return undefined;
    }
  }

  private watchStoreParent(
    directory: string | undefined,
    generation: number,
  ): void {
    if (!directory) return;
    try {
      this.stateWatcher = fs.watch(directory, (_event, filename) => {
        if (
          generation !== this.watchGeneration ||
          !this.watching ||
          this.watchedManager !== this.config.getExtensionManager()
        )
          return;
        const nextRoot = this.getStateWatchRoot();
        if (
          nextRoot !== directory ||
          this.getWatchIdentity(this.getWatchRoots(), nextRoot) !==
            this.watchIdentity
        ) {
          const hadBaseline = this.observedStoreGeneration !== undefined;
          this.restartWatching();
          if (hadBaseline || this.readStoreGeneration() === undefined)
            this.getRefreshAction('change', path.resolve(this.storeStatePath));
          return;
        }
        if (directory !== path.dirname(this.storeStatePath)) return;
        if (
          filename !== null &&
          filename.toString() !== path.basename(this.storeStatePath)
        )
          return;
        this.getRefreshAction('change', path.resolve(this.storeStatePath));
      });
      this.stateWatcherHealthy = true;
      this.stateWatcher.on('error', (error: unknown) => {
        if (
          generation !== this.watchGeneration ||
          !this.watching ||
          this.watchedManager !== this.config.getExtensionManager()
        )
          return;
        this.stateWatcherHealthy = false;
        debugLogger.warn('Extension store watcher error:', error);
      });
      this.stateWatcher.on('close', () => {
        if (
          generation === this.watchGeneration &&
          this.watching &&
          this.watchedManager === this.config.getExtensionManager()
        )
          this.stateWatcherHealthy = false;
      });
    } catch (error) {
      this.stateWatcherHealthy = false;
      debugLogger.warn('Extension store watcher error:', error);
    }
  }

  private getWatchRoots(): string[] {
    const roots = new Set<string>();
    if (fs.existsSync(this.extensionsDir)) {
      roots.add(this.extensionsDir);
    }
    for (const extension of this.config.getActiveExtensions()) {
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

  private getStaleFiles(): Set<string> {
    const files = new Set<string>();
    for (const extension of this.config.getActiveExtensions()) {
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
      this.addManifestFileReference(
        files,
        extension.path,
        extension.config.hooks,
      );
      this.addManifestFileReference(
        files,
        extension.path,
        extension.config.lspServers,
      );
    }
    return files;
  }

  private addManifestFileReference(
    files: Set<string>,
    extensionPath: string,
    value: unknown,
  ): void {
    if (typeof value !== 'string') return;
    files.add(
      path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(extensionPath, value),
    );
  }

  private watchExtensionsParent(): void {
    this.closeBootstrapWatcher();
    const parentDir = path.dirname(this.extensionsDir);
    const dirBasename = path.basename(this.extensionsDir);
    const generation = this.watchGeneration;
    const bootstrapWatcher: FSWatcher = watchFs(parentDir, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      ignored: (filePath: string) =>
        filePath !== parentDir && path.basename(filePath) !== dirBasename,
    })
      .on('all', (_event: string, changedPath: string) => {
        if (
          generation !== this.watchGeneration ||
          !this.watching ||
          this.watchedManager !== this.config.getExtensionManager() ||
          this.bootstrapWatcher !== bootstrapWatcher
        )
          return;
        if (path.basename(changedPath) !== dirBasename) return;
        if (!fs.existsSync(this.extensionsDir)) return;
        this.refreshState.markExtensionsChanged('extension directory created');
        queueMicrotask(() => {
          if (
            generation === this.watchGeneration &&
            this.watching &&
            this.watchedManager === this.config.getExtensionManager() &&
            this.bootstrapWatcher === bootstrapWatcher
          ) {
            this.restartWatching();
          }
        });
      })
      .on('error', (error: unknown) => {
        if (
          generation !== this.watchGeneration ||
          !this.watching ||
          this.watchedManager !== this.config.getExtensionManager() ||
          this.bootstrapWatcher !== bootstrapWatcher
        )
          return;
        this.watcherHealthy = false;
        debugLogger.warn('Extension bootstrap watcher error:', error);
      });
    this.bootstrapWatcher = bootstrapWatcher;
  }

  private getRefreshAction(
    event: WatchEvent,
    changedPath: string,
  ): RefreshAction | false {
    if (changedPath === path.resolve(this.storeStatePath)) {
      const generation = this.readStoreGeneration();
      if (generation !== undefined) {
        this.markStoreGenerationChanged(generation, true);
      } else {
        this.refreshState.markExtensionsChanged(
          'extension store generation changed',
        );
      }
      return false;
    }
    if (this.staleFiles.has(changedPath)) {
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
    for (const extension of this.config.getActiveExtensions()) {
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
    this.watchedManager = manager;
    const generation = this.watchGeneration;
    this.mutationListenerDisposer = manager.addMutationListener(
      (event: ExtensionMutationEvent) => {
        if (
          generation !== this.watchGeneration ||
          !this.watching ||
          this.watchedManager !== this.config.getExtensionManager()
        )
          return;
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
    closeFileWatcher(bootstrapWatcher).catch((error: unknown) => {
      debugLogger.warn('Extension bootstrap watcher close error:', error);
    });
  }

  private startGenerationPolling(): void {
    if (this.generationPoller) clearInterval(this.generationPoller);
    this.pollStoreGeneration();
    const generation = this.watchGeneration;
    this.generationPoller = setInterval(() => {
      if (generation === this.watchGeneration) this.pollStoreGeneration();
    }, 30_000);
    this.generationPoller.unref?.();
  }

  private pollStoreGeneration(): void {
    if (
      !this.watching ||
      this.watchedManager !== this.config.getExtensionManager()
    )
      return;
    const generation = this.readStoreGeneration();
    if (generation === undefined) return;
    this.markStoreGenerationChanged(generation);
  }

  private markStoreGenerationChanged(generation: number, force = false): void {
    const previous = this.observedStoreGeneration;
    // First observed generation — establish baseline without firing a change
    // notification. On a fresh install, state.json doesn't exist yet so the
    // baseline is undefined; the store then writes generation:0 and the next
    // poll sees undefined→0. That transition is baseline establishment, not
    // a real extension change (see #7029).
    if (previous === undefined) {
      this.observedStoreGeneration = generation;
      return;
    }
    if (!force && previous === generation) return;
    if (this.refreshState.isSuppressed()) return;
    const marked = this.refreshState.markExtensionsChanged(
      'extension store generation changed',
    );
    if (marked || this.refreshState.needsExtensionRefresh()) {
      this.observedStoreGeneration = generation;
    }
  }

  private readStoreGeneration(): number | undefined {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.storeStatePath, 'utf8'),
      ) as { generation?: unknown };
      return typeof parsed.generation === 'number'
        ? parsed.generation
        : undefined;
    } catch {
      return undefined;
    }
  }
}
