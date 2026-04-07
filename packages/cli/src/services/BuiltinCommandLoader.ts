/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandLoader } from './types.js';
import type { SlashCommand } from '../ui/commands/types.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { aboutCommand } from '../ui/commands/aboutCommand.js';
import { agentsCommand } from '../ui/commands/agentsCommand.js';
import { arenaCommand } from '../ui/commands/arenaCommand.js';
import { approvalModeCommand } from '../ui/commands/approvalModeCommand.js';
import { authCommand } from '../ui/commands/authCommand.js';
import { btwCommand } from '../ui/commands/btwCommand.js';
import { bugCommand } from '../ui/commands/bugCommand.js';
import { clearCommand } from '../ui/commands/clearCommand.js';
import { compressCommand } from '../ui/commands/compressCommand.js';
import { contextCommand } from '../ui/commands/contextCommand.js';
import { copyCommand } from '../ui/commands/copyCommand.js';
import { docsCommand } from '../ui/commands/docsCommand.js';
import { directoryCommand } from '../ui/commands/directoryCommand.js';
import { editorCommand } from '../ui/commands/editorCommand.js';
import { exportCommand } from '../ui/commands/exportCommand.js';
import { extensionsCommand } from '../ui/commands/extensionsCommand.js';
import { helpCommand } from '../ui/commands/helpCommand.js';
import { hooksCommand } from '../ui/commands/hooksCommand.js';
import { ideCommand } from '../ui/commands/ideCommand.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { initCommand } from '../ui/commands/initCommand.js';
import { languageCommand } from '../ui/commands/languageCommand.js';
import { mcpCommand } from '../ui/commands/mcpCommand.js';
import { memoryCommand } from '../ui/commands/memoryCommand.js';
import { modelCommand } from '../ui/commands/modelCommand.js';
import { modeCommand } from '../ui/commands/modeCommand.js';
import { parallelCommand } from '../ui/commands/parallelCommand.js';
import { hooksCommand } from '../ui/commands/hooksCommand.js';
import { presetCommand } from '../ui/commands/presetCommand.js';
import { inheritCommand } from '../ui/commands/inheritCommand.js';
import { permissionsCommand } from '../ui/commands/permissionsCommand.js';
import { trustCommand } from '../ui/commands/trustCommand.js';
import { quitCommand } from '../ui/commands/quitCommand.js';
import { restoreCommand } from '../ui/commands/restoreCommand.js';
import { resumeCommand } from '../ui/commands/resumeCommand.js';
import { settingsCommand } from '../ui/commands/settingsCommand.js';
import { skillsCommand } from '../ui/commands/skillsCommand.js';
import { statsCommand } from '../ui/commands/statsCommand.js';
import { summaryCommand } from '../ui/commands/summaryCommand.js';
import { terminalSetupCommand } from '../ui/commands/terminalSetupCommand.js';
import { themeCommand } from '../ui/commands/themeCommand.js';
import { toolsCommand } from '../ui/commands/toolsCommand.js';
import { vimCommand } from '../ui/commands/vimCommand.js';
import { setupGithubCommand } from '../ui/commands/setupGithubCommand.js';
import { insightCommand } from '../ui/commands/insightCommand.js';
import { analyticsCommand } from '../ui/commands/analyticsCommand.js';

const builtinDebugLogger = createDebugLogger('BUILTIN_COMMAND_LOADER');

/**
 * Loads the core, hard-coded slash commands that are an integral part
 * of the Qwen Code application.
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
    // Load ideCommand separately with error handling so that a failure
    // (e.g., platform-specific process detection on Windows) does not
    // prevent ALL built-in commands from loading.
    let resolvedIdeCommand: SlashCommand | null = null;
    try {
      resolvedIdeCommand = await ideCommand();
    } catch (error) {
      builtinDebugLogger.warn(
        'Failed to load IDE command:',
        error instanceof Error ? error.message : String(error),
      );
    }

    const allDefinitions: Array<SlashCommand | null> = [
      aboutCommand,
      agentsCommand,
      arenaCommand,
      approvalModeCommand,
      authCommand,
      btwCommand,
      bugCommand,
      clearCommand,
      compressCommand,
      contextCommand,
      copyCommand,
      docsCommand,
      directoryCommand,
      editorCommand,
      exportCommand,
      extensionsCommand,
      helpCommand,
      hooksCommand,
      resolvedIdeCommand,
      initCommand,
      languageCommand,
      mcpCommand,
      memoryCommand,
      modelCommand,
      modeCommand,
      parallelCommand,
      hooksCommand,
      presetCommand,
      inheritCommand,
      permissionsCommand,
      ...(this.config?.getFolderTrust() ? [trustCommand] : []),
      quitCommand,
      restoreCommand(this.config),
      resumeCommand,
      skillsCommand,
      statsCommand,
      summaryCommand,
      themeCommand,
      toolsCommand,
      settingsCommand,
      vimCommand,
      setupGithubCommand,
      terminalSetupCommand,
      insightCommand,
      analyticsCommand,
    ];

    return allDefinitions.filter((cmd): cmd is SlashCommand => cmd !== null);
  }
}
