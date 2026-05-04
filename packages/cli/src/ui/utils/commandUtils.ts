/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { SlashCommand } from '../commands/types.js';

/**
 * Common Windows console code pages (CP) used for encoding conversions.
 *
 * @remarks
 * - `UTF8` (65001): Unicode (UTF-8) — recommended for cross-language scripts.
 * - `GBK` (936): Simplified Chinese — default on most Chinese Windows systems.
 * - `BIG5` (950): Traditional Chinese.
 * - `LATIN1` (1252): Western European — default on many Western systems.
 */
export const CodePage = {
  UTF8: 65001,
  GBK: 936,
  BIG5: 950,
  LATIN1: 1252,
} as const;

export type CodePage = (typeof CodePage)[keyof typeof CodePage];
/**
 * Checks if a query string potentially represents an '@' command.
 * It triggers if the query starts with '@' or contains '@' preceded by whitespace
 * and followed by a non-whitespace character.
 *
 * @param query The input query string.
 * @returns True if the query looks like an '@' command, false otherwise.
 */
export const isAtCommand = (query: string): boolean =>
  // Check if starts with @ OR has a space, then @
  query.startsWith('@') || /\s@/.test(query);

const SLASH_PATH_SEPARATOR_RE = /[/\\]/;

const getSlashCommandFirstToken = (query: string): string =>
  query.slice(1).trimStart().split(/\s+/)[0] ?? '';

export const hasSlashCommandPathSeparator = (query: string): boolean =>
  SLASH_PATH_SEPARATOR_RE.test(getSlashCommandFirstToken(query));

/**
 * Checks if a query string potentially represents an '/' command.
 * It triggers if the query starts with '/' but excludes code comments like '//'
 * and '/*', and file paths where the first token contains a path separator.
 *
 * @param query The input query string.
 * @returns True if the query looks like an '/' command, false otherwise.
 */
export const isSlashCommand = (query: string): boolean => {
  if (!query.startsWith('/')) {
    return false;
  }

  // Exclude line comments that start with '//'
  if (query.startsWith('//')) {
    return false;
  }

  // Exclude block comments that start with '/*'
  if (query.startsWith('/*')) {
    return false;
  }

  if (hasSlashCommandPathSeparator(query)) {
    return false;
  }

  return true;
};

const BTW_COMMAND_RE = /^[/?]btw(?:\s|$)/;

/**
 * Checks if a query is a /btw side-question invocation.
 * Accepts both "/btw" and "?btw" prefixes.
 */
export const isBtwCommand = (query: string): boolean => {
  const trimmed = query.trim();
  return trimmed.length > 0 && BTW_COMMAND_RE.test(trimmed);
};

const debugLogger = createDebugLogger('COMMAND_UTILS');

// Copies a string snippet to the clipboard for different platforms
export const copyToClipboard = async (text: string): Promise<void> => {
  const run = (cmd: string, args: string[], options?: SpawnOptions) =>
    new Promise<void>((resolve, reject) => {
      const child = options ? spawn(cmd, args, options) : spawn(cmd, args);
      let stderr = '';
      if (child.stderr) {
        child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      }
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve();
        const errorMsg = stderr.trim();
        reject(
          new Error(
            `'${cmd}' exited with code ${code}${errorMsg ? `: ${errorMsg}` : ''}`,
          ),
        );
      });
      if (child.stdin) {
        child.stdin.on('error', reject);
        child.stdin.write(text);
        child.stdin.end();
      } else {
        reject(new Error('Child process has no stdin stream to write to.'));
      }
    });

  // Configure stdio for Linux clipboard commands.
  // - stdin: 'pipe' to write the text that needs to be copied.
  // - stdout: 'inherit' since we don't need to capture the command's output on success.
  // - stderr: 'pipe' to capture error messages (e.g., "command not found") for better error handling.
  const linuxOptions: SpawnOptions = { stdio: ['pipe', 'inherit', 'pipe'] };

  switch (process.platform) {
    case 'win32':
      return run('cmd', ['/c', `chcp ${CodePage.UTF8} >nul && clip`]);
    case 'darwin':
      return run('pbcopy', []);
    case 'linux':
      try {
        await run('xclip', ['-selection', 'clipboard'], linuxOptions);
      } catch (primaryError) {
        try {
          // If xclip fails for any reason, try xsel as a fallback.
          await run('xsel', ['--clipboard', '--input'], linuxOptions);
        } catch (fallbackError) {
          const xclipNotFound =
            primaryError instanceof Error &&
            (primaryError as NodeJS.ErrnoException).code === 'ENOENT';
          const xselNotFound =
            fallbackError instanceof Error &&
            (fallbackError as NodeJS.ErrnoException).code === 'ENOENT';
          if (xclipNotFound && xselNotFound) {
            throw new Error(
              'Please ensure xclip or xsel is installed and configured.',
            );
          }

          let primaryMsg =
            primaryError instanceof Error
              ? primaryError.message
              : String(primaryError);
          if (xclipNotFound) {
            primaryMsg = `xclip not found`;
          }
          let fallbackMsg =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          if (xselNotFound) {
            fallbackMsg = `xsel not found`;
          }

          throw new Error(
            `All copy commands failed. "${primaryMsg}", "${fallbackMsg}". `,
          );
        }
      }
      return;
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
};

export const getUrlOpenCommand = (): string => {
  // --- Determine the OS-specific command to open URLs ---
  let openCmd: string;
  switch (process.platform) {
    case 'darwin':
      openCmd = 'open';
      break;
    case 'win32':
      openCmd = 'start';
      break;
    case 'linux':
      openCmd = 'xdg-open';
      break;
    default:
      // Default to xdg-open, which appears to be supported for the less popular operating systems.
      openCmd = 'xdg-open';
      debugLogger.warn(
        `Unknown platform: ${process.platform}. Attempting to open URLs with: ${openCmd}.`,
      );
      break;
  }
  return openCmd;
};

/**
 * Represents a slash command token found mid-input (not at position 0).
 * e.g., in "hello /st", startPos=6, partialCommand="st"
 */
export type MidInputSlashCommand = {
  /** Full token including slash, e.g. "/st" */
  token: string;
  /** Position of the "/" in the full input string */
  startPos: number;
  /** Command portion without slash, e.g. "st" */
  partialCommand: string;
};

/**
 * Finds a slash command token that appears mid-input (not at position 0).
 * Only triggers when the "/" is preceded by whitespace and the cursor is
 * right at or within the partial command (no text between cursor and slash).
 *
 * Returns null when input starts with "/" (handled by start-of-line completion).
 */
export function findMidInputSlashCommand(
  input: string,
  cursorOffset: number,
): MidInputSlashCommand | null {
  // Start-of-line slash handled by existing dropdown completion
  if (input.startsWith('/')) return null;

  const beforeCursor = input.slice(0, cursorOffset);

  // Match: whitespace then "/" then optional command chars, anchored at end
  // Capture whitespace instead of lookbehind to avoid JSC JIT regression
  const match = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]*)$/);
  if (!match || match.index === undefined) return null;

  const slashPos = match.index + 1; // +1 to skip the captured whitespace char
  const textAfterSlash = input.slice(slashPos + 1);

  // Extend to next space (or end of input) to find the full command name
  const commandMatch = textAfterSlash.match(/^[a-zA-Z0-9_:-]*/);
  const fullCommand = commandMatch ? commandMatch[0] : '';

  // Only show ghost text when cursor is exactly at the end of the token.
  // If the cursor is inside the token or past it, return null.
  if (cursorOffset !== slashPos + 1 + fullCommand.length) return null;

  return {
    token: '/' + fullCommand,
    startPos: slashPos,
    partialCommand: input.slice(slashPos + 1, cursorOffset),
  };
}

/**
 * Finds the best (alphabetically first) prefix-matching command for a partial
 * command string. Returns the completion suffix and full command name, or null.
 *
 * e.g. partialCommand="st" → { suffix: "ats", fullCommand: "stats" }
 */
export function getBestSlashCommandMatch(
  partialCommand: string,
  commands: readonly SlashCommand[],
): { suffix: string; fullCommand: string } | null {
  if (!partialCommand) return null;
  const query = partialCommand.toLowerCase();
  let best: { suffix: string; fullCommand: string } | null = null;
  for (const cmd of commands) {
    // Only suggest model-invocable commands for mid-input completion,
    // since built-in commands typed in the middle of text won't be executed.
    if (!cmd.modelInvocable) continue;
    const name = cmd.name.toLowerCase();
    if (name.startsWith(query) && name !== query) {
      const suffix = cmd.name.slice(partialCommand.length);
      if (!best || cmd.name < best.fullCommand) {
        best = { suffix, fullCommand: cmd.name };
      }
    }
  }
  return best;
}
