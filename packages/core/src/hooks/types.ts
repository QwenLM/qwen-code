/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolConfig as GenAIToolConfig,
  ToolListUnion,
} from '@google/genai';
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
  PreToolUse = 'PreToolUse',
  PostToolUse = 'PostToolUse',
  UserPromptSubmit = 'UserPromptSubmit',
  Notification = 'Notification',
  Stop = 'Stop',
  SessionStart = 'SessionStart',
  SessionEnd = 'SessionEnd',
  PreCompact = 'PreCompact',
  SubagentStop = 'SubagentStop',
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
  const name = hook.name || '';
  const command = hook.command || '';
  return `${name}:${command}`;
}

/**
 * Decision types for hook outputs
 */
export type HookDecision =
  | 'ask'
  | 'block'
  | 'deny'
  | 'approve'
  | 'allow'
  | undefined;

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
 * Returns DefaultHookOutput for all events since it contains all necessary methods
 */
export function createHookOutput(
  eventName: string,
  data: Partial<HookOutput>,
): DefaultHookOutput {
  switch (eventName) {
    case 'PreToolUse':
      return new PreToolUseHookOutput(data);
    case 'Stop':
      return new StopHookOutput(data);
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
   * Apply tool config modifications (specific method for BeforeToolSelection hooks)
   */
  applyToolConfigModifications(target: {
    toolConfig?: GenAIToolConfig;
    tools?: ToolListUnion;
  }): {
    toolConfig?: GenAIToolConfig;
    tools?: ToolListUnion;
  } {
    // Base implementation - overridden by BeforeToolSelectionHookOutput
    return target;
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
 * Specific hook output class for BeforeTool events.
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
export class StopHookOutput extends DefaultHookOutput {
  override stopReason?: string;

  constructor(data: Partial<StopOutput> = {}) {
    super(data);
    this.stopReason = data.stopReason;
  }

  /**
   * Get the stop reason if provided
   */
  getStopReason(): string | undefined {
    return this.stopReason;
  }

  /**
   * Check if context clearing was requested by hook
   */
  override shouldClearContext(): boolean {
    if (this.hookSpecificOutput && 'clearContext' in this.hookSpecificOutput) {
      return this.hookSpecificOutput['clearContext'] === true;
    }
    return false;
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
}

/**
 * BeforeTool hook output
 */
export interface BeforeToolOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeTool';
    tool_input?: Record<string, unknown>;
  };
}
export interface PostToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  mcp_context?: McpToolContext;
}
export interface PostToolUseOutput extends HookOutput {
  hookEventName: 'PostToolUse';
}
/**
 * BeforeAgent hook input
 */
export interface UserPromptSubmitInput extends HookInput {
  prompt: string;
}
export interface UserPromptSubmitOutput extends HookOutput {
  additionalContext?: string;
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
  notification_type: NotificationType;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Notification hook output
 */
export interface NotificationOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * AfterAgent hook input
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
  stopReason?: string;
}

/**
 * SessionStart source types
 */
export enum SessionStartSource {
  Startup = 'startup',
  Resume = 'resume',
  Clear = 'clear',
}

/**
 * SessionStart hook input
 */
export interface SessionStartInput extends HookInput {
  source: SessionStartSource;
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
  Exit = 'exit',
  Clear = 'clear',
  Logout = 'logout',
  PromptInputExit = 'prompt_input_exit',
  Other = 'other',
}

/**
 * SessionEnd hook input
 */
export interface SessionEndInput extends HookInput {
  reason: SessionEndReason;
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
}

/**
 * PreCompress hook output
 */
export interface PreCompressOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
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
