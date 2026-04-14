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
  target: 'message' | 'thought' | 'both';
  /** LLM rewrite prompt (system prompt for the rewriter). Inline string. */
  prompt?: string;
  /** Path to a file containing the rewrite prompt. Resolved relative to CWD.
   *  Takes precedence over `prompt` if both are set. */
  promptFile?: string;
  /** Model to use for rewriting (empty = use current model) */
  model?: string;
}

/**
 * Accumulated content for a single turn.
 */
export interface TurnContent {
  thoughts: string[];
  messages: string[];
  hasToolCalls: boolean;
}
