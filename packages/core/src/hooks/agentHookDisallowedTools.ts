/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tools that agent hooks must never have access to.
 *
 * Mirrors Claude Code's `ALL_AGENT_DISALLOWED_TOOLS` — prevents hook
 * subagents from spawning recursive agents, entering interactive/plan modes,
 * or interfering with the parent session's control plane.
 *
 * Note: EXCLUDED_TOOLS_FOR_SUBAGENTS (in agent-core.ts) already blocks
 * AGENT, CRON_*, TASK_STOP, and SEND_MESSAGE for all subagents. We list
 * them here explicitly so the disallowed set is self-contained and correct
 * even if the hook runner uses a custom tool list instead of '*'.
 */
import { ToolNames } from '../tools/tool-names.js';

export const AGENT_HOOK_DISALLOWED_TOOLS: readonly string[] = [
  // Prevent recursive agent spawning
  ToolNames.AGENT,
  // Prevent interactive user prompts
  ToolNames.ASK_USER_QUESTION,
  // Prevent plan mode toggling
  ToolNames.EXIT_PLAN_MODE,
  // Prevent task/cron control plane interference
  ToolNames.TASK_STOP,
  ToolNames.SEND_MESSAGE,
  ToolNames.CRON_CREATE,
  ToolNames.CRON_LIST,
  ToolNames.CRON_DELETE,
  // Prevent todo writes (hook agent should not manage parent todos)
  ToolNames.TODO_WRITE,
  // Prevent arbitrary command execution in YOLO mode
  ToolNames.SHELL,
  ToolNames.MONITOR,
  // Prevent SSRF and data exfiltration
  ToolNames.WEB_FETCH,
  // Prevent persistent memory corruption
  ToolNames.MEMORY,
  // Prevent skill execution (can spawn agents / execute shell)
  ToolNames.SKILL,
];
