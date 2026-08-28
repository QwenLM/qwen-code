/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { canonicalToolName, ToolNames } from './tool-names.js';
import { ToolMode } from './tool-mode.js';

export enum ToolExposure {
  CodeModeControl = 'code_mode_control',
  DirectOnly = 'direct_only',
  CodeModeCallable = 'code_mode_callable',
  Hidden = 'hidden',
}

const HIDDEN_TOOLS = new Set<string>([
  ToolNames.TOOL_SEARCH,
  ToolNames.TOOL_CALL,
]);

const DIRECT_ONLY_TOOLS = new Set<string>([
  ToolNames.ASK_USER_QUESTION,
  ToolNames.AGENT,
  ToolNames.SKILL,
  ToolNames.ENTER_PLAN_MODE,
  ToolNames.EXIT_PLAN_MODE,
  ToolNames.GET_GOAL,
  ToolNames.UPDATE_GOAL,
  ToolNames.STRUCTURED_OUTPUT,
  ToolNames.CREATE_SUB_SESSION,
  ToolNames.ENTER_WORKTREE,
  ToolNames.EXIT_WORKTREE,
  ToolNames.LIST_AGENTS,
  ToolNames.TASK_STOP,
  ToolNames.SEND_MESSAGE,
  ToolNames.TEAM_CREATE,
  ToolNames.TEAM_DELETE,
  ToolNames.TEAM_PLAN_APPROVAL,
  ToolNames.REQUEST_SHUTDOWN,
  ToolNames.TASK_CREATE,
  ToolNames.TASK_UPDATE,
  ToolNames.TASK_LIST,
  'capture_screen_context',
  'speak_to_user',
  'list_threads',
  'read_thread',
  'wait_threads',
  'send_message_to_thread',
  'create_thread',
]);

export function getToolExposure(name: string): ToolExposure {
  const canonicalName = canonicalToolName(name);
  if (canonicalName === ToolNames.EXEC) {
    return ToolExposure.CodeModeControl;
  }
  if (HIDDEN_TOOLS.has(canonicalName)) {
    return ToolExposure.Hidden;
  }
  if (DIRECT_ONLY_TOOLS.has(canonicalName)) {
    return ToolExposure.DirectOnly;
  }
  return ToolExposure.CodeModeCallable;
}

export function isModelVisibleTool(name: string, mode: ToolMode): boolean {
  if (mode === ToolMode.Direct) {
    return name !== ToolNames.EXEC;
  }
  const exposure = getToolExposure(name);
  return (
    exposure === ToolExposure.CodeModeControl ||
    exposure === ToolExposure.DirectOnly
  );
}

export function isCodeModeCallableTool(name: string): boolean {
  return getToolExposure(name) === ToolExposure.CodeModeCallable;
}
