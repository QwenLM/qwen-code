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
  /** LLM rewrite prompt (system prompt for the rewriter) */
  prompt: string;
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
