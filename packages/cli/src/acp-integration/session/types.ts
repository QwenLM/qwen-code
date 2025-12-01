/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type * as acp from '../acp.js';

/**
 * Interface for sending session updates to the ACP client.
 * Implemented by Session class and used by all emitters.
 */
export interface SessionUpdateSender {
  sendUpdate(update: acp.SessionUpdate): Promise<void>;
}

/**
 * Session context shared across all emitters.
 * Provides access to session state and configuration.
 */
export interface SessionContext extends SessionUpdateSender {
  readonly sessionId: string;
  readonly config: Config;
}

/**
 * Parameters for emitting a tool call start event.
 */
export interface ToolCallStartParams {
  /** Name of the tool being called */
  toolName: string;
  /** Unique identifier for this tool call */
  callId: string;
  /** Arguments passed to the tool */
  args?: Record<string, unknown>;
  /** Optional description override (e.g., from subagent events) */
  description?: string;
}

/**
 * Parameters for emitting a tool call result event.
 */
export interface ToolCallResultParams {
  /** Name of the tool that was called */
  toolName: string;
  /** Unique identifier for this tool call */
  callId: string;
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Display result from tool execution */
  resultDisplay?: unknown;
  /** Error if tool execution failed */
  error?: Error;
  /** Original args (fallback for TodoWriteTool todos extraction) */
  args?: Record<string, unknown>;
  /**
   * Fallback content from message when resultDisplay is not available.
   * Used in history replay when tool result has content in message but not resultDisplay.
   */
  fallbackContent?: string;
  /**
   * Optional extra fields for tool_call_update (used by SubAgentTracker).
   * When provided, these are included in the update event.
   */
  extra?: {
    title?: string;
    kind?: acp.ToolKind | null;
    locations?: acp.ToolCallLocation[] | null;
    rawInput?: Record<string, unknown>;
  };
}

/**
 * Todo item structure for plan updates.
 */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Resolved tool metadata from the registry.
 */
export interface ResolvedToolMetadata {
  title: string;
  locations: acp.ToolCallLocation[];
  kind: acp.ToolKind;
}
