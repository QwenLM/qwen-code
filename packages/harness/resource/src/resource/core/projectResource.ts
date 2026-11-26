/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
// oxlint-disable-next-line no-restricted-imports
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import type { FileWatcher } from '../../file-watcher/types.js';
import {
  createProjectResourcePaths,
  type ProjectResourcePathOptions,
} from '../paths/resourcePaths.js';
import {
  ResourceWatchBridge,
  type WatchTarget,
} from '../watch/resourceWatchBridge.js';
import { SkillResource } from '../kinds/skills/skillResource.js';
import { ProjectSkillProvider } from '../kinds/skills/providers/projectSkillProvider.js';
import type { SkillDirectorySet } from '../kinds/skills/providers/skillProvider.js';
import { SKILL_SCAN_IGNORED_DIRS } from '../kinds/skills/skillLoader.js';
import { logger } from '../kinds/skills/internal.js';
import { AgentResource } from '../kinds/agents/agentResource.js';
import { ProjectAgentProvider } from '../kinds/agents/providers/projectAgentProvider.js';
import { OutputStyleResource } from '../kinds/outputStyles/outputStyleResource.js';
import { OutputStyleProvider } from '../kinds/outputStyles/providers/outputStyleProvider.js';
import type {
  SkillDefinition,
  SkillLoadError,
  SkillSource,
} from '../kinds/skills/types.js';
import type { AgentResourceSource } from '../kinds/agents/types.js';
import type {
  SkillResourceView,
  AgentResourceView,
  OutputStyleResourceView,
} from './resourceViews.js';

export interface ResourceSkillSettings {
  allowedSources?: SkillSource[];
}

export interface ResourceAgentSettings {
  allowedSources?: Array<Extract<AgentResourceSource, 'user' | 'project'>>;
}

/** Mutable workspace state shared by file-backed resource domains. */
export interface ResourceWorkspaceContext {
  isTrusted?: boolean;
  additionalDirectories: readonly string[];
}

export interface ProjectResourceOptions extends ProjectResourcePathOptions {
  /** OS user home, used only to avoid treating cwd == home as a project source. */
  homeDir?: string;
  additionalDirectories?: readonly string[];
  isTrusted?: boolean;
  skillSettings?: ResourceSkillSettings;
  agentSettings?: ResourceAgentSettings;
  projectAgentSkillsDirOverride?: string;
  loadFromAgentsDirectory?: boolean;
  fileWatcher?: FileWatcher;
}

/** Owns workspace paths, source gates, watcher policy and domain lifetimes. */
export class ProjectResource {
  readonly skills: SkillResourceView;
  readonly agents: AgentResourceView;
  readonly outputStyles: OutputStyleResourceView;
  private readonly paths: ReturnType<typeof createProjectResourcePaths>;
  private readonly homeDir: string;
  private readonly skillResource: SkillResource;
  private readonly agentResource: AgentResource;
  private readonly outputStyleResource: OutputStyleResource;
  private readonly watcher: ResourceWatchBridge;
  private readonly skillAllowedSources: SkillSource[] | undefined;
  private readonly loadFromAgentsDirectory: boolean;
  private readonly projectAgentSkillsDirOverride: string | undefined;
  private additionalDirectories: string[];
  private isTrusted: boolean | undefined;
  private readyPromise?: Promise<void>;
  private watcherStartPromise?: Promise<void>;
  private watcherLifecyclePromise?: Promise<void>;
  private disposed = false;

  constructor(options: ProjectResourceOptions) {
    const paths = (this.paths = createProjectResourcePaths(options));
    const homeDir = (this.homeDir = resolve(options.homeDir ?? homedir()));
    const allowedAgents = options.agentSettings?.allowedSources
      ? [...options.agentSettings.allowedSources]
      : undefined;
    this.skillAllowedSources = options.skillSettings?.allowedSources
      ? [...options.skillSettings.allowedSources]
      : undefined;
    this.loadFromAgentsDirectory = options.loadFromAgentsDirectory ?? false;
    this.projectAgentSkillsDirOverride = options.projectAgentSkillsDirOverride;
    this.additionalDirectories = normalizeDirectories(
      options.additionalDirectories ?? [],
    );
    this.isTrusted = options.isTrusted;

    this.skillResource = new SkillResource({
      load: async () => ({
        source: 'project',
        ...(await this.loadProjectSkills()),
      }),
      reloadMode: 'queue',
      disposedError: 'ProjectResource is disposed',
    });
    this.agentResource = new AgentResource({
      load: async () => {
        if (
          (!allowedAgents || allowedAgents.includes('project')) &&
          this.isTrusted &&
          normalizeRealPath(paths.cwd) !== normalizeRealPath(homeDir) &&
          paths.project.agentsDir
        ) {
          return new ProjectAgentProvider(paths.project.agentsDir).load();
        }
        return { source: 'project', agents: [], loadErrors: [] };
      },
      reloadMode: 'queue',
      disposedError: 'ProjectResource is disposed',
    });
    this.outputStyleResource = new OutputStyleResource({
      load: (configDirOverride) =>
        new OutputStyleProvider(
          configDirOverride
            ? join(resolve(configDirOverride), 'output-styles')
            : paths.project.outputStylesDir,
          'projectSettings',
        ).load(),
      reloadMode: 'queue',
      disposedError: 'ProjectResource is disposed',
    });
    this.skills = this.skillResource;
    this.agents = this.agentResource;
    this.outputStyles = this.outputStyleResource;
    this.watcher = new ResourceWatchBridge({
      targets: this.createSkillWatchTargets(),
      fileWatcher: options.fileWatcher,
      refreshPolicies: [
        {
          kinds: ['skill', 'command'],
          debounceMs: 300,
          refresh: async (events) => {
            await this.skillResource.reload({ events });
          },
        },
      ],
    });
  }

  get ready(): Promise<void> {
    return (this.readyPromise ??= this.initialize());
  }
  get watcherReady(): Promise<void> {
    return this.ready.then(() => this.watcherStartPromise ?? Promise.resolve());
  }
  /** Update mutable context; callers reload the affected domain snapshots. */
  async updateWorkspaceContext(
    context: ResourceWorkspaceContext,
  ): Promise<void> {
    this.isTrusted = context.isTrusted;
    const nextDirectories = normalizeDirectories(context.additionalDirectories);
    if (sameDirectories(this.additionalDirectories, nextDirectories)) return;
    this.additionalDirectories = nextDirectories;
    await this.watcher.setTargets(this.createSkillWatchTargets());
  }
  reloadSkills(options: { notify?: boolean } = {}): Promise<void> {
    return this.skillResource.reload(options);
  }
  reloadAgents(): Promise<void> {
    return this.agentResource.reload();
  }
  reloadOutputStyles(
    options: { projectConfigDirOverride?: string } = {},
  ): Promise<void> {
    return this.outputStyleResource.reload({
      configDirOverride: options.projectConfigDirOverride,
    });
  }
  private async initialize(): Promise<void> {
    await Promise.all([
      this.skillResource.initialize(),
      this.agentResource.initialize(),
      this.outputStyleResource.initialize(),
    ]);
    if (!this.disposed) this.startWatcher();
  }
  private startWatcher(): void {
    if (this.disposed || this.watcherStartPromise) return;
    this.watcherStartPromise = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        if (this.disposed) {
          resolve();
          return;
        }
        void this.watcher.start().then(resolve, reject);
      });
    });
    this.watcherLifecyclePromise = this.watcherStartPromise.catch(
      () => undefined,
    );
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([
      this.watcher.stop(),
      this.skillResource.dispose(),
      this.agentResource.dispose(),
      this.outputStyleResource.dispose(),
    ]);
    await this.watcherLifecyclePromise;
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private async loadProjectSkills(): Promise<{
    skills: SkillDefinition[];
    loadErrors: SkillLoadError[];
  }> {
    const isSourceAllowed = (source: SkillSource): boolean =>
      !this.skillAllowedSources || this.skillAllowedSources.includes(source);

    if (!isSourceAllowed('project')) {
      return { skills: [], loadErrors: [] };
    }
    if (!this.isTrusted) {
      logger.debug('Workspace skills disabled because folder is not trusted.');
      return { skills: [], loadErrors: [] };
    }

    const projectDirectories: SkillDirectorySet[] = [];
    if (this.isWorkspaceHomeDir()) {
      logger.debug(
        'Skipping project skills because cwd is the home directory.',
      );
    } else {
      projectDirectories.push(this.buildProjectSkillDirectorySet());
    }
    projectDirectories.push(...this.buildAdditionalSkillDirectorySets());
    if (projectDirectories.length === 0) {
      return { skills: [], loadErrors: [] };
    }
    const contribution = await new ProjectSkillProvider(
      projectDirectories,
    ).load();
    return {
      skills: contribution.skills,
      loadErrors: contribution.loadErrors,
    };
  }

  private buildProjectSkillDirectorySet(): SkillDirectorySet {
    return {
      skillsDir: this.paths.project.skillsDir,
      commandsDir: this.paths.project.commandsDir,
      agentSkillsDir: this.resolveAgentSkillsDir(
        this.projectAgentSkillsDirOverride,
        this.paths.cwd,
      ),
    };
  }

  private buildAdditionalSkillDirectorySets(): SkillDirectorySet[] {
    return this.additionalDirectories.map((directory) => ({
      skillsDir: join(directory, this.paths.configDirName, 'skills'),
      commandsDir: join(directory, this.paths.configDirName, 'commands'),
      agentSkillsDir: this.resolveAgentSkillsDir(undefined, directory),
    }));
  }

  private createSkillWatchTargets(): WatchTarget[] {
    const project = this.buildProjectSkillDirectorySet();
    const projectRoot = this.paths.cwd;
    const targets: WatchTarget[] = [
      {
        kind: 'skill',
        source: 'project',
        path: project.skillsDir,
        logicalRoot: projectRoot,
        signal: true,
      },
      {
        kind: 'command',
        source: 'project',
        path: project.commandsDir,
        logicalRoot: projectRoot,
        signal: true,
      },
    ];

    addAgentSkillWatchTarget(
      targets,
      'project',
      project.agentSkillsDir,
      projectRoot,
    );

    for (const directorySet of this.buildAdditionalSkillDirectorySets()) {
      const additionalRoot = dirname(dirname(directorySet.skillsDir));
      targets.push(
        {
          kind: 'skill',
          source: 'project',
          path: directorySet.skillsDir,
          logicalRoot: additionalRoot,
          signal: true,
        },
        {
          kind: 'command',
          source: 'project',
          path: directorySet.commandsDir,
          logicalRoot: additionalRoot,
          signal: true,
        },
      );
      addAgentSkillWatchTarget(
        targets,
        'project',
        directorySet.agentSkillsDir,
        additionalRoot,
      );
    }

    return targets.map((target) => ({
      ...target,
      depth: 2,
      preferNativeRecursive: true,
      ignoredDirectoryNames: [...SKILL_SCAN_IGNORED_DIRS],
    }));
  }

  private resolveAgentSkillsDir(
    override: string | undefined,
    root: string,
  ): string | undefined {
    if (!this.loadFromAgentsDirectory) return undefined;
    return override ?? join(root, '.agents', 'skills');
  }

  private isWorkspaceHomeDir(): boolean {
    return (
      normalizeRealPath(this.paths.cwd) === normalizeRealPath(this.homeDir)
    );
  }
}

function addAgentSkillWatchTarget(
  targets: WatchTarget[],
  source: 'user' | 'project',
  path: string | undefined,
  logicalRoot: string,
): void {
  if (path) {
    targets.push({ kind: 'skill', source, path, logicalRoot, signal: true });
  }
}

function normalizeRealPath(path: string): string {
  try {
    return normalize(realpathSync.native(path));
  } catch {
    return normalize(resolve(path));
  }
}

function normalizeDirectories(directories: readonly string[]): string[] {
  return [...new Set(directories.map((directory) => resolve(directory)))];
}

function sameDirectories(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((directory, index) => directory === right[index])
  );
}
