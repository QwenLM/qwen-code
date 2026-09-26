/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { canonicalToolName, ToolNames } from './tool-names.js';

export function createManagedToolEditParams<T extends object>(
  toolName: string,
  originalParams: T,
  originalContent: string,
  newContent: string,
): T {
  switch (canonicalToolName(toolName)) {
    case ToolNames.WRITE_FILE:
      return {
        ...originalParams,
        ai_proposed_content: (originalParams as { content?: unknown }).content,
        content: newContent,
        modified_by_user: true,
      };
    case ToolNames.EDIT:
      return {
        ...originalParams,
        ai_proposed_content: originalContent,
        old_string: originalContent,
        new_string: newContent,
        modified_by_user: true,
      };
    default:
      throw new Error('Managed tool does not support content modification.');
  }
}
