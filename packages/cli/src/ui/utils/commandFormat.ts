/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for formatting slash command invocations and their results into
 * structured XML tags for the LLM transcript. The tags allow the model to
 * distinguish command metadata from command output in conversation history.
 *
 * Escape policy:
 *   - User-authored input (command name / args / bash input) is inserted
 *     verbatim. The user is the author and is not defending against themselves.
 *   - External / tool output (bash stdout/stderr, local command stdout) is
 *     XML-escaped so the model cannot be confused by tags emitted by external
 *     processes.
 */

import {
  buildSlashCommandMetadata,
  escapeXml,
  LOCAL_COMMAND_STDOUT_TAG,
} from '@qwen-code/core';
import { buildSlashCommandMetadataFromRawInvocation } from '../../utils/slashCommandMetadata.js';

/**
 * Formats a slash command invocation for the LLM transcript.
 *
 * @param commandName  The bare command name, e.g. `"vim"` (without the leading `/`).
 * @param args         The argument string that follows the command name, may be empty.
 *
 * @example
 * formatCommandInput('vim', '')
 * // "<command-message>vim</command-message>\n<command-name>/vim</command-name>"
 */
export function formatCommandInput(commandName: string, args: string): string {
  return buildSlashCommandMetadata(commandName, args || undefined);
}

/**
 * Parses a raw slash command invocation (e.g. `"/export session.txt"`) and
 * returns the formatted command input string for the LLM transcript.
 *
 * Returns `null` if the input does not look like a slash command.
 */
export function formatRawCommandInput(rawInvocation: string): string | null {
  return buildSlashCommandMetadataFromRawInvocation(rawInvocation);
}

/**
 * Wraps a slash command's text result in a `<local-command-stdout>` tag
 * for the LLM transcript.
 *
 * @param output  The human-readable result text produced by the command.
 *
 * @example
 * formatCommandOutput('Entered Vim mode. Run /vim again to exit.')
 * // "<local-command-stdout>Entered Vim mode. Run /vim again to exit.</local-command-stdout>"
 */
export function formatCommandOutput(output: string): string {
  return `<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(output)}</${LOCAL_COMMAND_STDOUT_TAG}>`;
}

// ---------------------------------------------------------------------------
// Shell mode (bash) formatting — used to inject shell command output into the
// LLM conversation history so the model can reference it in subsequent turns.
// ---------------------------------------------------------------------------

/** Wraps the user's shell command in an XML tag for the LLM transcript. */
export function formatBashInput(command: string): string {
  return `<bash-input>${command}</bash-input>`;
}

/** Wraps shell command stdout/stderr in XML tags for the LLM transcript. */
export function formatBashOutput(stdout: string, stderr: string): string {
  return `<bash-stdout>${escapeXml(stdout)}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`;
}
