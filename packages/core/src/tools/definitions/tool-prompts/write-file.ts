/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { READ_FILE_TOOL_NAME, EDIT_TOOL_NAME } from '../base-declarations.js';
import type { PromptBundle } from '../../../prompts/types.js';

/**
 * Returns the description for `Write`.
 */
export function getWriteFileDescription(
  preReadLineDropped = false,
  bundle: PromptBundle = 'full',
): string {
  if (bundle === 'lean') {
    const existingFileGuidance = preReadLineDropped
      ? `Overwriting an existing file outside the working directory that you haven't ${READ_FILE_TOOL_NAME} will fail.`
      : `Overwriting an existing file you haven't ${READ_FILE_TOOL_NAME} will fail.`;

    return `Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one you've already ${READ_FILE_TOOL_NAME}. ${existingFileGuidance} For partial changes, use ${EDIT_TOOL_NAME} instead.`;
  }

  return `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
${preReadLineDropped ? `- If this is an existing file outside the working directory, you MUST use the ${READ_FILE_TOOL_NAME} tool first to read the file's contents. This tool will fail if you did not.` : `- If this is an existing file, you MUST use the ${READ_FILE_TOOL_NAME} tool first to read the file's contents. This tool will fail if you did not read the file first.`}
- Prefer the ${EDIT_TOOL_NAME} tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;
}
