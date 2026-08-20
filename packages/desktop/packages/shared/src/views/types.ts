/**
 * View Types
 *
 * Views are dynamic, user-configurable filters computed from session state
 * using Filtrex expressions. They are never persisted on sessions — purely runtime.
 *
 * Stored in views.json at the workspace root.
 */

import type { EntityColor } from '../colors/types.ts';

/**
 * View configuration as stored in views.json.
 * Each view defines a Filtrex expression evaluated against session state.
 */
export interface ViewConfig {
  /** Unique ID slug */
  id: string;

  /** Display name (shown as badge text, e.g. "PLAN", "NEW") */
  name: string;

  /** Human-readable description of what this view detects */
  description?: string;

  /** Optional color for badge rendering */
  color?: EntityColor;

  /**
   * Filtrex expression evaluated against session context.
   * Must return a truthy value for the view to match.
   * Supports dot notation for nested fields (e.g. tokenUsage.costUsd).
   * @example "hasUnread == true"
   * @example "tokenUsage.costUsd > 1"
   * @example "daysSince(lastUsedAt) > 7"
   */
  expression: string;
}

/**
 * Compiled view — config paired with its compiled Filtrex function.
 * The compiled function is a native JS function (fast hot path).
 * Compilation happens once on config load; execution is O(1).
 */
export interface CompiledView {
  config: ViewConfig;
  /** Compiled Filtrex function: takes context object, returns truthy/falsy */
  evaluate: (context: ViewEvaluationContext) => unknown;
}

/**
 * Evaluation context built from SessionMeta + runtime state.
 * These are all the fields available inside view expressions.
 *
 * The evaluator builds this object once per session and passes it to
 * all compiled view functions.
 */
export interface ViewEvaluationContext {
  // === Strings ===
  /** Session name */
  name: string;
  /** Preview text (first 150 chars of first user message) */
  preview: string;
  /** Status ID (e.g. 'todo', 'in-progress', 'done') */
  sessionStatus: string;
  /** @deprecated Use `sessionStatus` instead. Kept for backward compatibility with existing view expressions. */
  todoState: string;
  /** Permission mode (canonical: 'explore'|'ask'|'execute'|'auto-edit'; internal: 'safe'|'ask'|'allow-all'|'auto-edit') */
  permissionMode: string;
  /** Model override string */
  model: string;
  /** Role of last message ('user', 'assistant', 'plan', 'tool', 'error') */
  lastMessageRole: string;

  // === Numbers ===
  /** Timestamp (ms) of last activity */
  lastUsedAt: number;
  /** Timestamp (ms) of session creation */
  createdAt: number;
  /** Total number of messages in the session */
  messageCount: number;
  /** Number of labels on the session */
  labelCount: number;

  // === Booleans ===
  /** Whether session is starred */
  isFlagged: boolean;
  /** Whether session has unread messages */
  hasUnread: boolean;
  /** Whether agent is currently running */
  isProcessing: boolean;
  /** Whether there's a pending plan to accept (lastMessageRole == 'plan') */
  hasPendingPlan: boolean;

  // === Nested Objects (accessed via dot notation) ===
  /** Token usage stats — access via tokenUsage.costUsd, tokenUsage.totalTokens, etc. */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    contextTokens: number;
  };

  // === Arrays ===
  /** Labels array (bare IDs for contains() checks) */
  labels: string[];
}
