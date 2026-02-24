/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export enum HooksConfigSource {
  Project = 'project',
  User = 'user',
  System = 'system',
  Extensions = 'extensions',
}

/**
 * Event names for the hook system
 */
export enum HookEventName {
  // PreToolUse - Before tool execution
  PreToolUse = 'PreToolUse',
  // PostToolUse - After tool execution
  PostToolUse = 'PostToolUse',
  // PostToolUseFailure - After tool execution fails
  PostToolUseFailure = 'PostToolUseFailure',
  // Notification - When notifications are sent
  Notification = 'Notification',
  // UserPromptSubmit - When the user submits a prompt
  UserPromptSubmit = 'UserPromptSubmit',
  // SessionStart - When a new session is started
  SessionStart = 'SessionStart',
  // Stop - Right before Claude concludes its response
  Stop = 'Stop',
  // SubagentStart - When a subagent (Task tool call) is started
  SubagentStart = 'SubagentStart',
  // SubagentStop - Right before a subagent (Task tool call) concludes its response
  SubagentStop = 'SubagentStop',
  // PreCompact - Before conversation compaction
  PreCompact = 'PreCompact',
  // SessionEnd - When a session is ending
  SessionEnd = 'SessionEnd',
  // When a permission dialog is displayed
  PermissionRequest = 'PermissionRequest',
}

/**
 * Fields in the hooks configuration that are not hook event names
 */
export const HOOKS_CONFIG_FIELDS = ['enabled', 'disabled', 'notifications'];

/**
 * Hook configuration entry
 */
export interface CommandHookConfig {
  type: HookType.Command;
  command: string;
  name?: string;
  description?: string;
  timeout?: number;
  source?: HooksConfigSource;
  env?: Record<string, string>;
}

export type HookConfig = CommandHookConfig;

/**
 * Hook definition with matcher
 */
export interface HookDefinition {
  matcher?: string;
  sequential?: boolean;
  hooks: HookConfig[];
}

/**
 * Hook implementation types
 */
export enum HookType {
  Command = 'command',
}

/**
 * Generate a unique key for a hook configuration
 */
export function getHookKey(hook: HookConfig): string {
  const name = hook.name ?? '';
  return name ? `${name}:${hook.command}` : hook.command;
}

/**
 * Decision types for hook outputs
 */
export type HookDecision = 'ask' | 'block' | 'deny' | 'approve' | 'allow';

/**
 * Base hook input - common fields for all events
 */
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  timestamp: string;
}

/**
 * Base hook output - common fields for all events
 */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: HookDecision;
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

/**
 * Factory function to create the appropriate hook output class based on event name
 * Returns specialized HookOutput subclasses for events with specific methods
 */
export function createHookOutput(
  eventName: string,
  data: Partial<HookOutput>,
): DefaultHookOutput {
  switch (eventName) {
    case HookEventName.PreToolUse:
      return new PreToolUseHookOutput(data);
    case HookEventName.Stop:
      return new StopHookOutput(data);
    case HookEventName.PermissionRequest:
      return new PermissionRequestHookOutput(data);
    default:
      return new DefaultHookOutput(data);
  }
}

/**
 * Default implementation of HookOutput with utility methods
 */
export class DefaultHookOutput implements HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: HookDecision;
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;

  constructor(data: Partial<HookOutput> = {}) {
    this.continue = data.continue;
    this.stopReason = data.stopReason;
    this.suppressOutput = data.suppressOutput;
    this.systemMessage = data.systemMessage;
    this.decision = data.decision;
    this.reason = data.reason;
    this.hookSpecificOutput = data.hookSpecificOutput;
  }

  /**
   * Check if this output represents a blocking decision
   */
  isBlockingDecision(): boolean {
    return this.decision === 'block' || this.decision === 'deny';
  }

  /**
   * Check if this output requests to stop execution
   */
  shouldStopExecution(): boolean {
    return this.continue === false;
  }

  /**
   * Get the effective reason for blocking or stopping
   */
  getEffectiveReason(): string {
    return this.stopReason || this.reason || 'No reason provided';
  }

  /**
   * Get sanitized additional context for adding to responses.
   */
  getAdditionalContext(): string | undefined {
    if (
      this.hookSpecificOutput &&
      'additionalContext' in this.hookSpecificOutput
    ) {
      const context = this.hookSpecificOutput['additionalContext'];
      if (typeof context !== 'string') {
        return undefined;
      }

      // Sanitize by escaping < and > to prevent tag injection
      return context.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    return undefined;
  }

  /**
   * Check if execution should be blocked and return error info
   */
  getBlockingError(): { blocked: boolean; reason: string } {
    if (this.isBlockingDecision()) {
      return {
        blocked: true,
        reason: this.getEffectiveReason(),
      };
    }
    return { blocked: false, reason: '' };
  }

  /**
   * Check if context clearing was requested by hook.
   */
  shouldClearContext(): boolean {
    return false;
  }
}

/**
 * Specific hook output class for PreToolUse events.
 */
export class PreToolUseHookOutput extends DefaultHookOutput {
  /**
   * Get modified tool input if provided by hook
   */
  getModifiedToolInput(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && 'tool_input' in this.hookSpecificOutput) {
      const input = this.hookSpecificOutput['tool_input'];
      if (
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input)
      ) {
        return input as Record<string, unknown>;
      }
    }
    return undefined;
  }
}

/**
 * Specific hook output class for Stop events.
 */
export class StopHookOutput extends DefaultHookOutput {
  override stopReason?: string;

  constructor(data: Partial<HookOutput> = {}) {
    super(data);
    this.stopReason = data.stopReason;
  }

  /**
   * Get the stop reason if provided
   */
  getStopReason(): string | undefined {
    if (!this.stopReason) {
      return undefined;
    }
    return `Stop hook feedback:\n${this.stopReason}`;
  }
}

/**
 * Permission suggestion type
 */
export interface PermissionSuggestion {
  type: string;
  tool?: string;
}

/**
 * Input for PermissionRequest hook events
 */
export interface PermissionRequestInput extends HookInput {
  permission_mode: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: PermissionSuggestion[];
}

/**
 * Decision object for PermissionRequest hooks
 */
export interface PermissionRequestDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionSuggestion[];
  message?: string;
  interrupt?: boolean;
}

/**
 * Specific hook output class for PermissionRequest events.
 */
export class PermissionRequestHookOutput extends DefaultHookOutput {
  /**
   * Get the permission decision if provided by hook
   */
  getPermissionDecision(): PermissionRequestDecision | undefined {
    if (this.hookSpecificOutput && 'decision' in this.hookSpecificOutput) {
      const decision = this.hookSpecificOutput['decision'];
      if (
        typeof decision === 'object' &&
        decision !== null &&
        !Array.isArray(decision)
      ) {
        return decision as PermissionRequestDecision;
      }
    }
    return undefined;
  }

  /**
   * Check if the permission was denied
   */
  isPermissionDenied(): boolean {
    const decision = this.getPermissionDecision();
    return decision?.behavior === 'deny';
  }

  /**
   * Get the deny message if permission was denied
   */
  getDenyMessage(): string | undefined {
    const decision = this.getPermissionDecision();
    return decision?.message;
  }

  /**
   * Check if execution should be interrupted after denial
   */
  shouldInterrupt(): boolean {
    const decision = this.getPermissionDecision();
    return decision?.interrupt === true;
  }

  /**
   * Get updated tool input if permission was allowed with modifications
   */
  getUpdatedToolInput(): Record<string, unknown> | undefined {
    const decision = this.getPermissionDecision();
    return decision?.updatedInput;
  }

  /**
   * Get updated permissions if permission was allowed with permission updates
   */
  getUpdatedPermissions(): PermissionSuggestion[] | undefined {
    const decision = this.getPermissionDecision();
    return decision?.updatedPermissions;
  }
}

/**
 * Context for MCP tool executions.
 * Contains non-sensitive connection information about the MCP server
 * identity. Since server_name is user controlled and arbitrary, we
 * also include connection information (e.g., command or url) to
 * help identify the MCP server.
 *
 * NOTE: In the future, consider defining a shared sanitized interface
 * from MCPServerConfig to avoid duplication and ensure consistency.
 */
export interface McpToolContext {
  server_name: string;
  tool_name: string; // Original tool name from the MCP server

  // Connection info (mutually exclusive based on transport type)
  command?: string; // For stdio transport
  args?: string[]; // For stdio transport
  cwd?: string; // For stdio transport

  url?: string; // For SSE/HTTP transport

  tcp?: string; // For WebSocket transport
}

export interface PreToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  mcp_context?: McpToolContext;
  original_request_name?: string;
}

/**
 * PreToolUse hook output
 */
export interface PreToolUseOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    tool_input?: Record<string, unknown>;
  };
}

/**
 * PostToolUse hook input
 */
export interface PostToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  mcp_context?: McpToolContext;
  original_request_name?: string;
}

/**
 * PostToolUse hook output
 */
export interface PostToolUseOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext?: string;

    /**
     * Optional request to execute another tool immediately after this one.
     * The result of this tail call will replace the original tool's response.
     */
    tailToolCallRequest?: {
      name: string;
      args: Record<string, unknown>;
    };
  };
}

/**
 * PostToolUseFailure hook input
 * Fired when a tool execution fails
 */
export interface PostToolUseFailureInput extends HookInput {
  tool_use_id: string; // Unique identifier for the tool use
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string; // Error message describing the failure
  error_type?: string; // Type of error (e.g., 'timeout', 'network', 'permission', etc.)
  is_interrupt?: boolean; // Whether the failure was caused by user interruption
}

/**
 * PostToolUseFailure hook output
 * Supports all three hook types: command, prompt, and agent
 */
export interface PostToolUseFailureOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUseFailure';
    additionalContext?: string;
  };
}

/**
 * UserPromptSubmit hook input
 */
export interface UserPromptSubmitInput extends HookInput {
  prompt: string;
}

/**
 * UserPromptSubmit hook output
 */
export interface UserPromptSubmitOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    additionalContext?: string;
  };
}

/**
 * Notification types
 */
export enum NotificationType {
  ToolPermission = 'ToolPermission',
}

/**
 * Notification hook input
 */
export interface NotificationInput extends HookInput {
  permission_mode?: string;
  notification_type: NotificationType;
  message: string;
  title?: string;
  details: Record<string, unknown>;
}

/**
 * Notification hook output
 */
export interface NotificationOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Notification';
    additionalContext?: string;
  };
}

/**
 * Stop hook input
 */
export interface StopInput extends HookInput {
  prompt: string;
  prompt_response: string;
  stop_hook_active: boolean;
}

/**
 * Stop hook output
 */
export interface StopOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    additionalContext?: string;
  };
}

/**
 * SessionStart source types
 */
export enum SessionStartSource {
  Startup = 'startup',
  Resume = 'resume',
  Clear = 'clear',
  Compact = 'compact',
}

/**
 * SessionStart hook input
 */
export interface SessionStartInput extends HookInput {
  permission_mode?: string;
  source: SessionStartSource;
  model?: string;
}

/**
 * SessionStart hook output
 */
export interface SessionStartOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext?: string;
  };
}

/**
 * SessionEnd reason types
 */
export enum SessionEndReason {
  Clear = 'clear',
  Logout = 'logout',
  PromptInputExit = 'prompt_input_exit',
  Bypass_permissions_disabled = 'bypass_permissions_disabled',
  Other = 'other',
}

/**
 * SessionEnd hook input
 */
export interface SessionEndInput extends HookInput {
  reason: SessionEndReason;
}

/**
 * SessionEnd hook output
 */
export interface SessionEndOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionEnd';
    additionalContext?: string;
  };
}

/**
 * PreCompress trigger types
 */
export enum PreCompactTrigger {
  Manual = 'manual',
  Auto = 'auto',
}

/**
 * PreCompress hook input
 */
export interface PreCompactInput extends HookInput {
  trigger: PreCompactTrigger;
  custom_instructions?: string;
}

/**
 * PreCompress hook output
 */
export interface PreCompactOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreCompact';
    additionalContext?: string;
  };
}

export enum AgentType {
  Bash = 'Bash',
  Explorer = 'Explorer',
  Plan = 'Plan',
  Custom = 'Custom',
}

/**
 * SubagentStart hook input
 * Fired when a subagent (Task tool call) is started
 */
export interface SubagentStartInput extends HookInput {
  permission_mode?: string;
  agent_id: string;
  agent_type: AgentType;
}

/**
 * SubagentStart hook output
 */
export interface SubagentStartOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SubagentStart';
    additionalContext?: string;
  };
}

/**
 * SubagentStop hook input
 * Fired right before a subagent (Task tool call) concludes its response
 */
export interface SubagentStopInput extends HookInput {
  permission_mode?: string;
  stop_hook_active: boolean;
  agent_id: string;
  agent_type: AgentType;
  agent_transcript_path: string;
  last_assistant_message: string;
}

/**
 * SubagentStop hook output
 * Supports all three hook types: command, prompt, and agent
 */
export interface SubagentStopOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SubagentStop';
    additionalContext?: string;
  };
}

/**
 * Hook execution result
 */
export interface HookExecutionResult {
  hookConfig: HookConfig;
  eventName: HookEventName;
  success: boolean;
  output?: HookOutput;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  duration: number;
  error?: Error;
}

/**
 * Hook execution plan for an event
 */
export interface HookExecutionPlan {
  eventName: HookEventName;
  hookConfigs: HookConfig[];
  sequential: boolean;
}
