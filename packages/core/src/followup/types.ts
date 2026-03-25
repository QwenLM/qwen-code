/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Types
 *
 * Types for the follow-up suggestions feature that suggests next actions
 * after completing a task.
 */

/**
 * A single follow-up suggestion
 */
export interface FollowupSuggestion {
  /** The suggested command text */
  text: string;
  /** Optional description shown below the suggestion */
  description?: string;
  /** Priority for ranking (higher = more relevant) */
  priority: number;
}

/**
 * Tool call information for context analysis
 */
export interface ToolCallInfo {
  /** Tool display name (e.g., 'Edit', 'WriteFile', 'Shell') */
  name: string;
  /** Tool input data */
  input: Record<string, unknown>;
  /** Whether the tool call succeeded */
  status: 'success' | 'error' | 'cancelled';
}

/**
 * File modification information
 */
export interface FileModification {
  /** File path */
  path: string;
  /** Modification type */
  type: 'created' | 'edited' | 'deleted';
}

/**
 * Git status information (optional, when available)
 */
export interface GitStatus {
  /** Whether there are staged changes */
  hasStagedChanges: boolean;
  /** Whether there are unstaged changes */
  hasUnstagedChanges: boolean;
  /** Current branch name */
  branch?: string;
}

/**
 * Context for generating follow-up suggestions
 */
export interface SuggestionContext {
  /** Last assistant message content */
  lastMessage: string;
  /** Tool calls performed in the last response */
  toolCalls: ToolCallInfo[];
  /** Files that were modified */
  modifiedFiles: FileModification[];
  /** Optional git status */
  gitStatus?: GitStatus;
  /** Whether the last response contained an error */
  hasError: boolean;
  /** Whether the response was streaming/cancelled */
  wasCancelled: boolean;
}

/**
 * Result from generating suggestions
 */
export interface SuggestionResult {
  /** Generated suggestions ordered by priority */
  suggestions: FollowupSuggestion[];
  /** Whether suggestions should be shown */
  shouldShow: boolean;
}

/**
 * Provider interface for generating suggestions
 */
export interface SuggestionProvider {
  /**
   * Generate suggestions based on the context
   * @param context - The suggestion context
   * @returns Suggestion result with suggestions and visibility flag
   */
  getSuggestions(context: SuggestionContext): SuggestionResult;
}

/**
 * Rule definition for pattern-based suggestions
 */
export interface SuggestionRule {
  /** Pattern to match (can be tool name regex, command pattern, etc.) */
  pattern: RegExp | string;
  /** Suggestions to provide when rule matches */
  suggestions: Array<string | { text: string; description?: string }>;
  /** Priority for this rule (higher = checked first) */
  priority?: number;
  /** Condition function for more complex matching */
  condition?: (context: SuggestionContext) => boolean;
  /** If true, pattern matches against message content instead of tool names */
  matchMessage?: boolean;
}
