/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { READ_FILE_TOOL_NAME } from '../base-declarations.js';
import type { PromptBundle } from '../../../prompts/types.js';

/**
 * Returns the description for `Edit`.
 *
 * The parameter is named `allow_multiple` (not `replace_all`).
 */
export function getReplaceDescription(
  preReadLineDropped = false,
  bundle: PromptBundle = 'full',
): string {
  if (bundle === 'lean') {
    return `Performs exact string replacement in a file.

${preReadLineDropped ? `- If the file is outside the working directory, you must ${READ_FILE_TOOL_NAME} it in this conversation before editing, or the call will fail.` : `- You must ${READ_FILE_TOOL_NAME} the file in this conversation before editing, or the call will fail.`}
- \`old_string\` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.
- \`allow_multiple: true\` replaces every occurrence instead.`;
  }

  return `Performs exact string replacements in files.

Usage:
${preReadLineDropped ? `- If the file is outside the working directory, you must use your \`${READ_FILE_TOOL_NAME}\` tool to read it before editing. This tool will error if you edit such a file without reading it first.` : `- You must use your \`${READ_FILE_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.`}
- When editing text from ${READ_FILE_TOOL_NAME} tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`allow_multiple\` to change every instance of \`old_string\`.
- Use \`allow_multiple\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;
}
