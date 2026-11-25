/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// oxlint-disable-next-line no-restricted-imports
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createFileWatcher } from '../../file-watcher/fileWatcher.js';
import {
  createUserResourcePaths,
  type UserResourcePathOptions,
} from '../paths/resourcePaths.js';
import {
  ResourceWatchBridge,
  type WatchTarget,
} from '../watch/resourceWatchBridge.js';
import {
  SkillResource,
  cloneSkillDefinition,
  normalizeSkillCandidates,
} from '../kinds/skills/skillResource.js';
import { SKILL_SCAN_IGNORED_DIRS } from '../kinds/skills/skillLoader.js';
import {
  isUserCompatibilityCandidate,
  UserSkillProvider,
} from '../kinds/skills/providers/userSkillProvider.js';
import type {
  SkillDirectorySet,
  SkillProviderContribution,
} from '../kinds/skills/providers/skillProvider.js';
import type { SkillDefinition, SkillLoadError } from '../kinds/skills/types.js';
import { AgentResource } from '../kinds/agents/agentResource.js';
import { UserAgentProvider } from '../kinds/agents/providers/userAgentProvider.js';
import { OutputStyleResource } from '../kinds/outputStyles/outputStyleResource.js';
import { OutputStyleProvider } from '../kinds/outputStyles/providers/outputStyleProvider.js';
import type {
  AgentResourceView,
  OutputStyleResourceView,
  SkillResourceChangeListener,
} from './resourceViews.js';

interface UserSkillsView {
  get ready(): Promise<void>;
  getAllDiscoveredSkills(): SkillDefinition[];
  getLoadErrors(): readonly SkillLoadError[];
  onDidChange(listener: SkillResourceChangeListener): () => void;
  get watcherReady(): Promise<void>;
}

export interface UserResourceOptions extends UserResourcePathOptions {
  loadFromAgentsDirectory?: boolean;
  userAgentSkillsDirOverride?: string;
}

/** Composes user domains for the lifetime of the process-owned service. */
export class UserResource {
  private readonly paths: ReturnType<typeof createUserResourcePaths>;
  private readonly agentSkillsDir: string;
  private skillEntry?: UserSkillEntry;
  private loadFromAgentsDirectory: boolean;
  private compatibilityLoading?: Promise<void>;
  private skillReadiness?: Promise<void>;
  private readonly agentResource: AgentResource;
  private readonly outputStyleResource: OutputStyleResource;
  private readiness?: Promise<void>;
  private stopping?: Promise<void>;
  private disposed = false;
  readonly agents: AgentResourceView;
  readonly outputStyles: OutputStyleResourceView;

  constructor(options: UserResourceOptions) {
    const paths = (this.paths = createUserResourcePaths(options));
    this.agentSkillsDir = resolve(
      options.userAgentSkillsDirOverride ??
        join(options.homeDir ?? homedir(), '.agents', 'skills'),
    );
    this.loadFromAgentsDirectory = options.loadFromAgentsDirectory ?? false;
    const agentProvider = new UserAgentProvider(paths.agentsDir);
    this.agentResource = new AgentResource({
      load: () => agentProvider.load(),
      reloadMode: 'join',
    });
    const outputStyleProvider = new OutputStyleProvider(
      paths.outputStylesDir,
      'userSettings',
    );
    this.outputStyleResource = new OutputStyleResource({
      load: () => outputStyleProvider.load(),
      reloadMode: 'join',
    });
    this.agents = this.agentResource;
    this.outputStyles = this.outputStyleResource;
  }

  private initializeSkills(): Promise<void> {
    return (this.skillReadiness ??= (async () => {
      await this.skills.ready;
    })().catch((error) => {
      this.skillReadiness = undefined;
      throw error;
    }));
  }

  /** Re-reads every loaded Skill/Command set and publishes new snapshots. */
  private async reloadSkillViews(
    options: { notify?: boolean } = {},
  ): Promise<void> {
    if (this.skillEntry) await this.skillEntry.resource.reload(options);
  }

  /** Add the compatibility directory once when a session first needs it. */
  private enableCompatibilitySkills(): Promise<void> {
    const entry = this.getOrCreateSkillEntry();
    if (this.loadFromAgentsDirectory) return entry.ready;
    if (this.compatibilityLoading) return this.compatibilityLoading;
    const loading = (async () => {
      await entry.ready;
      entry.directories.agentSkillsDir = this.agentSkillsDir;
      // An earlier watcher read may have started before this source was added.
      await entry.loading?.catch(() => undefined);
      await entry.bridge.setTargets(this.createSkillWatchTargets(entry.directories));
      await entry.resource.reload({ notify: false });
      this.loadFromAgentsDirectory = true;
    })();
    this.compatibilityLoading = loading;
    void loading
      .finally(() => {
        if (this.compatibilityLoading === loading)
          this.compatibilityLoading = undefined;
      })
      .catch(() => undefined);
    return loading;
  }

  private getOrCreateSkillEntry(): UserSkillEntry {
    if (this.skillEntry) {
      if (this.skillEntry.failed) this.recoverSkillEntry(this.skillEntry);
      return this.skillEntry;
    }
    const directories: SkillDirectorySet = {
      skillsDir: this.paths.skillsDir,
      commandsDir: this.paths.commandsDir,
      agentSkillsDir: this.loadFromAgentsDirectory
        ? this.agentSkillsDir
        : undefined,
    };
    const provider = new UserSkillProvider(directories);
    const entry = {} as UserSkillEntry;
    entry.directories = directories;
    entry.provider = provider;
    entry.resource = new SkillResource({
      load: (reload) => this.readSkillEntry(entry, reload),
      reloadMode: 'join',
      retainContribution: true,
    });
    entry.bridge = this.createSkillBridge(entry);
    entry.view = {
      get ready() {
        return entry.ready;
      },
      get watcherReady() {
        return entry.watcherReady;
      },
      getAllDiscoveredSkills: () => entry.resource.getAllDiscoveredSkills(),
      getLoadErrors: () => entry.resource.getLoadErrors(),
      onDidChange: (listener) => entry.resource.onDidChange(listener),
    };
    this.skillEntry = entry;
    entry.ready = entry.resource.initialize().catch((error) => {
      this.failSkillEntry(entry, entry.bridge);
      throw error;
    });
    this.startSkillWatcher(entry);
    return entry;
  }

  private createSkillBridge(entry: UserSkillEntry): ResourceWatchBridge {
    const bridge = new ResourceWatchBridge({
      targets: this.createSkillWatchTargets(entry.directories),
      fileWatcher: createFileWatcher({
        onError: () => this.failSkillEntry(entry, bridge),
      }),
      refreshPolicies: [
        {
          kinds: ['skill', 'command'],
          debounceMs: 300,
          refresh: async (events) => {
            if (entry.bridge !== bridge || entry.stopping) return;
            await entry.loading?.catch(() => undefined);
            if (entry.bridge !== bridge || entry.stopping) return;
            await this.readSkillEntry(entry, true);
            await entry.resource.refreshFromSource(events);
          },
        },
      ],
    });
    return bridge;
  }

  private startSkillWatcher(entry: UserSkillEntry): void {
    const bridge = entry.bridge;
    entry.watcherReady = entry.bridge.start().catch((error) => {
      this.failSkillEntry(entry, bridge);
      throw error;
    });
    void entry.watcherReady.catch(() => undefined);
  }

  private failSkillEntry(
    entry: UserSkillEntry,
    bridge: ResourceWatchBridge,
  ): void {
    if (entry.bridge !== bridge || entry.failed || this.disposed) return;
    entry.failed = true;
    if (this.skillEntry === entry) {
      this.skillReadiness = undefined;
      this.readiness = undefined;
    }
    void this.stopSkillEntry(entry).catch(() => undefined);
  }

  private recoverSkillEntry(entry: UserSkillEntry): void {
    if (entry.recovering) return;
    const recovery = (async () => {
      await this.stopSkillEntry(entry);
      if (this.disposed) return;
      entry.stopping = undefined;
      entry.bridge = this.createSkillBridge(entry);
      entry.failed = false;
      this.startSkillWatcher(entry);
      // Refresh the stable view without waiting for session listeners: a new
      // Config may still be waiting for its initial resource projection.
      await entry.resource.reload({ notify: false });
    })();
    entry.recovering = recovery;
    entry.ready = recovery;
    void recovery
      .then(() => {
        if (!this.disposed) {
          void entry.resource
            .notifyDidChange(entry.resource.snapshot)
            .catch(() => undefined);
        }
      })
      .catch(() => {
        if (!this.disposed) this.failSkillEntry(entry, entry.bridge);
      })
      .finally(() => {
        if (entry.recovering === recovery) entry.recovering = undefined;
      });
  }

  private readSkillEntry(
    entry: UserSkillEntry,
    reload: boolean,
  ): Promise<SkillProviderContribution> {
    if (entry.loading) return entry.loading;
    if (!reload && entry.snapshot) return Promise.resolve(entry.snapshot);
    const loading = entry.provider.load().then((snapshot) => {
      entry.snapshot = snapshot;
      return snapshot;
    });
    entry.loading = loading;
    void loading
      .finally(() => {
        if (entry.loading === loading) entry.loading = undefined;
      })
      .catch(() => undefined);
    return loading;
  }

  private stopSkillEntry(entry: UserSkillEntry): Promise<void> {
    return (entry.stopping ??= (async () => {
      try {
        await entry.bridge.stop();
      } finally {
        await entry.watcherReady?.catch(() => undefined);
        await entry.loading?.catch(() => undefined);
      }
    })());
  }

  private createSkillWatchTargets(directories: {
    skillsDir: string;
    commandsDir: string;
    agentSkillsDir?: string;
  }): WatchTarget[] {
    const targets = [
      { kind: 'skill' as const, path: directories.skillsDir },
      { kind: 'command' as const, path: directories.commandsDir },
      ...(directories.agentSkillsDir
        ? [{ kind: 'skill' as const, path: directories.agentSkillsDir }]
        : []),
    ];
    return targets.map((target) => ({
      ...target,
      source: 'user' as const,
      logicalRoot:
        target.path === directories.agentSkillsDir
          ? dirname(dirname(target.path))
          : dirname(this.paths.root),
      signal: true,
      depth: 2,
      preferNativeRecursive: true,
      ignoredDirectoryNames: [...SKILL_SCAN_IGNORED_DIRS],
    }));
  }

  private async disposeSkills(): Promise<void> {
    const entries = this.skillEntry ? [this.skillEntry] : [];
    this.skillEntry = undefined;
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const stopped = await Promise.allSettled([
          this.stopSkillEntry(entry),
          entry.resource.dispose(),
        ]);
        const failure = stopped.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** Compare resolved paths without folding filesystem case or symlinks. */
  hasSamePaths(options: UserResourceOptions): boolean {
    const paths = createUserResourcePaths(options);
    return (
      this.paths.root === paths.root &&
      this.agentSkillsDir ===
        resolve(
          options.userAgentSkillsDirOverride ??
            join(options.homeDir ?? homedir(), '.agents', 'skills'),
        )
    );
  }

  initialize(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error('UserResource is disposed'));
    return (this.readiness ??= (async () => {
      await Promise.all([
        this.initializeSkills(),
        this.agentResource.initialize(),
        this.outputStyleResource.initialize(),
      ]);
    })().catch((error) => {
      this.readiness = undefined;
      throw error;
    }));
  }
  get ready(): Promise<void> {
    return this.initialize();
  }
  get skills(): UserSkillsView {
    if (this.disposed) throw new Error('UserResource is disposed');
    return this.getOrCreateSkillEntry().view;
  }
  /** Select compatibility candidates for this session without duplicating I/O. */
  getSkills(options: { loadFromAgentsDirectory: boolean }): UserSkillsView {
    const raw = this.skills;
    const entry = this.skillEntry!;
    if (options.loadFromAgentsDirectory) {
      const ready = this.enableCompatibilitySkills();
      return {
        get ready() { return ready; },
        get watcherReady() { return ready.then(() => raw.watcherReady); },
        getAllDiscoveredSkills: () => raw.getAllDiscoveredSkills(),
        getLoadErrors: () => raw.getLoadErrors(),
        onDidChange: (listener) => raw.onDidChange(listener),
      };
    }
    const withoutCompatibility = <T extends SkillDefinition | SkillLoadError>(
      candidates: readonly T[],
    ): T[] => candidates.filter((candidate) => !isUserCompatibilityCandidate(candidate));
    const regularSkills = () => {
      const committed = entry.resource.getCommittedContribution();
      if (!committed) return withoutCompatibility(raw.getAllDiscoveredSkills());
      if (entry.regularContribution !== committed) {
        entry.regularContribution = committed;
        entry.regularSkills = normalizeSkillCandidates(
          withoutCompatibility(committed.skills),
          'user',
        );
      }
      return entry.regularSkills!.map(cloneSkillDefinition);
    };
    const isCompatibilityEvent = (event: { path: string }) => {
      const path = resolve(event.path);
      return path === this.agentSkillsDir || path.startsWith(this.agentSkillsDir + sep);
    };
    return {
      get ready() { return raw.ready; },
      get watcherReady() { return raw.watcherReady; },
      getAllDiscoveredSkills: regularSkills,
      getLoadErrors: () => withoutCompatibility(raw.getLoadErrors()),
      onDidChange: (listener) => raw.onDidChange((events, snapshot) => {
        const visibleEvents = events?.filter((event) => !isCompatibilityEvent(event));
        if (events && visibleEvents?.length === 0) return;
        return listener(visibleEvents, {
          discoveredSkills: regularSkills(),
          loadErrors: withoutCompatibility(snapshot.loadErrors),
        });
      }),
    };
  }
  reloadSkills(options: { notify?: boolean } = {}): Promise<void> {
    return this.reloadSkillViews(options);
  }
  reloadAgents(): Promise<void> {
    return this.agentResource.reload();
  }
  reloadOutputStyles(): Promise<void> {
    return this.outputStyleResource.reload();
  }
  get watcherReady(): Promise<void> {
    return this.skillEntry?.watcherReady ?? Promise.resolve();
  }
  private stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      const results = await Promise.allSettled([
        this.agentResource.dispose(),
        this.outputStyleResource.dispose(),
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })());
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([
      this.disposeSkills(),
      this.stop(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

interface UserSkillEntry {
  directories: SkillDirectorySet;
  provider: UserSkillProvider;
  resource: SkillResource;
  bridge: ResourceWatchBridge;
  view: UserSkillsView;
  ready: Promise<void>;
  watcherReady: Promise<void>;
  snapshot?: SkillProviderContribution;
  regularContribution?: SkillProviderContribution;
  regularSkills?: SkillDefinition[];
  loading?: Promise<SkillProviderContribution>;
  stopping?: Promise<void>;
  recovering?: Promise<void>;
  failed?: boolean;
}
