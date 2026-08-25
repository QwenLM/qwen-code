/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool name constants to avoid circular dependencies.
 * These constants are used across multiple files and should be kept in sync
 * with the actual tool class names.
 *
 * Filesystem-path-bearing tools (whose inputs name actual project files)
 * also need to be added to `FS_PATH_TOOL_NAMES` in
 * `core/coreToolScheduler.ts` so conditional rules and path-conditional
 * skill activation see the touched paths. Forgetting that registration
 * silently skips the activation pipeline for that tool — there is no
 * compile-time guard. (TODO: replace the manual allowlist with a
 * per-declaration `pathFields?: string[]` annotation on the tool class.)
 */
export const ToolNames = {
  EDIT: 'edit',
  WRITE_FILE: 'write_file',
  READ_FILE: 'read_file',
  ZOOM_IMAGE: 'zoom_image',
  GREP: 'grep_search',
  GLOB: 'glob',
  SHELL: 'run_shell_command',
  TODO_WRITE: 'todo_write',
  MEMORY: 'save_memory',
  AGENT: 'agent',
  SKILL: 'skill',
  EXIT_PLAN_MODE: 'exit_plan_mode',
  ENTER_PLAN_MODE: 'enter_plan_mode',
  WEB_FETCH: 'web_fetch',
  WEB_SEARCH: 'web_search',
  IMAGE_GEN: 'image_gen',
  LS: 'list_directory',
  LSP: 'lsp',
  ASK_USER_QUESTION: 'ask_user_question',
  CRON_CREATE: 'cron_create',
  CRON_LIST: 'cron_list',
  CRON_DELETE: 'cron_delete',
  LOOP_WAKEUP: 'loop_wakeup',
  CREATE_SUB_SESSION: 'create_sub_session',
  LIST_AGENTS: 'list_agents',
  TASK_STOP: 'task_stop',
  TASK_CREATE: 'task_create',
  TASK_UPDATE: 'task_update',
  TASK_LIST: 'task_list',
  TEAM_CREATE: 'team_create',
  TEAM_DELETE: 'team_delete',
  TEAM_PLAN_APPROVAL: 'team_plan_approval',
  REQUEST_SHUTDOWN: 'request_shutdown',
  SEND_MESSAGE: 'send_message',
  STRUCTURED_OUTPUT: 'structured_output',
  MONITOR: 'monitor',
  NOTEBOOK_EDIT: 'notebook_edit',
  TOOL_SEARCH: 'tool_search',
  READ_MCP_RESOURCE: 'read_mcp_resource',
  ENTER_WORKTREE: 'enter_worktree',
  EXIT_WORKTREE: 'exit_worktree',
  WORKFLOW: 'workflow',
  ARTIFACT: 'artifact',
  RECORD_ARTIFACT: 'record_artifact',
  REPORT_FINDINGS: 'report_findings',
  GET_GOAL: 'get_goal',
  UPDATE_GOAL: 'update_goal',
  DISPLAY_IMAGE: 'display_image',
} as const;

/**
 * Tool display name constants to avoid circular dependencies.
 * These constants are used across multiple files and should be kept in sync
 * with the actual tool display names.
 */
export const ToolDisplayNames = {
  EDIT: 'Edit',
  WRITE_FILE: 'WriteFile',
  READ_FILE: 'ReadFile',
  ZOOM_IMAGE: 'ZoomImage',
  GREP: 'Grep',
  GLOB: 'Glob',
  SHELL: 'Shell',
  TODO_WRITE: 'TodoList',
  MEMORY: 'SaveMemory',
  AGENT: 'Agent',
  SKILL: 'Skill',
  EXIT_PLAN_MODE: 'ExitPlanMode',
  ENTER_PLAN_MODE: 'EnterPlanMode',
  WEB_FETCH: 'WebFetch',
  WEB_SEARCH: 'WebSearch',
  IMAGE_GEN: 'ImageGen',
  LS: 'ListFiles',
  LSP: 'Lsp',
  ASK_USER_QUESTION: 'AskUserQuestion',
  CRON_CREATE: 'CronCreate',
  CRON_LIST: 'CronList',
  CRON_DELETE: 'CronDelete',
  LOOP_WAKEUP: 'LoopWakeup',
  CREATE_SUB_SESSION: 'CreateSubSession',
  LIST_AGENTS: 'ListAgents',
  TASK_STOP: 'TaskStop',
  TASK_CREATE: 'TaskCreate',
  TASK_UPDATE: 'TaskUpdate',
  TASK_LIST: 'TaskList',
  TEAM_CREATE: 'TeamCreate',
  TEAM_DELETE: 'TeamDelete',
  TEAM_PLAN_APPROVAL: 'TeamPlanApproval',
  REQUEST_SHUTDOWN: 'RequestShutdown',
  SEND_MESSAGE: 'SendMessage',
  STRUCTURED_OUTPUT: 'StructuredOutput',
  MONITOR: 'Monitor',
  NOTEBOOK_EDIT: 'NotebookEdit',
  TOOL_SEARCH: 'ToolSearch',
  READ_MCP_RESOURCE: 'ReadMcpResource',
  ENTER_WORKTREE: 'EnterWorktree',
  EXIT_WORKTREE: 'ExitWorktree',
  WORKFLOW: 'Workflow',
  ARTIFACT: 'Artifact',
  RECORD_ARTIFACT: 'RecordArtifact',
  REPORT_FINDINGS: 'ReportFindings',
  GET_GOAL: 'Goal',
  UPDATE_GOAL: 'UpdateGoal',
  DISPLAY_IMAGE: 'DisplayImage',
} as const;

// Migration from old tool names to new tool names
// These legacy tool names were used in earlier versions and need to be supported
// for backward compatibility with existing user configurations
export const ToolNamesMigration = {
  search_file_content: ToolNames.GREP, // Legacy name from grep tool
  replace: ToolNames.EDIT, // Legacy name from edit tool
  task: ToolNames.AGENT, // Legacy name from agent tool (renamed from task)
} as const;

/**
 * Resolve a tool name through the legacy-alias migration map (e.g.
 * `search_file_content` → `grep_search`) to its canonical form. The single
 * alias-resolution site: every caller that classifies or keys tool calls by
 * name — the scheduler, loop detection, plan redaction, memory refresh, the
 * headless partitioner in nonInteractiveCli, the daemon/ACP session — must
 * use this so an aliased call is treated identically everywhere.
 */
export function canonicalToolName(toolName: string): string {
  return (ToolNamesMigration as Record<string, string>)[toolName] ?? toolName;
}

// Migration from old tool display names to new tool display names
// These legacy display names were used before the tool naming standardization
export const ToolDisplayNamesMigration = {
  SearchFiles: ToolDisplayNames.GREP, // Old display name for Grep
  FindFiles: ToolDisplayNames.GLOB, // Old display name for Glob
  ReadFolder: ToolDisplayNames.LS, // Old display name for ListFiles
  Task: ToolDisplayNames.AGENT, // Old display name for Agent (renamed from Task)
  TodoWrite: ToolDisplayNames.TODO_WRITE, // Old display name for TodoList (renamed from TodoWrite)
} as const;
