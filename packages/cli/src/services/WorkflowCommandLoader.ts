/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isWorkflowAuthoringAvailable,
  isWorkflowSkill,
  buildWorkflowCommandPrompt,
  type Config,
  type WorkflowRegistryEntry,
} from '@qwen-code/core';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { type ICommandLoader } from './types.js';

export class WorkflowCommandLoader implements ICommandLoader {
  constructor(private readonly config: Config | null) {}

  async loadCommands(signal: AbortSignal): Promise<SlashCommand[]> {
    if (!this.config) {
      return [];
    }
    const config = this.config;

    if (signal.aborted || !config.getSkillManager().isAdminEnabled()) return [];
    return config.getSkillManager().getDisplayableSkills()
      .filter(isWorkflowSkill)
      .map(skill => toSlashCommand(skill.workflow, config));
  }
}

function toSlashCommand(
  entry: WorkflowRegistryEntry,
  config: Config,
): SlashCommand {
  const pluginInfo = getPluginWorkflowInfo(entry, config);
  return {
    name: entry.name,
    description: formatWorkflowCommandDescription(entry),
    kind: CommandKind.WORKFLOW,
    hasUserSpecifiedDescription: true,
    whenToUse: entry.whenToUse,
    progressMessage: 'running dynamic workflow',
    contentLength: entry.scriptLength,
    source: entry.source === 'built-in' ? 'bundled' : entry.source,
    loadedFrom: workflowLoadedFrom(entry),
    workflow: {
      source: entry.source,
      pluginName: entry.pluginName,
      pluginManifest: pluginInfo.pluginManifest,
      pluginRepository: pluginInfo.pluginRepository,
      pluginPath: pluginInfo.pluginPath,
    },
    autoExecute: true,
    argumentHint: entry.inputSchema ? '<args>' : '[args]',
    action: async (_context, args) => {
      await config.getSkillManager().recordUsage(entry.name);
      const authoringAvailable =
        isWorkflowAuthoringAvailable(
          config,
          config
            .getToolRegistry()
            .getFunctionDeclarations(config.getModel())
            .flatMap((tool) => (tool.name ? [tool.name] : [])),
        );
      return {
        type: 'submit_prompt',
        content: buildWorkflowCommandPrompt(entry, args, authoringAvailable),
      };
    },
  };
}

function getPluginWorkflowInfo(
  entry: WorkflowRegistryEntry,
  config: Config,
): {
  pluginManifest?: unknown;
  pluginRepository?: string;
  pluginPath?: string;
} {
  if (entry.source !== 'plugin' || !entry.pluginName) {
    return {};
  }
  const plugin = config
    .getEnabledPlugins?.()
    .find((item) => item.name === entry.pluginName);
  return {
    pluginManifest: entry.pluginManifest ?? plugin?.manifest,
    pluginRepository: entry.pluginRepository ?? plugin?.repository,
    pluginPath: entry.pluginPath ?? plugin?.path,
  };
}

function formatWorkflowCommandDescription(
  entry: WorkflowRegistryEntry,
): string {
  return `${entry.description} (dynamic workflow)`;
}

function workflowLoadedFrom(entry: WorkflowRegistryEntry): string {
  if (entry.source === 'built-in') return 'bundled';
  if (entry.source === 'plugin') return 'plugin';
  return 'skills';
}
