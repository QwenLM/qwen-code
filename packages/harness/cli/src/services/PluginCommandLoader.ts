/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  loadAllPluginCommands,
  type PluginCommandDefinition,
  substitutePluginVariables,
  substituteArguments,
  pickQueryOverrides,
  isWorkflowSkill,
  ENV_SKILL_SESSION_ID,
  PluginCommandLifecycle,
  readPluginMarketplaceMetadata,
} from '@qwen-code/core';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { type ICommandLoader } from './types.js';

/**
 * Loads plugin commands as slash commands.
 *
 * Scans all enabled plugins for command definitions (markdown files in
 * commands/ directories or manifest-declared commands) and converts them
 * into executable SlashCommand objects.
 *
 * Only `context === 'inline'` file-backed plugin commands are surfaced here.
 * Fork-context plugin commands are converted to `SkillDefinition` records and
 * registered via `SkillManager`; `SkillCommandLoader` then surfaces them as
 * `CommandKind.PLUGIN` slash commands routed through the skill fork pipeline
 * (tool execution, allowedTools enforcement, agent selection).
 */
export class PluginCommandLoader implements ICommandLoader {
  constructor(private config: Config | null) {}

  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = [];

    // Load file-based commands from external plugins. Fork commands are
    // handled by SkillCommandLoader after SkillManager registration, so we
    // filter them out here to avoid duplicate surfaces.
    if (this.config) {
      const config = this.config;
      const plugins = config.getEnabledPlugins();
      if (plugins.length > 0) {
        const commandDefs = loadAllPluginCommands(plugins);
        commands.push(
          ...(await Promise.all(
            commandDefs
              .filter((def) => def.context !== 'fork')
              .filter((def) =>
                !isWorkflowSkill(config.getSkillManager().getSkill(def.name)),
              )
              // Hide commands explicitly marked user-invocable: false.
              // undefined or true means visible.
              .filter((def) => def.userInvocable !== false)
              .map((def) => this.toSlashCommand(def)),
          )),
        );
      }
    }

    return commands;
  }

  private async toSlashCommand(
    def: PluginCommandDefinition,
  ): Promise<SlashCommand> {
    const plugin = await readPluginMarketplaceMetadata(def.pluginRoot);

    return {
      name: def.name,
      ...(def.displayName ? { displayName: def.displayName } : {}),
      description: def.description,
      kind: CommandKind.PLUGIN,
      autoExecute: true,
      pluginName: def.pluginName,
      argumentHint: def.argumentHint,
      action: async (_context, args) => {
        const lifecycle = new PluginCommandLifecycle(
          this.config!,
          def.name,
          plugin,
          // 本地插件可能没有商城元数据，仍需传入加载时已确定的插件名称。
          def.pluginName,
        );

        try {
          const trimmedArgs = args.trim();

          // Inline execution: submit the substituted command body as a synthetic
          // user prompt; allowedTools / model / effort flow through as a
          // query-scoped overlay.
          const content = this.resolveContentWithArgs(
            def,
            trimmedArgs,
          );

          // 这里只记录命令展开结果，后续模型执行的结果不计入本次插件激活。
          await lifecycle.succeed(content);

          return {
            type: 'submit_prompt',
            content,
            isMeta: true,
            ...pickQueryOverrides(def),
          };
        } catch (error) {
          await lifecycle.fail(error);
          throw error;
        }
      },
    };
  }

  /**
   * Resolve the branded plugin root/data variables (and the
   * `${CLAUDE_*}` aliases — including `${CLAUDE_SESSION_ID}` for upstream
   * plugins) in a plugin command's content at execution time. The
   * branded session variable is handled by
   * {@link resolveContentWithArgs} so it works even for legacy in-tree
   * commands without a plugin root.
   */
  private resolveContent(def: PluginCommandDefinition): string {
    if (!def.pluginRoot) return def.content;
    return substitutePluginVariables(def.content, {
      path: def.pluginRoot,
      pluginId: def.pluginId,
      sessionId: this.config?.getSessionId(),
    });
  }

  /**
   * Full resolution pipeline applied at command-invocation time:
   *   1. plugin path / data variables (incl. ${CLAUDE_SESSION_ID})
   *   2. argument substitution ($ARGUMENTS, $0, named args)
   *   3. Branded session variable
   */
  private resolveContentWithArgs(
    def: PluginCommandDefinition,
    args: string,
  ): string {
    let content = this.resolveContent(def);
    content = substituteArguments(content, args, true, def.argNames ?? []);
    const sessionId = this.config?.getSessionId() ?? '';
    if (sessionId) {
      content = content.replaceAll('${' + ENV_SKILL_SESSION_ID + '}', () => sessionId);
    }
    return content;
  }
}
