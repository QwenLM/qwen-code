/**
 * Craft Agent Automations - Public API
 *
 * Slim barrel file that re-exports from decomposed modules:
 * - types.ts: All type definitions
 * - validation.ts: Config validation functions
 * - sdk-bridge.ts: SDK environment variable building
 * - utils.ts: Shared utilities (toSnakeCase, expandEnvVars, etc.)
 * - automation-system.ts: AutomationSystem facade (main entry point)
 * - event-bus.ts: WorkspaceEventBus
 * - handlers/: PromptHandler, WebhookHandler, EventLogHandler
 */

// ============================================================================
// Types
// ============================================================================

export type {
  AppEvent,
  AgentEvent,
  AutomationEvent,
  PromptAction,
  WebhookAction,
  WebhookHttpMethod,
  WebhookBodyFormat,
  WebhookAuth,
  AutomationAction,
  AutomationMatcher,
  AutomationsConfig,
  PromptReferences,
  PromptActionResult,
  WebhookActionResult,
  ActionExecutionResult,
  PendingPrompt,
  AutomationResult,
  AutomationsValidationResult,
  SdkAutomationInput,
  SdkAutomationCallback,
  SdkAutomationCallbackMatcher,
  SessionMetadataSnapshot,
  TimeCondition,
  StateCondition,
  LogicalCondition,
  AutomationCondition,
} from './types.ts';

export { APP_EVENTS, AGENT_EVENTS } from './types.ts';

// ============================================================================
// Validation
// ============================================================================

export {
  validateAutomationsConfig,
  validateAutomationsContent,
  validateAutomations,
} from './validation.ts';

// ============================================================================
// SDK Bridge
// ============================================================================

export { buildEnvFromSdkInput } from './sdk-bridge.ts';

// ============================================================================
// Utilities
// ============================================================================

export { parsePromptReferences } from './utils.ts';

// ============================================================================
// Re-exports from sub-modules
// ============================================================================

// Event logger
export { AutomationEventLogger, type LoggedAutomationEvent, type LoggedAutomationEventInput } from './event-logger.ts';

// Schemas
export { AutomationsConfigSchema, AutomationConditionSchema, TimeConditionSchema, StateConditionSchema, zodErrorToIssues, VALID_EVENTS } from './schemas.ts';

// Condition evaluator
export { evaluateConditions, type ConditionContext } from './conditions.ts';

// Security utilities
export { sanitizeForShell } from './security.ts';

// Webhook execution utilities
export { executeWebhookRequest, executeWithRetry, createWebhookHistoryEntry, createPromptHistoryEntry, type ExecuteWebhookOptions, type RetryConfig } from './webhook-utils.ts';

// Retry scheduler
export { RetryScheduler, type RetryQueueEntry, type RetrySchedulerOptions } from './retry-scheduler.ts';

// Config constants
export { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE, HISTORY_FIELD_MAX_LENGTH, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER, AUTOMATION_HISTORY_MAX_ENTRIES } from './constants.ts';

// History store
export { appendAutomationHistoryEntry, compactAutomationHistory, compactAutomationHistorySync } from './history-store.ts';

// Config path resolution
export { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';

// Cron matching
export { matchesCron } from './cron-matcher.ts';

// Event Bus
export {
  WorkspaceEventBus,
  type EventBus,
  type EventPayloadMap,
  type BaseEventPayload,
  type LabelEventPayload,
  type PermissionModeChangePayload,
  type FlagChangePayload,
  type SessionStatusChangePayload,
  type SchedulerTickPayload,
  type LabelConfigChangePayload,
  type GenericEventPayload,
  type EventHandler,
  type AnyEventHandler,
} from './event-bus.ts';

// AutomationSystem facade
export {
  AutomationSystem,
  type AutomationSystemOptions,
  type SessionMetadataSnapshot as AutomationSystemMetadataSnapshot,
} from './automation-system.ts';

// Handlers
export {
  PromptHandler,
  EventLogHandler,
  WebhookHandler,
  type AutomationHandler,
  type PromptHandlerOptions,
  type EventLogHandlerOptions,
  type WebhookHandlerOptions,
  type AutomationsConfigProvider,
} from './handlers/index.ts';
