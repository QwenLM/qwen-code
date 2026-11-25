/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadAgentsFromPath } from '../../agents/registry/agentLoader.js';
import { loadPluginCommands } from '../loadPluginCommands.js';
import { walkPluginMarkdown } from './walkPluginMarkdown.js';
import { loadSkillFromFile } from '@qwen-code/resource';
import type { LoadedPlugin } from '../types.js';
import { getErrorMessage } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';

export interface PluginSkillInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface PluginAgentInfo {
  name: string;
  description?: string;
  color?: string;
}

export interface PluginMcpServerInfo {
  name: string;
  description?: string;
  type?: string;
}

export interface PluginCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface PluginHookInfo {
  event: string;
  matcher?: string;
  type: string;
}

export interface PluginResources {
  skills: PluginSkillInfo[];
  agents: PluginAgentInfo[];
  mcpServers: PluginMcpServerInfo[];
  commands: PluginCommandInfo[];
  hooks: PluginHookInfo[];
}

export async function collectPluginResources(
  plugin: LoadedPlugin,
): Promise<PluginResources> {
  const [skills, agents, mcpServers, commands, hooks] = await Promise.all([
    collectResourceSafely(plugin, 'skills', () => collectSkills(plugin)),
    collectResourceSafely(plugin, 'agents', () => collectAgents(plugin)),
    collectResourceSafely(plugin, 'mcpServers', () =>
      collectMcpServers(plugin),
    ),
    collectResourceSafely(plugin, 'commands', () => collectCommands(plugin)),
    collectResourceSafely(plugin, 'hooks', () => collectHooks(plugin)),
  ]);

  return {
    skills,
    agents,
    mcpServers,
    commands,
    hooks,
  };
}

/**
 * Resource inventory is a best-effort projection of an already loaded plugin.
 * A broken component must not hide the plugin or its healthy components from
 * list consumers such as the SDK control protocol.
 */
async function collectResourceSafely<T>(
  plugin: LoadedPlugin,
  resourceType: keyof PluginResources,
  collect: () => T[] | Promise<T[]>,
): Promise<T[]> {
  try {
    return await collect();
  } catch (error) {
    runLogger.warn(
      `[Plugin Resource Collector] Failed to collect ${resourceType} for plugin "${plugin.name}": ${getErrorMessage(error)}`,
    );
    return [];
  }
}

async function collectSkills(plugin: LoadedPlugin): Promise<PluginSkillInfo[]> {
  const dirs = [
    ...(plugin.skillsPath ? [plugin.skillsPath] : []),
    ...(plugin.skillsPaths ?? []),
  ];
  if (dirs.length === 0) return [];

  const results: PluginSkillInfo[] = [];

  for (const dir of dirs) {
    await walkPluginMarkdown(dir, async (filePath) => {
      if (!filePath.toLowerCase().endsWith('skill.md')) return;
      try {
        const skill = await loadSkillFromFile(filePath);
        if (skill) {
          results.push({
            name: skill.displayName ?? skill.name,
            description: skill.description,
            argumentHint: skill.argumentHint,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }, { stopAtSkillDir: true });
  }

  return results;
}

async function collectAgents(plugin: LoadedPlugin): Promise<PluginAgentInfo[]> {
  const sources = [
    ...(plugin.agentsPath ? [plugin.agentsPath] : []),
    ...(plugin.agentsPaths ?? []),
  ];
  if (sources.length === 0) return [];

  const results: PluginAgentInfo[] = [];

  for (const sourcePath of sources) {
    const loadResult = await loadAgentsFromPath(sourcePath, {
      pluginName: plugin.name,
    });
    if (!loadResult) continue;
    for (const agent of loadResult.agents) {
      results.push({
        name: agent.name,
        description: agent.description,
        color: agent.color,
      });
    }
  }

  return results;
}

function collectMcpServers(plugin: LoadedPlugin): PluginMcpServerInfo[] {
  if (!plugin.mcpServers) return [];

  return Object.entries(plugin.mcpServers).map(([name, config]) => ({
    name,
    description: config.description,
    type: config.type ?? 'stdio',
  }));
}

function collectCommands(plugin: LoadedPlugin): PluginCommandInfo[] {
  const commands = loadPluginCommands(plugin);
  return commands.map((cmd) => ({
    name: cmd.name,
    description: cmd.description || undefined,
    argumentHint: cmd.argumentHint,
  }));
}

function collectHooks(plugin: LoadedPlugin): PluginHookInfo[] {
  const hooksConfig: unknown = plugin.hooksConfig;
  if (
    !hooksConfig ||
    typeof hooksConfig !== 'object' ||
    Array.isArray(hooksConfig)
  ) {
    return [];
  }

  const results: PluginHookInfo[] = [];

  for (const [event, definitions] of Object.entries(hooksConfig)) {
    if (!Array.isArray(definitions)) continue;
    for (const def of definitions) {
      if (!def || typeof def !== 'object') continue;

      const { hooks, matcher } = def as {
        hooks?: unknown;
        matcher?: unknown;
      };
      if (!Array.isArray(hooks)) continue;

      for (const hook of hooks) {
        if (
          !hook ||
          typeof hook !== 'object' ||
          !('type' in hook) ||
          typeof hook.type !== 'string'
        ) {
          continue;
        }
        results.push({
          event,
          matcher: typeof matcher === 'string' ? matcher : undefined,
          type: hook.type,
        });
      }
    }
  }

  return results;
}
