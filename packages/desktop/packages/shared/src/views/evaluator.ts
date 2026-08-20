/**
 * View Evaluator
 *
 * Compiles Filtrex expressions into native JS functions (once, on config load)
 * and evaluates them against session context (per render).
 *
 * Architecture:
 *   config load → compileAllViews() → CompiledView[]  (cached)
 *   per render  → evaluateViews(context, compiled) → matching ViewConfig[]
 *
 * Performance: Compilation is one-time overhead; evaluation runs at native JS speed.
 */

import { compileExpression, useDotAccessOperatorAndOptionalChaining } from 'filtrex';
import type { ViewConfig, CompiledView, ViewEvaluationContext } from './types.ts';
import { VIEW_FUNCTIONS } from './functions.ts';
import { debug } from '../utils/debug.ts';

/**
 * Compile a single view expression into a native JS function.
 * Uses dot notation (tokenUsage.costUsd) and optional chaining (null-safe).
 * Returns null if compilation fails (invalid expression).
 */
export function compileView(config: ViewConfig): CompiledView | null {
  try {
    const fn = compileExpression(config.expression, {
      // Enable dot.notation for nested fields (e.g. tokenUsage.costUsd)
      // and optional chaining so accessing props of undefined doesn't throw
      customProp: useDotAccessOperatorAndOptionalChaining,
      extraFunctions: VIEW_FUNCTIONS,
      // Filtrex has no native boolean type — without this, `true`/`false` in
      // expressions are parsed as property name lookups (returning undefined).
      constants: { true: true, false: false },
    });

    return {
      config,
      evaluate: fn as (context: ViewEvaluationContext) => unknown,
    };
  } catch (error) {
    debug(`[views] Failed to compile expression for "${config.id}": ${config.expression}`, error);
    return null;
  }
}

/**
 * Compile all view configs. Skips invalid expressions with a warning.
 * Call once on config load, then cache the result.
 */
export function compileAllViews(configs: ViewConfig[]): CompiledView[] {
  const compiled: CompiledView[] = [];

  for (const config of configs) {
    const result = compileView(config);
    if (result) {
      compiled.push(result);
    }
    // Invalid expressions are logged in compileView and silently skipped
  }

  return compiled;
}

/**
 * Evaluate all compiled views against a session context.
 * Returns the configs of matching views (expression returned truthy).
 *
 * Each evaluation is a native JS function call — very fast.
 * Errors during evaluation (e.g. runtime type issues) are caught per-view
 * so one broken expression doesn't prevent others from matching.
 */
export function evaluateViews(
  context: ViewEvaluationContext,
  compiled: CompiledView[]
): ViewConfig[] {
  const matches: ViewConfig[] = [];

  for (const { config, evaluate } of compiled) {
    try {
      const result = evaluate(context);
      if (result) {
        matches.push(config);
      }
    } catch {
      // Silently skip — runtime errors in individual expressions
      // shouldn't break the entire view evaluation pipeline
    }
  }

  return matches;
}

/**
 * Build an evaluation context from session metadata.
 * Maps the SessionMeta-shaped object to the flat context expected by expressions.
 *
 * This is called once per session per render cycle.
 * The context includes computed fields (hasPendingPlan) derived from raw session data.
 */
export function buildViewContext(meta: {
  name?: string;
  preview?: string;
  sessionStatus?: string;
  permissionMode?: string;
  model?: string;
  lastMessageRole?: string;
  lastMessageAt?: number;
  createdAt?: number;
  messageCount?: number;
  isFlagged?: boolean;
  hasUnread?: boolean;
  isProcessing?: boolean;
  labels?: string[];
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    contextTokens?: number;
  };
}): ViewEvaluationContext {
  return {
    // Strings (default to empty string for safe expression evaluation)
    name: meta.name ?? '',
    preview: meta.preview ?? '',
    sessionStatus: meta.sessionStatus ?? '',
    todoState: meta.sessionStatus ?? '',  // Deprecated alias — existing expressions using todoState still work
    permissionMode: meta.permissionMode ?? '',
    model: meta.model ?? '',
    lastMessageRole: meta.lastMessageRole ?? '',

    // Numbers
    lastUsedAt: meta.lastMessageAt ?? 0,
    createdAt: meta.createdAt ?? 0,
    messageCount: meta.messageCount ?? 0,
    labelCount: meta.labels?.length ?? 0,

    // Booleans
    isFlagged: meta.isFlagged ?? false,
    hasUnread: meta.hasUnread ?? false,
    isProcessing: meta.isProcessing ?? false,
    // Derived: hasPendingPlan is true when last message is a plan
    hasPendingPlan: meta.lastMessageRole === 'plan',

    // Nested objects (safe defaults for dot access)
    tokenUsage: {
      inputTokens: meta.tokenUsage?.inputTokens ?? 0,
      outputTokens: meta.tokenUsage?.outputTokens ?? 0,
      totalTokens: meta.tokenUsage?.totalTokens ?? 0,
      costUsd: meta.tokenUsage?.costUsd ?? 0,
      contextTokens: meta.tokenUsage?.contextTokens ?? 0,
    },

    // Arrays
    labels: meta.labels ?? [],
  };
}
