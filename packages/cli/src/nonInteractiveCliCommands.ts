/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import { randomUUID } from 'node:crypto';
import { parseSlashCommand } from './utils/commands.js';
import { extractSlashCommandToken } from './utils/slashCommandToken.js';
import { findClosestCommand } from './utils/commandSuggestion.js';
import { CommandKind } from './ui/commands/types.js';
import type { CommandContext } from './ui/commands/types.js';
import {
  BRIDGE_SAFE_BUILTIN_COMMANDS,
  getBridgeCommandType,
  buildBridgeBlockedDecision,
} from './utils/bridgeCommandUtils.js';
import {
  FatalInputError,
  isAbortError,
  Logger,
  uiTelemetryService,
  type Config,
  pickQueryOverrides,
} from '@qwen-code/core';
import { CommandService } from './services/CommandService.js';
import { BuiltinCommandLoader } from './services/BuiltinCommandLoader.js';
import { McpPromptLoader } from './services/McpPromptLoader.js';
import { SkillCommandLoader } from './services/SkillCommandLoader.js';
import { PluginCommandLoader } from './services/PluginCommandLoader.js';
import { WorkflowCommandLoader } from './services/WorkflowCommandLoader.js';
import { createNonInteractiveUI } from './ui/noninteractive/nonInteractiveUi.js';
import type { LoadedSettings } from './config/settings.js';
import type { SessionStatsState } from './ui/contexts/SessionContext.js';
import {
  waitForCommandCatalogReady,
  waitForSlashCommandReady,
} from './startup/startupModePolicy.js';

/**
 * Discriminated union for non-interactive slash command results.
 *
 * - `query`: The content should be sent to the model as a prompt.
 * - `direct_output`: The result should be printed directly without model
 *   inference (e.g. fork skills).
 * - `unknown_command_fallback`: The input looked like a command invocation but
 *   no command resolved. The caller sends the raw input to the model as a
 *   normal turn plus a model-only note describing what did not run, so the
 *   text is never silently dropped.
 */
export type NonInteractiveSlashResult =
  | {
      type: 'query';
      content: PartListUnion;
      allowedTools?: string[];
      model?: string;
      effort?: string;
      isMeta: boolean;
      commandInvocationId: string;
      skillActivation?: {
        skillName: string;
        activationSource: 'slash_command';
      };
    }
  | { type: 'direct_output'; resultText: string; isError?: boolean }
  | {
      type: 'unknown_command_fallback';
      commandName: string;
      suggestion?: string;
      availableCommandNames: string[];
      availableCommandCount: number;
    };

export async function getNonInteractiveBridgeSlashCommandDecision(
  rawQuery: string,
  config: Config,
): Promise<{ allow: true } | { allow: false; message: string } | null> {
  const commandService = await createNonInteractiveCommandService(
    config,
    new AbortController().signal,
  );
  const { commandToExecute, args } = parseSlashCommand(
    rawQuery,
    commandService.getCommands(),
  );
  if (!commandToExecute) {
    return null;
  }
  const bridgeCommandType = getBridgeCommandType(
    commandToExecute,
    args,
    rawQuery,
  );
  if (bridgeCommandType === 'prompt') {
    return { allow: true };
  }
  if (bridgeCommandType === 'local-jsx') {
    return buildBridgeBlockedDecision(commandToExecute.name);
  }
  if (bridgeCommandType === 'local') {
    return BRIDGE_SAFE_BUILTIN_COMMANDS.has(commandToExecute.name)
      ? { allow: true }
      : buildBridgeBlockedDecision(commandToExecute.name);
  }

  if (commandToExecute.kind !== CommandKind.BUILT_IN) {
    return { allow: true };
  }

  if (BRIDGE_SAFE_BUILTIN_COMMANDS.has(commandToExecute.name)) {
    return { allow: true };
  }

  return buildBridgeBlockedDecision(commandToExecute.name);
}

/**
 * Processes a slash command in a non-interactive environment.
 *
 * @returns A result for every recognised slash command, including commands
 *   that complete without output. Returns `undefined` only when the input is
 *   not a slash command or has no command token.
 * @throws {FatalInputError} if the command result is not supported in
 *   non-interactive mode.
 */

/**
 * Creates a CommandService for the non-interactive path.
 * Includes SkillCommandLoader so that skill slash commands (e.g. /my-skill)
 * are properly resolved and preprocessed in -p mode, matching TUI behaviour.
 */
export async function createNonInteractiveCommandService(
  config: Config,
  signal: AbortSignal,
): Promise<CommandService> {
  await waitForCommandCatalogReady(config, { signal });
  return createBestEffortNonInteractiveCommandService(config, signal);
}

export async function createBestEffortNonInteractiveCommandService(
  config: Config,
  signal: AbortSignal,
): Promise<CommandService> {
  return CommandService.create(
    [
      new BuiltinCommandLoader(config),
      new SkillCommandLoader(config),
      new PluginCommandLoader(config),
      new WorkflowCommandLoader(config),
      new McpPromptLoader(config),
    ],
    signal,
    config.getBuiltinPluginContributions(),
  );
}

export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
): Promise<NonInteractiveSlashResult | undefined> => {
  const trimmed = rawQuery.trim();
  if (!trimmed.startsWith('/')) {
    return;
  }
  const commandInvocationId = randomUUID();

  let commandService: Awaited<
    ReturnType<typeof createNonInteractiveCommandService>
  >;
  try {
    commandService = await createNonInteractiveCommandService(
      config,
      abortController.signal,
    );
  } catch (error) {
    if (abortController.signal.aborted || isAbortError(error)) {
      return {
        type: 'direct_output',
        resultText: '',
      };
    }
    throw error;
  }
  const commands = commandService.getCommands();

  const { commandToExecute, args, canonicalPath } = parseSlashCommand(
    rawQuery,
    commands,
  );

  if (commandToExecute) {
    if (commandToExecute.action) {
      try {
        await waitForSlashCommandReady(config, commandToExecute, {
          signal: abortController.signal,
        });
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) {
          return {
            type: 'direct_output',
            resultText: '',
          };
        }
        throw error;
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

      const commandContext: CommandContext = {
        abortSignal: abortController.signal,
        services: {
          agentContext: config,
          settings,
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

      let result: Awaited<
        ReturnType<NonNullable<typeof commandToExecute.action>>
      >;
      try {
        result = await commandToExecute.action(commandContext, args);
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) {
          return {
            type: 'direct_output',
            resultText: '',
          };
        }
        throw error;
      }
      if (abortController.signal.aborted) {
        return {
          type: 'direct_output',
          resultText: '',
        };
      }

      if (!result) {
        return { type: 'direct_output', resultText: '' };
      }

      switch (result.type) {
        case 'submit_prompt':
          return {
            type: 'query',
            content: result.content,
            isMeta: result.isMeta ?? true,
            commandInvocationId,
            skillActivation: result.skillActivation,
            ...pickQueryOverrides(result),
          };
        case 'tool':
          // SkillCommandLoader returns 'tool' for forked skills.
          // In non-interactive mode, return the postSubmitPrompt as the query
          // so the model can invoke the Skill tool during conversation.
          if (result.postSubmitPrompt) {
            return {
              type: 'query',
              content: result.postSubmitPrompt,
              isMeta: true,
              commandInvocationId,
            };
          }
          return { type: 'direct_output', resultText: '' };
        case 'message':
          return {
            type: 'direct_output',
            resultText: result.content,
            ...(result.messageType === 'error' ? { isError: true } : {}),
          };
        case 'local_command_result':
          // Fork skills and local commands executed directly — return their
          // result without starting a model query.
          return {
            type: 'direct_output',
            resultText: result.text,
            ...(result.severity === 'error' ? { isError: true } : {}),
          };
        case 'confirm_shell_commands':
          // This result indicates a command attempted to confirm shell commands.
          // However note that currently, ShellTool is excluded in non-interactive
          // mode unless 'bypass permissions mode' is active, so confirmation actually won't
          // occur because of bypass permissions mode.
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
    return {
      type: 'direct_output',
      resultText: commandToExecute.subCommands
        ? `Command '/${canonicalPath.join(' ')}' requires a subcommand.`
        : `Command '/${canonicalPath.join(' ')}' is not executable.`,
      isError: true,
    };
  }

  const unknownCommandName = extractSlashCommandToken(rawQuery);
  if (unknownCommandName) {
    const visibleCommands = commands.filter((command) => !command.hidden);
    const modelInvocableCommands = visibleCommands.filter(
      (command) => command.kind !== CommandKind.BUILT_IN,
    );
    const suggestion = findClosestCommand(
      unknownCommandName,
      modelInvocableCommands,
      { maxEditDistance: 2 },
    );
    return {
      type: 'unknown_command_fallback',
      commandName: unknownCommandName,
      availableCommandNames: modelInvocableCommands.map(
        (command) => command.name,
      ),
      availableCommandCount: visibleCommands.length,
      ...(suggestion ? { suggestion } : {}),
    };
  }

  return;
};
