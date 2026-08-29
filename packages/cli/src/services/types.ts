/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from '../ui/commands/types.js';

/**
 * Defines the contract for any class that can load and provide slash commands.
 * This allows the CommandService to be extended with new command sources
 * (e.g., file-based, remote APIs) without modification.
 *
 * Loaders should receive any necessary dependencies (like Config) via their
 * constructor.
 */
export interface ICommandLoader {
  /**
   * Discovers and returns a list of slash commands from the loader's source.
   * @param signal An AbortSignal to allow cancellation.
   * @returns A promise that resolves to an array of SlashCommand objects.
   */
  loadCommands(signal: AbortSignal): Promise<SlashCommand[]>;
  /**
   * Command names this loader withheld from the array above, and which
   * `CommandService` must therefore keep treating as taken when it renames a
   * colliding command. A name the user disabled is not free for another command
   * merely because the command that owns it never reached the aggregate
   * (#9408). Names are compared case-insensitively.
   *
   * Optional: only loaders that filter their own output need it, and the set
   * describes the most recent `loadCommands` result, so call it after awaiting
   * that promise.
   */
  reservedNames?(): ReadonlySet<string>;
}
