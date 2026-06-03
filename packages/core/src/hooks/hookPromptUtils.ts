/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Replaces the `$ARGUMENTS` placeholder in a hook prompt template with the
 * serialized JSON input. This mirrors Claude Code's `addArgumentsToPrompt`.
 *
 * Uses a function replacer to avoid `String.prototype.replace` interpreting
 * `$&`, `$$`, `$'`, and `` $` `` as special sequences in the replacement
 * string — if `jsonInput` contains these characters (e.g., a file path
 * like `/foo/$&/bar`), the prompt would be silently corrupted.
 *
 * @param prompt - The prompt template potentially containing `$ARGUMENTS`.
 * @param jsonInput - The JSON string to substitute in place of `$ARGUMENTS`.
 * @returns The prompt with `$ARGUMENTS` replaced by the JSON input.
 */
export function substituteHookArguments(
  prompt: string,
  jsonInput: string,
): string {
  return prompt.replace(/\$ARGUMENTS/g, () => jsonInput);
}
