/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookType } from './HookManager.js';

export interface HookConfig {
  type: HookType;
  scriptPath?: string;
  inlineScript?: string;
  enabled?: boolean;
  priority?: number;
  parameters?: Record<string, unknown>;
}

// Claude-compatible hook configuration format
export interface ClaudeHookConfig {
  event: ClaudeHookEvent;
  matcher?: string[] | string;
  command: string; // Path to hook script/command
  timeout?: number; // in seconds
  priority?: number;
  enabled?: boolean;
}

export type ClaudeHookEvent =
  | 'PreToolUse' // Before tool execution
  | 'Stop' // Session end
  | 'SubagentStop' // Subagent end
  | 'InputReceived' // When input is received
  | 'BeforeResponse' // Before AI responds
  | 'AfterResponse' // After AI responds
  | 'SessionStart' // When session starts
  | 'AppStartup' // When app starts
  | 'AppShutdown'; // When app shuts down

// Tool name mapping configuration
export interface ToolNameMapping {
  /** Claude Code tool names as keys, Qwen equivalents as values */
  [claudeToolName: string]: string;
}

export interface HooksSettings {
  /** Global hooks settings */
  enabled?: boolean;
  /** Array of configured hooks (Qwen format) */
  hooks?: HookConfig[];
  /** Array of Claude-compatible hooks (for compatibility) */
  claudeHooks?: ClaudeHookConfig[];
  /** Timeout for hook execution in milliseconds */
  timeoutMs?: number;
}

// Default mapping from Claude Code tools to Qwen Code tools
export const DEFAULT_TOOL_NAME_MAPPING: ToolNameMapping = {
  // Claude Code -> Qwen Code
  Write: 'write_file',
  Edit: 'replace',
  Bash: 'run_shell_command',
  TodoWrite: 'todoWrite',
  NotebookEdit: 'edit_notebook',
  Read: 'read_file',
  Grep: 'grep',
  Glob: 'glob',
  Ls: 'ls',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
};
