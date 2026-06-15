/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
  status: DaemonMessageToolCallStatus;
  parentToolCallId?: string;
  title?: string;
  content?: DaemonMessageToolCallContent[];
  rawOutput?: unknown;
  locations?: DaemonMessageToolCallLocation[];
  kind?: DaemonMessageToolKind;
  startTime?: number;
  endTime?: number;
  subContent?: string;
  subTools?: DaemonMessageToolCall[];
}

export interface DaemonMessageTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
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
}

export interface DaemonUserMessage extends DaemonMessageMeta {
  id: string;
  role: 'user';
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface DaemonAssistantMessage extends DaemonMessageMeta {
  id: string;
  role: 'assistant';
  content: string;
  thinking?: string;
  isStreaming?: boolean;
}

export interface DaemonToolGroupMessage extends DaemonMessageMeta {
  id: string;
  role: 'tool_group';
  tools: DaemonMessageToolCall[];
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
  | DaemonToolGroupMessage
  | DaemonPlanMessage
  | DaemonSystemMessage
  | DaemonUserShellMessage
  | DaemonBtwMessage
  | DaemonInsightProgressMessage
  | DaemonInsightReadyMessage
  | DaemonInsightErrorMessage;
