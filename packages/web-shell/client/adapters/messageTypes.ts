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

export interface DaemonUserMessage {
  id: string;
  role: 'user';
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface DaemonAssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  thinking?: string;
  isStreaming?: boolean;
}

export interface DaemonToolGroupMessage {
  id: string;
  role: 'tool_group';
  tools: DaemonMessageToolCall[];
}

export interface DaemonPlanMessage {
  id: string;
  role: 'plan';
  todos: DaemonMessageTodoItem[];
}

export interface DaemonSystemMessage {
  id: string;
  role: 'system';
  content: string;
  variant: 'info' | 'error' | 'warning';
  retryable?: boolean;
}

export interface DaemonUserShellMessage {
  id: string;
  role: 'user_shell';
  command: string;
  output: string;
  cwd?: string;
}

export interface DaemonBtwMessage {
  id: string;
  role: 'btw';
  question: string;
  answer: string;
  isPending: boolean;
}

export interface DaemonInsightProgressMessage {
  id: string;
  role: 'insight_progress';
  stage: string;
  progress: number;
  detail?: string;
}

export interface DaemonInsightReadyMessage {
  id: string;
  role: 'insight_ready';
  path: string;
}

export interface DaemonInsightErrorMessage {
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
