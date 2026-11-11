/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook lifecycle result types for the tool execution pipeline.
 *
 * Three hook points with structured result interfaces:
 * - PreToolUse:  modify input, override permission, inject context, stop
 * - PostToolUse: modify output, blocking error, inject context
 * - PostToolUseFailure: error recovery, enhanced error messages
 *
 * These types bridge the existing HookSystem (which fires events and
 * returns DefaultHookOutput/PreToolUseHookOutput) with the structured
 * lifecycle pipeline in tool-execution-lifecycle.ts.
 */

import type { ToolResult } from './tools.js';

// ---------------------------------------------------------------------------
// Hook permission
// ---------------------------------------------------------------------------

/**
 * Permission decisions a hook can make. Maps to a subset of HookDecision
 * from hooks/types.ts, constrained to the values meaningful for tool
 * permission resolution.
 *
 * - `'allow'` — Hook explicitly permits execution.
 * - `'deny'`  — Hook explicitly blocks execution (highest priority).
 * - `'ask'`   — Hook requests user confirmation.
 * - `'none'`  — Hook has no opinion; fall through to the permission pipeline.
 */
export type HookPermissionResult = 'allow' | 'deny' | 'ask' | 'none';

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

/**
 * Structured result from evaluating PreToolUse hooks.
 *
 * Produced by translating the existing DefaultHookOutput / PreToolUseHookOutput
 * into a typed shape that the lifecycle pipeline can consume.
 */
export interface PreToolUseHookResult {
  /**
   * Hook's permission decision for this tool invocation.
   * When undefined, treated as `'none'` (no opinion).
   */
  hookPermissionResult?: HookPermissionResult;

  /**
   * Modified tool input parameters. When present, the lifecycle pipeline
   * should rebuild the invocation with these parameters.
   */
  hookUpdatedInput?: Record<string, unknown>;

  /**
   * Additional context string to inject into the LLM conversation
   * after the tool result.
   */
  additionalContext?: string;

  /**
   * When true, prevents the LLM conversation from continuing after
   * this tool result (different from `stop` which halts the session).
   */
  preventContinuation?: boolean;

  /** When true, requests termination of the entire agent session. */
  stop?: boolean;

  /**
   * Human-readable reason for deny/stop decisions.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------

/**
 * Structured result from evaluating PostToolUse hooks.
 */
export interface PostToolUseHookResult {
  /**
   * Modified semantic tool output. When present, replaces the original model,
   * transcript, and host-facing tool result projections.
   */
  updatedToolOutput?: unknown;

  /**
   * A blocking error message. When present, the tool result is
   * replaced with an error containing this message.
   */
  blockingError?: string;

  /**
   * Additional context strings to inject into the LLM conversation.
   * Each string is wrapped in <hook_context> tags.
   */
  additionalContexts?: string[];

  /**
   * When true, requests that the entire agent session be stopped.
   */
  stop?: boolean;

  /**
   * Human-readable reason for stop/blocking decisions.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// PostToolUseFailure
// ---------------------------------------------------------------------------

/**
 * Structured result from evaluating PostToolUseFailure hooks.
 *
 * When a tool execution fails (throws or returns an error), this hook
 * point gives hooks a chance to recover or enhance the error.
 */
export interface PostToolUseFailureHookResult {
  /**
   * A fully recovered ToolResult. When present, replaces the error
   * entirely — the pipeline treats execution as successful.
   */
  recoveredResult?: ToolResult;

  /**
   * Enhanced error message. When present, replaces the original
   * error message with a more informative one.
   */
  enhancedError?: string;

  /**
   * Additional context strings to inject into the conversation
   * after the failure result, mirroring PostToolUseHookResult.
   */
  additionalContexts?: string[];
}
