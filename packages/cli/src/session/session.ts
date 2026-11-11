/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Message,
  AiTitleOrigin,
  AskPrompt,
  PermissionMode,
  PermissionModeChangeTelemetryContext,
  ReasoningEffortLevel,
  SerializableConfirmationDetails,
  ThoughtSummary,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from '@qwen-code/core';
import type {
  SessionPort,
  SessionMessageSource,
  SessionRestoreState,
} from './sessionPort.js';
import type { SessionModelInfo } from './sessionModels.js';

export interface SessionAccessState {
  readonly status:
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'failed';
  readonly sessionId: string | null;
  readonly error: string | null;
}
/** Imported session history records. Rendering remains the UI's responsibility. */
export type SessionHistoryRecord = Readonly<Record<string, unknown>>;
export interface SessionApproval {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly input?: Record<string, unknown>;
  readonly description: string;
  readonly title?: string;
  readonly details?: SerializableConfirmationDetails;
  /** Original permission facts; settlement remains owned by the local session. */
  readonly permissionPrompt?: AskPrompt;
  readonly prompt?: { readonly reason: string; readonly skippable: boolean };
}
export interface SessionSettings {
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffortLevel;
  readonly contextWindow?: number;
  readonly permissionMode: PermissionMode;
}
/** Plan selection is separate from the current permission mode. */
export type SessionModeChoice = PermissionMode | 'plan';
/** Original execution facts needed by UI consumers; no execution is owned here. */
export interface SessionActivityState {
  readonly status: 'idle' | 'responding' | 'waiting_for_confirmation';
  readonly isModelTurnActive: boolean;
  /** Live guard; it may change before the next committed display snapshot. */
  readonly isResponding: boolean;
  readonly thought: ThoughtSummary | null;
}
export interface SessionState extends SessionSettings {
  /** Native execution supplies exact facts; transports can use message projections. */
  readonly activity?: SessionActivityState;
  readonly planMode?: boolean;
  readonly access: SessionAccessState;
  readonly title: string | null;
  readonly models: readonly SessionModelInfo[];
  readonly modeChoices: readonly SessionModeChoice[];
  readonly approvals: readonly SessionApproval[];
  /** Only the initial/restore values. SessionPort.observe owns current message facts. */
  readonly initialMessages: SessionRestoreState;
  /** Full UI pending display, including shell/command items outside execution. */
  readonly displayPendingHistory?: readonly SessionHistoryRecord[];
  readonly pendingHistory: readonly SessionHistoryRecord[] | null;
  readonly historyAvailable: boolean;
  /** Imported initial records; only the UI interprets their display format. */
  readonly initialHistory?: readonly SessionHistoryRecord[];
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly warnings?: readonly string[];
}
export type SessionSettingsChange = Partial<
  Omit<SessionSettings, 'reasoningEffort' | 'contextWindow'>
> & {
  reasoningEffort?: ReasoningEffortLevel | null;
  contextWindow?: number | null;
};
export type SessionUpdate =
  | { type: 'snapshot'; state: SessionState; reason: 'observe' | 'restore' }
  | { type: 'access'; state: SessionAccessState }
  | { type: 'settings'; settings: SessionSettingsChange }
  | { type: 'title'; title: string; origin?: AiTitleOrigin }
  | { type: 'models'; models: readonly SessionModelInfo[] }
  | { type: 'mode_choices'; choices: readonly SessionModeChoice[] }
  | { type: 'approval'; approval: SessionApproval; replace: boolean }
  | { type: 'approval_removed'; id: string }
  | { type: 'approvals_cleared' }
  | {
      type: 'history';
      kind: 'snapshot' | 'pending' | 'display_pending';
      records: readonly SessionHistoryRecord[];
    }
  | { type: 'history'; kind: 'append'; record: SessionHistoryRecord }
  | { type: 'delivery'; source: SessionMessageSource };

/** Operations and observations for a conversation; this interface creates no executor. */
export interface SessionHandle extends SessionPort {
  getState(): SessionState;
  observeUpdates(listener: (update: SessionUpdate) => void): () => void;
  /** Restore input remains opaque to the UI and is interpreted by its provider. */
  restore(input: unknown): Promise<void>;
  start(): Promise<void>;
  release(): Promise<void>;
  resume(): Promise<SessionAccessState>;
  end(reason?: string): Promise<void>;
  getMessages(): Message[];
  getConversationMessages(): Message[];
  setMessages(update: (messages: Message[]) => Message[]): void;
  replaceMessages(messages: readonly Message[]): void;
  setModel(
    model: string,
    effort?: ReasoningEffortLevel,
    contextWindow?: number,
    /** Native callers preserve Config's selection scope and save result. */
    options?: { sessionOnly?: boolean },
  ): Promise<boolean | void>;
  setContextWindow(contextWindow?: number): Promise<void>;
  applySettings(
    settings: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Native validation can throw synchronously so shortcuts can choose a fallback. */
  setPermissionMode(
    mode: PermissionMode,
    context?: PermissionModeChangeTelemetryContext,
  ): Promise<void>;
  setTitle(title: string): Promise<void>;
  refreshModels(): Promise<SessionModelInfo[]>;
  respondToApproval(
    id: string,
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
    /** Withdrawal settles nobody answering, instead of a user refusal. */
    options?: { abort?: boolean },
  ): Promise<void>;
  describeOperationError(
    operation: 'submit' | 'interrupt',
    message: string,
  ): string;
}
