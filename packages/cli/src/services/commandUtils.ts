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
 * All commands must explicitly declare `supportedModes` (Phase 2+ requirement).
 * If a command omits it, this function falls back to a conservative default
 * based on `CommandKind` — built-in commands default to interactive-only,
 * while file/skill/mcp-prompt commands default to all modes.
 *
 * @param cmd The slash command to evaluate.
 * @returns The list of execution modes in which the command is available.
 */
export function getEffectiveSupportedModes(cmd: SlashCommand): ExecutionMode[] {
  // Explicit declaration is always authoritative.
  if (cmd.supportedModes !== undefined) {
    return cmd.supportedModes;
  }

  // Fallback based on CommandKind for commands that omit supportedModes.
  // Built-in commands without a declaration are conservative (interactive only).
  // File / skill / MCP-prompt commands retain their historical all-mode behavior.
  switch (cmd.kind) {
    case CommandKind.BUILT_IN:
      return ['interactive'];
    case CommandKind.FILE:
    case CommandKind.SKILL:
    case CommandKind.MCP_PROMPT:
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
