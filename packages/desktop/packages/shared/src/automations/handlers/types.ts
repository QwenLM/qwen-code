/**
 * AutomationHandler Interface and Common Types
 *
 * Defines the contract for all automation handlers in the Event Bus system.
 * Each handler:
 * - Subscribes to relevant events on the bus
 * - Executes its specific logic
 * - Is self-contained and testable in isolation
 */

import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationEvent, AutomationsConfig, AutomationMatcher, PendingPrompt } from '../types.ts';

// ============================================================================
// Handler Interface
// ============================================================================

/**
 * Base interface for all automation handlers.
 * Handlers subscribe to events and process them independently.
 */
export interface AutomationHandler {
  /** Subscribe to events on the bus */
  subscribe(bus: EventBus): void;

  /** Clean up resources and unsubscribe from events */
  dispose(): void | Promise<void>;
}

// ============================================================================
// Handler Options
// ============================================================================

/** Options for creating a PromptHandler */
export interface PromptHandlerOptions {
  /** Workspace ID */
  workspaceId: string;
  /** Workspace root path for history file location */
  workspaceRootPath: string;
  /** Session ID (if executing in a session context) */
  sessionId?: string;
  /** Called when prompts are ready to be executed */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
  /** Called when a prompt execution fails */
  onError?: (event: AutomationEvent, error: Error) => void;
}

/** Options for creating an EventLogHandler */
export interface EventLogHandlerOptions {
  /** Workspace root path for log file location */
  workspaceRootPath: string;
  /** Workspace ID for log entries */
  workspaceId: string;
  /** Called when logging fails after retries */
  onEventLost?: (events: string[], error: Error) => void;
}

// ============================================================================
// Handler Result Types
// ============================================================================

/** Result from prompt processing */
export interface PromptProcessingResult {
  event: AutomationEvent;
  prompts: PendingPrompt[];
  durationMs: number;
}

// ============================================================================
// Config Provider Interface
// ============================================================================

/**
 * Interface for getting automations configuration.
 * Allows handlers to be decoupled from config loading.
 */
export interface AutomationsConfigProvider {
  /** Get the current automations configuration */
  getConfig(): AutomationsConfig | null;

  /** Get matchers for a specific event */
  getMatchersForEvent(event: AutomationEvent): AutomationMatcher[];
}
