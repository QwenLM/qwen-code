/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

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
  // PostCompact - After conversation compaction
  PostCompact = 'PostCompact',
  // SessionEnd - When a session is ending
  SessionEnd = 'SessionEnd',
  // When a permission dialog is displayed
  PermissionRequest = 'PermissionRequest',
  // StopFailure - When the turn ends due to an API error (instead of Stop)
  StopFailure = 'StopFailure',
  // PostTurn - After each model turn completes (at tool_call boundary or end of response)
  PostTurn = 'PostTurn',
}

/**
 * Fields in the hooks configuration that are not hook event names
 */
export const HOOKS_CONFIG_FIELDS = ['enabled', 'disabled', 'notifications'];

/**
 * Hook configuration entry
 */
export interface CommandHookConfig {
  type: HookType;
  command: string;
  name?: string;
  description?: string;
  timeout?: number;
  source?: HooksConfigSource;
  env?: Record<string, string>;
  // LLM hook fields (only used when type='llm')
  /** System prompt for the LLM call (type: "llm" only). */
  prompt?: string;
  /** Path to system prompt file, relative to CWD (type: "llm" only). Takes precedence over prompt. */
  promptFile?: string;
  /** Model to use for LLM call (type: "llm" only). Empty = use session model. */
  model?: string;
  /** Temperature for LLM call (type: "llm" only). Default 0.3. */
  temperature?: number;
  /** Max output tokens for LLM call (type: "llm" only). Default 1024. */
  maxTokens?: number;
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
  Llm = 'llm',
}

/**
 * Generate a unique key for a hook configuration
 */
export function getHookKey(hook: HookConfig): string {
  const name = hook.name ?? '';
  const id =
    hook.type === HookType.Command
      ? hook.command
      : `llm:${hook.model ?? 'default'}`;
  return name ? `${name}:${id}` : id;
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
    case HookEventName.PostToolUse:
      return new PostToolUseHookOutput(data);
    case HookEventName.PostToolUseFailure:
      return new PostToolUseFailureHookOutput(data);
    case HookEventName.Stop:
    case HookEventName.SubagentStop:
      return new StopHookOutput(data);
    case HookEventName.PermissionRequest:
      return new PermissionRequestHookOutput(data);
    case HookEventName.PostTurn:
      return new PostTurnHookOutput(data);
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
   * Get permission decision from hook output
   * @returns 'allow' | 'deny' | 'ask' | undefined
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
    // Fall back to base decision field
    if (this.decision === 'allow' || this.decision === 'approve') {
      return 'allow';
    }
    if (this.decision === 'deny' || this.decision === 'block') {
      return 'deny';
    }
    if (this.decision === 'ask') {
      return 'ask';
    }
    return undefined;
  }

  /**
   * Get permission decision reason
   */
  getPermissionDecisionReason(): string | undefined {
    if (
      this.hookSpecificOutput &&
      'permissionDecisionReason' in this.hookSpecificOutput
    ) {
      const reason = this.hookSpecificOutput['permissionDecisionReason'];
      if (typeof reason === 'string') {
        return reason;
      }
    }
    return this.reason;
  }

  /**
   * Check if permission was denied
   */
  isDenied(): boolean {
    return this.getPermissionDecision() === 'deny';
  }

  /**
   * Check if user confirmation is required
   */
  isAsk(): boolean {
    return this.getPermissionDecision() === 'ask';
  }

  /**
   * Check if permission was allowed
   */
  isAllowed(): boolean {
    return this.getPermissionDecision() === 'allow';
  }
}

/**
 * Specific hook output class for PostToolUse events.
 * Default behavior is to allow tool usage if the hook does not explicitly set a decision.
 * This follows the security model of allowing by default unless explicitly blocked.
 */
export class PostToolUseHookOutput extends DefaultHookOutput {
  override decision: HookDecision;
  override reason: string;

  constructor(data: Partial<HookOutput> = {}) {
    super(data);
    // Default to allowing tool usage if hook does not provide explicit decision
    // This maintains backward compatibility and follows security model of allowing by default
    this.decision = data.decision ?? 'allow';
    this.reason = data.reason ?? 'No reason provided';

    // Log when default values are used to help with debugging
    if (data.decision === undefined) {
      debugLogger.debug(
        'PostToolUseHookOutput: No explicit decision set, defaulting to "allow"',
      );
    }
    if (data.reason === undefined) {
      debugLogger.debug(
        'PostToolUseHookOutput: No explicit reason set, defaulting to "No reason provided"',
      );
    }
  }
}

/**
 * Specific hook output class for PostToolUseFailure events.
 */
export class PostToolUseFailureHookOutput extends DefaultHookOutput {
  /**
   * Get additional context to provide error handling information
   */
  override getAdditionalContext(): string | undefined {
    return super.getAdditionalContext();
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
 * Specific hook output class for PostTurn events.
 * Supports ACP message injection via hookSpecificOutput.acpMessage.
 */
export class PostTurnHookOutput extends DefaultHookOutput {
  constructor(data: Partial<HookOutput> = {}) {
    super(data);
  }

  /**
   * Get the ACP message to inject (with _meta.rewritten), if any.
   */
  getAcpMessage(): string | undefined {
    const specific = this.hookSpecificOutput as
      | { acpMessage?: string }
      | undefined;
    const msg = specific?.acpMessage;
    if (!msg || typeof msg !== 'string' || msg.trim().length < 5) {
      return undefined;
    }
    return msg.trim();
  }

  /**
   * Get optional metadata to attach to the injected ACP message.
   * Hook scripts define this freely; qwen-code passes it through as-is.
   */
  getAcpMeta(): Record<string, unknown> | undefined {
    const specific = this.hookSpecificOutput as
      | { acpMeta?: Record<string, unknown> }
      | undefined;
    return specific?.acpMeta;
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
  permission_mode: PermissionMode;
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
 * PreToolUse hook input
 */
export interface PreToolUseInput extends HookInput {
  permission_mode: PermissionMode;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string; // Unique identifier for this tool use instance
}

/**
 * PreToolUse hook output
 */
export interface PreToolUseOutput extends HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason: string;
  };
}

/**
 * PostToolUse hook input
 */
export interface PostToolUseInput extends HookInput {
  permission_mode: PermissionMode;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string; // Unique identifier for this tool use instance
}

/**
 * PostToolUse hook output
 */
export interface PostToolUseOutput extends HookOutput {
  decision: HookDecision;
  reason: string;
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
  };
  updatedMCPToolOutput?: Record<string, unknown>;
}

/**
 * PostToolUseFailure hook input
 * Fired when a tool execution fails
 */
export interface PostToolUseFailureInput extends HookInput {
  permission_mode: PermissionMode;
  tool_use_id: string; // Unique identifier for the tool use
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string; // Error message describing the failure
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
  PermissionPrompt = 'permission_prompt',
  IdlePrompt = 'idle_prompt',
  AuthSuccess = 'auth_success',
  ElicitationDialog = 'elicitation_dialog',
}

/**
 * Notification hook input
 */
export interface NotificationInput extends HookInput {
  message: string;
  title?: string;
  notification_type: NotificationType;
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
  stop_hook_active: boolean;
  last_assistant_message: string;
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

export enum PermissionMode {
  Default = 'default',
  Plan = 'plan',
  AutoEdit = 'auto_edit',
  Yolo = 'yolo',
}

/**
 * SessionStart hook input
 */
export interface SessionStartInput extends HookInput {
  permission_mode: PermissionMode;
  source: SessionStartSource;
  model: string;
  agent_type?: AgentType;
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
  custom_instructions: string;
}

/**
 * PreCompress hook output
 */
export interface PreCompactOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreCompact';
    additionalContext: string;
  };
}

/**
 * PostCompact trigger types
 */
export enum PostCompactTrigger {
  Manual = 'manual',
  Auto = 'auto',
}

/**
 * PostCompact hook input
 * Fired after conversation compaction completes
 */
export interface PostCompactInput extends HookInput {
  trigger: PostCompactTrigger;
  compact_summary: string;
}

/**
 * PostCompact hook output
 * Note: PostCompact is not in the official decision mode supported events list,
 * so hookSpecificOutput / additionalContext do not produce any control effects
 */
export interface PostCompactOutput extends HookOutput {
  // All returned JSON is ignored for control purposes
  hookSpecificOutput?: {
    hookEventName: 'PostCompact';
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
 * Fired when a subagent (Agent tool call) is spawned
 */
export interface SubagentStartInput extends HookInput {
  permission_mode: PermissionMode;
  agent_id: string;
  agent_type: AgentType | string;
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
 * Fired when a subagent has finished responding
 */
export interface SubagentStopInput extends HookInput {
  permission_mode: PermissionMode;
  stop_hook_active: boolean;
  agent_id: string;
  agent_type: AgentType | string;
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
 * StopFailure error types
 * Fires instead of Stop when an API error ended the turn
 */
export type StopFailureErrorType =
  | 'rate_limit'
  | 'authentication_failed'
  | 'billing_error'
  | 'invalid_request'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown';

/**
 * StopFailure hook input
 * Fired when the turn ends due to an API error (instead of Stop)
 */
export interface StopFailureInput extends HookInput {
  error: StopFailureErrorType;
  error_details?: string;
  last_assistant_message?: string;
}

/**
 * StopFailure hook output
 * Fire-and-forget: hook output and exit codes are ignored
 * This type alias is used instead of an empty interface to satisfy ESLint rules
 */
export type StopFailureOutput = HookOutput;

/**
 * PostTurn hook input
 * Fired after each model turn completes (at tool_call boundary or end of response).
 * Receives accumulated thoughts and messages from the turn.
 */
export interface PostTurnToolCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface PostTurnInput extends HookInput {
  turn_index: number;
  thoughts: string[];
  messages: string[];
  tool_calls: PostTurnToolCall[];
}

/**
 * PostTurn hook output
 * Supports ACP message injection via hookSpecificOutput.acpMessage.
 * Fire-and-forget: does not block agent execution.
 */
export interface PostTurnOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostTurn';
    /** Message text to inject into ACP stream as agent_message_chunk. */
    acpMessage?: string;
    /** Optional metadata attached to the injected ACP message. Hook scripts define this freely. */
    acpMeta?: Record<string, unknown>;
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
