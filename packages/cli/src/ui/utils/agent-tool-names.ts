/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolNames,
  ToolNamesMigration,
} from '@qwen-code/qwen-code-core/tools/tool-names.js';

/**
 * Names that resolve to the agent tool: the canonical name plus whatever
 * legacy request aliases core's migration map declares (e.g. 'task').
 * Tool-usage stats key on the raw request name, so the scrollback
 * sub-agent count must accept all of them.
 *
 * Shared because both renderers derive the same sub-agent count from the
 * execution summary and must not drift apart on which aliases count.
 */
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.AGENT,
  ...Object.entries(ToolNamesMigration)
    .filter(([, canonical]) => canonical === ToolNames.AGENT)
    .map(([legacy]) => legacy),
]);
