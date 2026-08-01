/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDebugLogger,
  type Config,
  type Extension,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('EXTENSION_RUNTIME_RELOAD');

export interface ReloadPluginsSummary {
  extensionCount: number;
  commandCount: number;
  skillCount: number;
  agentCount: number;
  hookCount: number;
  mcpServerCount: number;
  lspServerCount: number;
}

export async function reloadPluginsRuntime(options: {
  config: Config;
  reloadCommands?: () => void | Promise<void>;
}): Promise<ReloadPluginsSummary> {
  if (options.config.isSafeMode()) {
    throw new Error('Extension reload is disabled in safe mode.');
  }
  const manager = options.config.getExtensionManager();
  await manager.refreshCache();
  await manager.refreshTools();
  await options.reloadCommands?.();
  return summarizeExtensions(options.config.getActiveExtensions());
}

export async function refreshExtensionContentRuntime(options: {
  config: Config;
  reloadCommands?: () => void | Promise<void>;
}): Promise<void> {
  if (options.config.isSafeMode()) return;

  const manager = options.config.getExtensionManager();
  const errors: unknown[] = [];
  try {
    await manager.refreshCache();
  } catch (error) {
    errors.push(error);
    debugLogger.warn(
      'refreshExtensionContentRuntime: refreshCache failed:',
      error,
    );
  }

  const settled = await Promise.allSettled([
    options.config.getSkillManager()?.refreshCache(),
    options.config.getSubagentManager()?.refreshCache(),
    options.reloadCommands?.(),
  ]);

  for (const result of settled) {
    if (result.status === 'rejected') {
      errors.push(result.reason);
      debugLogger.warn(
        'refreshExtensionContentRuntime: a refresh leg failed:',
        result.reason,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      errors
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join('; '),
    );
  }
}

function summarizeExtensions(extensions: Extension[]): ReloadPluginsSummary {
  return extensions.reduce<ReloadPluginsSummary>(
    (summary, extension) => {
      summary.extensionCount++;
      summary.commandCount += extension.commands?.length ?? 0;
      summary.skillCount += extension.skills?.length ?? 0;
      summary.agentCount += extension.agents?.length ?? 0;
      summary.hookCount += countHooks(extension);
      summary.mcpServerCount += Object.keys(extension.mcpServers ?? {}).length;
      summary.lspServerCount += countLspServers(extension);
      return summary;
    },
    {
      extensionCount: 0,
      commandCount: 0,
      skillCount: 0,
      agentCount: 0,
      hookCount: 0,
      mcpServerCount: 0,
      lspServerCount: 0,
    },
  );
}

function countHooks(extension: Extension): number {
  return Object.values(extension.hooks ?? {}).reduce(
    (sum, definitions) =>
      sum +
      (definitions ?? []).reduce(
        (innerSum, definition) => innerSum + (definition.hooks?.length ?? 0),
        0,
      ),
    0,
  );
}

function countLspServers(extension: Extension): number {
  const lspServers = extension.config.lspServers;
  if (!lspServers) return 0;
  if (typeof lspServers === 'string') return 1;
  return Object.keys(lspServers).length;
}
