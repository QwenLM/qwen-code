/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';

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

  /** Token usage for this message (mainly for assistant messages) */
  usageMetadata?: GenerateContentResponseUsageMetadata;

  /** For tool_call messages */
  toolCall?: {
    toolCallId: string;
    kind: string;
    title: string | object;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    rawInput?: string | object;
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
