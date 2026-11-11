/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionMode } from '../protocol/schemas/common.js';
import type { PermissionUpdate } from '../tools/tool-checkers/checker-reasons.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import { spillHookOutputToFile } from './hookOutputSpill.js';

// Re-export for convenience
export type { PermissionMode } from '../protocol/schemas/common.js';

/**
 * Configuration source levels in precedence order (highest to lowest)
 */
export enum ConfigSource {
  Runtime = 'runtime',
  Project = 'project',
  User = 'user',
  Local = 'local',
  System = 'system',
  Plugins = 'plugins',
  Flag = 'flag',
}

/**
 * Returns true if a hook source implies it is a user-visible hook.
 * Only System hooks are hidden by default to reduce noise.
 */
export function isUserVisibleHook(source?: string | ConfigSource): boolean {
  if (!source) return true; // Treat unknown/legacy hooks as user-visible
  return source !== ConfigSource.System && source !== ConfigSource.Runtime;
}

/**
 * Event names for the hook system
 */
export enum HookEventName {
  ImagePrepare = 'ImagePrepare',
  PreToolUse = 'PreToolUse',
  PostToolUse = 'PostToolUse',
  PostToolUseFailure = 'PostToolUseFailure',
  SubagentStart = 'SubagentStart',
  Notification = 'Notification',
  SubagentStop = 'SubagentStop',
  SessionStart = 'SessionStart',
  Setup = 'Setup',
  SessionEnd = 'SessionEnd',
  PreCompact = 'PreCompact',
  PostCompact = 'PostCompact',
  Stop = 'Stop',
  QueryEnd = 'QueryEnd',
  UserPromptSubmit = 'UserPromptSubmit',
  ConfigChange = 'ConfigChange',
  StopFailure = 'StopFailure',
  TeammateIdle = 'TeammateIdle',
  InstructionsLoaded = 'InstructionsLoaded',
  CwdChanged = 'CwdChanged',
  FileChanged = 'FileChanged',
  WorktreeCreate = 'WorktreeCreate',
  WorktreeRemove = 'WorktreeRemove',
  Elicitation = 'Elicitation',
  ElicitationResult = 'ElicitationResult',
  TaskCreated = 'TaskCreated',
  TaskCompleted = 'TaskCompleted',
  PermissionRequest = 'PermissionRequest',
  PermissionDenied = 'PermissionDenied',
}

/**
 * Queued hook output entry awaiting injection via the attachment pipeline.
 * Shared by ToolUseContext, AttachmentToolUseContext, and TUI orchestrator.
 */
export interface PendingHookOutput {
  hookEventName: HookEventName;
  output: string;
  toolName?: string;
  /** Source type determines which attachment type drainHookOutputAttachments produces */
  sourceType?:
    | 'stdout'
    | 'additionalContext'
    | 'systemMessage'
    | 'blockingError'
    | 'stoppedContinuation';
  /** Hook attribution for error messages */
  hookName?: string;
  hookCommand?: string;
}

/**
 * Fields in the hooks configuration that are not hook event names
 */
export const HOOKS_CONFIG_FIELDS = ['enabled', 'disabled', 'notifications'];

/**
 * All hook events currently supported by the system, in enum declaration
 * order. Mirrors the upstream `HOOK_EVENTS` const: the single source of
 * truth shared by every consumer that needs the runtime list (settings
 * loading, frontmatter registration, SDK surfaces), so no caller maintains
 * its own subset that can go stale when new events are added.
 */
export const HOOK_EVENTS: readonly HookEventName[] =
  Object.values(HookEventName);

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

/**
 * Type guard for hook event names, mirroring upstream `isHookEvent`.
 */
export function isHookEventName(value: string): value is HookEventName {
  return HOOK_EVENT_SET.has(value);
}

/**
 * Hook implementation types
 */
export enum HookType {
  Command = 'command',
  Runtime = 'runtime',
  Http = 'http',
  Prompt = 'prompt',
  Agent = 'agent',
}

/**
 * Hook action function
 */
export type HookAction = (
  input: HookInput,
  options?: {
    signal: AbortSignal;
    execution?: import('../builtin-plugins/types.js').BuiltinRuntimeExecutionContext;
  },
) => Promise<HookOutput | void | null>;

/**
 * Runtime hook configuration
 */
export interface RuntimeHookConfig {
  type: HookType.Runtime;
  /** Unique name for the runtime hook */
  name: string;
  /** Function to execute when the hook is triggered */
  action: HookAction;
  command?: never;
  source?: ConfigSource;
  /** Trusted product capability; not disabled by the user hook master switch. */
  internal?: boolean;
  /** Allows an already-completed file write to be attributed after cancellation. */
  runAfterCancellation?: 'completed-file-write';
  /** Maximum time allowed for hook execution in seconds */
  timeout?: number;
  /** Custom status message for spinner/status line display. */
  statusMessage?: string;
}

/**
 * Static environment, or an execution-time environment for trusted builtin hooks.
 * A function is called before every spawn. Its undefined values remove inherited
 * variables; omitted keys are preserved. Explicit keys replace case variants.
 */
export type CommandHookEnv =
  | Record<string, string>
  | (() => Record<string, string | undefined>);

/**
 * Command hook configuration entry
 */
export interface CommandHookConfig {
  type: HookType.Command;
  command: string;
  action?: never;
  timeout?: number;
  source?: ConfigSource;
  env?: CommandHookEnv;
  /**
   * Per-hook condition filter.
   * Format: "ToolName(arg_pattern)" or "ToolName".
   * When set, the hook only fires if the tool name and optional argument
   * glob pattern match the current event context.
   */
  if?: string;
  /** Custom status message for spinner/status line display. */
  statusMessage?: string;
  /**
   * Shell to use for running this command.
   * - `'bash'`: On Unix, prefer bash and fall back to `/bin/sh` when bash is
   *   unavailable; on Windows, use Git Bash.
   * - `'powershell'`: Use pwsh (Linux/Mac) or powershell.exe (Windows)
   * - `undefined`: Use system default shell via getShellConfiguration()
   */
  shell?: 'bash' | 'powershell';
  /**
   * When provided, runs the hook in exec form: `spawn(command, args, { shell: false })`.
   * No shell is involved — `command` is a single executable path/name and each
   * `args` element is one literal argv entry. No splitting, quoting, or glob
   * expansion is performed. The `shell` field is ignored when `args` is set.
   *
   * Use this when the command path or arguments contain shell metacharacters
   * that would require complex quoting in shell form. Not suitable when you
   * need shell features like pipes, redirection, or glob expansion.
   */
  args?: string[];
  /**
   * When true, this command hook runs in the background without blocking.
   * Overrides the definition-level `async` flag for this specific hook.
   */
  async?: boolean;
  /**
   * When true, the hook is removed from the registry after its first
   * successful execution. Only effective for session-scoped hooks.
   */
  once?: boolean;
  /**
   * When true, the hook runs in the background (like `async: true`) but
   * if it exits with code 2, its stderr/error message is injected as a
   * system-reminder to wake the model. This enables long-running
   * background checks that can interrupt the agent when they detect
   * a problem.
   */
  asyncRewake?: boolean;
  /**
   * Override the prefix of the system-reminder injected when an
   * asyncRewake hook exits with code 2. The hook's stderr (or stdout
   * fallback) is appended after this prefix.
   * Default: `Stop hook blocking error from command "<name>":`.
   * Only effective when `asyncRewake: true`.
   */
  rewakeMessage?: string;
  /**
   * Override the one-line summary shown to the user (and embedded in the
   * `<summary>` block injected to the model) when an asyncRewake hook
   * exits with code 2. Whitespace is collapsed and the value is truncated
   * to 300 characters.
   * Default: `Stop hook feedback`.
   * Only effective when `asyncRewake: true`.
   */
  rewakeSummary?: string;
  /** Plugin install directory, set when this hook comes from a plugin */
  pluginRoot?: string;
  /** Plugin identifier (e.g. "name@source"), for resolving data dir */
  pluginId?: string;
  /** Set by the host registry; never accepted as proof without System source. */
  builtinPlugin?: boolean;
}

/**
 * HTTP hook configuration entry.
 *
 * Sends the hook input as a JSON POST request to the specified URL and expects
 * a JSON HookOutput response. Headers support environment variable interpolation
 * via `${ENV_VAR}` syntax.
 */
export interface HttpHookConfig {
  type: HookType.Http;
  /** URL to POST the hook event JSON to */
  url: string;
  /** Optional HTTP headers. Values support `${ENV_VAR}` interpolation. */
  headers?: Record<string, string>;
  /**
   * Restrict which environment variables can be interpolated in header values.
   * When set, only variables in this list are substituted; all others resolve
   * to empty strings. When omitted, all `${ENV_VAR}` references are resolved.
   */
  allowedEnvVars?: string[];
  command?: never;
  action?: never;
  /** Maximum time allowed for the HTTP request in seconds (default 600s) */
  timeout?: number;
  source?: ConfigSource;
  /**
   * Per-hook condition filter.
   * Format: "ToolName(arg_pattern)" or "ToolName".
   */
  if?: string;
  /** Custom status message for spinner/status line display. */
  statusMessage?: string;
  /**
   * When true, the hook is removed from the registry after its first
   * successful execution. Only effective for session-scoped hooks.
   */
  once?: boolean;
}

export type HookConfig =
  | CommandHookConfig
  | RuntimeHookConfig
  | HttpHookConfig
  | PromptHookConfig
  | AgentHookConfig;

/**
 * Prompt hook configuration entry.
 *
 * Evaluates the hook event via a single-turn LLM call. The LLM receives the
 * user-defined prompt together with the serialized hook input and returns a
 * structured JSON decision (`{ decision, reason }`).
 */
export interface PromptHookConfig {
  type: HookType.Prompt;
  /** The prompt template to send to the LLM */
  prompt: string;
  command?: never;
  action?: never;
  url?: never;
  /** Maximum time for the LLM call in seconds (default 30s) */
  timeout?: number;
  /**
   * Model override for this prompt hook (e.g., "haiku").
   * If not specified, uses the session's default model.
   */
  model?: string;
  source?: ConfigSource;
  /**
   * Per-hook condition filter.
   * Format: "ToolName(arg_pattern)" or "ToolName".
   */
  if?: string;
  /** Custom status message for spinner/status line display. */
  statusMessage?: string;
  /**
   * When true, the hook is removed from the registry after its first
   * successful execution. Only effective for session-scoped hooks.
   */
  once?: boolean;
}

/**
 * Agent hook configuration entry.
 *
 * Spawns a sub-agent with tool access to verify a condition. The agent must
 * call the `StructuredOutput` tool with `{ ok: boolean, reason?: string }`.
 *
 * - `ok: true`  → outcome: 'success',  decision: 'allow'
 * - `ok: false` → outcome: 'blocking', decision: 'deny'
 * - no result   → outcome: 'cancelled', decision: 'defer'
 */
export interface AgentHookConfig {
  type: HookType.Agent;
  /** Verification prompt. Supports `$ARGUMENTS` placeholder for hook input JSON. */
  prompt: string;
  /**
   * Optional tool whitelist. If omitted, inherits all available tools
   * (with dangerous tools like Agent, EnterPlanMode, etc. filtered).
   */
  tools?: string[];
  /** Maximum number of agentic turns. Default 50. */
  maxTurns?: number;
  command?: never;
  action?: never;
  url?: never;
  /** Timeout in SECONDS (not ms). Default 60. */
  timeout?: number;
  /**
   * Model override. Default: use config's default model.
   * TODO: Consider using getSmallFastModel() (Haiku) for cost/speed.
   *       Consider defaulting to a lightweight model instead of the main model.
   */
  model?: string;
  /**
   * Custom status message for spinner display.
   * TODO: Emit statusMessage as a UI event during agent hook execution
   *       so the spinner/status line can display it.
   */
  statusMessage?: string;
  source?: ConfigSource;
  /**
   * Per-hook condition filter.
   * Format: "ToolName(arg_pattern)" or "ToolName".
   */
  if?: string;
  /**
   * When true, the hook is removed from the registry after its first
   * successful execution. Only effective for session-scoped hooks.
   */
  once?: boolean;
}

/**
 * Hook definition with matcher
 */
export interface HookDefinition {
  matcher?: string;
  sequential?: boolean;
  /**
   * When true, hooks in this definition run in the background without blocking
   * the current operation. Results are collected and injected as
   * `additionalContext` in the next model turn.
   */
  async?: boolean;
  hooks: HookConfig[];
}

/**
 * Generate a dedup key for a hook configuration.
 *
 * Per-type identity fields:
 * - command (shell-form): shell (default 'bash') + command + if
 * - command (exec-form, when `args` is set): 'exec' + command + args (JSON) + if.
 *   `shell` is ignored in exec form and normalized to the constant 'exec' so
 *   that the same {command, args} pair dedupes regardless of an irrelevant
 *   shell hint.
 * - prompt/agent: prompt (first 64 chars) + if
 * - http: url + if
 * - runtime: name (each is unique by definition)
 */
export function getHookKey(hook: HookConfig): string {
  const ifCondition = 'if' in hook && hook.if ? hook.if : '';

  switch (hook.type) {
    case HookType.Command:
      if (hook.args !== undefined) {
        return `command\0exec\0${hook.command}\0${JSON.stringify(hook.args)}\0${ifCondition}`;
      }
      return `command\0${hook.shell ?? 'bash'}\0${hook.command}\0${ifCondition}`;
    case HookType.Prompt:
      return `prompt\0${hook.prompt.slice(0, 64)}\0${ifCondition}`;
    case HookType.Agent:
      return `agent\0${hook.prompt.slice(0, 64)}\0${ifCondition}`;
    case HookType.Http:
      return `http\0${hook.url}\0${ifCondition}`;
    case HookType.Runtime:
      return `runtime\0${hook.name}`;
    default:
      return `unknown\0${ifCondition}`;
  }
}

/**
 * Get human-readable display text for a hook config.
 * Priority: statusMessage → primary content field (command/url/prompt/name).
 * Never returns "unknown" — every hook type has a required primary content field.
 */
export function getHookDisplayText(config: HookConfig): string {
  if (config.statusMessage) return config.statusMessage;
  switch (config.type) {
    case HookType.Command:
      return config.command;
    case HookType.Http:
      return config.url;
    case HookType.Prompt:
      return config.prompt;
    case HookType.Agent:
      return config.prompt;
    case HookType.Runtime:
      return config.name;
    default:
      return '';
  }
}

/**
 * Get the identity string for a hook execution context.
 * Format: `{eventName}:{matcher}` when matcher exists, otherwise just `{eventName}`.
 * Used for event keying, attachment routing, and UI state tracking.
 */
export function getHookIdentity(eventName: string, matcher?: string): string {
  return matcher ? `${eventName}:${matcher}` : eventName;
}

/**
 * Extract plugin attribution from a hook config. Only command hooks carry
 * plugin context today; other hook types return an empty object.
 */
export function getHookPluginAttribution(config: HookConfig): {
  pluginId?: string;
  pluginRoot?: string;
} {
  if (config.type !== HookType.Command) return {};
  return { pluginId: config.pluginId, pluginRoot: config.pluginRoot };
}

/**
 * Decision types for hook outputs.
 */
export type HookDecision = 'allow' | 'deny' | 'ask' | 'defer' | undefined;

/**
 * Base hook input - common fields for all events.
 */
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  /** Human-readable display name of the model responsible for this event. */
  model?: string;
  // Optional so events that do not carry permission mode (e.g. PreCompact/
  // PostCompact, per upstream spec) can omit it rather than leaking a value.
  permission_mode?: PermissionMode;
  agent_id?: string;
  agent_type?: string;
  /** Current session workspace directories (target dir + added dirs). */
  workspace_dirs?: readonly string[];
}

/**
 * Base hook output - common fields for all events
 */
export interface HookOutput {
  /**
   * SDK callback async marker. When true, normalizeHookOutput strips all
   * synchronous control fields (decision, continue, etc.) so the output is
   * treated as a no-op by the CLI hook aggregator.
   */
  async?: true;
  asyncTimeout?: number;
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  /** Shell hook raw stdout (mutually exclusive with systemMessage in practice) */
  stdoutContent?: string;
  decision?: HookDecision;
  reason?: string;
  /** Content to inject into the model context when blocking. Unlike systemMessage (UI-only for JSON hooks), this is explicitly intended for LLM consumption. */
  modelInjection?: string;
  hookSpecificOutput?: Record<string, unknown>;
  /** Attribution: name of the hook that produced this output */
  hookName?: string;
  /** Attribution: command string of the hook */
  hookCommand?: string;
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
    case 'PostToolUse':
      return new PostToolUseHookOutput(data);
    case 'SubagentStop':
      return new SubagentStopHookOutput(data);
    case 'Stop':
      return new StopHookOutput(data);
    case 'UserPromptSubmit':
      return new UserPromptSubmitHookOutput(data);
    case 'Elicitation':
      return new ElicitationHookOutput(data);
    case 'ElicitationResult':
      return new ElicitationResultHookOutput(data);
    case 'PermissionRequest':
      return new PermissionRequestHookOutput(data);
    case 'PermissionDenied':
      return new PermissionDeniedHookOutput(data);
    default:
      return new DefaultHookOutput(data);
  }
}

export const MAX_HOOK_OUTPUT_LENGTH = 10000;

/**
 * Marker that precedes the spill-file path in truncated hook output. The path
 * varies per run, so consumers that need a stable identity for the same output
 * (transcript dedup) normalise everything after this prefix.
 */
export const HOOK_OUTPUT_SPILL_PATH_PREFIX = 'Full output saved to: ';

export function truncateHookOutput(value: string): string {
  if (value.length > MAX_HOOK_OUTPUT_LENGTH) {
    let suffix: string;
    try {
      const filePath = spillHookOutputToFile(value);
      suffix = `\n… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters. ${HOOK_OUTPUT_SPILL_PATH_PREFIX}${filePath}]`;
    } catch {
      suffix = `\n… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`;
    }
    return value.substring(0, MAX_HOOK_OUTPUT_LENGTH) + suffix;
  }
  return value;
}

/**
 * Hook events whose stdout content should reach the model
 * (as opposed to being UI-only). Used by getStdoutForModel() to gate
 * stdout extraction for model injection.
 */
export const STDOUT_MODEL_EVENTS: ReadonlySet<HookEventName> = new Set([
  HookEventName.SessionStart,
  HookEventName.UserPromptSubmit,
]);

/**
 * Format a blocking error message with hook attribution.
 * Used by both PreToolUse (hook-utils.ts) and PostToolUse (coreToolHookTriggers.ts).
 */
export function formatBlockingAttribution(
  blockingError: { hookName?: string; hookCommand?: string },
  fallbackPrefix = 'Tool execution blocked',
): string {
  if (blockingError.hookName) {
    return (
      `${blockingError.hookName} hook blocking error` +
      (blockingError.hookCommand
        ? ` from command: "${blockingError.hookCommand}"`
        : '')
    );
  }
  return fallbackPrefix;
}

/**
 * Default implementation of HookOutput with utility methods
 */
export class DefaultHookOutput implements HookOutput {
  async?: true;
  asyncTimeout?: number;
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  stdoutContent?: string;
  decision?: HookDecision;
  reason?: string;
  modelInjection?: string;
  hookSpecificOutput?: Record<string, unknown>;
  hookName?: string;
  hookCommand?: string;

  constructor(data: Partial<HookOutput> = {}) {
    this.async = data.async;
    this.asyncTimeout = data.asyncTimeout;
    this.continue = data.continue;
    this.stopReason = data.stopReason;
    this.suppressOutput = data.suppressOutput;
    this.systemMessage = data.systemMessage;
    this.stdoutContent = data.stdoutContent;
    this.decision = data.decision;
    this.reason = data.reason;
    this.modelInjection = data.modelInjection;
    this.hookSpecificOutput = data.hookSpecificOutput;
    this.hookName = data.hookName;
    this.hookCommand = data.hookCommand;
  }

  /**
   * Check if this output represents a blocking decision.
   */
  isBlockingDecision(): boolean {
    return this.decision === 'deny';
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
   * Get the trimmed stdout content from a shell hook.
   */
  getStdoutContent(): string | undefined {
    return this.stdoutContent?.trim() || undefined;
  }

  /**
   * Get additional context from hookSpecificOutput for adding to responses.
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

      return context;
    }
    return undefined;
  }

  /**
   * Get stdout content for model injection (SessionStart/UserPromptSubmit only).
   * Returns truncated stdout if the event is in STDOUT_MODEL_EVENTS, undefined otherwise.
   * Callers should queue the result via sourceType 'stdout' → hook_success.
   */
  getStdoutForModel(eventName: HookEventName): string | undefined {
    if (!STDOUT_MODEL_EVENTS.has(eventName)) return undefined;
    const stdout = this.getStdoutContent();
    if (!stdout) return undefined;
    return truncateHookOutput(stdout);
  }

  /**
   * Check if execution should be blocked and return error info
   */
  getBlockingError(): {
    blocked: boolean;
    reason: string;
    hookName?: string;
    hookCommand?: string;
  } {
    if (this.isBlockingDecision()) {
      return {
        blocked: true,
        reason: this.getEffectiveReason(),
        hookName: this.hookName,
        hookCommand: this.hookCommand,
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

  /**
   * Get replacement tool output if provided by a PostToolUse hook.
   * Works for all tools (not just MCP). Takes precedence over updatedMCPToolOutput.
   */
  getUpdatedToolOutput(): unknown {
    if (
      this.hookSpecificOutput &&
      'updatedToolOutput' in this.hookSpecificOutput
    ) {
      return this.hookSpecificOutput['updatedToolOutput'];
    }
    return undefined;
  }

  /**
   * Get replacement MCP tool output if provided by a PostToolUse hook.
   * When present, the original tool response should be replaced with this value.
   */
  getUpdatedMCPToolOutput(): unknown {
    if (
      this.hookSpecificOutput &&
      'updatedMCPToolOutput' in this.hookSpecificOutput
    ) {
      return this.hookSpecificOutput['updatedMCPToolOutput'];
    }
    return undefined;
  }
}

/**
 * Specific hook output class for PreToolUse events.
 *
 * Hooks emit `permissionDecision` inside `hookSpecificOutput`
 * rather than a top-level `decision`. The constructor normalizes this so that
 * the aggregator and downstream callers can rely on the standard `decision`
 * field.
 */
export class PreToolUseHookOutput extends DefaultHookOutput {
  constructor(data: Partial<HookOutput> = {}) {
    super(data);

    // Normalize permissionDecision → top-level decision
    // permissionDecision always overrides top-level decision (aligns with reference)
    if (
      this.hookSpecificOutput &&
      'permissionDecision' in this.hookSpecificOutput
    ) {
      const pd = this.hookSpecificOutput['permissionDecision'];
      if (pd === 'allow' || pd === 'deny' || pd === 'ask') {
        this.decision = pd;
      }
    }

    // Normalize permissionDecisionReason → top-level reason
    // permissionDecisionReason always overrides top-level reason (aligns with reference)
    if (
      this.hookSpecificOutput &&
      'permissionDecisionReason' in this.hookSpecificOutput
    ) {
      const pdr = this.hookSpecificOutput['permissionDecisionReason'];
      if (typeof pdr === 'string') {
        this.reason = pdr;
      }
    }
  }

  /**
   * Check if this output represents an 'ask' decision.
   * Only meaningful for PreToolUse — the interactive permission prompt.
   */
  isAskDecision(): boolean {
    return this.decision === 'ask';
  }

  /**
   * Get modified tool input if provided by hook
   */
  getModifiedToolInput(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && 'updatedInput' in this.hookSpecificOutput) {
      const input = this.hookSpecificOutput['updatedInput'];
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
 * Specific hook output class for PostToolUse events.
 * Enables the createHookOutput factory to produce a distinct type for PostToolUse,
 * matching the pattern used by other event-specific output classes.
 */
export class PostToolUseHookOutput extends DefaultHookOutput {}

/**
 * Specific hook output class for SubagentStop events
 */
export class SubagentStopHookOutput extends DefaultHookOutput {
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
 * Specific hook output class for Stop events (main agent completion).
 * Supports context clearing, matching SubagentStopHookOutput semantics.
 */
export class StopHookOutput extends DefaultHookOutput {
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

/**
 * PreToolUse hook input
 */
export interface PreToolUseInput extends HookInput {
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  mcp_context?: McpToolContext; // Only present for MCP tools
  original_request_name?: string;
}

/**
 * PreToolUse hook output
 */
export interface PreToolUseOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    /** Permission decision for this tool use */
    permissionDecision?: HookDecision;
    /** Reason for the permission decision */
    permissionDecisionReason?: string;
    /** Modified tool input to replace the original */
    updatedInput?: Record<string, unknown>;
    /** Additional context injected into the conversation */
    additionalContext?: string;
  };
}

export interface PostToolUseFileWrite {
  file_path: string;
  workspace_path: string;
  original_content: string;
  proposed_content: string;
  written_content: string;
  business_id?: string;
  request_set_id?: string;
  orphan?: boolean;
  task_id?: string;
  config_snapshot_id?: string;
  product?: string;
  scenario?: string;
}

/**
 * PostToolUse hook input
 */
export interface PostToolUseInput extends HookInput {
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  /** Internal write facts for Runtime Hooks; never projected into model output. */
  file_write?: PostToolUseFileWrite;
  mcp_context?: McpToolContext; // Only present for MCP tools
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
     * Replacement output for any tool call. When set, the original tool
     * response is discarded and this value is used instead.
     * Takes priority over updatedMCPToolOutput.
     */
    updatedToolOutput?: unknown;
    /**
     * Replacement output for MCP tool calls only. When set, the original tool
     * response is discarded and this value is used instead.
     */
    updatedMCPToolOutput?: unknown;
  };
}

/**
 * SubagentStart hook input.
 * Carries agent identity, not the prompt.
 */
export interface SubagentStartInput extends HookInput {
  agent_id: string;
  agent_type: string;
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
 * Notification types
 */
export enum NotificationType {
  PermissionPrompt = 'permission_prompt',
  IdlePrompt = 'idle_prompt',
  AuthSuccess = 'auth_success',
  ElicitationDialog = 'elicitation_dialog',
  ElicitationResponse = 'elicitation_response',
  ElicitationComplete = 'elicitation_complete',
}

/**
 * Notification hook input
 */
export interface NotificationInput extends HookInput {
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
    /** Additional context injected into the conversation */
    additionalContext?: string;
  };
}

/**
 * SubagentStop hook input.
 * Carries agent identity and stop metadata.
 */
export interface SubagentStopInput extends HookInput {
  agent_id: string;
  agent_type: string;
  stop_hook_active: boolean;
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

/**
 * SubagentStop hook output
 */
export interface SubagentStopOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SubagentStop';
    clearContext?: boolean;
  };
}

/**
 * SessionStart source types
 */
export enum SessionStartSource {
  Startup = 'startup',
  Resume = 'resume',
  Clear = 'clear',
  New = 'new',
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

export type SetupTrigger = 'init' | 'maintenance';

/**
 * Setup hook input
 */
export interface SetupInput extends HookInput {
  trigger: SetupTrigger;
}

/**
 * Setup hook output
 */
export interface SetupOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Setup';
    additionalContext?: string;
  };
}

/**
 * SessionEnd reason types
 */
export enum SessionEndReason {
  Clear = 'clear',
  Resume = 'resume',
  Logout = 'logout',
  PromptInputExit = 'prompt_input_exit',
  BypassPermissionsDisabled = 'bypass_permissions_disabled',
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
 * PreCompact hook output — can block compaction via `decision: 'deny'`.
 */
export type PreCompactOutput = HookOutput;

/**
 * PostToolUseFailure hook input
 */
export interface PostToolUseFailureInput extends HookInput {
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
  error_type?: string;
  is_interrupt?: boolean;
  mcp_context?: McpToolContext;
  original_request_name?: string;
}

/**
 * PostToolUseFailure hook output
 */
export interface PostToolUseFailureOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUseFailure';
    additionalContext?: string;
  };
}

/**
 * PostCompact hook input.
 *
 * BREAKING (2026-04): previously carried product-specific
 * `original_token_count` / `compressed_token_count`; replaced by
 * `compact_summary` field for compact summaries.
 */
export interface PostCompactInput extends HookInput {
  trigger: PreCompactTrigger;
  compact_summary: string;
}

/**
 * PostCompact hook output
 */
export interface PostCompactOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostCompact';
    additionalContext?: string;
  };
}

/**
 * Stop hook input
 */
export interface StopInput extends HookInput {
  /** Whether the Stop hook itself is driving a continuation turn */
  stop_hook_active: boolean;
  /** The last assistant message before stopping */
  last_assistant_message?: string;
  /** Parent agent's requestSetId for lifecycle-scoped integrations. */
  parent_request_set_id?: string;
  /** Parent agent's BusinessInfo for lifecycle-scoped integrations. */
  parent_business_info?: Readonly<BusinessInfo>;
}

/**
 * Stop hook output — decision: 'deny' prevents the stop (agent continues),
 * 'allow' permits the stop (default behavior).
 */
export interface StopOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    clearContext?: boolean;
  };
}

export type QueryEndReason =
  | 'end_turn'
  | 'abort'
  | 'max_turns'
  | 'error'
  | 'repeated_tool_call_denied';

/** QueryEnd is notification-only and fires when a top-level request finally ends. */
export interface QueryEndInput extends HookInput {
  request_set_id: string;
  business_id?: string;
  model: string;
  reason: QueryEndReason;
}

export interface QueryEndOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'QueryEnd';
  };
}

/**
 * UserPromptSubmit hook input
 */
export interface UserPromptSubmitInput extends HookInput {
  prompt: string;
  /** Entry-allocated request-set ID, shared with QueryEnd when available. */
  request_set_id?: string;
  /** Resolved HTTP(S) image URLs; omitted when none are available. */
  image_urls?: string[];
}

/**
 * UserPromptSubmit hook output
 */
export interface UserPromptSubmitOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    /** Session title suggestion */
    sessionTitle?: string;
    /** Additional context injected alongside the prompt */
    additionalContext?: string;
  };
}

/**
 * Valid sources for ConfigChange hook events.
 */
export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'
  | 'agents';

/**
 * ConfigChange hook input
 */
export interface ConfigChangeInput extends HookInput {
  source: ConfigChangeSource;
  file_path?: string;
}

/**
 * ConfigChange hook output
 */
export interface ConfigChangeOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'ConfigChange';
  };
}

/**
 * Specific hook output class for UserPromptSubmit events.
 */
export class UserPromptSubmitHookOutput extends DefaultHookOutput {
  /**
   * Get session title suggestion if provided by hook
   */
  getSessionTitle(): string | undefined {
    if (this.hookSpecificOutput && 'sessionTitle' in this.hookSpecificOutput) {
      const title = this.hookSpecificOutput['sessionTitle'];
      if (typeof title === 'string') {
        return title;
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// StopFailure event
// ---------------------------------------------------------------------------

/**
 * StopFailure error types
 */
export type StopFailureErrorType =
  | 'rate_limit'
  | 'overloaded'
  | 'authentication_failed'
  | 'oauth_org_not_allowed'
  | 'billing_error'
  | 'invalid_request'
  | 'model_not_found'
  | 'server_error'
  | 'max_output_tokens'
  | 'empty_response'
  | 'unknown';

/**
 * StopFailure hook input — fired when the agent unexpectedly stops due to an error.
 * Output / exit code is ignored; hooks are notification-only.
 */
export interface StopFailureInput extends HookInput {
  /** Machine-readable failure category and matcher value. */
  error: StopFailureErrorType;
  /** Detailed error text (e.g. stack trace or API error body) */
  error_details?: string;
  /** The most recent assistant message before the failure, when available. */
  last_assistant_message?: string;
}

/**
 * Options for firing a StopFailure hook event, providing additional error context.
 */
export interface StopFailureOptions {
  errorDetails?: string;
  lastAssistantMessage?: string;
}

/**
 * StopFailure hook output (informational only, ignored by the system)
 */
export interface StopFailureOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'StopFailure';
  };
}

// ---------------------------------------------------------------------------
// TeammateIdle event
// ---------------------------------------------------------------------------

/**
 * TeammateIdle hook input — fired when a teammate agent attempts to become idle.
 * exit 2 or continue:false blocks the idle state (keeps teammate active).
 */
export interface TeammateIdleInput extends HookInput {
  teammate_name: string;
  team_name?: string;
}

/**
 * TeammateIdle hook output
 */
export interface TeammateIdleOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'TeammateIdle';
  };
}

// ---------------------------------------------------------------------------
// InstructionsLoaded event
// ---------------------------------------------------------------------------

/**
 * Load reason for InstructionsLoaded.
 */
export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact';

/**
 * InstructionsLoaded hook input — fired when instruction/memory files are loaded.
 * Output/exit code is ignored; hooks are notification-only.
 */
export interface InstructionsLoadedInput extends HookInput {
  file_path: string;
  memory_type: string;
  load_reason: InstructionsLoadReason;
  globs?: string[];
  trigger_file_path?: string;
  parent_file_path?: string;
}

/**
 * InstructionsLoaded hook output (informational only)
 */
export interface InstructionsLoadedOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'InstructionsLoaded';
  };
}

// ---------------------------------------------------------------------------
// CwdChanged event
// ---------------------------------------------------------------------------

/**
 * CwdChanged hook input — fired when the working directory changes.
 */
export interface CwdChangedInput extends HookInput {
  old_cwd: string;
  new_cwd: string;
}

/**
 * CwdChanged hook output
 */
export interface CwdChangedOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'CwdChanged';
    /** Optional list of file/directory paths to watch */
    watchPaths?: string[];
    additionalContext?: string;
  };
}

// ---------------------------------------------------------------------------
// FileChanged event
// ---------------------------------------------------------------------------

/**
 * File change event types
 */
export type FileChangeEventType = 'change' | 'add' | 'unlink';

/**
 * FileChanged hook input — fired when a watched file changes.
 */
export interface FileChangedInput extends HookInput {
  file_path: string;
  event: FileChangeEventType;
}

/**
 * FileChanged hook output
 */
export interface FileChangedOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'FileChanged';
    /** Optional list of additional file/directory paths to watch */
    watchPaths?: string[];
    additionalContext?: string;
  };
}

// ---------------------------------------------------------------------------
// WorktreeCreate event
// ---------------------------------------------------------------------------

/**
 * WorktreeCreate hook input — fired when a git worktree needs to be created.
 * The hook must return the worktree path (stdout or hookSpecificOutput.worktreePath).
 * Any non-zero exit code fails the creation.
 */
export interface WorktreeCreateInput extends HookInput {
  name: string;
}

/**
 * WorktreeCreate hook output
 */
export interface WorktreeCreateOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'WorktreeCreate';
    /** Path to the created worktree */
    worktreePath?: string;
  };
}

// ---------------------------------------------------------------------------
// WorktreeRemove event
// ---------------------------------------------------------------------------

/**
 * WorktreeRemove hook input — fired when a git worktree is being removed.
 * When this hook is configured it owns removal. The caller preserves the
 * worktree if every configured hook fails.
 */
export interface WorktreeRemoveInput extends HookInput {
  worktree_path: string;
}

/**
 * WorktreeRemove hook output
 */
export interface WorktreeRemoveOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'WorktreeRemove';
    status?: 'removed' | 'retained' | 'unknown';
  };
}

// ---------------------------------------------------------------------------
// Elicitation event
// ---------------------------------------------------------------------------

/**
 * Elicitation action types
 */
export type ElicitationAction = 'accept' | 'decline' | 'cancel';

/**
 * Elicitation hook input — fired when an MCP server requests user input.
 * Hooks can auto-accept, decline, or cancel the elicitation.
 */
export interface ElicitationInput extends HookInput {
  mcp_server_name: string;
  message: string;
  mode?: string;
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
}

/**
 * Elicitation hook output
 */
export interface ElicitationOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Elicitation';
    /** Action to take: accept, decline, or cancel */
    action?: ElicitationAction;
    /** Content to provide when accepting */
    content?: Record<string, unknown>;
  };
}

/**
 * Base class for Elicitation-style hook outputs that share action/content accessors.
 */
class ElicitationBaseHookOutput extends DefaultHookOutput {
  getAction(): ElicitationAction | undefined {
    if (this.hookSpecificOutput && 'action' in this.hookSpecificOutput) {
      const action = this.hookSpecificOutput['action'];
      if (action === 'accept' || action === 'decline' || action === 'cancel') {
        return action;
      }
    }
    return undefined;
  }

  getContent(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && 'content' in this.hookSpecificOutput) {
      const content = this.hookSpecificOutput['content'];
      if (
        typeof content === 'object' &&
        content !== null &&
        !Array.isArray(content)
      ) {
        return content as Record<string, unknown>;
      }
    }
    return undefined;
  }
}

/**
 * Specific hook output class for Elicitation events.
 */
export class ElicitationHookOutput extends ElicitationBaseHookOutput {}

// ---------------------------------------------------------------------------
// ElicitationResult event
// ---------------------------------------------------------------------------

/**
 * ElicitationResult hook input — fired after an elicitation completes.
 * Hooks can override the action/content.
 */
export interface ElicitationResultInput extends HookInput {
  mcp_server_name: string;
  action: ElicitationAction;
  content?: Record<string, unknown>;
  mode?: string;
  elicitation_id?: string;
}

/**
 * ElicitationResult hook output
 */
export interface ElicitationResultOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'ElicitationResult';
    /** Override action */
    action?: ElicitationAction;
    /** Override content */
    content?: Record<string, unknown>;
  };
}

/**
 * Specific hook output class for ElicitationResult events.
 */
export class ElicitationResultHookOutput extends ElicitationBaseHookOutput {}

// ---------------------------------------------------------------------------
// TaskCreated event
// ---------------------------------------------------------------------------

/**
 * TaskCreated hook input — fired when a task is created.
 * exit 2 or continue:false blocks the task creation.
 */
export interface TaskCreatedInput extends HookInput {
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
}

/**
 * TaskCreated hook output
 */
export interface TaskCreatedOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'TaskCreated';
  };
}

// ---------------------------------------------------------------------------
// TaskCompleted event
// ---------------------------------------------------------------------------

/**
 * TaskCompleted hook input — fired when a task completes.
 * exit 2 or continue:false blocks the completion (keeps task active).
 */
export interface TaskCompletedInput extends HookInput {
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
}

/**
 * TaskCompleted hook output
 */
export interface TaskCompletedOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'TaskCompleted';
  };
}

// ---------------------------------------------------------------------------
// PermissionRequest event
// ---------------------------------------------------------------------------

/**
 * Permission behavior types
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

/**
 * Permission suggestion entry.
 * Represents an "always allow" option the user would see in the permission dialog.
 */
export interface PermissionSuggestion {
  type:
    | 'addRules'
    | 'replaceRules'
    | 'removeRules'
    | 'setMode'
    | 'addDirectories'
    | 'removeDirectories';
  rules?: Array<{ toolName: string; ruleContent: string }>;
  behavior?: PermissionBehavior;
  destination?:
    | 'session'
    | 'localSettings'
    | 'projectSettings'
    | 'userSettings';
  mode?: string;
  directories?: string[];
}

/**
 * PermissionRequest hook input — fired when a tool requests permission.
 * Hooks can auto-allow, deny, or modify the tool input.
 */
export interface PermissionRequestInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: PermissionSuggestion[];
}

/**
 * Permission decision details returned by PermissionRequest hooks.
 * behavior is limited to 'allow'/'deny' — 'ask' is not valid for
 * PermissionRequest hooks (only for PreToolUse permissionDecision).
 */
export interface HookPermissionDecision {
  /** Permission behavior: allow or deny */
  behavior: 'allow' | 'deny';
  /** Modified tool input (when allowing with modifications) */
  updatedInput?: Record<string, unknown>;
  /** Updated permission rules */
  updatedPermissions?: PermissionUpdate[];
  /** Message to display to the user */
  message?: string;
  /** Whether to interrupt and show to user */
  interrupt?: boolean;
}

/**
 * PermissionRequest hook output
 */
export interface PermissionRequestOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PermissionRequest';
    decision?: HookPermissionDecision;
  };
}

/**
 * Specific hook output class for PermissionRequest events.
 */
export class PermissionRequestHookOutput extends DefaultHookOutput {
  /**
   * Get the permission decision if provided by hook
   */
  getDecision(): HookPermissionDecision | undefined {
    if (this.hookSpecificOutput && 'decision' in this.hookSpecificOutput) {
      const decision = this.hookSpecificOutput['decision'];
      if (typeof decision === 'object' && decision !== null) {
        return decision as HookPermissionDecision;
      }
    }
    return undefined;
  }

  /**
   * Get modified tool input from permission decision
   */
  getUpdatedInput(): Record<string, unknown> | undefined {
    const decision = this.getDecision();
    if (decision?.updatedInput) {
      return decision.updatedInput;
    }
    return undefined;
  }

  /**
   * Get updated permissions from permission decision
   */
  getUpdatedPermissions(): PermissionUpdate[] | undefined {
    const decision = this.getDecision();
    if (
      decision?.updatedPermissions &&
      decision.updatedPermissions.length > 0
    ) {
      return decision.updatedPermissions;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// PermissionDenied event
// ---------------------------------------------------------------------------

/**
 * PermissionDenied hook input — fired when auto mode's classifier denies a tool call.
 * Hooks can request a retry.
 */
export interface PermissionDeniedInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  reason: string;
}

/**
 * PermissionDenied hook output
 */
export interface PermissionDeniedOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PermissionDenied';
    /** Whether to retry the tool call */
    retry?: boolean;
  };
}

/**
 * Specific hook output class for PermissionDenied events.
 */
export class PermissionDeniedHookOutput extends DefaultHookOutput {
  /**
   * Check if a retry was requested by hook
   */
  shouldRetry(): boolean {
    if (this.hookSpecificOutput && 'retry' in this.hookSpecificOutput) {
      return this.hookSpecificOutput['retry'] === true;
    }
    return false;
  }
}

/**
 * Hook execution outcome.
 *
 * - `success`:            Hook ran and condition was met (ok=true for agent hooks).
 * - `blocking`:           Hook ran and condition was NOT met (ok=false for agent hooks).
 * - `non_blocking_error`: Hook execution itself failed (runtime error, crash).
 * - `cancelled`:          Hook did not produce a result (timeout, max turns, abort).
 */
export type HookOutcome =
  | 'success'
  | 'blocking'
  | 'non_blocking_error'
  | 'cancelled';

/**
 * Hook execution result
 */
export interface HookExecutionResult {
  hookConfig: HookConfig;
  eventName: HookEventName;
  success: boolean;
  /** Structured outcome. When present, takes precedence over `success`. */
  outcome?: HookOutcome;
  output?: HookOutput;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  duration: number;
  error?: Error;
  /** The format of the output provided by the hook */
  outputFormat?: 'json' | 'text';
  /**
   * Optional failure-cause discriminator used by attachment construction to
   * compose CC-compatible display text. `spawn` covers child.on('error')
   * (ENOENT, EACCES, etc.); `timeout`/`cancelled` cover the forced-settle
   * branches in `settleForced`; `schema` covers stdout JSON that parses but
   * fails the strict hook output schema (sync command hooks only).
   */
  failureKind?: 'spawn' | 'timeout' | 'cancelled' | 'schema';
}

/**
 * Controls how hookRunner reacts when stdout JSON parses but fails the strict
 * hook output schema:
 * - `'strict'` — sync command hook path (CC parity: `qXn` drops plain text on
 *    schema failure and surfaces a non-blocking error attachment).
 * - `'plain-text-fallback'` — async / asyncRewake path (CC parity: `Yal` does
 *    no schema validation; the CLI still validates but falls back to plain
 *    text so the existing pendingAsyncContexts injection in
 *    `hookEventHandler.ts` keeps working unchanged).
 */
export type SchemaFailureMode = 'strict' | 'plain-text-fallback';

/**
 * Hook execution plan for an event
 */
export interface HookExecutionPlan {
  eventName: HookEventName;
  hookConfigs: HookConfig[];
  sequential: boolean;
  /** Hooks marked as async that should run in the background */
  asyncHookConfigs: HookConfig[];
  /** The match query from the event context (toolName or trigger), used to construct hookIdentity */
  matchQuery?: string;
}
