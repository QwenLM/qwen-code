/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared prompt fragments for the read-only subagents (Explore, Plan).
 *
 * Both run under READ_ONLY_SUBAGENT_DISALLOWED_TOOLS and must state the same
 * prohibitions and the same shell allowlist; keeping the text here means the
 * two prompts cannot drift apart.
 */

import {
  EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../tools/tool-names.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';

/**
 * Shell commands the read-only agents may run.
 *
 * Select examples for the active shell.
 */
const READ_ONLY_SHELL_COMMANDS = [
  'ls',
  'git status',
  'git log',
  'git diff',
  'find',
  'cat',
  'head',
  'tail',
] as const;

const FORBIDDEN_SHELL_COMMANDS =
  'mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install';

/**
 * Renders the READ-ONLY prohibition banner.
 *
 * @param taskKind names the task in the banner, e.g. `'exploration'`.
 * @param roleSentence what the agent may do instead, ending with a period.
 */
export function renderReadOnlyModeBlock(
  taskKind: string,
  roleSentence: string,
): string {
  return `=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY ${taskKind} task. You are STRICTLY PROHIBITED from:
- Creating new files (no ${WRITE_FILE_TOOL_NAME}, touch, or file creation of any kind)
- Modifying existing files (no ${EDIT_TOOL_NAME} operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to ${roleSentence} You do NOT have access to file editing tools - attempting to edit files will fail.`;
}

/** Renders shell-specific examples for the invocation's available tools. */
export function renderShellRules(
  extraReadOnlyCommands: readonly string[] = [],
  toolRegistry?: Pick<ToolRegistry, 'hasToolEnabled'>,
): string[] {
  return [SHELL_TOOL_NAME, POWERSHELL_TOOL_NAME].flatMap((shellName) => {
    const enabled =
      toolRegistry?.hasToolEnabled(shellName) ?? shellName === SHELL_TOOL_NAME;
    if (!enabled) return [];
    const isBash = shellName === SHELL_TOOL_NAME;
    const allowed = [
      ...new Set([
        ...(isBash
          ? READ_ONLY_SHELL_COMMANDS
          : [
              'Get-ChildItem',
              'git status',
              'git log',
              'git diff',
              'Get-Content',
              'Select-String',
              'Select-Object -First/-Last',
            ]),
        // Explore routes search fallbacks through Bash when both are available.
        ...(isBash || !toolRegistry?.hasToolEnabled(SHELL_TOOL_NAME)
          ? extraReadOnlyCommands
          : []),
      ]),
    ].join(', ');
    const forbidden = isBash
      ? FORBIDDEN_SHELL_COMMANDS
      : 'New-Item, Remove-Item, Copy-Item, Move-Item, git add, git commit, npm install, pip install';
    return [
      `Use ${shellName} ONLY for read-only operations (${allowed})`,
      `NEVER use ${shellName} for: ${forbidden}, or any file creation/modification`,
    ];
  });
}
