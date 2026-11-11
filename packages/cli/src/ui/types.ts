/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CompressionStatus,
  type ThoughtSummary,
  type SubmitPromptActionReturn,
  type SerializableConfirmationDetails,
  type ToolResultDisplay,
  type Kind,
  type SystemSubtype,
  type Message,
  CoreToolCallStatus,
  checkExhaustive,
  type SubagentActivityItem,
} from '@qwen-code/core';
import type { PartListUnion } from '@google/genai';
import { type ReactNode } from 'react';

export { CoreToolCallStatus };
export type {
  ThoughtSummary,
  SerializableConfirmationDetails,
  ToolResultDisplay,
};

// Only defining the state enum needed by the UI
export enum StreamingState {
  Idle = 'idle',
  Responding = 'responding',
  WaitingForConfirmation = 'waiting_for_confirmation',
}

export enum ToolCallStatus {
  Pending = 'Pending',
  Canceled = 'Canceled',
  Confirming = 'Confirming',
  Executing = 'Executing',
  Success = 'Success',
  Error = 'Error',
}

/**
 * Maps core tool call status to a simplified UI status.
 */
export function mapCoreStatusToDisplayStatus(
  coreStatus: CoreToolCallStatus,
): ToolCallStatus {
  switch (coreStatus) {
    case CoreToolCallStatus.Validating:
      return ToolCallStatus.Pending;
    case CoreToolCallStatus.AwaitingApproval:
      return ToolCallStatus.Confirming;
    case CoreToolCallStatus.Executing:
      return ToolCallStatus.Executing;
    case CoreToolCallStatus.Success:
      return ToolCallStatus.Success;
    case CoreToolCallStatus.Cancelled:
      return ToolCallStatus.Canceled;
    case CoreToolCallStatus.Error:
      return ToolCallStatus.Error;
    case CoreToolCallStatus.Scheduled:
      return ToolCallStatus.Pending;
    default:
      return checkExhaustive(coreStatus);
  }
}

/**
 * --- TYPE GUARDS ---
 */

export const isTodoList = (res: unknown): res is { todos: unknown[] } =>
  typeof res === 'object' &&
  res !== null &&
  'todos' in res &&
  Array.isArray((res as { todos?: unknown }).todos);

export interface ToolCallEvent {
  type: 'tool_call';
  status: CoreToolCallStatus;
  callId: string;
  name: string;
  args: Record<string, never>;
  resultDisplay: ToolResultDisplay | undefined;
  confirmationDetails: SerializableConfirmationDetails | undefined;
  correlationId?: string;
}

export interface IndividualToolCallDisplay {
  callId: string;
  parentCallId?: string;
  name: string;
  args?: Record<string, unknown>;
  description: string;
  /** Raw command or concise title (e.g. from getDisplayTitle()). Falls back to description. */
  displayTitle?: string;
  resultDisplay: ToolResultDisplay | undefined;
  status: CoreToolCallStatus;
  // True when the tool was initiated directly by the user (slash/@/shell flows).
  isClientInitiated?: boolean;
  kind?: Kind;
  confirmationDetails: SerializableConfirmationDetails | undefined;
  renderOutputAsMarkdown?: boolean;
  /** Stable execution start time used to derive live shell elapsed time. */
  startedAt?: number;
  executionId?: number;
  outputFile?: string;
  correlationId?: string;
  planModeActive?: boolean;
  progressMessage?: string;
  originalRequestName?: string;
  progress?: number;
  progressTotal?: number;
  /** Live progress metadata for shell commands (totalLines / totalBytes). */
  shellProgress?: { totalLines?: number; totalBytes: number };
  subagentHistory?: SubagentActivityItem[];
}

export interface CompressionProps {
  isPending: boolean;
  originalTokenCount: number | null;
  newTokenCount: number | null;
  compressionStatus: CompressionStatus | null;
  failureReason?: string;
  providerStatus?: number;
  providerCode?: string;
  providerSource?: string;
  displayErrorCode?: string | number;
  errorFallbackMessage?: string;
  trigger?: 'manual' | 'auto';
}

export interface ModelQueueProps {
  status: 'queued' | 'ready';
  requestId?: string;
  requestSetId?: string;
  modelKey?: string;
  queueType?: string;
  queueCount?: number;
  initialQueueCount?: number;
  waitTimeMs?: number;
  waitElapsedMs?: number;
  maxWaitMs?: number;
  serviceAvailable?: boolean;
  progress: number;
}

export interface HistoryItemBase {
  text?: string; // Text content for user/gemini/info/error messages
  /** Stable source identity used by transcript render windows and React keys. */
  renderKey?: string;
  /** Visible in the current UI, but never written to the session transcript. */
  omitFromTranscript?: boolean;
  /** Visible in the TUI, but omitted from the context sent with future turns. */
  excludedFromContext?: boolean;
  /** Associated tool call ID (maps to IndividualToolCallDisplay.callId). Used to reorder ancillary items next to their tool_group. */
  toolCallId?: string;
  /** Marks this item as ancillary to a tool execution (e.g. hook warning). Ancillary items can be absorbed by collapsed read-only groups. */
  isAncillary?: boolean;
}

export type HistoryItemUser = HistoryItemBase & {
  type: 'user';
  text: string;
};

export type HistoryItemGemini = HistoryItemBase & {
  type: 'gemini';
  text: string;
};

export type HistoryItemGeminiContent = HistoryItemBase & {
  type: 'gemini_content';
  text: string;
};

export type HistoryItemCustomContent = HistoryItemBase & {
  type: 'custom_content';
  content: ReactNode;
};

export interface HistoryItemInlineLink {
  text: string;
  href: string;
}

export type HistoryItemTranscriptSubtype = Extract<
  SystemSubtype,
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response'
  | 'local_command_output'
>;

export type HistoryItemInfo = HistoryItemBase & {
  type: 'info';
  text: string;
  /** Render an animated activity marker while this pending item is live. */
  activity?: boolean;
  customContent?: ReactNode;
  links?: HistoryItemInlineLink[];
  secondaryText?: string;
  source?: string;
  transcriptSubtype?: HistoryItemTranscriptSubtype;
  icon?: string;
  color?: string;
};

export type HistoryItemError = HistoryItemBase & {
  type: 'error';
  text: string;
  transcriptSubtype?: Extract<SystemSubtype, 'local_command_output'>;
};

export type HistoryItemWarning = HistoryItemBase & {
  type: 'warning';
  text: string;
  transcriptSubtype?: SystemSubtype;
};

export type HistoryItemAbout = HistoryItemBase & {
  type: 'about';
  cliVersion: string;
  osVersion: string;
  modelVersion: string;
  selectedAuthType: string;
  userEmail?: string;
};

export type HistoryItemHelp = HistoryItemBase & {
  type: 'help';
  timestamp: Date;
};

export interface HistoryItemStatsBase extends HistoryItemBase {
  selectedAuthType?: string;
  userEmail?: string;
  currentModel?: string;
}

export type HistoryItemStats = HistoryItemStatsBase & {
  type: 'stats';
  duration: string;
};

export type HistoryItemModelStats = HistoryItemStatsBase & {
  type: 'model_stats';
};

export type HistoryItemToolStats = HistoryItemBase & {
  type: 'tool_stats';
};

export type HistoryItemModel = HistoryItemBase & {
  type: 'model';
  model: string;
};

export type HistoryItemQuit = HistoryItemBase & {
  type: 'quit';
  duration: string;
};

export type HistoryItemToolGroup = HistoryItemBase & {
  type: 'tool_group';
  tools: IndividualToolCallDisplay[];
  borderTop?: boolean;
  borderBottom?: boolean;
  borderColor?: string;
  borderDimColor?: boolean;
};

export type HistoryItemUserShell = HistoryItemBase & {
  type: 'user_shell';
  text: string;
};

export type HistoryItemCompression = HistoryItemBase & {
  type: 'compression';
  compression: CompressionProps;
};

export type HistoryItemModelQueue = HistoryItemBase & {
  type: 'model_queue';
  modelQueue: ModelQueueProps;
};

export type HistoryItemThinking = HistoryItemBase & {
  type: 'thinking';
  thought: ThoughtSummary;
};

export type HistoryItemHint = HistoryItemBase & {
  type: 'hint';
  text: string;
};

export type HistoryItemSubagent = HistoryItemBase & {
  type: 'subagent';
  agentName: string;
  messages: Message[];
  parentToolUseId?: string;
};

export interface ToolDefinition {
  name: string;
  displayName: string;
  description?: string;
  serverName?: string;
}

// Individually exported types extending HistoryItemBase
export type HistoryItemWithoutId =
  | HistoryItemUser
  | HistoryItemUserShell
  | HistoryItemGemini
  | HistoryItemGeminiContent
  | HistoryItemCustomContent
  | HistoryItemInfo
  | HistoryItemError
  | HistoryItemWarning
  | HistoryItemAbout
  | HistoryItemHelp
  | HistoryItemToolGroup
  | HistoryItemStats
  | HistoryItemModelStats
  | HistoryItemToolStats
  | HistoryItemModel
  | HistoryItemQuit
  | HistoryItemCompression
  | HistoryItemModelQueue
  | HistoryItemThinking
  | HistoryItemHint
  | HistoryItemSubagent;

export type HistoryItem = HistoryItemWithoutId & { id: number };

// Message types used by internal command feedback (subset of HistoryItem types)
export enum MessageType {
  INFO = 'info',
  ERROR = 'error',
  WARNING = 'warning',
  USER = 'user',
  ABOUT = 'about',
  HELP = 'help',
  STATS = 'stats',
  MODEL_STATS = 'model_stats',
  TOOL_STATS = 'tool_stats',
  QUIT = 'quit',
  GEMINI = 'gemini',
  COMPRESSION = 'compression',
  MODEL_QUEUE = 'model_queue',
  HINT = 'hint',
}

// Simplified message structure for internal feedback
export type FeedbackMessage =
  | {
      type: MessageType.INFO | MessageType.ERROR | MessageType.USER;
      content: string; // Renamed from text for clarity in this context
      timestamp: Date;
    }
  | {
      type: MessageType.ABOUT;
      timestamp: Date;
      cliVersion: string;
      osVersion: string;
      modelVersion: string;
      selectedAuthType: string;
      userEmail?: string;
      content?: string; // Optional content, not really used for ABOUT
    }
  | {
      type: MessageType.HELP;
      timestamp: Date;
      content?: string; // Optional content, not really used for HELP
    }
  | {
      type: MessageType.STATS;
      timestamp: Date;
      duration: string;
      content?: string;
    }
  | {
      type: MessageType.MODEL_STATS;
      timestamp: Date;
      content?: string;
    }
  | {
      type: MessageType.TOOL_STATS;
      timestamp: Date;
      content?: string;
    }
  | {
      type: MessageType.QUIT;
      timestamp: Date;
      duration: string;
      content?: string;
    }
  | {
      type: MessageType.COMPRESSION;
      compression: CompressionProps;
      timestamp: Date;
    };

export interface ConsoleMessageItem {
  type: 'log' | 'warn' | 'error' | 'debug' | 'info';
  content: string;
  count: number;
}

/**
 * Result type for a slash command that should immediately result in a prompt
 * being submitted to the model.
 */
export type SubmitPromptResult = SubmitPromptActionReturn & {
  /** Prompt slash-command invocation that produced this model query. */
  commandInvocationId?: string;
};

/**
 * Defines the result of the slash command processor for its consumer in the
 * local TUI session-owner path.
 */
export type SlashCommandProcessorResult =
  | {
      type: 'schedule_tool';
      toolName: string;
      toolArgs: Record<string, unknown>;
      postSubmitPrompt?: PartListUnion;
    }
  | {
      type: 'handled'; // Indicates the command was processed and no further action is needed.
    }
  | SubmitPromptResult;

export interface ConfirmationRequest {
  prompt: ReactNode;
  onConfirm: (confirm: boolean) => void;
  onCancel?: () => void;
  showCancelOption?: boolean;
  hideTitle?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** One hook of the batch currently shown in the status row. */
export interface ActiveHook {
  eventName: string;
  /** First actual start in this batch, before display debounce. */
  batchStartedAt?: number;
  /** Last actual end in this batch, frozen through UI hold and linger. */
  batchEndedAt?: number;
  /** 1-based position among the batch's user-visible hooks. */
  index: number;
  /** Number of user-visible hooks in the batch. */
  total: number;
  /** Custom status message from hook config, displayed as spinner text */
  statusMessage?: string;
  /** True once this hook has finished. */
  settled: boolean;
}
