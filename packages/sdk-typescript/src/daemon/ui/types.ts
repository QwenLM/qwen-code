/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent, PermissionResponse } from '../types.js';

export const DAEMON_PLAN_TOOL_CALL_ID = 'daemon-plan';

export type DaemonUiEventType =
  | 'user.text.delta'
  | 'assistant.text.delta'
  | 'assistant.done'
  | 'thought.text.delta'
  | 'tool.update'
  | 'shell.output'
  | 'permission.request'
  | 'permission.resolved'
  | 'model.changed'
  | 'status'
  | 'error'
  | 'debug';

export interface DaemonUiEventBase {
  type: DaemonUiEventType;
  eventId?: number;
  originatorClientId?: string;
  rawEvent?: DaemonEvent;
}

export interface DaemonUiTextEvent extends DaemonUiEventBase {
  type: 'user.text.delta' | 'assistant.text.delta' | 'thought.text.delta';
  text: string;
}

export interface DaemonUiAssistantDoneEvent extends DaemonUiEventBase {
  type: 'assistant.done';
  reason?: string;
}

export interface DaemonUiToolUpdateEvent extends DaemonUiEventBase {
  type: 'tool.update';
  toolCallId: string;
  title?: string;
  status?: string;
  toolName?: string;
  toolKind?: string;
  content?: unknown;
  locations?: unknown;
  details?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface DaemonUiShellOutputEvent extends DaemonUiEventBase {
  type: 'shell.output';
  text: string;
  stream?: 'stdout' | 'stderr';
}

export interface DaemonUiPermissionOption {
  optionId: string;
  label: string;
  description?: string;
  raw: unknown;
}

export interface DaemonUiPermissionRequestEvent extends DaemonUiEventBase {
  type: 'permission.request';
  requestId: string;
  sessionId?: string;
  title: string;
  options: DaemonUiPermissionOption[];
  toolCall?: unknown;
}

export interface DaemonUiPermissionResolvedEvent extends DaemonUiEventBase {
  type: 'permission.resolved';
  requestId: string;
  outcome: string;
}

export interface DaemonUiModelChangedEvent extends DaemonUiEventBase {
  type: 'model.changed';
  modelId: string;
}

export interface DaemonUiStatusEvent extends DaemonUiEventBase {
  type: 'status' | 'debug';
  text: string;
}

export interface DaemonUiErrorEvent extends DaemonUiEventBase {
  type: 'error';
  text: string;
  recoverable?: boolean;
}

export type DaemonUiEvent =
  | DaemonUiTextEvent
  | DaemonUiAssistantDoneEvent
  | DaemonUiToolUpdateEvent
  | DaemonUiShellOutputEvent
  | DaemonUiPermissionRequestEvent
  | DaemonUiPermissionResolvedEvent
  | DaemonUiModelChangedEvent
  | DaemonUiStatusEvent
  | DaemonUiErrorEvent;

export interface NormalizeDaemonEventOptions {
  /**
   * Client id returned by `DaemonSessionClient`. Used only for optional
   * optimistic-echo suppression; the raw stream remains unchanged.
   */
  clientId?: string;
  /**
   * When a UI app already appended the user's own prompt optimistically,
   * suppress the matching `user_message_chunk` echo from the daemon.
   */
  suppressOwnUserEcho?: boolean;
  /** Keep raw daemon event envelopes on each UI event for debug panels. */
  includeRawEvent?: boolean;
}

export interface DaemonTranscriptQuestionOption {
  label: string;
  description?: string;
  raw: unknown;
}

export interface DaemonTranscriptQuestion {
  header?: string;
  question: string;
  options: DaemonTranscriptQuestionOption[];
  raw: unknown;
}

export type DaemonToolPreview =
  | {
      kind: 'ask_user_question';
      questions: DaemonTranscriptQuestion[];
    }
  | {
      kind: 'command';
      command: string;
      cwd?: string;
    }
  | {
      kind: 'key_value';
      rows: Array<{ label: string; value: string }>;
    }
  | {
      kind: 'generic';
      summary?: string;
    };

export type DaemonTranscriptBlockKind =
  | 'user'
  | 'assistant'
  | 'thought'
  | 'tool'
  | 'shell'
  | 'permission'
  | 'status'
  | 'error'
  | 'debug';

export interface DaemonTranscriptBlockBase {
  id: string;
  kind: DaemonTranscriptBlockKind;
  eventId?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DaemonTextTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'user' | 'assistant' | 'thought';
  text: string;
  streaming?: boolean;
  collapsed?: boolean;
}

export interface DaemonToolTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'tool';
  toolCallId: string;
  title: string;
  status: string;
  toolName?: string;
  toolKind?: string;
  preview: DaemonToolPreview;
  content?: unknown;
  locations?: unknown;
  details?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface DaemonShellTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'shell';
  text: string;
  stream?: 'stdout' | 'stderr';
}

export interface DaemonPermissionTranscriptBlock
  extends DaemonTranscriptBlockBase {
  kind: 'permission';
  requestId: string;
  sessionId?: string;
  title: string;
  options: DaemonUiPermissionOption[];
  toolCall?: unknown;
  preview: DaemonToolPreview;
  resolved?: string;
}

export interface DaemonStatusTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'status' | 'error' | 'debug';
  text: string;
}

export type DaemonTranscriptBlock =
  | DaemonTextTranscriptBlock
  | DaemonToolTranscriptBlock
  | DaemonShellTranscriptBlock
  | DaemonPermissionTranscriptBlock
  | DaemonStatusTranscriptBlock;

export interface DaemonTranscriptState {
  blocks: DaemonTranscriptBlock[];
  lastEventId?: number;
  activeUserBlockId?: string;
  activeAssistantBlockId?: string;
  activeThoughtBlockId?: string;
  blockIndexById: Record<string, number>;
  toolBlockByCallId: Record<string, string>;
  trimmedToolNotificationByCallId: Record<string, true>;
  permissionBlockByRequestId: Record<string, string>;
  nextOrdinal: number;
  now: number;
  maxBlocks: number;
}

export interface DaemonTranscriptReducerOptions {
  maxBlocks?: number;
  now?: number;
}

export interface DaemonTranscriptStore {
  getSnapshot(): DaemonTranscriptState;
  subscribe(listener: () => void): () => void;
  dispatch(event: DaemonUiEvent | DaemonUiEvent[]): void;
  appendLocalUserMessage(text: string): void;
  reset(seed?: Partial<DaemonTranscriptState>): void;
}

export interface DaemonUiSessionActions {
  sendPrompt(text: string): Promise<unknown>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<unknown>;
  respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean>;
}
