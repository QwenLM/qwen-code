/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import { parseSlashCommand } from './utils/commands.js';
import {
  FatalInputError,
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
} from './ui/commands/types.js';
import { createNonInteractiveUI } from './ui/noninteractive/nonInteractiveUi.js';
import type { LoadedSettings } from './config/settings.js';
import type { SessionStatsState } from './ui/contexts/SessionContext.js';

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
 *   allowed. If not provided or empty, only file commands are available.
 * @returns A Promise that resolves to `PartListUnion` if a valid command is
 *   found and results in a prompt, or `undefined` otherwise.
 * @throws {FatalInputError} if the command result is not supported in
 *   non-interactive mode.
 */
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
  allowedBuiltinCommandNames?: string[],
): Promise<PartListUnion | undefined> => {
  const trimmed = rawQuery.trim();
  if (!trimmed.startsWith('/')) {
    return;
  }

  const allowedBuiltinSet = new Set(allowedBuiltinCommandNames ?? []);

  // Only load BuiltinCommandLoader if there are allowed built-in commands
  const loaders =
    allowedBuiltinSet.size > 0
      ? [new BuiltinCommandLoader(config), new FileCommandLoader(config)]
      : [new FileCommandLoader(config)];

  const commandService = await CommandService.create(
    loaders,
    abortController.signal,
  );
  const commands = commandService.getCommands();
  const filteredCommands = filterCommandsForNonInteractive(
    commands,
    allowedBuiltinSet,
  );

  const { commandToExecute, args } = parseSlashCommand(
    rawQuery,
    filteredCommands,
  );

  if (commandToExecute) {
    if (commandToExecute.action) {
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

      if (result) {
        switch (result.type) {
          case 'submit_prompt':
            return result.content;
          case 'confirm_shell_commands':
            // This result indicates a command attempted to confirm shell commands.
            // However note that currently, ShellTool is excluded in non-interactive
            // mode unless 'YOLO mode' is active, so confirmation actually won't
            // occur because of YOLO mode.
            // This ensures that if a command *does* request confirmation (e.g.
            // in the future with more granular permissions), it's handled appropriately.
            throw new FatalInputError(
              'Exiting due to a confirmation prompt requested by the command.',
            );
          default:
            throw new FatalInputError(
              'Exiting due to command result that is not supported in non-interactive mode.',
            );
        }
      }
    }
  }

  return;
};

/**
 * Retrieves all available slash commands for the current configuration.
 *
 * @param config The configuration object
 * @param settings The loaded settings
 * @param abortSignal Signal to cancel the loading process
 * @param allowedBuiltinCommandNames Optional array of built-in command names that are
 *   allowed. If not provided or empty, only file commands are available.
 * @returns A Promise that resolves to an array of SlashCommand objects
 */
export const getAvailableCommands = async (
  config: Config,
  settings: LoadedSettings,
  abortSignal: AbortSignal,
  allowedBuiltinCommandNames?: string[],
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
