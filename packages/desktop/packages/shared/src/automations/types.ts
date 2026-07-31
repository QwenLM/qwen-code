/**
 * Automation System Type Definitions
 *
 * All types, interfaces, and type exports for the automations system.
 */

import type { PermissionMode } from '../agent/mode-types.ts';

// ============================================================================
// Event Types
// ============================================================================

/** App events - handled by Craft */
export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'SessionStatusChange'
  | 'SchedulerTick';

/** Agent events passed through backend automation hooks */
export type AgentEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup';

export type AutomationEvent = AppEvent | AgentEvent;

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'SessionStatusChange', 'SchedulerTick'
];

export const AGENT_EVENTS: AgentEvent[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest', 'Setup'
];

// ============================================================================
// Action Definitions
// ============================================================================

/** A prompt action - sends a prompt to Qwen Code */
export interface PromptAction {
  type: 'prompt';
  prompt: string;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
}

/** HTTP method for webhook actions */
export type WebhookHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Body format for webhook actions */
export type WebhookBodyFormat = 'json' | 'form' | 'raw';

/** Authentication shorthand for webhook actions */
export type WebhookAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string };

/** A webhook action - sends an HTTP request to an endpoint */
export interface WebhookAction {
  type: 'webhook';
  /** The URL to send the webhook to (http or https) */
  url: string;
  /** HTTP method (default: POST) */
  method?: WebhookHttpMethod;
  /** HTTP headers as key-value pairs */
  headers?: Record<string, string>;
  /** Body format: 'json' sends Content-Type application/json, 'form' URL-encodes, 'raw' sends as-is */
  bodyFormat?: WebhookBodyFormat;
  /** Request body — JSON object when bodyFormat is 'json' or 'form', string when 'raw' */
  body?: unknown;
  /** Capture response body in result (truncated to 4KB). Default: false */
  captureResponse?: boolean;
  /** Authentication shorthand (applied before custom headers) */
  auth?: WebhookAuth;
}

export type AutomationAction = PromptAction | WebhookAction;

// ============================================================================
// Condition Types
// ============================================================================

/** Time-of-day and day-of-week condition */
export interface TimeCondition {
  condition: 'time';
  /** Start time in 24h HH:MM format */
  after?: string;
  /** End time in 24h HH:MM format */
  before?: string;
  /** Days of week (3-letter lowercase: mon, tue, wed, thu, fri, sat, sun) */
  weekday?: string[];
  /** IANA timezone (falls back to matcher timezone, then system local) */
  timezone?: string;
}

/** State/field check condition with HA-style from/to for transitions */
export interface StateCondition {
  condition: 'state';
  /** Field name to check (e.g. 'permissionMode', 'sessionStatus', 'labels', 'isFlagged') */
  field: string;
  /** Exact value match */
  value?: unknown;
  /** Transition: previous value (mapped via TRANSITION_FIELDS) */
  from?: unknown;
  /** Transition: new value (mapped via TRANSITION_FIELDS) */
  to?: unknown;
  /** Array membership check */
  contains?: string;
  /** Negation: matches anything except this value */
  not_value?: unknown;
}

/** Logical composition condition (and/or/not) */
export interface LogicalCondition {
  condition: 'and' | 'or' | 'not';
  conditions: AutomationCondition[];
}

/** Union of all condition types */
export type AutomationCondition = TimeCondition | StateCondition | LogicalCondition;

// ============================================================================
// Matcher Definition
// ============================================================================

export interface AutomationMatcher {
  /** Short 6-character hex ID for stable identification across config changes. */
  id?: string;
  /** Optional display name. If omitted, derived from the first action. */
  name?: string;
  /** Regex pattern for matching event data (not used for SchedulerTick) */
  matcher?: string;
  /** Cron expression for SchedulerTick events (5-field format) */
  cron?: string;
  /** IANA timezone for cron evaluation (e.g., "Europe/Budapest", "America/New_York") */
  timezone?: string;
  /** Permission mode for sessions created by prompt actions. */
  permissionMode?: PermissionMode;
  /** Labels to apply to sessions created by prompt actions */
  labels?: string[];
  /** Whether this automation matcher is enabled. Defaults to true. Set to false to disable without removing. */
  enabled?: boolean;
  /** Optional conditions that must all pass (AND) after matcher matches, before actions fire */
  conditions?: AutomationCondition[];
  actions: AutomationAction[];
}

export interface AutomationsConfig {
  automations: Partial<Record<AutomationEvent, AutomationMatcher[]>>;
}

// ============================================================================
// Action Results
// ============================================================================

/** References parsed from a prompt (@name for sources and skills) */
export interface PromptReferences {
  /**
   * All @name references found in the prompt.
   * These could be sources (@linear, @github) or skills (@commit, @review-pr).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
}

/** Result of a prompt action - returns the prompt to be executed by caller */
export interface PromptActionResult {
  type: 'prompt';
  prompt: string;
  /** The expanded prompt with environment variables substituted */
  expandedPrompt: string;
  /** References to sources and skills found in the prompt */
  references: PromptReferences;
}

/** Result of a webhook action */
export interface WebhookActionResult {
  type: 'webhook';
  /** The URL that was called */
  url: string;
  /** HTTP status code from the response */
  statusCode: number;
  /** Whether the request was successful (2xx status) */
  success: boolean;
  /** Error message if the request failed */
  error?: string;
  /** Number of attempts made (1 = no retry, 2+ = retried) */
  attempts?: number;
  /** Total duration including retries, in ms */
  durationMs?: number;
  /** Captured response body (only when captureResponse is true, truncated to 4KB) */
  responseBody?: string;
}

export type ActionExecutionResult = PromptActionResult | WebhookActionResult;

/** A pending prompt with its metadata */
export interface PendingPrompt {
  /** The session ID this prompt should be sent to */
  sessionId: string | undefined;
  /** The automation matcher ID this prompt originated from */
  matcherId?: string;
  /** Human-readable automation name (from matcher.name or derived fallback) */
  automationName?: string;
  /** The expanded prompt text */
  prompt: string;
  /**
   * All @mentions found in the prompt (sources and skills).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
  /** Labels to apply to the created session */
  labels?: string[];
  /** Permission mode for the created session (from matcher config) */
  permissionMode?: PermissionMode;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
}

export interface AutomationResult {
  event: string;
  matched: number;
  results: ActionExecutionResult[];
  /** Prompts that should be executed by Qwen Code (with metadata) */
  pendingPrompts: PendingPrompt[];
}

// ============================================================================
// Validation Types
// ============================================================================

/** Internal validation result that includes the parsed config */
export type AutomationsValidationResult = {
  valid: boolean;
  errors: string[];
  config: AutomationsConfig | null;
};

// ============================================================================
// SDK Types
// ============================================================================

/**
 * SDK automation input type - union of all possible SDK event inputs
 */
export interface SdkAutomationInput {
  hook_event_name: string;
  // Tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  tool_use_id?: string;
  // Session events
  source?: string;  // startup, resume, clear, compact
  model?: string;
  // Subagent events
  agent_id?: string;
  agent_type?: string;
  // User prompt events
  prompt?: string;
  // Notification events
  message?: string;
  title?: string;
  // Error events
  error?: string;
}

/**
 * SDK automation callback signature
 */
export type SdkAutomationCallback = (
  input: SdkAutomationInput,
  toolUseId: string,
  options: { signal?: AbortSignal }
) => Promise<{ continue: boolean; reason?: string }>;

/**
 * SDK automation matcher format.
 */
export interface SdkAutomationCallbackMatcher {
  matcher?: string;
  timeout?: number;
  hooks: SdkAutomationCallback[];
}

// ============================================================================
// Session Metadata
// ============================================================================

/**
 * Lightweight session metadata for diffing.
 * Only includes fields that trigger automations.
 */
export interface SessionMetadataSnapshot {
  permissionMode?: string;
  labels?: string[];
  isFlagged?: boolean;
  sessionStatus?: string;
  /** Session name (user-defined or auto-generated) */
  sessionName?: string;
}
