/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandUnknownOpts, Option } from '@commander-js/extra-typings';
import type {
  BuiltinPlugin,
} from '@qwen-code/core';
import type { SlashCommand } from '../ui/commands/types.js';

/**
 * Trusted product plugin owned by AppFramework across application entry modes.
 * Application contributions extend the Core lifecycle on the same instance.
 */
export interface AppPlugin extends BuiltinPlugin {
  /** Static root options must be available before initialize, for argv parsing and help. */
  getRootOptions?(): ReadonlyArray<Option | BuiltinRootOptionContribution>;
  /** TUI slash commands, read after initialization and on contribution refresh. */
  getSlashCommands?(): readonly SlashCommand[];
  /**
   * Static terminal declarations are available before initialize, for help.
   * A matching canonical name replaces the complete host command group;
   * the product supplies its aliases and children. Other name collisions fail.
   */
  getTerminalCommands?(): ReadonlyArray<
    CommandUnknownOpts | AppTerminalCommandContribution
  >;
  /** Resolve dynamic terminal commands after Settings/.env, before argv dispatch. */
  resolveTerminalCommands?(
    context: AppTerminalCommandResolutionContext,
  ): Promise<readonly CommandUnknownOpts[]>;
  /** Optional guidance appended to the TUI next-action suggestion prompt. */
  getPromptSuggestionContributions?(): readonly AppPromptSuggestionContribution[];
}

export interface AppPluginConstructor {
  new (): AppPlugin;
}

/** Parsed inputs for a product-owned root action, before default Session setup. */
export interface BuiltinRootOptionActionContext {
  readonly options: Readonly<Record<string, unknown>>;
  readonly positionalArgs: readonly string[];
  readonly signal: AbortSignal;
}

/** An ordinary root option, optionally owning this invocation's action. */
export interface BuiltinRootOptionContribution {
  readonly option: Option;
  /**
   * 显式提供该动作参数时，在根命令完成解析后调用；匹配子命令时不调用。
   * 在选择列表、删除或插件动作之前检查，避免 action 不执行时漏检。
   * options 保留解析器的值并补齐环境默认值，不含由位置输入生成的提示词。
   * 通用参数整理后的配置交给 action，避免校验把派生值当作用户原始输入。
   * 参数非法时抛错；返回 false 时仅让出当前动作，其他动作仍须校验。
   * 返回 true、不返回值或省略 validate 时，当前动作参与选择。
   * 不初始化插件或创建会话，不修改运行状态。
   */
  readonly validate?: (
    options: Readonly<Record<string, unknown>>,
  ) => boolean | void;
  readonly action?: (
    context: BuiltinRootOptionActionContext,
  ) => Promise<AppTerminalCommandResult>;
}

/** Plugin-owned guidance for the model that generates TUI next actions. */
export interface AppPromptSuggestionContribution {
  /** Stable identity for diagnostics and future contribution controls. */
  id: string;
  /** Complete prompt section; omitted by the plugin when it is not applicable. */
  prompt: string;
}

/** Result returned to the CLI terminal adapter. */
export type AppTerminalCommandResult =
  | string
  | {
      output?: string;
      errorOutput?: string;
      showHelp?: boolean;
      exitCode: number;
    };

/** Static command metadata supplied by a product. */
export interface AppTerminalCommandContribution {
  readonly command: CommandUnknownOpts;
  readonly hidden?: boolean;
  /** Use the ordinary host's local startup instead of a product-owned action. */
  readonly startup?: 'local';
}

export interface AppTerminalCommandResolutionContext {
  readonly rawArgv: readonly string[];
  readonly reservedCommandNames: ReadonlySet<string>;
  readonly explicitHeadless: boolean;
  readonly valueOptionFlags: readonly string[];
}
