/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  MONITOR_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  // Shared parameter names
  PARAM_FILE_PATH,
  PARAM_DIR_PATH,
  PARAM_PATTERN,
  PARAM_CASE_SENSITIVE,
  PARAM_RESPECT_GIT_IGNORE,
  PARAM_RESPECT_GEMINI_IGNORE,
  PARAM_FILE_FILTERING_OPTIONS,
  PARAM_DESCRIPTION,
  // Tool-specific parameter names
  READ_FILE_PARAM_OFFSET,
  READ_FILE_PARAM_LIMIT,
  READ_FILE_PARAM_PAGES,
  WRITE_FILE_PARAM_CONTENT,
  // Grep/glob parameter names (ripgrep variant)
  GLOB_PARAM_PATH,
  GREP_PARAM_PATH,
  GREP_PARAM_GLOB,
  GREP_PARAM_OUTPUT_MODE,
  GREP_PARAM_MINUS_B,
  GREP_PARAM_MINUS_A,
  GREP_PARAM_MINUS_C,
  GREP_PARAM_CONTEXT,
  GREP_PARAM_MINUS_N,
  GREP_PARAM_MINUS_I,
  GREP_PARAM_TYPE,
  GREP_PARAM_HEAD_LIMIT,
  GREP_PARAM_OFFSET,
  GREP_PARAM_MULTILINE,
  // Legacy grep parameter names
  GREP_PARAM_INCLUDE_PATTERN,
  GREP_PARAM_EXCLUDE_PATTERN,
  GREP_PARAM_NAMES_ONLY,
  GREP_PARAM_MAX_MATCHES_PER_FILE,
  GREP_PARAM_TOTAL_MAX_MATCHES,
  GREP_PARAM_FIXED_STRINGS,
  GREP_PARAM_AFTER,
  GREP_PARAM_BEFORE,
  GREP_PARAM_NO_IGNORE,
  EDIT_PARAM_OLD_STRING,
  EDIT_PARAM_NEW_STRING,
  EDIT_PARAM_ALLOW_MULTIPLE,
  SHELL_PARAM_COMMAND,
  SHELL_PARAM_RUN_IN_BACKGROUND,
  BASH_INPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
  WEB_SEARCH_PARAM_QUERY,
  WEB_FETCH_PARAM_PROMPT,
  WEB_FETCH_PARAM_URL,
  WEB_SEARCH_PARAM_ALLOWED_DOMAINS,
  WEB_SEARCH_PARAM_BLOCKED_DOMAINS,
  TODOS_PARAM_TODOS,
  TODOS_ITEM_PARAM_DESCRIPTION,
  TODOS_ITEM_PARAM_STATUS,
  ASK_USER_PARAM_QUESTIONS,
  ASK_USER_QUESTION_PARAM_QUESTION,
  ASK_USER_QUESTION_PARAM_HEADER,
  ASK_USER_QUESTION_PARAM_OPTIONS,
  ASK_USER_QUESTION_PARAM_MULTI_SELECT,
  ASK_USER_OPTION_PARAM_LABEL,
  ASK_USER_OPTION_PARAM_DESCRIPTION,
  PLAN_MODE_PARAM_REASON,
  EXIT_PLAN_PARAM_PLAN_FILENAME,
  SKILL_PARAM_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  UPDATE_TOPIC_DISPLAY_NAME,
  COMPLETE_TASK_TOOL_NAME,
  COMPLETE_TASK_DISPLAY_NAME,
  AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  IMAGE_SEARCH_PARAM_QUERY,
  IMAGE_SEARCH_PARAM_COUNT,
  IMAGE_GEN_TOOL_NAME,
  IMAGE_GEN_PARAM_NAME,
  IMAGE_GEN_PARAM_PROMPT,
  IMAGE_GEN_PARAM_SIZE,
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_DISPLAY_NAME,
  VIDEO_GEN_PARAM_NAME,
  VIDEO_GEN_PARAM_MODE,
  VIDEO_GEN_PARAM_PROMPT,
  VIDEO_GEN_PARAM_MEDIA,
  VIDEO_GEN_PARAM_SIZE,
  VIDEO_GEN_PARAM_DURATION_SECONDS,
  VIDEO_GEN_PARAM_DELIVERY,
  VIDEO_GEN_RETRIEVE_TOOL_NAME,
  VIDEO_GEN_RETRIEVE_DISPLAY_NAME,
  VIDEO_GEN_RETRIEVE_PARAM_VIDEO_ID,
  TOPIC_PARAM_TITLE,
  TOPIC_PARAM_SUMMARY,
  TOPIC_PARAM_STRATEGIC_INTENT,
  CODEBASE_INVESTIGATOR_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  SCHEDULE_WAKEUP_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
} from './definitions/coreTools.js';

export const CODE_MODE_TOOL_NAME = 'CodeMode';
export const CODE_MODE_WAIT_TOOL_NAME = 'CodeModeWait';
export const WORKFLOW_TOOL_NAME = 'Workflow';
export const RUN_WORKFLOW_TOOL_NAME = 'RunWorkflow';
/**
 * The result-return channel injected into a subagent when a workflow script
 * asks for structured output, and into hook-scoped agents. The name is the
 * permission registry's key, so all injectors share this spelling.
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';

export const LIST_AGENTS_TOOL_NAME = 'ListAgents';
export const LIST_AGENTS_DISPLAY_NAME = 'ListAgents';
/** Pre-rename name, kept addressable for user policies and hooks. */
export const LIST_AGENTS_LEGACY_ALIAS = 'ListPeers';

export {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  MONITOR_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  UPDATE_TOPIC_DISPLAY_NAME,
  COMPLETE_TASK_TOOL_NAME,
  COMPLETE_TASK_DISPLAY_NAME,
  AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  IMAGE_GEN_PARAM_NAME,
  IMAGE_GEN_PARAM_PROMPT,
  IMAGE_GEN_PARAM_SIZE,
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_DISPLAY_NAME,
  VIDEO_GEN_PARAM_NAME,
  VIDEO_GEN_PARAM_MODE,
  VIDEO_GEN_PARAM_PROMPT,
  VIDEO_GEN_PARAM_MEDIA,
  VIDEO_GEN_PARAM_SIZE,
  VIDEO_GEN_PARAM_DURATION_SECONDS,
  VIDEO_GEN_PARAM_DELIVERY,
  VIDEO_GEN_RETRIEVE_TOOL_NAME,
  VIDEO_GEN_RETRIEVE_DISPLAY_NAME,
  VIDEO_GEN_RETRIEVE_PARAM_VIDEO_ID,
  CODEBASE_INVESTIGATOR_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  SCHEDULE_WAKEUP_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  // Shared parameter names
  PARAM_FILE_PATH,
  PARAM_DIR_PATH,
  PARAM_PATTERN,
  PARAM_CASE_SENSITIVE,
  PARAM_RESPECT_GIT_IGNORE,
  PARAM_RESPECT_GEMINI_IGNORE,
  PARAM_FILE_FILTERING_OPTIONS,
  PARAM_DESCRIPTION,
  // Tool-specific parameter names
  READ_FILE_PARAM_OFFSET,
  READ_FILE_PARAM_LIMIT,
  READ_FILE_PARAM_PAGES,
  WRITE_FILE_PARAM_CONTENT,
  // Grep/glob parameter names (ripgrep variant)
  GLOB_PARAM_PATH,
  GREP_PARAM_PATH,
  GREP_PARAM_GLOB,
  GREP_PARAM_OUTPUT_MODE,
  GREP_PARAM_MINUS_B,
  GREP_PARAM_MINUS_A,
  GREP_PARAM_MINUS_C,
  GREP_PARAM_CONTEXT,
  GREP_PARAM_MINUS_N,
  GREP_PARAM_MINUS_I,
  GREP_PARAM_TYPE,
  GREP_PARAM_HEAD_LIMIT,
  GREP_PARAM_OFFSET,
  GREP_PARAM_MULTILINE,
  // Legacy grep parameter names
  GREP_PARAM_INCLUDE_PATTERN,
  GREP_PARAM_EXCLUDE_PATTERN,
  GREP_PARAM_NAMES_ONLY,
  GREP_PARAM_MAX_MATCHES_PER_FILE,
  GREP_PARAM_TOTAL_MAX_MATCHES,
  GREP_PARAM_FIXED_STRINGS,
  GREP_PARAM_AFTER,
  GREP_PARAM_BEFORE,
  GREP_PARAM_NO_IGNORE,
  EDIT_PARAM_OLD_STRING,
  EDIT_PARAM_NEW_STRING,
  EDIT_PARAM_ALLOW_MULTIPLE,
  SHELL_PARAM_COMMAND,
  SHELL_PARAM_RUN_IN_BACKGROUND,
  BASH_INPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
  WEB_SEARCH_PARAM_QUERY,
  IMAGE_SEARCH_PARAM_QUERY,
  IMAGE_SEARCH_PARAM_COUNT,
  WEB_FETCH_PARAM_PROMPT,
  WEB_FETCH_PARAM_URL,
  WEB_SEARCH_PARAM_ALLOWED_DOMAINS,
  WEB_SEARCH_PARAM_BLOCKED_DOMAINS,
  TODOS_PARAM_TODOS,
  TODOS_ITEM_PARAM_DESCRIPTION,
  TODOS_ITEM_PARAM_STATUS,
  ASK_USER_PARAM_QUESTIONS,
  ASK_USER_QUESTION_PARAM_QUESTION,
  ASK_USER_QUESTION_PARAM_HEADER,
  ASK_USER_QUESTION_PARAM_OPTIONS,
  ASK_USER_QUESTION_PARAM_MULTI_SELECT,
  ASK_USER_OPTION_PARAM_LABEL,
  ASK_USER_OPTION_PARAM_DESCRIPTION,
  PLAN_MODE_PARAM_REASON,
  EXIT_PLAN_PARAM_PLAN_FILENAME,
  SKILL_PARAM_NAME,
  TOPIC_PARAM_TITLE,
  TOPIC_PARAM_SUMMARY,
  TOPIC_PARAM_STRATEGIC_INTENT,
};

export const EDIT_TOOL_NAMES = new Set([
  EDIT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);

export const BASH_PTY_TOOL_NAMES = new Set<string>([
  BASH_INPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
]);

/** Persistent task tools that mutate task-list state (create/update). */
/** Task-orchestration tools, as a reusable group. */
export const TASK_ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
];

/** Cron-scheduling tools, as a reusable group. */
export const CRON_TOOL_NAMES: readonly string[] = [
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
];

export const TASK_MUTATION_TOOL_NAMES = new Set<string>([
  TASK_CREATE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]);

/**
 * Main-session control tools that must not flow into a fresh subagent through
 * wildcard/default inheritance. Fork agents deliberately bypass this filter
 * because their contract is to reuse the caller's exact tool surface.
 */
export const FRESH_SUBAGENT_DISALLOWED_TOOLS: readonly string[] = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  SCHEDULE_WAKEUP_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  ...BASH_PTY_TOOL_NAMES,
  // Costly media generation is main-session-only
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_RETRIEVE_TOOL_NAME,
];

/**
 * Built-in work tools retained by background fresh agents. MCP tools are
 * handled separately and always remain eligible; contextual tools such as
 * StructuredOutput and teammate controls are appended after this filter.
 */
export const BACKGROUND_SUBAGENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  POWERSHELL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SHELL_TOOL_NAME,
  MONITOR_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  SKILL_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  AGENT_TOOL_NAME,
]);

/** Extra orchestration tools retained only by background teammates. */
export const BACKGROUND_TEAMMATE_ADDITIONAL_ALLOWED_TOOLS: ReadonlySet<string> =
  new Set([...TASK_ORCHESTRATION_TOOL_NAMES, ...CRON_TOOL_NAMES]);

/**
 * Tools disallowed for read-only subagents (Explore, Plan) that inherit
 * all parent tools via full-inheritance (no toolConfig) and then blacklist
 * write/control/non-search tools.
 *
 * See docs/design/subagent-tool-allocation.md
 */
export const READ_ONLY_SUBAGENT_DISALLOWED_TOOLS: readonly string[] = [
  // Every main-session control tool a fresh subagent already loses, so the two
  // policies cannot drift apart.
  ...FRESH_SUBAGENT_DISALLOWED_TOOLS,
  // Write tools
  ...EDIT_TOOL_NAMES,
  // Control/coordination beyond the fresh-agent filter
  AGENT_TOOL_NAME,
  // Non-search CLI-specific tools
  IMAGE_GEN_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  ...CRON_TOOL_NAMES,
  ...TASK_ORCHESTRATION_TOOL_NAMES,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  CODEBASE_INVESTIGATOR_TOOL_NAME,
];

/**
 * Tools that require mandatory argument narrowing (e.g., file paths, command prefixes)
 * when granting persistent or session-wide approval.
 */
export const TOOLS_REQUIRING_NARROWING = new Set([
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
]);

// Tool Display Names
export const WRITE_FILE_DISPLAY_NAME = 'Write';
export const EDIT_DISPLAY_NAME = 'Edit';
export const ASK_USER_DISPLAY_NAME = 'AskUserQuestion';
export const READ_FILE_DISPLAY_NAME = 'Read';
export const GLOB_DISPLAY_NAME = 'Glob';
export const GREP_DISPLAY_NAME = 'Grep';
export const WEB_SEARCH_DISPLAY_NAME = 'WebSearch';
export const IMAGE_SEARCH_DISPLAY_NAME = 'ImageSearch';
export const WEB_FETCH_DISPLAY_NAME = 'WebFetch';
export const IMAGE_GEN_DISPLAY_NAME = 'ImageGen';
export const NOTEBOOK_EDIT_DISPLAY_NAME = 'NotebookEdit';
export const CRON_CREATE_DISPLAY_NAME = 'CronCreate';
export const CRON_DELETE_DISPLAY_NAME = 'CronDelete';
export const CRON_LIST_DISPLAY_NAME = 'CronList';
export const SCHEDULE_WAKEUP_DISPLAY_NAME = 'ScheduleWakeup';

/**
 * Mapping of legacy tool names to their current canonical names.
 * Add entries here when renaming tools after production release to maintain
 * backward compatibility for user-defined policies, skills, and hooks.
 */
export const TOOL_LEGACY_ALIASES: Record<string, string> = {};
TOOL_LEGACY_ALIASES[RUN_WORKFLOW_TOOL_NAME] = WORKFLOW_TOOL_NAME;
TOOL_LEGACY_ALIASES[LIST_AGENTS_LEGACY_ALIAS] = LIST_AGENTS_TOOL_NAME;

/**
 * Resolve a tool name to its canonical name.
 * Always resolves legacy aliases.
 */
export function resolveToolName(name: string): string {
  // Legacy aliases always apply
  if (TOOL_LEGACY_ALIASES[name]) return TOOL_LEGACY_ALIASES[name];
  return name;
}

/**
 * Returns all associated names for a tool (including legacy aliases and current name).
 * This ensures that if multiple legacy names point to the same tool, we consider all of them
 * for policy application.
 */
export function getToolAliases(name: string): string[] {
  const aliases = new Set<string>([name]);

  // Determine the canonical (current) name
  const canonicalName = resolveToolName(name);
  aliases.add(canonicalName);

  // Find all other legacy aliases that point to the same canonical name
  for (const [legacyName, currentName] of Object.entries(TOOL_LEGACY_ALIASES)) {
    if (currentName === canonicalName) {
      aliases.add(legacyName);
    }
  }

  return Array.from(aliases);
}

/**
 * List of all built-in tool names.
 */
import {
  isMcpToolName,
  parseMcpToolName,
  MCP_TOOL_PREFIX,
} from '../mcp/tools/mcp-names.js';

export const ALL_BUILTIN_TOOL_NAMES = [
  // Include dynamically enabled tools so an explicit --tools allowlist still applies.
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  MONITOR_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  BASH_INPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  COMPLETE_TASK_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_RETRIEVE_TOOL_NAME,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  SCHEDULE_WAKEUP_TOOL_NAME,
  // The unified Agent tool (dispatches to explore, plan, general-purpose, etc. via subagent_type).
  // Individual agent names (explore, plan) are NOT standalone tools — they are agent
  // definitions dispatched through the unified Agent tool's subagent_type parameter.
  AGENT_TOOL_NAME,
  // Worktree isolation tools — gated by isWorktreeEnabled()
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  // Messaging. Listed so `--tools` narrows them like any other built-in: left
  // out, an empty `--tools` still handed a headless run these two and nothing
  // else, and with nothing else to do the model went and messaged sessions.
  SEND_MESSAGE_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
] as const;

/**
 * Recognized preset names for the --tools flag.
 * "default" expands to all built-in tools (i.e. no restriction).
 */
export const TOOL_PRESETS = ['default'] as const;
export type ToolPreset = (typeof TOOL_PRESETS)[number];

/**
 * Validates if a tool name is syntactically valid.
 * Checks against built-in tools, discovered tools, and MCP naming conventions.
 */
export function isValidToolName(
  name: string,
  options: { allowWildcards?: boolean } = {},
): boolean {
  // Built-in tools
  if ((ALL_BUILTIN_TOOL_NAMES as readonly string[]).includes(name)) {
    return true;
  }

  // Legacy aliases
  if (TOOL_LEGACY_ALIASES[name]) {
    return true;
  }

  // Policy wildcards
  if (options.allowWildcards && name === '*') {
    return true;
  }

  // Handle standard MCP FQNs (mcp__server__tool or wildcards mcp__*, mcp__server__*)
  if (isMcpToolName(name)) {
    // Global wildcard: mcp__*
    if (name === `${MCP_TOOL_PREFIX}*` && options.allowWildcards) {
      return true;
    }

    const parsed = parseMcpToolName(name);
    if (parsed.serverName && parsed.toolName) {
      // Segments must match the normalized MCP charset (no consecutive _,
      // no leading/trailing _), see normalizeMcpSegment.
      const slugRegex = /^[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*$/;

      if (!slugRegex.test(parsed.serverName)) {
        return false;
      }

      if (parsed.toolName === '*') {
        return options.allowWildcards === true;
      }

      return slugRegex.test(parsed.toolName);
    }

    return false;
  }

  // Agent(name) or Agent(name1, name2) syntax for subagent references
  const agentNames = parseAgentToolExpression(name);
  if (agentNames) {
    return agentNames.every((n) => /^[a-zA-Z0-9_-]+$/.test(n));
  }

  return false;
}

/**
 * Parses an `Agent(name1, name2, ...)` expression and returns the list of
 * agent names inside. Returns `undefined` if the string is not an Agent(...)
 * expression.
 */
export function parseAgentToolExpression(expr: string): string[] | undefined {
  const match = expr.match(/^Agent\(([^)]+)\)$/);
  if (!match) return undefined;
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Collects agent type names from an iterable of tool spec strings by
 * extracting names from `Agent(name1, name2)` expressions.
 */
export function collectAgentNamesFromToolSpecs(
  specs: Iterable<string>,
): Set<string> {
  const names = new Set<string>();
  for (const spec of specs) {
    const agentNames = parseAgentToolExpression(spec);
    if (agentNames) {
      for (const name of agentNames) names.add(name);
    }
  }
  return names;
}

/**
 * Unregisters tools from a registry, handling `Agent(name1, name2)` expressions
 * by either unregistering individual agent names (legacy) or disabling agent
 * types on the unified Agent tool.
 *
 * @param disallowedTools - List of tool names or Agent() expressions to disable
 * @param unregister - Callback to unregister a tool by name
 * @param disableAgentType - Optional callback to disable a specific agent type
 *   on the unified Agent tool. When provided, Agent() expressions disable
 *   types instead of unregistering by name.
 */
export function applyDisallowedTools(
  disallowedTools: string[],
  unregister: (name: string) => void,
  disableAgentType?: (name: string) => void,
): void {
  for (const toolName of disallowedTools) {
    const agentNames = parseAgentToolExpression(toolName);
    if (agentNames) {
      if (disableAgentType) {
        // Unified Agent tool: disable specific agent types
        for (const agentName of agentNames) {
          disableAgentType(agentName);
        }
      } else {
        // Legacy fallback: unregister by name
        for (const agentName of agentNames) {
          unregister(agentName);
        }
      }
    } else {
      unregister(toolName);
    }
  }
}
