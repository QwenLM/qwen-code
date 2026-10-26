/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { GoalStateRecordPayloadV2 } from '@qwen-code/qwen-code-core';

export interface ExportToolLocation {
  path: string;
  line?: number | null;
}

export interface ExportToolInvocation {
  getDescription(): string;
  toolLocations(): ExportToolLocation[];
}

export interface ExportToolDefinition {
  displayName?: string;
  kind?: unknown;
  build?: (args: Record<string, unknown>) => ExportToolInvocation;
}

export interface ExportToolRegistry {
  getTool?: (toolName: string) => ExportToolDefinition | null | undefined;
}

export interface ExportConfig {
  getChannel?: () => string | undefined;
  getToolRegistry?: () => ExportToolRegistry | undefined;
}

/**
 * Universal export message format - SSOT for all export formats.
 * This is format-agnostic and contains all information needed for any export type.
 */
export interface ExportMessage {
  uuid: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'system' | 'tool_call';

  /** For user/assistant messages */
  message?: {
    role?: string;
    parts?: Array<{ text: string }>;
    content?: string;
  };

  /** Model used for assistant messages */
  model?: string;

  /**
   * The workspace agent that wrote this message (an `agent_message` reply, or
   * a message an agent posted into the session). Unset for the user's own
   * messages and the session's own assistant.
   */
  author?: ExportMessageAuthor;

  /** Token usage for this message (mainly for assistant messages) */
  usageMetadata?: GenerateContentResponseUsageMetadata;

  /** For tool_call messages */
  toolCall?: {
    toolCallId: string;
    kind: string;
    title: string | object;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    rawInput?: string | object;
    rawOutput?: unknown;
    content?: Array<{
      type: string;
      [key: string]: unknown;
    }>;
    locations?: Array<{
      path: string;
      line?: number | null;
    }>;
    timestamp?: number;
  };

  /**
   * For system messages that record a Goal transition: the journaled
   * `goal_state` record, including the bookkeeping ones the transcript view
   * hides, so an export shows every verdict and stop the Goal went through.
   * The payload is carried whole: the blocked audit and a pending checkpoint
   * are part of why a Goal continued or stopped.
   */
  goalState?: GoalStateRecordPayloadV2;
}

/** Who wrote a message other than the user or the session's assistant. */
export interface ExportMessageAuthor {
  /** The agent's display name. */
  name: string;
}

/**
 * Metadata for export session - contains aggregated statistics and session context.
 */
export interface ExportMetadata {
  /** Session ID */
  sessionId: string;
  /** ISO timestamp when session started */
  startTime: string;
  /** Export timestamp */
  exportTime: string;
  /** Current working directory */
  cwd: string;
  /** Git repository name, if available */
  gitRepo?: string;
  /** Git branch name, if available */
  gitBranch?: string;
  /** Model used in the session */
  model?: string;
  /** Channel/source identifier */
  channel?: string;
  /** Number of user prompts in the session */
  promptCount: number;
  /** Context window utilization percentage (0-100) */
  contextUsagePercent?: number;
  /** Context window size in tokens (used for calculating percentage) */
  contextWindowSize?: number;
  /** Total tokens used (prompt + completion) */
  totalTokens?: number;
  /** Number of files written/edited */
  filesWritten?: number;
  /** Lines of code added */
  linesAdded?: number;
  /** Lines of code removed */
  linesRemoved?: number;
  /** Unique files referenced in the session (written files only) */
  uniqueFiles: string[];
}

/**
 * Complete export session data - the single source of truth.
 */
export interface ExportSessionData {
  sessionId: string;
  startTime: string;
  messages: ExportMessage[];
  /** Session metadata and statistics */
  metadata?: ExportMetadata;
}
