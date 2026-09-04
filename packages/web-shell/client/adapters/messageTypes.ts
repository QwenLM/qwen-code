/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';

export interface AttachmentPreviewRequest {
  name: string;
  mimeType?: string;
  data?: Blob;
  text?: string;
  workspacePath?: string;
  attachmentId?: string;
}

export type DaemonMessageToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

export type DaemonMessageToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface DaemonMessageToolCallLocation {
  file: string;
  line?: number;
}

export interface DaemonMessageToolCallContent {
  type: 'content' | 'diff' | 'terminal';
  content?: { type: string; text?: string; [key: string]: unknown };
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
}

export interface DaemonMessageToolCall {
  callId: string;
  toolName: string;
  args?: Record<string, unknown>;
  executionMode?: 'foreground' | 'background';
  status: DaemonMessageToolCallStatus;
  parentToolCallId?: string;
  title?: string;
  content?: readonly DaemonMessageToolCallContent[];
  rawOutput?: unknown;
  locations?: DaemonMessageToolCallLocation[];
  kind?: DaemonMessageToolKind;
  startTime?: number;
  endTime?: number;
  wasCancelled?: boolean;
  subContent?: string;
  subTools?: DaemonMessageToolCall[];
  /** Transcript blocks folded into this tool presentation. */
  sourceBlockIds?: string[];
}

export interface DaemonMessageTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
  blockedBy?: string[];
}

/**
 * Fields shared by every history message. Kept as a base interface so a new
 * cross-cutting field is declared once rather than on each role.
 */
export interface DaemonMessageMeta {
  /**
   * Wall-clock epoch milliseconds when the backing transcript block was first
   * observed, populated from `serverTimestamp ?? clientReceivedAt`. Surfaced
   * as a hover tooltip in the message list. Undefined for synthetic messages
   * that have no backing block.
   */
  timestamp?: number;
  /** Stable transcript blocks folded into this rendered message. */
  sourceBlockIds?: string[];
  /**
   * Persisted ChatRecord identities behind this rendered message, in
   * transcript order and deduplicated. Unlike `sourceBlockIds` these survive a
   * reload, an eviction, or a browser restart, which makes them the canonical
   * navigation identity: a durable turn is addressed by its persisted
   * user-record UUID, so a loaded message can be tied to its turn without
   * depending on client-local block ids. Populated only when the caller asks
   * for source identity, exactly like `sourceBlockIds`.
   */
  sourceRecordIds?: readonly string[];
  /**
   * Prompt correlation id the daemon stamped on the source blocks, when any
   * carried one. A message folds blocks from a single prompt, so this is the
   * first of them. Lets a provisional live entry reconcile with its persisted
   * turn by exact identity rather than by label or timestamp. Absent on
   * sessions whose records predate prompt-id stamping.
   */
  promptId?: string;
}

export interface DaemonUserMessage extends DaemonMessageMeta {
  id: string;
  role: 'user';
  content: string;
  images?: Array<{
    data: string;
    mimeType: string;
    /** Present when the image is a session attachment; keeps it re-fetchable. */
    attachmentId?: string;
  }>;
  files?: Array<{
    name: string;
    mimeType: string;
    data?: Blob;
    text?: string;
    attachmentId?: string;
  }>;
  inputAnnotations?: DaemonInputAnnotation[];
  source?: string;
}

export interface DaemonAssistantMessage extends DaemonMessageMeta {
  id: string;
  role: 'assistant';
  content: string;
  isStreaming?: boolean;
  branchRecordId?: string;
  /**
   * Token usage folded onto this assistant block by the daemon SDK reducer
   * (summed when several blocks merge into one message). Summed again across a
   * turn's assistant messages for the per-turn total shown on the fold toggle.
   * Absent on sessions whose agent predates usage stamping.
   */
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}

export interface DaemonThinkingMessage extends DaemonMessageMeta {
  id: string;
  role: 'thinking';
  content: string;
  isStreaming?: boolean;
}

export interface DaemonToolGroupMessage extends DaemonMessageMeta {
  id: string;
  role: 'tool_group';
  tools: DaemonMessageToolCall[];
  /**
   * Thinking folded into this group like a tool (compact mode). Streaming
   * entries carry `isStreaming` so the summary can read "Thinking…" while
   * the model works, then settle to a click-to-expand row when done.
   * `beforeToolCallId` pins each thought to the tool that follows it so the
   * group renders in the original interleaved order; thoughts without one
   * trail the last tool.
   */
  thoughts?: Array<{
    content: string;
    isStreaming?: boolean;
    beforeToolCallId?: string;
  }>;
}

export interface DaemonPlanMessage extends DaemonMessageMeta {
  id: string;
  role: 'plan';
  todos: DaemonMessageTodoItem[];
}

export interface DaemonSystemMessage extends DaemonMessageMeta {
  id: string;
  role: 'system';
  content: string;
  variant: 'info' | 'error' | 'warning';
  retryable?: boolean;
  source?: string;
  data?: unknown;
  images?: Array<{ data: string; mimeType: string }>;
  files?: Array<{
    name: string;
    mimeType: string;
    attachmentId?: string;
  }>;
}

export interface DaemonUserShellMessage extends DaemonMessageMeta {
  id: string;
  role: 'user_shell';
  command: string;
  output: string;
  cwd?: string;
}

export interface DaemonBtwMessage extends DaemonMessageMeta {
  id: string;
  role: 'btw';
  question: string;
  answer: string;
  isPending: boolean;
}

export interface DaemonInsightProgressMessage extends DaemonMessageMeta {
  id: string;
  role: 'insight_progress';
  stage: string;
  progress: number;
  detail?: string;
}

export interface DaemonInsightReadyMessage extends DaemonMessageMeta {
  id: string;
  role: 'insight_ready';
  path: string;
}

export interface DaemonInsightErrorMessage extends DaemonMessageMeta {
  id: string;
  role: 'insight_error';
  error: string;
}

export type DaemonMessage =
  | DaemonUserMessage
  | DaemonAssistantMessage
  | DaemonThinkingMessage
  | DaemonToolGroupMessage
  | DaemonPlanMessage
  | DaemonSystemMessage
  | DaemonUserShellMessage
  | DaemonBtwMessage
  | DaemonInsightProgressMessage
  | DaemonInsightReadyMessage
  | DaemonInsightErrorMessage;
