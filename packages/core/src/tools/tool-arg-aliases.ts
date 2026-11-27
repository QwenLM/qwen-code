/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames, canonicalToolName } from './tool-names.js';

// Argument names other harnesses use for the file tools' arguments. Models
// trained on them keep sending them, and the call would fail validation.
const TOOL_ARG_ALIASES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  [ToolNames.READ_FILE]: { path: 'file_path' },
  [ToolNames.WRITE_FILE]: { path: 'file_path' },
  [ToolNames.EDIT]: {
    path: 'file_path',
    old_str: 'old_string',
    new_str: 'new_string',
  },
};

/**
 * Renames, in place, the aliased arguments of a call to `toolName` whose
 * canonical name is absent. An alias next to its canonical name is left as is.
 */
export function applyToolArgAliases(
  toolName: string,
  args: Record<string, unknown>,
): void {
  const name = canonicalToolName(toolName);
  // A bridged call's arguments come from the model's JSON as they are.
  if (typeof args !== 'object' || args === null) return;
  if (!Object.hasOwn(TOOL_ARG_ALIASES, name)) return;
  const aliases = TOOL_ARG_ALIASES[name];
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (args[alias] === undefined || args[canonical] !== undefined) continue;
    args[canonical] = args[alias];
    delete args[alias];
  }
}
