/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command loader for codebase indexing related commands.
 * Follows the ICommandLoader interface pattern.
 */

import type { ICommandLoader } from './types.js';
import type { SlashCommand } from '../ui/commands/types.js';
import { codebaseCommand } from '../ui/commands/codebaseCommand.js';

/**
 * Loads codebase indexing related slash commands.
 */
export class CodebaseCommandLoader implements ICommandLoader {
  /**
   * Loads and returns the codebase-related commands.
   *
   * @param _signal An AbortSignal (unused for this synchronous loader).
   * @returns A promise that resolves to an array of `SlashCommand` objects.
   */
  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    return [codebaseCommand];
  }
}
