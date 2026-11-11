/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandMode,
  MessageOrigin,
  ModelStreamToolResultContent,
  PastedContent,
  QueuedCommand,
} from '@qwen-code/core';

/** Ordinary message input. Display policy and transport envelopes stay outside. */
export interface SessionMessageInput {
  id: string;
  text: string;
  content: Array<{ type: string; [key: string]: unknown }>;
}

/** Per-submission metadata; message identity and content remain unchanged. */
export interface SessionSubmitOptions {
  /** Local execution preserves the existing human/bridge rules; omitted means human. */
  origin?: Extract<MessageOrigin, { kind: 'human' | 'bridge' }>;
  /** Preserve the original message time when the caller already has one. */
  timestamp?: string;
  /** A retry can execute without adding another optimistic input to the feed. */
  hideFromDisplay?: boolean;
  /** Local input retains its original processor context; remote transports ignore it. */
  pastedContents?: Record<number, PastedContent>;
  commandMode?: CommandMode;
  queuedCommands?: QueuedCommand[];
  suppressWorkflowKeyword?: boolean;
}

/**
 * Present when the local UI interrupts (Esc / Ctrl+C): cancel the whole turn.
 * A bare interrupt (remote / headless) first settles a pending permission prompt.
 */
export interface SessionInterruptOptions {
  source?: string;
  origin?: string;
}

export interface SessionUserContent {
  text: string;
  images: Array<{ media_type: string; data: string; blob_id?: string }>;
}

export interface SessionToolResult {
  toolUse: { id: string; name: string; input: unknown };
  toolResult: {
    content?: ModelStreamToolResultContent;
    isError: boolean;
    toolUseResult?: unknown;
  };
}

/** Current message facts, not a terminal snapshot or a complete session history. */
export interface SessionMessageState {
  readonly pendingAssistantText: string;
  readonly pendingThinkingText: string;
  /** Caller activity, including send progress; not a model-start acknowledgement. */
  readonly activityStatus: string;
  readonly isSending: boolean;
}

/** Where the message was delivered; no terminal display policy. */
export interface SessionMessageSource {
  /** Recovery is the initial/reconnect replay, not routine event polling. */
  delivery: 'live' | 'recovery';
  /** The same source batch also carries authoritative display-history events. */
  hasDisplayHistory: boolean;
}

export interface AssistantStreamDelta {
  type: 'text_delta' | 'thinking_delta';
  text: string;
}

export type SessionRestoreState = Pick<
  SessionMessageState,
  'pendingAssistantText' | 'activityStatus'
>;

export type SessionChange =
  | {
      type: 'snapshot';
      state: SessionMessageState;
      reason: 'observe' | 'restore';
    }
  // These events describe this caller's send operation, not model execution.
  | {
      type: 'input_prepared';
      message: SessionMessageInput;
      /** Omitted when the consumer must provide the optimistic input display. */
      source?: SessionMessageSource;
    }
  | { type: 'send_started'; messageId: string }
  | { type: 'send_failed'; messageId: string; errorMessage: string }
  | { type: 'send_finished'; messageId: string }
  | {
      type: 'user_message';
      content?: SessionUserContent;
      toolResults?: readonly SessionToolResult[];
      synthetic: boolean;
      source: SessionMessageSource;
    }
  | {
      type: 'assistant_message';
      content?: { text: string; thinkingTexts: readonly string[] };
      endsTurn: boolean;
      source: SessionMessageSource;
    }
  | {
      type: 'assistant_stream';
      delta?: AssistantStreamDelta;
      source: SessionMessageSource;
    }
  | { type: 'status'; activityStatus: string; transition: boolean }
  | { type: 'interrupted'; scope?: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'connection_closed' };

/** An implementation message event, excluding observation/restoration snapshots. */
export type SessionEvent = Exclude<SessionChange, { type: 'snapshot' }>;

/** Message operations only; approvals, settings and attachment lifetime migrate later. */
export interface SessionPort {
  /** Report prepared input and the caller send lifecycle through observe. */
  submitMessage: (
    message: SessionMessageInput,
    options?: SessionSubmitOptions,
  ) => Promise<void>;
  interrupt: (options?: SessionInterruptOptions) => Promise<void>;
  /** Deliver current facts first, then ordered changes without an attachment gap. */
  observe: (listener: (change: SessionChange) => void) => () => void;
}
