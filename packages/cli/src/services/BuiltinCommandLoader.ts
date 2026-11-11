/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDevelopment } from '../installation/source.js';
import type { ICommandLoader } from './types.js';
import {
  CommandKind,
  type SlashCommand,
  type CommandContext,
} from '../ui/commands/types.js';
import type { MessageActionReturn, Config } from '@qwen-code/core';
import { startupProfiler } from '@qwen-code/core';
import { aboutCommand } from '../ui/commands/aboutCommand.js';
import { releaseNotesCommand } from '../ui/commands/releaseNotesCommand.js';
import { agentsCommand } from '../ui/commands/agentsCommand.js';
import { btwCommand } from '../ui/commands/btwCommand.js';
import { rewindCommand } from '../ui/commands/rewindCommand.js';
import { clearCommand } from '../ui/commands/clearCommand.js';
import { newCommand } from '../ui/commands/newCommand.js';
import { branchCommand } from '../ui/commands/branchCommand.js';
import { subtaskCommand } from '../ui/commands/subtaskCommand.js';
import { commandsCommand } from '../ui/commands/commandsCommand.js';
import { compactCommand } from '../ui/commands/compressCommand.js';
import { copyCommand } from '../ui/commands/copyCommand.js';
import { corgiCommand } from '../ui/commands/corgiCommand.js';
import { editorCommand } from '../ui/commands/editorCommand.js';
import { effortCommand } from '../ui/commands/effortCommand.js';
import { exportCommand } from '../ui/commands/exportCommand.js';
import { helpCommand } from '../ui/commands/helpCommand.js';
import { shortcutsCommand } from '../ui/commands/shortcutsCommand.js';
import { diffCommand } from '../ui/commands/diffCommand.js';
import { reviewCommand } from '../ui/commands/reviewCommand.js';
import { hooksCommand } from '../ui/commands/hooksCommand.js';
import { initCommand } from '../ui/commands/initCommand.js';
import { insightsCommand } from '../ui/commands/insightsCommand.js';
import { mcpCommand } from '../ui/commands/mcpCommand.js';
import { memoryCommand } from '../ui/commands/memoryCommand.js';
import { modelCommand } from '../ui/commands/modelCommand.js';
import { planCommand } from '../ui/commands/planCommand.js';
import { goalCommand } from '../ui/commands/goalCommand.js';
import { crontabCommand } from '../ui/commands/crontabCommand.js';
import { policiesCommand } from '../ui/commands/policiesCommand.js';
import { profileCommand } from '../ui/commands/profileCommand.js';
import { quitCommand } from '../ui/commands/quitCommand.js';
import { continueCommand } from '../ui/commands/continueCommand.js';
import { renameCommand } from '../ui/commands/renameCommand.js';
import { resumeCommand } from '../ui/commands/resumeCommand.js';
import { usageCommand } from '../ui/commands/usageCommand.js';
import { statusCommand } from '../ui/commands/statusCommand.js';
import { addDirCommand } from '../ui/commands/addDirCommand.js';
import { contextCommand } from '../ui/commands/contextCommand.js';
import { contextWindowCommand } from '../ui/commands/contextWindowCommand.js';
import { themeCommand } from '../ui/commands/themeCommand.js';
import { toolsCommand } from '../ui/commands/toolsCommand.js';
import { skillsCommand } from '../ui/commands/skillsCommand.js';
import { outputStyleCommand } from '../ui/commands/outputStyleCommand.js';
import { settingsCommand } from '../ui/commands/settingsCommand.js';
import {
  tasksCommand,
  workflowsCommand,
} from '../ui/commands/tasksCommand.js';
import { vimCommand } from '../ui/commands/vimCommand.js';
import {
  marketplaceCommand,
  pluginsCommand,
} from '../ui/commands/pluginsCommand.js';
import { statuslineCommand } from '../ui/commands/statuslineCommand.js';
import { keyboardDebugCommand } from '../ui/commands/keyboardDebugCommand.js';
import { keyboardContextsCommand } from '../ui/commands/keyboardContextsCommand.js';

/**
 * Loads the core, hard-coded slash commands that are an integral part
 * of the CLI application.
 */
export class BuiltinCommandLoader implements ICommandLoader {
  constructor(private config: Config | null) {}

  /**
   * Gathers all raw built-in command definitions, injects dependencies where
   * needed (e.g., config) and filters out any that are not available.
   *
   * @param _signal An AbortSignal (unused for this synchronous loader).
   * @returns A promise that resolves to an array of `SlashCommand` objects.
   */
  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    const handle = startupProfiler.start('load_builtin_commands');
    const terminalSetupCommands =
      this.config?.isInteractive?.() === true &&
      this.config.getAcpMode?.() !== true
        ? [(await import('../ui/commands/terminalSetupCommand.js')).terminalSetupCommand]
        : [];

    const allDefinitions: Array<SlashCommand | null> = [
      aboutCommand,
      releaseNotesCommand,
      ...(this.config?.isAgentsEnabled() ? [agentsCommand] : []),
      btwCommand,
      branchCommand,
      subtaskCommand,
      clearCommand,
      newCommand,
      commandsCommand,
      compactCommand,
      copyCommand,
      corgiCommand,
      editorCommand,
      effortCommand,
      exportCommand,
      helpCommand,
      shortcutsCommand,
      hooksCommand,
      diffCommand,
      reviewCommand,
      insightsCommand,
      initCommand,
      ...(this.config?.getMcpEnabled() === false
        ? [
            {
              name: 'mcp',
              description:
                'Manage configured Model Context Protocol (MCP) servers',
              kind: CommandKind.BUILT_IN,
              autoExecute: false,
              subCommands: [],
              action: async (
                _context: CommandContext,
              ): Promise<MessageActionReturn> => ({
                type: 'message',
                messageType: 'error',
                content: 'MCP is disabled by settings.',
              }),
            },
          ]
        : [mcpCommand]),
      memoryCommand,
      modelCommand,
      marketplaceCommand,
      pluginsCommand,
      ...(this.config?.isPlanEnabled() ? [planCommand] : []),
      goalCommand,
      crontabCommand,
      policiesCommand,
      profileCommand,
      ...(isDevelopment ? [keyboardDebugCommand, keyboardContextsCommand] : []),
      quitCommand,
      rewindCommand,
      continueCommand,
      renameCommand,
      resumeCommand,
      usageCommand,
      statusCommand,
      addDirCommand,
      contextCommand,
      contextWindowCommand,
      themeCommand,
      toolsCommand,
      outputStyleCommand,
      ...(this.config?.isSkillsSupportEnabled()
        ? this.config?.getSkillManager()?.isAdminEnabled() === false
          ? [
              {
                name: 'skills',
                description: 'Manage agent skills',
                kind: CommandKind.BUILT_IN,
                isSafeConcurrent: true,
                autoExecute: false,
                subCommands: [],
                action: async (
                  _context: CommandContext,
                ): Promise<MessageActionReturn> => ({
                  type: 'message',
                  messageType: 'error',
                  content: 'Agent skills are disabled by settings.',
                }),
              },
            ]
          : [skillsCommand]
        : []),
      settingsCommand,
      statuslineCommand,
      tasksCommand,
      workflowsCommand,
      vimCommand,
      ...terminalSetupCommands,
    ];
    handle?.end();
    const commands = allDefinitions.filter(
      (cmd): cmd is SlashCommand => cmd !== null,
    );
    return commands;
  }
}
