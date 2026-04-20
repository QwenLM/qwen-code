/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utility functions for slash command mode filtering.
 *
 * This module provides the core capability-based filtering logic that replaces
 * the hardcoded ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE whitelist.
 */

import {
  CommandKind,
  type ExecutionMode,
  type SlashCommand,
} from '../ui/commands/types.js';

/**
 * Returns the effective list of execution modes for a command.
 *
 * Priority (highest to lowest):
 * 1. Explicit `supportedModes` declaration on the command
 * 2. Inference from `commandType`
 * 3. Fallback based on `CommandKind` (backward-compat for commands that
 *    have not yet been migrated to declare commandType)
 *
 * @param cmd The slash command to evaluate.
 * @returns The list of execution modes in which the command is available.
 */
export function getEffectiveSupportedModes(cmd: SlashCommand): ExecutionMode[] {
  // Priority 1: explicit declaration wins
  if (cmd.supportedModes !== undefined) {
    return cmd.supportedModes;
  }

  // Priority 2: infer from commandType
  if (cmd.commandType !== undefined) {
    switch (cmd.commandType) {
      case 'prompt':
        // prompt commands have no UI dependency — available in all modes
        return ['interactive', 'non_interactive', 'acp'];
      case 'local':
        // local commands default to interactive only (conservative).
        // Commands that are verified headless-friendly must explicitly declare
        // supportedModes (mirrors Claude Code's supportsNonInteractive: true).
        return ['interactive'];
      case 'local-jsx':
        // local-jsx commands always require the React/Ink runtime
        return ['interactive'];
      default:
        return ['interactive'];
    }
  }

  // Priority 3: backward-compat fallback based on CommandKind.
  // This branch should not be hit once all commands declare commandType.
  switch (cmd.kind) {
    case CommandKind.BUILT_IN:
      // Conservative default for unmigrated built-in commands
      return ['interactive'];
    case CommandKind.FILE:
    case CommandKind.SKILL:
    case CommandKind.MCP_PROMPT:
      // These kinds have always been available in all modes
      return ['interactive', 'non_interactive', 'acp'];
    default:
      return ['interactive'];
  }
}

/**
 * Filters a list of commands to those available in the given execution mode.
 *
 * This function replaces `filterCommandsForNonInteractive`. It does NOT filter
 * out hidden commands — that responsibility belongs to the caller (e.g.,
 * CommandService.getCommandsForMode).
 *
 * @param commands The full list of loaded commands.
 * @param mode The target execution mode.
 * @returns Commands that support the given mode.
 */
export function filterCommandsForMode(
  commands: readonly SlashCommand[],
  mode: ExecutionMode,
): SlashCommand[] {
  return commands.filter((cmd) =>
    getEffectiveSupportedModes(cmd).includes(mode),
  );
}
