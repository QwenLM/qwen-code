/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
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
  /** The response parts from tool execution (maps to content in update event) */
  message: Part[];
  /** Display result from tool execution (maps to rawOutput in update event) */
  resultDisplay?: unknown;
  /** Error if tool execution failed */
  error?: Error;
  /** Original args (fallback for TodoWriteTool todos extraction) */
  args?: Record<string, unknown>;
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
