/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Event names for the hook system
 */
export enum HookEventName {
  PreToolUse = 'PreToolUse',
  PostToolUse = 'PostToolUse',
  PermissionRequest = 'PermissionRequest',
  UserPromptSubmit = 'UserPromptSubmit',
  Stop = 'Stop',
  SubagentStop = 'SubagentStop',
  Notification = 'Notification',
  PreCompact = 'PreCompact',
  SessionStart = 'SessionStart',
  SessionEnd = 'SessionEnd',
}

/**
 * Hook configuration entry
 */
export interface CommandHookConfig {
  type: HookType.Command;
  command: string;
  timeout?: number;
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
    case HookEventName.PreToolUse:
    case HookEventName.PermissionRequest:
      return new PreToolUseHookOutput(data);
    case HookEventName.UserPromptSubmit:
      return new UserPromptSubmitHookOutput(data);
    case HookEventName.Stop:
    case HookEventName.SubagentStop:
      return new StopHookOutput(data);
    case HookEventName.PostToolUse:
      return new PostToolUseHookOutput(data);
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
    return this.reason || this.stopReason || 'No reason provided';
  }

  /**
   * Get additional context for adding to responses
   */
  getAdditionalContext(): string | undefined {
    if (
      this.hookSpecificOutput &&
      'additionalContext' in this.hookSpecificOutput
    ) {
      const context = this.hookSpecificOutput['additionalContext'];
      return typeof context === 'string' ? context : undefined;
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
}

/**
 * Hook output class for PreToolUse and PermissionRequest events
 */
export class PreToolUseHookOutput extends DefaultHookOutput {
  /**
   * Get the effective blocking reason
   */
  override getEffectiveReason(): string {
    if (this.hookSpecificOutput) {
      // Check permissionDecisionReason (PreToolUse)
      if ('permissionDecisionReason' in this.hookSpecificOutput) {
        const compatReason =
          this.hookSpecificOutput['permissionDecisionReason'];
        if (typeof compatReason === 'string') {
          return compatReason;
        }
      }
      // Check decision.message (PermissionRequest)
      if ('decision' in this.hookSpecificOutput) {
        const decision = this.hookSpecificOutput['decision'] as Record<
          string,
          unknown
        >;
        if (
          decision &&
          'message' in decision &&
          typeof decision['message'] === 'string'
        ) {
          return decision['message'];
        }
      }
    }
    return super.getEffectiveReason();
  }

  /**
   * Check if this output represents a blocking decision
   */
  override isBlockingDecision(): boolean {
    if (this.hookSpecificOutput) {
      // Check permissionDecision (PreToolUse)
      if ('permissionDecision' in this.hookSpecificOutput) {
        const compatDecision = this.hookSpecificOutput['permissionDecision'];
        if (compatDecision === 'block' || compatDecision === 'deny') {
          return true;
        }
      }
      // Check decision.behavior (PermissionRequest)
      if ('decision' in this.hookSpecificOutput) {
        const decision = this.hookSpecificOutput['decision'] as Record<
          string,
          unknown
        >;
        if (decision && 'behavior' in decision) {
          const behavior = decision['behavior'];
          if (behavior === 'deny') {
            return true;
          }
        }
      }
    }
    return super.isBlockingDecision();
  }

  /**
   * Get the permission decision for PreToolUse
   */
  getPermissionDecision(): 'allow' | 'deny' | 'ask' | undefined {
    if (
      this.hookSpecificOutput &&
      'permissionDecision' in this.hookSpecificOutput
    ) {
      const decision = this.hookSpecificOutput['permissionDecision'];
      if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
        return decision;
      }
    }
    return undefined;
  }

  /**
   * Get updated tool input if provided
   */
  getUpdatedToolInput(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput) {
      // PreToolUse style
      if ('updatedInput' in this.hookSpecificOutput) {
        return this.hookSpecificOutput['updatedInput'] as Record<
          string,
          unknown
        >;
      }
      // PermissionRequest style
      if ('decision' in this.hookSpecificOutput) {
        const decision = this.hookSpecificOutput['decision'] as Record<
          string,
          unknown
        >;
        if (decision && 'updatedInput' in decision) {
          return decision['updatedInput'] as Record<string, unknown>;
        }
      }
    }
    return undefined;
  }
}

/**
 * Hook output class for PostToolUse events
 */
export class PostToolUseHookOutput extends DefaultHookOutput {
  /**
   * Get additional context to add to the tool response
   */
  override getAdditionalContext(): string | undefined {
    if (
      this.hookSpecificOutput &&
      'additionalContext' in this.hookSpecificOutput
    ) {
      const context = this.hookSpecificOutput['additionalContext'];
      return typeof context === 'string' ? context : undefined;
    }
    return undefined;
  }
}

/**
 * Hook output class for UserPromptSubmit events
 */
export class UserPromptSubmitHookOutput extends DefaultHookOutput {
  /**
   * Get additional context to add to the user prompt
   */
  override getAdditionalContext(): string | undefined {
    if (
      this.hookSpecificOutput &&
      'additionalContext' in this.hookSpecificOutput
    ) {
      const context = this.hookSpecificOutput['additionalContext'];
      return typeof context === 'string' ? context : undefined;
    }
    return undefined;
  }
}

/**
 * Hook output class for Stop and SubagentStop events
 */
export class StopHookOutput extends DefaultHookOutput {
  /**
   * Check if the stop should be blocked (continue execution)
   */
  shouldContinueExecution(): boolean {
    return this.decision === 'block' || this.continue === false;
  }

  /**
   * Get the reason for continuing execution
   */
  getContinueReason(): string | undefined {
    return this.reason;
  }
}

/**
 * PreToolUse hook input
 */
export interface PreToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/**
 * PreToolUse hook output
 */
export interface PreToolUseOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

/**
 * PostToolUse hook input
 */
export interface PostToolUseInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
}

/**
 * PostToolUse hook output
 */
export interface PostToolUseOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
  };
}

/**
 * PermissionRequest hook input
 */
export interface PermissionRequestInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/**
 * PermissionRequest hook output
 */
export interface PermissionRequestOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PermissionRequest';
    decision?: {
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      message?: string;
      interrupt?: boolean;
    };
  };
}

/**
 * Notification types
 */
export enum NotificationType {
  PermissionPrompt = 'permission_prompt',
  IdlePrompt = 'idle_prompt',
  AuthSuccess = 'auth_success',
  ElicitationDialog = 'elicitation_dialog',
}

/**
 * Notification hook input
 */
export interface NotificationInput extends HookInput {
  notification_type: NotificationType;
  message: string;
}

/**
 * Notification hook output
 * Note: Only supports simple exit codes, cannot block
 */
export interface NotificationOutput {
  suppressOutput?: boolean;
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
 * Stop hook input
 */
export interface StopInput extends HookInput {
  stop_hook_active: boolean;
}

/**
 * Stop hook output
 */
export interface StopOutput extends HookOutput {
  decision?: 'block';
  reason?: string;
}

/**
 * SubagentStop hook input
 */
export interface SubagentStopInput extends HookInput {
  stop_hook_active: boolean;
}

/**
 * SubagentStop hook output
 */
export interface SubagentStopOutput extends HookOutput {
  decision?: 'block';
  reason?: string;
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
 * PreCompact trigger types
 */
export enum PreCompactTrigger {
  Manual = 'manual',
  Auto = 'auto',
}

/**
 * PreCompact hook input
 */
export interface PreCompactInput extends HookInput {
  trigger: PreCompactTrigger;
  custom_instructions: string;
}

/**
 * PreCompact hook output
 * Note: Only supports simple exit codes, cannot block
 */
export interface PreCompactOutput {
  suppressOutput?: boolean;
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
