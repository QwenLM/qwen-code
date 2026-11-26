/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for bridge/remote slash command safety gating.
 * Used by both the interactive TUI (AppContainer) and the non-interactive
 * (headless/remote-worker) paths.
 */

import type { BridgeCommandType, SlashCommand } from '../ui/commands/types.js';

/**
 * Built-in commands that are safe to execute when triggered via remote
 * control / bridge sessions.
 */
export const BRIDGE_SAFE_BUILTIN_COMMANDS = new Set([
  'clear',
  'compact',
  'release-notes',
  'usage',
]);

/**
 * Resolve the `bridgeCommandType` for a slash command, calling it if it's
 * a function (some commands determine their type dynamically based on args).
 */
export function getBridgeCommandType(
  command: SlashCommand,
  args: string,
  input: string,
): BridgeCommandType | undefined {
  const bridgeCommandType = command.bridgeCommandType;
  return typeof bridgeCommandType === 'function'
    ? bridgeCommandType(args, { input, command })
    : bridgeCommandType;
}

/**
 * Build a standard "not available over Remote Control" rejection decision.
 */
export function buildBridgeBlockedDecision(commandName: string): {
  allow: false;
  message: string;
} {
  return {
    allow: false,
    message: `/${commandName} isn't available over Remote Control.`,
  };
}
