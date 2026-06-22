/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration for ACP message rewriting.
 * Loaded from .qwen/settings.json under "messageRewrite" key.
 */
export interface MessageRewriteConfig {
  /** Whether message rewriting is enabled */
  enabled: boolean;
  /** Which message types to rewrite */
  target: 'message' | 'thought' | 'all';
  /** LLM rewrite prompt (system prompt for the rewriter). Inline string. */
  prompt?: string;
  /** Path to a file containing the rewrite prompt. Resolved relative to CWD.
   *  Takes precedence over `prompt` if both are set. */
  promptFile?: string;
  /** Model to use for rewriting (empty = use current model) */
  model?: string;
  /** Number of previous rewrite outputs to include as context.
   *  1 = last rewrite only (default), "all" = all previous rewrites,
   *  0 = no context, N = last N rewrites. */
  contextTurns?: number | 'all';
  /** Per-rewrite LLM call timeout in milliseconds. Defaults to 30000 (30s). */
  timeoutMs?: number;
}

/**
 * Accumulated content for a single turn.
 */
export interface TurnContent {
  thoughts: string[];
  messages: string[];
  hasToolCalls: boolean;
}
