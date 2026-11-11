/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Hook event payload shapes (WIRE).
 *
 * The HookCallback function signature lives in the SDK package — only the
 * input/output data shapes are wire-protocol concerns and live here.
 */
import type { SDKAssistantMessageError, ExitReason } from './common.js';
import type { PermissionBehavior, PermissionUpdate } from './permissions.js';
export type BaseHookInput = {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode?: string;
    agent_id?: string;
    agent_type?: string;
};
export type PreToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PreToolUse';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
};
export type PostToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PostToolUse';
    tool_name: string;
    tool_input: unknown;
    tool_response: unknown;
    tool_use_id: string;
};
export type PostToolUseFailureHookInput = BaseHookInput & {
    hook_event_name: 'PostToolUseFailure';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
    error: string;
    is_interrupt?: boolean;
};
export type UserPromptSubmitHookInput = BaseHookInput & {
    hook_event_name: 'UserPromptSubmit';
    prompt: string;
};
export type SessionStartHookInput = BaseHookInput & {
    hook_event_name: 'SessionStart';
    source: 'startup' | 'resume' | 'clear' | 'compact';
    agent_type?: string;
    model?: string;
};
export type SessionEndHookInput = BaseHookInput & {
    hook_event_name: 'SessionEnd';
    reason: ExitReason;
};
export type StopHookInput = BaseHookInput & {
    hook_event_name: 'Stop';
    stop_hook_active: boolean;
    last_assistant_message?: string;
};
export type StopFailureHookInput = BaseHookInput & {
    hook_event_name: 'StopFailure';
    error: SDKAssistantMessageError;
    error_details?: string;
    last_assistant_message?: string;
};
export type SubagentStartHookInput = BaseHookInput & {
    hook_event_name: 'SubagentStart';
    agent_id: string;
    agent_type: string;
};
export type SubagentStopHookInput = BaseHookInput & {
    hook_event_name: 'SubagentStop';
    stop_hook_active: boolean;
    agent_id: string;
    agent_transcript_path: string;
    agent_type: string;
    last_assistant_message?: string;
};
export type PreCompactHookInput = BaseHookInput & {
    hook_event_name: 'PreCompact';
    trigger: 'manual' | 'auto';
    custom_instructions: string | null;
};
export type PostCompactHookInput = BaseHookInput & {
    hook_event_name: 'PostCompact';
    trigger: 'manual' | 'auto';
    compact_summary: string;
};
export type PermissionRequestHookInput = BaseHookInput & {
    hook_event_name: 'PermissionRequest';
    tool_name: string;
    tool_input: unknown;
    permission_suggestions?: PermissionUpdate[];
};
export type PermissionDeniedHookInput = BaseHookInput & {
    hook_event_name: 'PermissionDenied';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
    denial_reason?: string;
};
export type SetupHookInput = BaseHookInput & {
    hook_event_name: 'Setup';
    trigger: 'init' | 'maintenance';
};
export type TeammateIdleHookInput = BaseHookInput & {
    hook_event_name: 'TeammateIdle';
    teammate_name: string;
    team_name: string;
};
export type TaskCreatedHookInput = BaseHookInput & {
    hook_event_name: 'TaskCreated';
    task_id: string;
    task_subject: string;
    task_description?: string;
    teammate_name?: string;
    team_name?: string;
};
export type TaskCompletedHookInput = BaseHookInput & {
    hook_event_name: 'TaskCompleted';
    task_id: string;
    task_subject: string;
    task_description?: string;
    teammate_name?: string;
    team_name?: string;
};
export type ElicitationHookInput = BaseHookInput & {
    hook_event_name: 'Elicitation';
    mcp_server_name: string;
    message: string;
    mode?: 'form' | 'url';
    url?: string;
    elicitation_id?: string;
    requested_schema?: Record<string, unknown>;
};
export type ElicitationResultHookInput = BaseHookInput & {
    hook_event_name: 'ElicitationResult';
    mcp_server_name: string;
    elicitation_id?: string;
    mode?: 'form' | 'url';
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
};
export type ConfigChangeHookInput = BaseHookInput & {
    hook_event_name: 'ConfigChange';
    source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills';
    file_path?: string;
};
export type WorktreeCreateHookInput = BaseHookInput & {
    hook_event_name: 'WorktreeCreate';
    name: string;
};
export type WorktreeRemoveHookInput = BaseHookInput & {
    hook_event_name: 'WorktreeRemove';
    worktree_path: string;
};
export type InstructionsLoadedHookInput = BaseHookInput & {
    hook_event_name: 'InstructionsLoaded';
    file_path: string;
    memory_type: 'User' | 'Project' | 'Local' | 'Managed';
    load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact';
    globs?: string[];
    trigger_file_path?: string;
    parent_file_path?: string;
};
export type CwdChangedHookInput = BaseHookInput & {
    hook_event_name: 'CwdChanged';
    old_cwd: string;
    new_cwd: string;
};
export type FileChangedHookInput = BaseHookInput & {
    hook_event_name: 'FileChanged';
    file_path: string;
    event: 'change' | 'add' | 'unlink';
};
export type HookInput = PreToolUseHookInput | PostToolUseHookInput | PostToolUseFailureHookInput | UserPromptSubmitHookInput | SessionStartHookInput | SessionEndHookInput | StopHookInput | StopFailureHookInput | SubagentStartHookInput | SubagentStopHookInput | PreCompactHookInput | PostCompactHookInput | PermissionRequestHookInput | PermissionDeniedHookInput | SetupHookInput | TeammateIdleHookInput | TaskCreatedHookInput | TaskCompletedHookInput | ElicitationHookInput | ElicitationResultHookInput | ConfigChangeHookInput | InstructionsLoadedHookInput | WorktreeCreateHookInput | WorktreeRemoveHookInput | CwdChangedHookInput | FileChangedHookInput;
export type PreToolUseHookSpecificOutput = {
    hookEventName: 'PreToolUse';
    permissionDecision?: PermissionBehavior;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
};
export type PostToolUseHookSpecificOutput = {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
    updatedMCPToolOutput?: unknown;
};
export type PostToolUseFailureHookSpecificOutput = {
    hookEventName: 'PostToolUseFailure';
    additionalContext?: string;
};
export type UserPromptSubmitHookSpecificOutput = {
    hookEventName: 'UserPromptSubmit';
    additionalContext?: string;
};
export type SessionStartHookSpecificOutput = {
    hookEventName: 'SessionStart';
    additionalContext?: string;
    initialUserMessage?: string;
    watchPaths?: string[];
};
export type SetupHookSpecificOutput = {
    hookEventName: 'Setup';
    additionalContext?: string;
};
export type SubagentStartHookSpecificOutput = {
    hookEventName: 'SubagentStart';
    additionalContext?: string;
};
export type PermissionRequestHookSpecificOutput = {
    hookEventName: 'PermissionRequest';
    decision: {
        behavior: 'allow';
        updatedInput?: Record<string, unknown>;
        updatedPermissions?: PermissionUpdate[];
    } | {
        behavior: 'deny';
        message?: string;
        interrupt?: boolean;
    };
};
export type ElicitationHookSpecificOutput = {
    hookEventName: 'Elicitation';
    action?: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
};
export type ElicitationResultHookSpecificOutput = {
    hookEventName: 'ElicitationResult';
    action?: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
};
export type CwdChangedHookSpecificOutput = {
    hookEventName: 'CwdChanged';
    watchPaths?: string[];
};
export type FileChangedHookSpecificOutput = {
    hookEventName: 'FileChanged';
    watchPaths?: string[];
};
export type WorktreeCreateHookSpecificOutput = {
    hookEventName: 'WorktreeCreate';
    worktreePath: string;
};
export type SyncHookJSONOutput = {
    continue?: boolean;
    suppressOutput?: boolean;
    stopReason?: string;
    decision?: 'approve' | 'block';
    systemMessage?: string;
    reason?: string;
    hookSpecificOutput?: PreToolUseHookSpecificOutput | UserPromptSubmitHookSpecificOutput | SessionStartHookSpecificOutput | SetupHookSpecificOutput | SubagentStartHookSpecificOutput | PostToolUseHookSpecificOutput | PostToolUseFailureHookSpecificOutput | PermissionRequestHookSpecificOutput | ElicitationHookSpecificOutput | ElicitationResultHookSpecificOutput | CwdChangedHookSpecificOutput | FileChangedHookSpecificOutput | WorktreeCreateHookSpecificOutput;
};
export type AsyncHookJSONOutput = {
    async: true;
    asyncTimeout?: number;
};
export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'PostCompact' | 'PermissionRequest' | 'PermissionDenied' | 'Setup' | 'TeammateIdle' | 'TaskCreated' | 'TaskCompleted' | 'Elicitation' | 'ElicitationResult' | 'ConfigChange' | 'WorktreeCreate' | 'WorktreeRemove' | 'InstructionsLoaded' | 'CwdChanged' | 'FileChanged';