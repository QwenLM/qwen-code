/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import { UserResource, type UserResourceOptions } from './userResource.js';
import {
  createFileWatcher,
  type FileWatcher,
} from '../../file-watcher/fileWatcher.js';
import { SKILL_SCAN_IGNORED_DIRS } from '../kinds/skills/skillLoader.js';
import { createProjectResourcePaths } from '../paths/resourcePaths.js';
import {
  ProjectResource,
  type ProjectResourceOptions,
} from './projectResource.js';

export interface ResourceHandle {
  readonly project: ProjectResource;
  /** Resolves once this context's project scope has loaded. */
  readonly ready: Promise<void>;
  /** Resolves once the project watcher is ready; rejects on failure. */
  readonly watcherReady: Promise<void>;
  isForContext(options: ProjectResourceOptions): boolean;
  release(): Promise<void>;
}

interface ResourceEntry {
  project: ProjectResource;
  shared: boolean;
  users: number;
  unwatch: Array<() => void>;
  disposal?: Promise<void>;
}

function contextKey(options: ProjectResourceOptions): string {
  // Resolve paths without folding case: case sensitivity is filesystem-specific.
  const directory = (value: string | undefined) =>
    value === undefined ? undefined : resolve(value);
  return JSON.stringify({
    cwd: directory(options.cwd),
    homeDir: directory(options.homeDir),
    configDirName: options.configDirName,
    projectConfigDirOverride: directory(options.projectConfigDirOverride),
    projectAgentSkillsDirOverride: directory(
      options.projectAgentSkillsDirOverride,
    ),
    // Preserve directory precedence: later roots can override earlier Skills.
    additionalDirectories: options.additionalDirectories
      ? [...new Set(options.additionalDirectories.map((dir) => resolve(dir)))]
      : undefined,
    isTrusted: options.isTrusted,
    loadFromAgentsDirectory: options.loadFromAgentsDirectory,
    skillSources: options.skillSettings?.allowedSources,
    agentSources: options.agentSettings?.allowedSources,
  });
}

/**
 * Process-owned holder of scoped resources. The user resource is one global
 * instance bound to the startup root; project resources are cached per
 * context. Sessions own project handles; the service owns the single user
 * Skill snapshot for its entire lifetime.
 */
export class ResourceService {
  private userResource?: UserResource;
  private userResourceOptions?: Readonly<UserResourceOptions>;
  private readonly entries = new Map<string, ResourceEntry>();
  private readonly privateEntries = new Set<ResourceEntry>();
  private disposed = false;
  private cacheWatcher: FileWatcher | undefined;
  private cacheUnavailable = false;

  /** Startup preload setting; sessions may activate the shared source later. */
  get loadFromAgentsDirectory(): boolean | undefined {
    return this.userResourceOptions
      ? (this.userResourceOptions.loadFromAgentsDirectory ?? false)
      : undefined;
  }

  /** Host startup fixes one user root before any workspace is acquired. */
  async initializeUserResources(options: UserResourceOptions): Promise<void> {
    if (this.disposed) throw new Error('ResourceService is disposed');
    if (this.userResource && !this.userResource.hasSamePaths(options))
      throw new Error(
        'ResourceService user configuration root is already fixed',
      );
    this.bindUserResourceOptions(options);
    await this.resolveUserResource().initialize();
  }

  /**
   * The process-global user resource; independent of any workspace context.
   * Embedded consumers may pass user options on the first call to bind the
   * root lazily; later calls with a different root are rejected.
   */
  getUserResource(options?: UserResourceOptions): UserResource {
    if (this.disposed) throw new Error('ResourceService is disposed');
    if (options) {
      if (this.userResource && !this.userResource.hasSamePaths(options))
        throw new Error(
          'ResourceService user configuration root is already fixed',
        );
      this.bindUserResourceOptions(options);
    }
    return this.resolveUserResource();
  }

  /** Capture user resource options independently of later workspace options. */
  private bindUserResourceOptions(options: UserResourceOptions): void {
    this.userResourceOptions ??= {
      homeDir: options.homeDir,
      configDirName: options.configDirName,
      globalConfigDirOverride: options.globalConfigDirOverride,
      userAgentSkillsDirOverride: options.userAgentSkillsDirOverride,
      loadFromAgentsDirectory: options.loadFromAgentsDirectory,
    };
  }

  private resolveUserResource(): UserResource {
    if (!this.userResourceOptions)
      throw new Error('ResourceService user configuration is not initialized');
    return (this.userResource ??= new UserResource(this.userResourceOptions));
  }

  /** Returns this session's handle to the shared or isolated project scope. */
  getProjectResource(options: ProjectResourceOptions): ResourceHandle {
    if (this.disposed) throw new Error('ResourceService is disposed');
    const key = contextKey(options);
    const shared = !options.fileWatcher && !this.cacheUnavailable;
    let entry = shared ? this.entries.get(key) : undefined;
    if (!entry) {
      const watcherState = {
        entry: undefined as ResourceEntry | undefined,
        failed: false,
      };
      const invalidate = () => {
        watcherState.failed = true;
        const failedEntry = watcherState.entry;
        if (failedEntry) this.invalidateEntry(key, failedEntry);
      };
      const project = new ProjectResource(
        shared
          ? {
              ...options,
              fileWatcher: createFileWatcher({
                onError: invalidate,
              }),
            }
          : options,
      );
      entry = {
        project,
        shared,
        users: 1,
        unwatch: [],
      };
      if (shared) this.entries.set(key, entry);
      else this.privateEntries.add(entry);
      const created = entry;
      watcherState.entry = created;
      if (shared) {
        // Cache invalidation is passive; polling avoids per-file OS watch limits.
        this.cacheWatcher ??= createFileWatcher({
          usePolling: true,
          onError: () => this.disableCache(),
        });
        const paths = createProjectResourcePaths(options);
        // These domains refresh explicitly. Invalidate only future acquisitions;
        // never change an active session's output style or agent snapshot here.
        for (const target of [
          paths.project.agentsDir,
          paths.project.outputStylesDir,
        ]) {
          created.unwatch.push(
            this.cacheWatcher.watch(
              {
                path: target,
                recursive: true,
                logicalRoot: resolve(target, '..'),
                ignoredDirectoryNames: [...SKILL_SCAN_IGNORED_DIRS],
              },
              () => this.invalidateEntry(key, created),
            ),
          );
        }
        void this.cacheWatcher.start().catch(() => this.disableCache());
        if (this.cacheWatcher.isNoop) this.disableCache();
        if (watcherState.failed) this.invalidateEntry(key, created);
        void created.project.watcherReady.catch(() =>
          this.invalidateEntry(key, created),
        );
      }
      void created.project.ready.catch(() =>
        this.invalidateEntry(key, created),
      );
    } else {
      entry.users++;
    }
    const current = entry;
    let released = false;
    return {
      project: current.project,
      // Lazy so unobserved reads never surface as unhandled rejections; the
      // underlying promises are memoized by the project resource.
      get ready() {
        return current.project.ready;
      },
      get watcherReady() {
        return current.project.watcherReady;
      },
      isForContext: (nextOptions) =>
        !released && contextKey(nextOptions) === key,
      release: async () => {
        if (released) return;
        released = true;
        current.users--;
        if (!shared || this.entries.get(key) !== current) {
          if (current.users === 0) {
            this.privateEntries.delete(current);
            this.detachWatches(current);
            await this.disposeEntry(current);
          }
        }
      },
    };
  }

  private invalidateEntry(key: string, entry: ResourceEntry): void {
    if (entry.disposal) return;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    this.privateEntries.add(entry);
    this.detachWatches(entry);
    if (entry.users === 0) {
      this.privateEntries.delete(entry);
      void this.disposeEntry(entry).catch(() => undefined);
    }
  }

  private disableCache(): void {
    this.cacheUnavailable = true;
    for (const [key, entry] of this.entries) this.invalidateEntry(key, entry);
  }

  private detachWatches(entry: ResourceEntry): void {
    for (const unwatch of entry.unwatch.splice(0)) {
      try {
        unwatch();
      } catch {
        // Attempt every detach even if a backend registration is already broken.
      }
    }
  }

  private disposeEntry(entry: ResourceEntry): Promise<void> {
    entry.disposal ??= (async () => {
      this.detachWatches(entry);
      await entry.project.dispose();
    })();
    return entry.disposal;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values(), ...this.privateEntries];
    this.entries.clear();
    for (const entry of entries) {
      this.detachWatches(entry);
      // General cleanup can precede session hooks/Config.dispose. Active handles
      // keep their resources until their session releases them.
      if (entry.users > 0) this.privateEntries.add(entry);
      else this.privateEntries.delete(entry);
    }
    const results = await Promise.allSettled([
      this.cacheWatcher?.stop(),
      this.userResource?.dispose(),
      ...entries
        .filter((entry) => entry.users === 0)
        .map((entry) => this.disposeEntry(entry)),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
