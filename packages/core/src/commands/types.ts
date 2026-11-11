/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import type { Message } from '../protocol/transcript/message.js';
import type { DirectSkillActivation } from '../skills/selectedSkillActivation.js';

/** Where a slash command submission came from, used by the input surface. */
export type SlashCommandSource =
  | 'typed'
  | 'menu'
  | 'suggestion'
  | 'programmatic';

/**
 * The return type for a command action that results in scheduling a tool call.
 */
export interface ToolActionReturn {
  type: 'tool';
  toolName: string;
  toolArgs: Record<string, unknown>;
  /**
   * Optional content to be submitted as a prompt to the Gemini model
   * after the tool call completes.
   */
  postSubmitPrompt?: PartListUnion;
}

/**
 * The return type for a command action that results in a simple message
 * being displayed to the user.
 */
export interface MessageActionReturn {
  type: 'message';
  messageType: 'info' | 'warning' | 'error';
  content: string;
}

/**
 * The return type for a command action that results in replacing
 * the entire conversation history.
 */
export interface LoadHistoryActionReturn<HistoryType = unknown> {
  type: 'load_history';
  history: HistoryType;
  /** 会话所有者持有的真实历史，独立于 UI 展示历史。 */
  clientHistory: readonly Message[];
}

/**
 * The return type for a command action that should immediately submit
 * content as a prompt to the Gemini model.
 */
export interface SubmitPromptActionReturn {
  type: 'submit_prompt';
  content: PartListUnion;
  /**
   * When true, the submitted prompt is treated as a synthetic/meta message
   * (not real user input). It will be recorded in the transcript but hidden
   * from the default conversation view and from resume history rendering.
   */
  isMeta?: boolean;
  /**
   * Meta content that is the user's own words, entered in host UI. Auto-mode
   * review reads it as the user, unlike other meta text.
   */
  isUserDecision?: boolean;
  /** Query-scoped tool allowlist (e.g. from plugin command `allowed-tools` frontmatter). */
  allowedTools?: string[];
  /** Model override for this query (e.g. from plugin command `model` frontmatter). */
  model?: string;
  /** Effort level override for this query (e.g. from plugin command `effort` frontmatter). */
  effort?: string;
  /** Optional attribution for a skill activated directly by a slash command. */
  skillActivation?: DirectSkillActivation & {
    activationSource: 'slash_command';
  };
}

export type CommandActionReturn<HistoryType = unknown> =
  | ToolActionReturn
  | MessageActionReturn
  | LoadHistoryActionReturn<HistoryType>
  | SubmitPromptActionReturn;

/**
 * Picks the query-scoped overrides (allowedTools / model / effort) from any
 * object that exposes them, returning only fields that are actually set.
 *
 * Centralises the conditional-spread pattern used by every slash-command
 * call-site that forwards plugin/skill frontmatter to the agent loop.
 */
export function pickQueryOverrides(src: {
  allowedTools?: string[];
  model?: string;
  effort?: string;
}): { allowedTools?: string[]; model?: string; effort?: string } {
  const out: { allowedTools?: string[]; model?: string; effort?: string } = {};
  if (src.allowedTools?.length) out.allowedTools = src.allowedTools;
  if (src.model) out.model = src.model;
  if (src.effort !== undefined && src.effort !== '') out.effort = src.effort;
  return out;
}
