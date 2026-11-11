/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pre-processes skill body text by executing embedded shell commands and
 * replacing the markers with their output.
 *
 * Two syntaxes are supported:
 *
 * 1. **Code block mode**: ` ```! command ``` `
 * 2. **Inline mode**: `` !`command` ``
 *
 * Security model:
 * - MCP-sourced skills MUST NOT use shell injection (caller is responsible
 *   for skipping).
 * - Each command is passed to the provided `executor` callback which is
 *   responsible for permission checks and actual execution.
 *
 * @module
 */

/** Pattern for code blocks: ` ```! command ``` ` */
export const SHELL_BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;

/**
 * Pattern for inline: `` !`command` ``
 *
 * Uses a positive lookbehind to require whitespace or start-of-line before `!`.
 * This prevents false matches inside markdown inline code spans like `!!` or
 * adjacent spans like `` `foo`!`bar` ``, and shell variables like `$!`.
 */
export const SHELL_INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm;

/**
 * Error thrown when a shell command embedded in a skill prompt fails.
 */
export class PromptShellExecutionError extends Error {
  readonly pattern: string;
  readonly originalCause?: unknown;

  constructor(message: string, pattern: string, originalCause?: unknown) {
    super(message);
    this.name = 'PromptShellExecutionError';
    this.pattern = pattern;
    this.originalCause = originalCause;
  }
}

/**
 * A match found in the prompt text with its position info.
 */
interface ShellMatch {
  /** Full match string (e.g. `` !`date` `` or ` ```! date ``` `) */
  fullMatch: string;
  /** The command to execute (trimmed) */
  command: string;
  /** Start index in the original text */
  startIndex: number;
}

/**
 * Execute all embedded shell commands in the given text and return the
 * text with command markers replaced by their output.
 *
 * @param text - The skill body text potentially containing shell markers.
 * @param executor - Callback that executes a shell command string and returns
 *   its output. The callback is responsible for permission checks.
 * @param skillName - Name of the skill (for error messages).
 * @returns The text with all shell markers replaced by command output.
 */
export async function executeShellCommandsInPrompt(
  text: string,
  executor: (command: string) => Promise<string>,
  skillName: string,
): Promise<string> {
  // Collect all matches from both patterns
  const matches: ShellMatch[] = [];

  // Block pattern: always scan (cheap regex, no lookbehind)
  for (const match of text.matchAll(SHELL_BLOCK_PATTERN)) {
    const command = match[1]?.trim();
    if (command && match.index !== undefined) {
      matches.push({
        fullMatch: match[0],
        command,
        startIndex: match.index,
      });
    }
  }

  // Inline pattern: gate on cheap substring check first.
  // The lookbehind in INLINE_PATTERN is ~100x slower than BLOCK_PATTERN on
  // large text. 93%+ of skills have no !` at all, so skip the expensive scan.
  if (text.includes('!`')) {
    for (const match of text.matchAll(SHELL_INLINE_PATTERN)) {
      const command = match[1]?.trim();
      if (command && match.index !== undefined) {
        matches.push({
          fullMatch: match[0],
          command,
          startIndex: match.index,
        });
      }
    }
  }

  if (matches.length === 0) {
    return text;
  }

  // Execute all commands concurrently
  const results = await Promise.all(
    matches.map(async (m) => {
      try {
        const output = await executor(m.command);
        return { match: m, output };
      } catch (error) {
        throw new PromptShellExecutionError(
          `Shell command failed for pattern "${m.fullMatch}" in skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
          m.fullMatch,
          error,
        );
      }
    }),
  );

  // Replace in reverse order of position to preserve offsets.
  // Sort by startIndex descending so earlier replacements don't shift later ones.
  results.sort((a, b) => b.match.startIndex - a.match.startIndex);

  let result = text;
  for (const { match, output } of results) {
    // Use string slicing instead of String.replace() to avoid $ characters
    // in the output being interpreted as replacement patterns ($&, $$, $`, $').
    const before = result.slice(0, match.startIndex);
    const after = result.slice(match.startIndex + match.fullMatch.length);
    result = before + output + after;
  }

  return result;
}
