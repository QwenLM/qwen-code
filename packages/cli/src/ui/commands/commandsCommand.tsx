/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { CommandsList } from '../components/views/CommandsList.js';

/**
 * Action for `/commands`.
 * Reloads custom commands, then displays an interactive dialog listing
 * all registered slash commands grouped by kind.
 */
async function commandsAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  // Reload commands first so the list is up-to-date
  context.ui.reloadCommands();

  return {
    type: 'custom_dialog',
    component: <CommandsList onClose={() => context.ui.removeComponent()} />,
  };
}

export const commandsCommand: SlashCommand = {
  name: 'commands',
  description: 'Reload and list all available slash commands',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: commandsAction,
};
