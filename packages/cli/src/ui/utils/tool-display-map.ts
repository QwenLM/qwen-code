/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolDisplayNames, ToolNames } from '@qwen-code/qwen-code-core';

/**
 * Internal-tool-name → user-facing display-name lookup
 * (`run_shell_command` → `Shell`, `glob` → `Glob`, …). Shared by every
 * surface that renders subagent tool activity (LiveAgentPanel,
 * BackgroundTasksDialog, InlineParallelAgentsDisplay, ToolMessage's
 * approval context) so the vocabulary can't drift between them.
 */
export const TOOL_DISPLAY_BY_NAME: Record<string, string> = Object.fromEntries(
  (Object.keys(ToolNames) as Array<keyof typeof ToolNames>).map((key) => [
    ToolNames[key],
    ToolDisplayNames[key],
  ]),
);
