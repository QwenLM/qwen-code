/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The message contract now lives in `@qwen-code/chat-panel`; this file re-exports
 * it so existing web-shell imports keep resolving.
 */
export type {
  DaemonMessage,
  DaemonMessageToolCall,
  DaemonMessageToolCallContent,
  DaemonMessageToolCallStatus,
  DaemonMessageToolKind,
  DaemonMessageToolCallLocation,
  DaemonMessageTodoItem,
  DaemonMessageMeta,
  DaemonUserMessage,
  DaemonAssistantMessage,
  DaemonThinkingMessage,
  DaemonToolGroupMessage,
  DaemonPlanMessage,
  DaemonSystemMessage,
  DaemonUserShellMessage,
  DaemonBtwMessage,
  DaemonInsightProgressMessage,
  DaemonInsightReadyMessage,
  DaemonInsightErrorMessage,
} from '@qwen-code/chat-panel';
