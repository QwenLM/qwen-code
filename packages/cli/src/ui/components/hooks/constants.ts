/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HooksConfigSource, HookEventName } from '@qwen-code/qwen-code-core';
import type { HookExitCode, HookEventDisplayInfo } from './types.js';

/**
 * Exit code descriptions for different hook types
 */
export const HOOK_EXIT_CODES: Record<string, HookExitCode[]> = {
  [HookEventName.Stop]: [
    { code: 0, description: 'stdout/stderr not shown' },
    { code: 2, description: 'show stderr to model and continue conversation' },
    { code: 'Other', description: 'show stderr to user only' },
  ],
  [HookEventName.PreToolUse]: [
    { code: 0, description: 'stdout/stderr not shown' },
    { code: 2, description: 'show stderr to model and block tool call' },
    {
      code: 'Other',
      description: 'show stderr to user only but continue with tool call',
    },
  ],
  [HookEventName.PostToolUse]: [
    { code: 0, description: 'stdout shown in transcript mode (ctrl+o)' },
    { code: 2, description: 'show stderr to model immediately' },
    { code: 'Other', description: 'show stderr to user only' },
  ],
  [HookEventName.PostToolUseFailure]: [
    { code: 0, description: 'stdout shown in transcript mode (ctrl+o)' },
    { code: 2, description: 'show stderr to model immediately' },
    { code: 'Other', description: 'show stderr to user only' },
  ],
  [HookEventName.Notification]: [
    { code: 0, description: 'stdout/stderr not shown' },
    { code: 'Other', description: 'show stderr to user only' },
  ],
  [HookEventName.UserPromptSubmit]: [
    { code: 0, description: 'stdout shown to model' },
    {
      code: 2,
      description:
        'block processing, erase original prompt, and show stderr to user only',
    },
    { code: 'Other', description: 'show stderr to user only' },
  ],
  [HookEventName.SessionStart]: [
    { code: 0, description: 'stdout shown to model' },
    {
      code: 'Other',
      description: 'show stderr to user only (blocking errors ignored)',
    },
  ],
  [HookEventName.SessionEnd]: [
    { code: 0, description: 'command completes successfully' },
    { code: 'Other', description: 'show stderr to user only' },
  ],
  [HookEventName.SubagentStart]: [
    { code: 0, description: 'stdout shown to subagent' },
    {
      code: 'Other',
      description: 'show stderr to user only (blocking errors ignored)',
    },
  ],
  [HookEventName.SubagentStop]: [
    { code: 0, description: 'stdout/stderr not shown' },
    {
      code: 2,
      description: 'show stderr to subagent and continue having it run',
    },
    { code: 'Other', description: 'show stderr to user only' },
  ],
  [HookEventName.PreCompact]: [
    { code: 0, description: 'stdout appended as custom compact instructions' },
    { code: 2, description: 'block compaction' },
    {
      code: 'Other',
      description: 'show stderr to user only but continue with compaction',
    },
  ],
  [HookEventName.PermissionRequest]: [
    { code: 0, description: 'use hook decision if provided' },
    { code: 'Other', description: 'show stderr to user only' },
  ],
};

/**
 * Short one-line description for hooks list view
 */
export const HOOK_SHORT_DESCRIPTIONS: Record<string, string> = {
  [HookEventName.PreToolUse]: 'Before tool execution',
  [HookEventName.PostToolUse]: 'After tool execution',
  [HookEventName.PostToolUseFailure]: 'After tool execution fails',
  [HookEventName.Notification]: 'When notifications are sent',
  [HookEventName.UserPromptSubmit]: 'When the user submits a prompt',
  [HookEventName.SessionStart]: 'When a new session is started',
  [HookEventName.Stop]: 'Right before Qwen Code concludes its response',
  [HookEventName.SubagentStart]: 'When a subagent (Agent tool call) is started',
  [HookEventName.SubagentStop]:
    'Right before a subagent concludes its response',
  [HookEventName.PreCompact]: 'Before conversation compaction',
  [HookEventName.SessionEnd]: 'When a session is ending',
  [HookEventName.PermissionRequest]: 'When a permission dialog is displayed',
};

/**
 * Detailed description for each hook event type (shown in detail view)
 */
export const HOOK_DESCRIPTIONS: Record<string, string> = {
  [HookEventName.Stop]: '',
  [HookEventName.PreToolUse]:
    'Input to command is JSON of tool call arguments.',
  [HookEventName.PostToolUse]:
    'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).',
  [HookEventName.PostToolUseFailure]:
    'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.',
  [HookEventName.Notification]:
    'Input to command is JSON with notification message and type.',
  [HookEventName.UserPromptSubmit]:
    'Input to command is JSON with original user prompt text.',
  [HookEventName.SessionStart]:
    'Input to command is JSON with session start source.',
  [HookEventName.SessionEnd]:
    'Input to command is JSON with session end reason.',
  [HookEventName.SubagentStart]:
    'Input to command is JSON with agent_id and agent_type.',
  [HookEventName.SubagentStop]:
    'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.',
  [HookEventName.PreCompact]:
    'Input to command is JSON with compaction details.',
  [HookEventName.PermissionRequest]:
    'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.',
};

/**
 * Source display mapping
 */
export const SOURCE_DISPLAY_MAP: Record<HooksConfigSource, string> = {
  [HooksConfigSource.Project]: 'Local Settings',
  [HooksConfigSource.User]: 'User Settings',
  [HooksConfigSource.System]: 'System Settings',
  [HooksConfigSource.Extensions]: 'Extensions',
};

/**
 * List of hook events to display in the UI
 */
export const DISPLAY_HOOK_EVENTS: HookEventName[] = [
  HookEventName.Stop,
  HookEventName.PreToolUse,
  HookEventName.PostToolUse,
  HookEventName.PostToolUseFailure,
  HookEventName.Notification,
  HookEventName.UserPromptSubmit,
  HookEventName.SessionStart,
  HookEventName.SessionEnd,
  HookEventName.SubagentStart,
  HookEventName.SubagentStop,
  HookEventName.PreCompact,
  HookEventName.PermissionRequest,
];

/**
 * Create empty hook event display info
 */
export function createEmptyHookEventInfo(
  eventName: HookEventName,
): HookEventDisplayInfo {
  return {
    event: eventName,
    shortDescription: HOOK_SHORT_DESCRIPTIONS[eventName] || '',
    description: HOOK_DESCRIPTIONS[eventName] || '',
    exitCodes: HOOK_EXIT_CODES[eventName] || [],
    configs: [],
  };
}
