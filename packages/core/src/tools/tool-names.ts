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
  GREP: 'grep_search',
  GLOB: 'glob',
  SHELL: 'run_shell_command',
  TODO_WRITE: 'todo_write',
  MEMORY: 'save_memory',
  AGENT: 'agent',
  SKILL: 'skill',
  EXIT_PLAN_MODE: 'exit_plan_mode',
  WEB_FETCH: 'web_fetch',
  LS: 'list_directory',
  LSP: 'lsp',
  ASK_USER_QUESTION: 'ask_user_question',
  CRON_CREATE: 'cron_create',
  CRON_LIST: 'cron_list',
  CRON_DELETE: 'cron_delete',
  TASK_STOP: 'task_stop',
  SEND_MESSAGE: 'send_message',
  STRUCTURED_OUTPUT: 'structured_output',
  MONITOR: 'monitor',
  TOOL_SEARCH: 'tool_search',
  ENTER_WORKTREE: 'enter_worktree',
  EXIT_WORKTREE: 'exit_worktree',
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
  GREP: 'Grep',
  GLOB: 'Glob',
  SHELL: 'Shell',
  TODO_WRITE: 'TodoWrite',
  MEMORY: 'SaveMemory',
  AGENT: 'Agent',
  SKILL: 'Skill',
  EXIT_PLAN_MODE: 'ExitPlanMode',
  WEB_FETCH: 'WebFetch',
  LS: 'ListFiles',
  LSP: 'Lsp',
  ASK_USER_QUESTION: 'AskUserQuestion',
  CRON_CREATE: 'CronCreate',
  CRON_LIST: 'CronList',
  CRON_DELETE: 'CronDelete',
  TASK_STOP: 'TaskStop',
  SEND_MESSAGE: 'SendMessage',
  STRUCTURED_OUTPUT: 'StructuredOutput',
  MONITOR: 'Monitor',
  TOOL_SEARCH: 'ToolSearch',
  ENTER_WORKTREE: 'EnterWorktree',
  EXIT_WORKTREE: 'ExitWorktree',
} as const;

// Migration from old tool names to new tool names
// These legacy tool names were used in earlier versions and need to be supported
// for backward compatibility with existing user configurations
export const ToolNamesMigration = {
  search_file_content: ToolNames.GREP, // Legacy name from grep tool
  replace: ToolNames.EDIT, // Legacy name from edit tool
  task: ToolNames.AGENT, // Legacy name from agent tool (renamed from task)
} as const;

// Migration from old tool display names to new tool display names
// These legacy display names were used before the tool naming standardization
export const ToolDisplayNamesMigration = {
  SearchFiles: ToolDisplayNames.GREP, // Old display name for Grep
  FindFiles: ToolDisplayNames.GLOB, // Old display name for Glob
  ReadFolder: ToolDisplayNames.LS, // Old display name for ListFiles
  Task: ToolDisplayNames.AGENT, // Old display name for Agent (renamed from Task)
} as const;
