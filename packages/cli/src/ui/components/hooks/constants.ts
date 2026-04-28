/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HooksConfigSource, HookEventName } from '@qwen-code/qwen-code-core';
import type { HookExitCode, HookEventDisplayInfo } from './types.js';
import { t } from '../../../i18n/index.js';

/**
 * Exit code descriptions for different hook types
 */
export function getHookExitCodes(eventName: string): HookExitCode[] {
  const exitCodesMap: Record<string, HookExitCode[]> = {
    [HookEventName.Stop]: [
      { code: 0, description: t('stdout/stderr not shown') },
      {
        code: 2,
        description: t('show stderr to model and continue conversation'),
      },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.PreToolUse]: [
      { code: 0, description: t('stdout/stderr not shown') },
      { code: 2, description: t('show stderr to model and block tool call') },
      {
        code: 'Other',
        description: t('show stderr to user only but continue with tool call'),
      },
    ],
    [HookEventName.PostToolUse]: [
      { code: 0, description: t('stdout shown in transcript mode (ctrl+o)') },
      { code: 2, description: t('show stderr to model immediately') },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.PostToolUseFailure]: [
      { code: 0, description: t('stdout shown in transcript mode (ctrl+o)') },
      { code: 2, description: t('show stderr to model immediately') },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.Notification]: [
      { code: 0, description: t('stdout/stderr not shown') },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.UserPromptSubmit]: [
      { code: 0, description: t('stdout shown to Qwen') },
      {
        code: 2,
        description: t(
          'block processing, erase original prompt, and show stderr to user only',
        ),
      },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.SessionStart]: [
      { code: 0, description: t('stdout shown to Qwen') },
      {
        code: 'Other',
        description: t('show stderr to user only (blocking errors ignored)'),
      },
    ],
    [HookEventName.SessionEnd]: [
      { code: 0, description: t('command completes successfully') },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.SubagentStart]: [
      { code: 0, description: t('stdout shown to subagent') },
      {
        code: 'Other',
        description: t('show stderr to user only (blocking errors ignored)'),
      },
    ],
    [HookEventName.SubagentStop]: [
      { code: 0, description: t('stdout/stderr not shown') },
      {
        code: 2,
        description: t('show stderr to subagent and continue having it run'),
      },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.PreCompact]: [
      {
        code: 0,
        description: t('stdout appended as custom compact instructions'),
      },
      { code: 2, description: t('block compaction') },
      {
        code: 'Other',
        description: t('show stderr to user only but continue with compaction'),
      },
    ],
    [HookEventName.PermissionRequest]: [
      { code: 0, description: t('use hook decision if provided') },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.TodoCreated]: [
      { code: 0, description: t('allow todo creation') },
      {
        code: 2,
        description: t('block todo creation and show reason to model'),
      },
      { code: 'Other', description: t('show stderr to user only') },
    ],
    [HookEventName.TodoCompleted]: [
      { code: 0, description: t('allow todo completion') },
      {
        code: 2,
        description: t('block todo completion and show reason to model'),
      },
      { code: 'Other', description: t('show stderr to user only') },
    ],
  };
  return exitCodesMap[eventName] || [];
}

/**
 * Short one-line description for hooks list view
 */
export function getHookShortDescription(eventName: string): string {
  const descriptions: Record<string, string> = {
    [HookEventName.PreToolUse]: t('Before tool execution'),
    [HookEventName.PostToolUse]: t('After tool execution'),
    [HookEventName.PostToolUseFailure]: t('After tool execution fails'),
    [HookEventName.Notification]: t('When notifications are sent'),
    [HookEventName.UserPromptSubmit]: t('When the user submits a prompt'),
    [HookEventName.SessionStart]: t('When a new session is started'),
    [HookEventName.Stop]: t('Right before Qwen Code concludes its response'),
    [HookEventName.SubagentStart]: t(
      'When a subagent (Agent tool call) is started',
    ),
    [HookEventName.SubagentStop]: t(
      'Right before a subagent concludes its response',
    ),
    [HookEventName.PreCompact]: t('Before conversation compaction'),
    [HookEventName.SessionEnd]: t('When a session is ending'),
    [HookEventName.PermissionRequest]: t(
      'When a permission dialog is displayed',
    ),
    [HookEventName.TodoCreated]: t('When a new todo item is created'),
    [HookEventName.TodoCompleted]: t('When a todo item is marked as completed'),
  };
  return descriptions[eventName] || '';
}

/**
 * Detailed description for each hook event type (shown in detail view)
 */
export function getHookDescription(eventName: string): string {
  const descriptions: Record<string, string> = {
    [HookEventName.Stop]: '',
    [HookEventName.PreToolUse]: t(
      'Input to command is JSON of tool call arguments.',
    ),
    [HookEventName.PostToolUse]: t(
      'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).',
    ),
    [HookEventName.PostToolUseFailure]: t(
      'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.',
    ),
    [HookEventName.Notification]: t(
      'Input to command is JSON with notification message and type.',
    ),
    [HookEventName.UserPromptSubmit]: t(
      'Input to command is JSON with original user prompt text.',
    ),
    [HookEventName.SessionStart]: t(
      'Input to command is JSON with session start source.',
    ),
    [HookEventName.SessionEnd]: t(
      'Input to command is JSON with session end reason.',
    ),
    [HookEventName.SubagentStart]: t(
      'Input to command is JSON with agent_id and agent_type.',
    ),
    [HookEventName.SubagentStop]: t(
      'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.',
    ),
    [HookEventName.PreCompact]: t(
      'Input to command is JSON with compaction details.',
    ),
    [HookEventName.PermissionRequest]: t(
      'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.',
    ),
    [HookEventName.TodoCreated]: t(
      'Input to command is JSON with todo_id, todo_content, todo_status, and all_todos. Output JSON with decision (allow/block) and reason.',
    ),
    [HookEventName.TodoCompleted]: t(
      'Input to command is JSON with todo_id, todo_content, previous_status, and all_todos. Output JSON with decision (allow/block) and reason.',
    ),
  };
  return descriptions[eventName] || '';
}

/**
 * Source display mapping (translated)
 */
export function getTranslatedSourceDisplayMap(): Record<
  HooksConfigSource,
  string
> {
  return {
    [HooksConfigSource.Project]: t('Local Settings'),
    [HooksConfigSource.User]: t('User Settings'),
    [HooksConfigSource.System]: t('System Settings'),
    [HooksConfigSource.Extensions]: t('Extensions'),
    [HooksConfigSource.Session]: t('Session (temporary)'),
  };
}

/**
 * List of hook events to display in the UI
 * Automatically synced with HookEventName enum from core.
 * Note: Order follows the enum definition order. If UI presentation order
 * needs to be different (e.g., grouped by lifecycle phase), consider using
 * an explicit sorted array instead. Current enum order is acceptable for display.
 */
export const DISPLAY_HOOK_EVENTS: HookEventName[] =
  Object.values(HookEventName);

/**
 * Create empty hook event display info
 */
export function createEmptyHookEventInfo(
  eventName: HookEventName,
): HookEventDisplayInfo {
  return {
    event: eventName,
    shortDescription: getHookShortDescription(eventName),
    description: getHookDescription(eventName),
    exitCodes: getHookExitCodes(eventName),
    configs: [],
  };
}
