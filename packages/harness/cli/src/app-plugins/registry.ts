/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** 应用扩展直接由 AppFramework 持有的 Registry 提供，不维护模块级插件列表。 */
import {
  BuiltinPluginRegistry,
  type BuiltinPluginContributions,
} from '@qwen-code/core';
import type { AppPlugin } from './types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

export class AppPluginRegistry extends BuiltinPluginRegistry {
  constructor(
    private readonly appPlugins: readonly AppPlugin[],
    context: ConstructorParameters<typeof BuiltinPluginRegistry>[1],
  ) {
    super(appPlugins, context);
  }
  getAppPlugin(id: string): AppPlugin | undefined {
    return this.appPlugins.find((plugin) => plugin.id === id);
  }
  /** Slash contributions are read after initialization, including on refresh. */
  getAppPluginSlashCommands(): SlashCommand[] {
    return this.isReady()
      ? this.appPlugins.flatMap((plugin) =>
          (plugin.getSlashCommands?.() ?? []).map((command) =>
            command.kind === CommandKind.DYNAMIC
              ? { ...command, pluginName: plugin.id }
              : command,
          ),
        )
      : [];
  }

  /** Terminal metadata can be discovered without initializing plugins. */
  getAppPluginTerminalCommands() {
    return this.appPlugins.flatMap(
      (plugin) => plugin.getTerminalCommands?.() ?? [],
    );
  }

  /** Root option metadata can be discovered without initializing plugins. */
  getAppPluginRootOptions() {
    return this.appPlugins.flatMap((plugin) => plugin.getRootOptions?.() ?? []);
  }

  /** Prompt contributions are dynamic and are read again for each suggestion. */
  getAppPluginPromptSuggestionContributions() {
    return this.isReady()
      ? this.appPlugins.flatMap(
          (plugin) => plugin.getPromptSuggestionContributions?.() ?? [],
        )
      : [];
  }
}

/** Core 的 Config 只暴露基础能力；CLI 层识别同一个 Registry 的扩展。 */
export function getAppPlugins(
  contributions?: BuiltinPluginContributions,
): AppPluginRegistry | undefined {
  return contributions instanceof AppPluginRegistry ? contributions : undefined;
}
