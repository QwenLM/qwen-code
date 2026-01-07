/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import { parseSlashCommand } from './utils/commands.js';
import {
  Logger,
  uiTelemetryService,
  type Config,
} from '@qwen-code/qwen-code-core';
import { CommandService } from './services/CommandService.js';
import { BuiltinCommandLoader } from './services/BuiltinCommandLoader.js';
import { FileCommandLoader } from './services/FileCommandLoader.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './ui/commands/types.js';
import { createNonInteractiveUI } from './ui/noninteractive/nonInteractiveUi.js';
import type { LoadedSettings } from './config/settings.js';
import type { SessionStatsState } from './ui/contexts/SessionContext.js';
import { t } from './i18n/index.js';

/**
 * Built-in commands that are allowed in non-interactive modes (CLI and ACP).
 * Only safe, read-only commands that don't require interactive UI.
 *
 * These commands are:
 * - init: Initialize project configuration
 * - summary: Generate session summary
 * - compress: Compress conversation history
 */
export const ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE = [
  'init',
  'summary',
  'compress',
] as const;

/**
 * Result of handling a slash command in non-interactive mode.
 *
 * Supported types:
 * - 'submit_prompt': Submits content to the model (supports all modes)
 * - 'message': Returns a single message (supports non-interactive JSON/text only)
 * - 'stream_messages': Streams multiple messages (supports ACP only)
 * - 'unsupported': Command cannot be executed in this mode
 * - 'no_command': No command was found or executed
 */
export type NonInteractiveSlashCommandResult =
  | {
      type: 'submit_prompt';
      content: PartListUnion;
    }
  | {
      type: 'message';
      messageType: 'info' | 'error';
      content: string;
    }
  | {
      type: 'stream_messages';
      messages: AsyncGenerator<
        { messageType: 'info' | 'error'; content: string },
        void,
        unknown
      >;
    }
  | {
      type: 'unsupported';
      reason: string;
      originalType: string;
    }
  | {
      type: 'no_command';
    };

/**
 * Converts a SlashCommandActionReturn to a NonInteractiveSlashCommandResult.
 *
 * Only the following result types are supported in non-interactive mode:
 * - submit_prompt: Submits content to the model (all modes)
 * - message: Returns a single message (non-interactive JSON/text only)
 * - stream_messages: Streams multiple messages (ACP only)
 *
 * All other result types are converted to 'unsupported'.
 *
 * @param result The result from executing a slash command action
 * @returns A NonInteractiveSlashCommandResult describing the outcome
 */
function handleCommandResult(
  result: SlashCommandActionReturn,
): NonInteractiveSlashCommandResult {
  switch (result.type) {
    case 'submit_prompt':
      return {
        type: 'submit_prompt',
        content: result.content,
      };

    case 'message':
      return {
        type: 'message',
        messageType: result.messageType,
        content: result.content,
      };

    case 'stream_messages':
      return {
        type: 'stream_messages',
        messages: result.messages,
      };

    /**
     * Currently return types below are never generated due to the
     * whitelist of allowed slash commands in ACP and non-interactive mode.
     * We'll try to add more supported return types in the future.
     */
    case 'tool':
      return {
        type: 'unsupported',
        reason:
          'Tool execution from slash commands is not supported in non-interactive mode.',
        originalType: 'tool',
      };

    case 'quit':
      return {
        type: 'unsupported',
        reason:
          'Quit command is not supported in non-interactive mode. The process will exit naturally after completion.',
        originalType: 'quit',
      };

    case 'dialog':
      return {
        type: 'unsupported',
        reason: `Dialog '${result.dialog}' cannot be opened in non-interactive mode.`,
        originalType: 'dialog',
      };

    case 'load_history':
      return {
        type: 'unsupported',
        reason:
          'Loading history is not supported in non-interactive mode. Each invocation starts with a fresh context.',
        originalType: 'load_history',
      };

    case 'confirm_shell_commands':
      return {
        type: 'unsupported',
        reason:
          'Shell command confirmation is not supported in non-interactive mode. Use YOLO mode or pre-approve commands.',
        originalType: 'confirm_shell_commands',
      };

    case 'confirm_action':
      return {
        type: 'unsupported',
        reason:
          'Action confirmation is not supported in non-interactive mode. Commands requiring confirmation cannot be executed.',
        originalType: 'confirm_action',
      };

    default: {
      // Exhaustiveness check
      const _exhaustive: never = result;
      return {
        type: 'unsupported',
        reason: `Unknown command result type: ${(_exhaustive as SlashCommandActionReturn).type}`,
        originalType: 'unknown',
      };
    }
  }
}

/**
 * Filters commands based on the allowed built-in command names.
 *
 * - Always includes FILE commands
 * - Only includes BUILT_IN commands if their name is in the allowed set
 * - Excludes other command types (e.g., MCP_PROMPT) in non-interactive mode
 *
 * @param commands All loaded commands
 * @param allowedBuiltinCommandNames Set of allowed built-in command names (empty = none allowed)
 * @returns Filtered commands
 */
function filterCommandsForNonInteractive(
  commands: readonly SlashCommand[],
  allowedBuiltinCommandNames: Set<string>,
): SlashCommand[] {
  return commands.filter((cmd) => {
    if (cmd.kind === CommandKind.FILE) {
      return true;
    }

    // Built-in commands: only include if in the allowed list
    if (cmd.kind === CommandKind.BUILT_IN) {
      return allowedBuiltinCommandNames.has(cmd.name);
    }

    // Exclude other types (e.g., MCP_PROMPT) in non-interactive mode
    return false;
  });
}

/**
 * Processes a slash command in a non-interactive environment.
 *
 * @param rawQuery The raw query string (should start with '/')
 * @param abortController Controller to cancel the operation
 * @param config The configuration object
 * @param settings The loaded settings
 * @param allowedBuiltinCommandNames Optional array of built-in command names that are
 *   allowed. Defaults to ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE (init, summary, compress).
 *   Pass an empty array to only allow file commands.
 * @returns A Promise that resolves to a `NonInteractiveSlashCommandResult` describing
 *   the outcome of the command execution.
 */
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
  allowedBuiltinCommandNames: string[] = [
    ...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE,
  ],
): Promise<NonInteractiveSlashCommandResult> => {
  const trimmed = rawQuery.trim();
  if (!trimmed.startsWith('/')) {
    return { type: 'no_command' };
  }

  const isAcpMode = config.getExperimentalZedIntegration();
  const isInteractive = config.isInteractive();

  const executionMode = isAcpMode
    ? 'acp'
    : isInteractive
      ? 'interactive'
      : 'non_interactive';

  const allowedBuiltinSet = new Set(allowedBuiltinCommandNames ?? []);

  // Load all commands to check if the command exists but is not allowed
  const allLoaders = [
    new BuiltinCommandLoader(config),
    new FileCommandLoader(config),
  ];

  const commandService = await CommandService.create(
    allLoaders,
    abortController.signal,
  );
  const allCommands = commandService.getCommands();
  const filteredCommands = filterCommandsForNonInteractive(
    allCommands,
    allowedBuiltinSet,
  );

  // First, try to parse with filtered commands
  const { commandToExecute, args } = parseSlashCommand(
    rawQuery,
    filteredCommands,
  );

  if (!commandToExecute) {
    // Check if this is a known command that's just not allowed
    const { commandToExecute: knownCommand } = parseSlashCommand(
      rawQuery,
      allCommands,
    );

    if (knownCommand) {
      // Command exists but is not allowed in non-interactive mode
      return {
        type: 'unsupported',
        reason: t(
          'The command "/{{command}}" is not supported in non-interactive mode.',
          { command: knownCommand.name },
        ),
        originalType: 'filtered_command',
      };
    }

    return { type: 'no_command' };
  }

  if (!commandToExecute.action) {
    return { type: 'no_command' };
  }

  // Not used by custom commands but may be in the future.
  const sessionStats: SessionStatsState = {
    sessionId: config?.getSessionId(),
    sessionStartTime: new Date(),
    metrics: uiTelemetryService.getMetrics(),
    lastPromptTokenCount: 0,
    promptCount: 1,
  };

  const logger = new Logger(config?.getSessionId() || '', config?.storage);

  const context: CommandContext = {
    executionMode,
    services: {
      config,
      settings,
      git: undefined,
      logger,
    },
    ui: createNonInteractiveUI(),
    session: {
      stats: sessionStats,
      sessionShellAllowlist: new Set(),
    },
    invocation: {
      raw: trimmed,
      name: commandToExecute.name,
      args,
    },
  };

  const result = await commandToExecute.action(context, args);

  if (!result) {
    // Command executed but returned no result (e.g., void return)
    return {
      type: 'message',
      messageType: 'info',
      content: 'Command executed successfully.',
    };
  }

  // Handle different result types
  return handleCommandResult(result);
};

/**
 * Retrieves all available slash commands for the current configuration.
 *
 * @param config The configuration object
 * @param abortSignal Signal to cancel the loading process
 * @param allowedBuiltinCommandNames Optional array of built-in command names that are
 *   allowed. Defaults to ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE (init, summary, compress).
 *   Pass an empty array to only include file commands.
 * @returns A Promise that resolves to an array of SlashCommand objects
 */
export const getAvailableCommands = async (
  config: Config,
  abortSignal: AbortSignal,
  allowedBuiltinCommandNames: string[] = [
    ...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE,
  ],
): Promise<SlashCommand[]> => {
  try {
    const allowedBuiltinSet = new Set(allowedBuiltinCommandNames ?? []);

    // Only load BuiltinCommandLoader if there are allowed built-in commands
    const loaders =
      allowedBuiltinSet.size > 0
        ? [new BuiltinCommandLoader(config), new FileCommandLoader(config)]
        : [new FileCommandLoader(config)];

    const commandService = await CommandService.create(loaders, abortSignal);
    const commands = commandService.getCommands();
    const filteredCommands = filterCommandsForNonInteractive(
      commands,
      allowedBuiltinSet,
    );

    // Filter out hidden commands
    return filteredCommands.filter((cmd) => !cmd.hidden);
  } catch (error) {
    // Handle errors gracefully - log and return empty array
    console.error('Error loading available commands:', error);
    return [];
  }
};
