/**
 * View Validation
 *
 * Validates view expressions at config time (before they're used).
 * Catches syntax errors and provides helpful error messages with available fields.
 */

import { compileExpression, useDotAccessOperatorAndOptionalChaining } from 'filtrex';
import { VIEW_FUNCTIONS } from './functions.ts';

/**
 * Available fields for view expressions.
 * Used for documentation and error hints when expressions reference unknown fields.
 */
export const AVAILABLE_FIELDS: Array<{ name: string; type: string; description: string }> = [
  // Strings
  { name: 'name', type: 'string', description: 'Session name' },
  { name: 'preview', type: 'string', description: 'Preview text of first user message' },
  { name: 'sessionStatus', type: 'string', description: 'Status ID (e.g. "todo", "in-progress", "done")' },
  { name: 'todoState', type: 'string', description: '(Deprecated — use sessionStatus) Status ID alias for backward compatibility' },
  { name: 'permissionMode', type: 'string', description: 'Permission mode (canonical: "explore"|"ask"|"execute"|"auto-edit"; internal: "safe"|"ask"|"allow-all"|"auto-edit")' },
  { name: 'model', type: 'string', description: 'Model override string' },
  { name: 'lastMessageRole', type: 'string', description: 'Last message role ("user", "assistant", "plan", "tool", "error")' },

  // Numbers
  { name: 'lastUsedAt', type: 'number', description: 'Timestamp (ms) of last activity' },
  { name: 'createdAt', type: 'number', description: 'Timestamp (ms) of session creation' },
  { name: 'messageCount', type: 'number', description: 'Total number of messages in the session' },
  { name: 'labelCount', type: 'number', description: 'Number of labels on the session' },
  { name: 'tokenUsage.inputTokens', type: 'number', description: 'Input tokens consumed' },
  { name: 'tokenUsage.outputTokens', type: 'number', description: 'Output tokens consumed' },
  { name: 'tokenUsage.totalTokens', type: 'number', description: 'Total tokens' },
  { name: 'tokenUsage.costUsd', type: 'number', description: 'Cost in USD' },
  { name: 'tokenUsage.contextTokens', type: 'number', description: 'Context tokens used' },

  // Booleans
  { name: 'isFlagged', type: 'boolean', description: 'Whether session is starred' },
  { name: 'hasUnread', type: 'boolean', description: 'Whether session has unread messages' },
  { name: 'isProcessing', type: 'boolean', description: 'Whether agent is currently running' },
  { name: 'hasPendingPlan', type: 'boolean', description: 'Whether there\'s a pending plan to accept' },

  // Arrays
  { name: 'labels', type: 'array', description: 'Labels array (for contains() checks)' },
];

/**
 * Available custom functions for view expressions.
 */
export const AVAILABLE_FUNCTIONS: Array<{ name: string; signature: string; description: string; example: string }> = [
  { name: 'daysSince', signature: 'daysSince(timestamp)', description: 'Days elapsed since timestamp', example: 'daysSince(lastUsedAt) > 7' },
  { name: 'hoursSince', signature: 'hoursSince(timestamp)', description: 'Hours elapsed since timestamp', example: 'hoursSince(lastUsedAt) > 24' },
  { name: 'contains', signature: 'contains(arr, value)', description: 'Array/string contains value', example: 'contains(labels, "bug")' },
  { name: 'length', signature: 'length(arr)', description: 'Array or string length', example: 'length(labels) > 3' },
  { name: 'startsWith', signature: 'startsWith(str, prefix)', description: 'String starts with prefix', example: 'startsWith(name, "feat")' },
  { name: 'lower', signature: 'lower(str)', description: 'Lowercase string', example: 'lower(model) == "opus"' },
];

/**
 * Result of expression validation.
 */
export interface ValidationResult {
  /** Whether the expression is valid */
  valid: boolean;
  /** Error message if invalid (Filtrex parse error) */
  error?: string;
}

/**
 * Validate a view expression by attempting compilation.
 * Returns validation result with error details if the expression is invalid.
 *
 * This is a pure syntax check — it doesn't evaluate the expression.
 * Runtime errors (e.g. accessing undefined nested props) are handled
 * gracefully by the evaluator via optional chaining.
 */
export function validateViewExpression(expression: string): ValidationResult {
  if (!expression || typeof expression !== 'string') {
    return { valid: false, error: 'Expression must be a non-empty string' };
  }

  const trimmed = expression.trim();
  if (!trimmed) {
    return { valid: false, error: 'Expression must be a non-empty string' };
  }

  try {
    compileExpression(trimmed, {
      customProp: useDotAccessOperatorAndOptionalChaining,
      extraFunctions: VIEW_FUNCTIONS,
      // Must match evaluator.ts — Filtrex treats `true`/`false` as property lookups
      // without explicit constants, so validation would accept invalid semantics.
      constants: { true: true, false: false },
    });
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `Invalid expression: ${message}` };
  }
}
