/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { getConfigHomeDir } from '../utils/paths.js';
import {
  parseWorkflowMetaCached,
  readWorkflowScriptFileCached,
} from './workflow-script-cache.js';
import {
  getProjectWorkflowsDir,
  getUserWorkflowsDir,
  getUserWorkflowsDirFromConfigRoot,
} from './workflow-storage.js';
import { BUILT_IN_WORKFLOWS } from './workflow-builtins.js';
import type {
  ResolvedWorkflowScript,
  WorkflowMeta,
  WorkflowRegistryDiagnostic,
  WorkflowRegistryEntry,
  WorkflowRegistryListResult,
  WorkflowRegistrySource,
} from './workflow-types.js';

export interface WorkflowRegistryInlineDefinition {
  disableModelInvocation?: boolean | (() => boolean);
  script: string;
  scriptPath?: string;
  sourceId?: string;
}

export interface WorkflowRegistryPluginDefinition {
  pluginName: string;
  pluginManifest?: unknown;
  pluginRepository?: string;
  pluginPath?: string;
  workflows: WorkflowRegistryInlineDefinition[];
  workflowPaths?: string[];
  workflowsDir?: string;
}

export interface WorkflowRegistryOptions {
  allowedSources?: WorkflowRegistrySource[];
  projectRoot: string;
  homeDir?: string;
  userConfigRoot?: string;
  builtInWorkflows?: WorkflowRegistryInlineDefinition[];
  pluginWorkflows?: WorkflowRegistryPluginDefinition[];
}

interface WorkflowRegistryCandidate {
  entry: WorkflowRegistryEntry;
  script: string;
  scriptPath?: string;
}

export interface WorkflowRegistryConfigHost {
  isAgentSourceAllowed?: (source: 'project' | 'user') => boolean;
  getSessionArtifactProjectRoot(): string;
  getEnabledPlugins?: () => Array<{
    name: string;
    path: string;
    enabled?: boolean;
    workflowsPath?: string;
    workflowsPaths?: string[];
    repository?: string;
    manifest?: {
      workflowsPath?: string;
      workflowsPaths?: string[];
      [key: string]: unknown;
    };
  }>;
}

export function createWorkflowRegistryFromConfig(
  config: WorkflowRegistryConfigHost,
): WorkflowRegistry {
  return new WorkflowRegistry({
    projectRoot: config.getSessionArtifactProjectRoot(),
    allowedSources: (['project', 'user', 'plugin', 'built-in'] as const).filter(source =>
      source === 'plugin' || source === 'built-in' || config.isAgentSourceAllowed?.(source) !== false),
    builtInWorkflows: BUILT_IN_WORKFLOWS,
    pluginWorkflows: discoverPluginWorkflowSources(config),
  });
}

export class WorkflowRegistry {
  static createDefault(projectRoot: string, homeDir?: string) {
    return new WorkflowRegistry({
      projectRoot,
      ...(homeDir === undefined ? {} : { homeDir }),
      builtInWorkflows: BUILT_IN_WORKFLOWS,
    });
  }

  constructor(private readonly options: WorkflowRegistryOptions) {}

  async resolve(name: string): Promise<ResolvedWorkflowScript> {
    if (!/^[a-zA-Z0-9._:-]+$/.test(name)) {
      throw new Error(
        'Workflow name may only contain letters, numbers, dot, underscore, dash, and colon',
      );
    }

    const { candidates, diagnostics } = await this.loadCandidates();
    const candidate = candidates.find((item) => item.entry.name === name);
    if (!candidate) {
      const locations = [
        getProjectWorkflowsDir(this.options.projectRoot),
        this.getUserWorkflowsDir(),
      ];
      const diagnosticSuffix =
        diagnostics.length > 0
          ? ` Invalid workflow diagnostics: ${diagnostics
              .map(
                (item) =>
                  `${item.scriptPath ?? item.name ?? item.source}: ${item.message}`,
              )
              .join('; ')}`
          : '';
      throw new Error(
        `Workflow "${name}" not found in ${locations.join(', ')}.${diagnosticSuffix}`,
      );
    }
    return {
      script: candidate.script,
      source: candidate.entry.source,
      scriptPath: candidate.scriptPath,
    };
  }

  async listAvailable(): Promise<WorkflowRegistryListResult> {
    const { candidates, diagnostics } = await this.loadCandidates();
    return {
      entries: candidates.map((candidate) => candidate.entry),
      diagnostics,
    };
  }

  private async loadCandidates(): Promise<{
    candidates: WorkflowRegistryCandidate[];
    diagnostics: WorkflowRegistryDiagnostic[];
  }> {
    const diagnostics: WorkflowRegistryDiagnostic[] = [];
    const isLocalSourceAllowed = (
      source: Extract<WorkflowRegistrySource, 'project' | 'user'>,
    ) =>
      !this.options.allowedSources ||
      this.options.allowedSources.includes(source);
    const orderedGroups: WorkflowRegistryCandidate[][] = [
      !isLocalSourceAllowed('project')
        ? []
        : await this.loadFilesystemSource(
            getProjectWorkflowsDir(this.options.projectRoot),
            'project',
            diagnostics,
          ),
      !isLocalSourceAllowed('user')
        ? []
        : await this.loadFilesystemSource(
            this.getUserWorkflowsDir(),
            'user',
            diagnostics,
          ),
      ...(await this.loadPluginSources(diagnostics)),
      this.loadBuiltInSource(diagnostics),
    ];

    const candidates: WorkflowRegistryCandidate[] = [];
    const seen = new Map<string, WorkflowRegistryCandidate>();
    for (const group of orderedGroups) {
      for (const candidate of group) {
        const existing = seen.get(candidate.entry.name);
        if (existing) {
          diagnostics.push({
            source: candidate.entry.source,
            kind: 'shadowed',
            scriptPath: candidate.entry.scriptPath,
            name: candidate.entry.name,
            message: `Workflow "${candidate.entry.name}" from ${formatWorkflowLocation(
              candidate.entry,
            )} is shadowed by ${formatWorkflowLocation(existing.entry)}.`,
          });
          continue;
        }
        seen.set(candidate.entry.name, candidate);
        candidates.push(candidate);
      }
    }
    return { candidates, diagnostics };
  }

  private getUserWorkflowsDir(): string {
    if (this.options.userConfigRoot !== undefined) {
      return getUserWorkflowsDirFromConfigRoot(this.options.userConfigRoot);
    }
    if (this.options.homeDir !== undefined) {
      return getUserWorkflowsDir(this.options.homeDir);
    }
    return getUserWorkflowsDirFromConfigRoot(getConfigHomeDir());
  }

  private async loadFilesystemSource(
    workflowsDir: string,
    source: Extract<WorkflowRegistrySource, 'plugin' | 'project' | 'user'>,
    diagnostics: WorkflowRegistryDiagnostic[],
    pluginName?: string,
    pluginManifest?: unknown,
    pluginRepository?: string,
    pluginPath?: string,
  ): Promise<WorkflowRegistryCandidate[]> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(workflowsDir, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    const scriptPaths: string[] = [];
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dirent.name.startsWith('.')) continue;
      const fullPath = path.join(workflowsDir, dirent.name);
      if (dirent.isFile()) {
        if (dirent.name.endsWith('.js')) scriptPaths.push(fullPath);
      } else if (dirent.isDirectory()) {
        scriptPaths.push(path.join(fullPath, 'workflow.js'));
        scriptPaths.push(path.join(fullPath, 'index.js'));
      }
    }

    const candidates: WorkflowRegistryCandidate[] = [];
    for (const scriptPath of scriptPaths) {
      let resolved: { script: string; scriptPath: string };
      try {
        resolved = await readWorkflowScriptFileCached(
          scriptPath,
          this.options.projectRoot,
        );
      } catch (error) {
        if (isFileNotFound(error)) continue;
        diagnostics.push({
          source,
          kind: 'invalid',
          scriptPath,
          message: formatError(error),
        });
        continue;
      }
      const candidate = this.parseCandidate({
        source,
        script: resolved.script,
        scriptPath: resolved.scriptPath,
        pluginName,
        pluginManifest,
        pluginRepository,
        pluginPath,
        diagnostics,
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  private async loadFilesystemPathSource(
    workflowPath: string,
    source: Extract<WorkflowRegistrySource, 'plugin' | 'project' | 'user'>,
    diagnostics: WorkflowRegistryDiagnostic[],
    pluginName?: string,
    pluginManifest?: unknown,
    pluginRepository?: string,
    pluginPath?: string,
  ): Promise<WorkflowRegistryCandidate[]> {
    let pathStat;
    try {
      pathStat = await fs.stat(workflowPath);
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    if (pathStat.isDirectory()) {
      return this.loadFilesystemSource(
        workflowPath,
        source,
        diagnostics,
        pluginName,
        pluginManifest,
        pluginRepository,
        pluginPath,
      );
    }

    if (!pathStat.isFile()) return [];
    if (!workflowPath.endsWith('.js')) {
      diagnostics.push({
        source,
        kind: 'invalid',
        scriptPath: workflowPath,
        name: pluginName,
        message: 'Workflow file must use a .js extension',
      });
      return [];
    }

    try {
      const resolved = await readWorkflowScriptFileCached(
        workflowPath,
        this.options.projectRoot,
      );
      const candidate = this.parseCandidate({
        source,
        script: resolved.script,
        scriptPath: resolved.scriptPath,
        pluginName,
        pluginManifest,
        pluginRepository,
        pluginPath,
        diagnostics,
      });
      return candidate ? [candidate] : [];
    } catch (error) {
      diagnostics.push({
        source,
        kind: 'invalid',
        scriptPath: workflowPath,
        name: pluginName,
        message: formatError(error),
      });
      return [];
    }
  }

  private async loadPluginSources(
    diagnostics: WorkflowRegistryDiagnostic[],
  ): Promise<WorkflowRegistryCandidate[][]> {
    const groups: WorkflowRegistryCandidate[][] = [];
    for (const plugin of [...(this.options.pluginWorkflows ?? [])].sort(
      (a, b) => a.pluginName.localeCompare(b.pluginName),
    )) {
      const candidates: WorkflowRegistryCandidate[] = [];
      for (const workflow of plugin.workflows) {
        const candidate = this.parseCandidate({
          source: 'plugin',
          script: workflow.script,
          scriptPath: workflow.scriptPath,
          sourceId: workflow.sourceId,
        disableModelInvocation: typeof workflow.disableModelInvocation === 'function'
          ? workflow.disableModelInvocation() : workflow.disableModelInvocation,
          pluginName: plugin.pluginName,
          pluginManifest: plugin.pluginManifest,
          pluginRepository: plugin.pluginRepository,
          pluginPath: plugin.pluginPath,
          diagnostics,
        });
        if (candidate) candidates.push(candidate);
      }
      const workflowPaths = [
        ...(plugin.workflowPaths ?? []),
        ...(plugin.workflowsDir ? [plugin.workflowsDir] : []),
      ];
      for (const workflowPath of workflowPaths) {
        candidates.push(
          ...(await this.loadFilesystemPathSource(
            workflowPath,
            'plugin',
            diagnostics,
            plugin.pluginName,
            plugin.pluginManifest,
            plugin.pluginRepository,
            plugin.pluginPath,
          )),
        );
      }
      groups.push(candidates);
    }
    return groups;
  }

  private loadBuiltInSource(
    diagnostics: WorkflowRegistryDiagnostic[],
  ): WorkflowRegistryCandidate[] {
    const candidates: WorkflowRegistryCandidate[] = [];
    for (const workflow of this.options.builtInWorkflows ?? []) {
      const candidate = this.parseCandidate({
        source: 'built-in',
        script: workflow.script,
        scriptPath: workflow.scriptPath,
        sourceId: workflow.sourceId,
        disableModelInvocation: typeof workflow.disableModelInvocation === 'function'
          ? workflow.disableModelInvocation() : workflow.disableModelInvocation,
        diagnostics,
      });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  private parseCandidate(params: {
    disableModelInvocation?: boolean;
    source: WorkflowRegistrySource;
    script: string;
    scriptPath?: string;
    sourceId?: string;
    pluginName?: string;
    pluginManifest?: unknown;
    pluginRepository?: string;
    pluginPath?: string;
    diagnostics: WorkflowRegistryDiagnostic[];
  }): WorkflowRegistryCandidate | undefined {
    let meta: WorkflowMeta;
    try {
      // Memoized by script text. The returned meta is frozen and shared, so
      // the per-source fields below are applied around it, never onto it.
      meta = parseWorkflowMetaCached(params.script);
    } catch (error) {
      params.diagnostics.push({
        source: params.source,
        kind: 'invalid',
        scriptPath: params.scriptPath ?? params.sourceId,
        name: params.pluginName,
        message: formatError(error),
      });
      return undefined;
    }
    const name =
      params.source === 'plugin' && params.pluginName
        ? `${params.pluginName}:${meta.name}`
        : meta.name;
    return {
      script: params.script,
      scriptPath: params.scriptPath,
      entry: {
        name,
        disableModelInvocation: params.disableModelInvocation,
        source: params.source,
        scriptPath: params.scriptPath,
        scriptLength: params.script.length,
        description: meta.description,
        title: meta.title,
        whenToUse: meta.whenToUse,
        phases: meta.phases,
        inputSchema: meta.inputSchema,
        pluginName: params.pluginName,
        pluginManifest: params.pluginManifest,
        pluginRepository: params.pluginRepository,
        pluginPath: params.pluginPath,
        trustLevel: params.source,
      },
    };
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatWorkflowLocation(entry: WorkflowRegistryEntry): string {
  const source =
    entry.source === 'plugin' && entry.pluginName
      ? `plugin:${entry.pluginName}`
      : entry.source;
  return entry.scriptPath ? `${source} (${entry.scriptPath})` : source;
}

function discoverPluginWorkflowSources(
  config: WorkflowRegistryConfigHost,
): WorkflowRegistryPluginDefinition[] {
  return (config.getEnabledPlugins?.() ?? [])
    .filter((plugin) => plugin.enabled !== false)
    .map((plugin) => {
      const declaredPaths = [
        ...(plugin.workflowsPath ? [plugin.workflowsPath] : []),
        ...(plugin.workflowsPaths ?? []),
      ];
      const manifestDeclared = Boolean(
        plugin.manifest?.workflowsPath || plugin.manifest?.workflowsPaths?.length,
      );
      return {
        pluginName: plugin.name,
        pluginManifest: plugin.manifest,
        pluginRepository: plugin.repository,
        pluginPath: plugin.path,
        workflows: [],
        workflowPaths:
          declaredPaths.length > 0
            ? declaredPaths
            : manifestDeclared
              ? []
              : [path.join(plugin.path, 'workflows')],
      };
    });
}
