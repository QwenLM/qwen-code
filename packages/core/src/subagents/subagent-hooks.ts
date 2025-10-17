/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PreToolUsePayload {
  subagentId: string;
  name: string; // subagent name
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface PostToolUsePayload extends PreToolUsePayload {
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}

export interface SubagentStopPayload {
  subagentId: string;
  name: string; // subagent name
  terminateReason: string;
  summary: Record<string, unknown>;
  timestamp: number;
}

export interface SubagentHooks {
  preToolUse?(payload: PreToolUsePayload): Promise<void> | void;
  postToolUse?(payload: PostToolUsePayload): Promise<void> | void;
  onStop?(payload: SubagentStopPayload): Promise<void> | void;
}
