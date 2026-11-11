/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelMessage,
  ModelStreamEvent,
  ModelInputContentBlock,
  BlockedExternalImport,
  FileHistorySnapshot,
  FileHistoryRewindResult,
  Message,
  PastedContent,
  HookEventName,
  PendingHookOutput,
  PromptBuildResult,
  PermissionMode,
  CommandMode,
  QueuedCommand,
  UserShellCommandOutcome,
  ConversationRewindPlan,
} from '@qwen-code/core';
import type { PartListUnion } from '@google/genai';
import {
  type HistoryItemWithoutId,
  type ModelQueueProps,
  StreamingState,
} from '../types.js';
import type { ExternalImportApprovalResult } from '../components/ExternalImportApprovalDialog.js';
import type {
  TrackedToolCall,
  TrackedWaitingToolCall,
} from './useToolScheduler.js';

export interface SubmitQueryOptions {
  hideFromDisplay?: boolean;
  emitInputEvent?: boolean;
  /**
   * Marks a real user-authored prompt that should advance the ai-title
   * generation cadence. Internal/system follow-up prompts must leave this off.
   */
  countTowardsAiTitleCadence?: boolean;
  pastedContents?: Record<number, PastedContent>;
  userMessage?: {
    uuid?: string;
    timestamp?: string;
  };
  /** Marks a synthetic prompt injected by the system (e.g. a slash command), not real user input. */
  isMeta?: boolean;
  /** Rich content blocks (e.g. image blocks supplied by a session client). When present, used as the agent-loop prompt. */
  contentBlocks?: readonly ModelInputContentBlock[];
  /** Route normal user input through the shared processUserInput/executeUserInput chain. */
  useInputProcessor?: boolean;
  /** Reuse a prompt id when processUserInput has already fired lifecycle hooks. */
  promptId?: string;
  /** Interpret this prompt as a specific queued command mode. */
  commandMode?: CommandMode;
  /** Full queued command batch to preserve queue metadata and per-command modes. */
  queuedCommands?: QueuedCommand[];
  /** Per-prompt opt-out from the local TUI UltraCode keyword trigger. */
  suppressWorkflowKeyword?: boolean;
  /** When true, the query starts with stopHookActive=true (asyncRewake rewake turn). */
  stopHookActive?: boolean;
}

export interface SubmitUserInputOptions
  extends Pick<
    SubmitQueryOptions,
    'hideFromDisplay' | 'userMessage' | 'contentBlocks'
  > {
  pastedContents?: Record<number, PastedContent>;
  commandMode?: CommandMode;
  /** Full queued command batch to preserve queue metadata. */
  queuedCommands?: QueuedCommand[];
  /** Per-prompt opt-out from the local TUI UltraCode keyword trigger. */
  suppressWorkflowKeyword?: boolean;
}

export interface ManualCompressResult {
  newHistory: Message[] | null;
  info: {
    originalTokenCount: number | null;
    newTokenCount: number | null;
    compressionStatus: number | null;
    blockReason?: string;
    failureReason?: string;
    providerStatus?: number;
    providerCode?: string;
    providerSource?: string;
    displayErrorCode?: string | number;
    errorFallbackMessage?: string;
  };
}

export type RunManualCompress = (
  customInstructions?: string,
) => Promise<ManualCompressResult>;

export interface ExternalImportApprovalState {
  isOpen: boolean;
  pendingImports: readonly BlockedExternalImport[];
}

export const EMPTY_EXTERNAL_IMPORT_STATE: ExternalImportApprovalState = {
  isOpen: false,
  pendingImports: [],
};

/**
 * How the last turn ended. `null` before any turn and for turns the model
 * never took part in (e.g. a local slash command).
 */
export type TurnEnd = 'completed' | 'cancelled' | { error: string } | null;

export interface RuntimeProjectionController {
  /** Read the original native projection, without rebuilding it in the container. */
  getSnapshot(): RuntimeProjectionSnapshot;
  startTurn(options?: { modelTurnActive?: boolean }): void;
  handleInputResolved(shouldQuery: boolean): void;
  handleRequestStart(): void;
  handleStreamEvent(event: ModelStreamEvent): void;
  handleAssistantBlock(message: ModelMessage, index: number): void;
  handleAssistantMessage(
    message: Pick<
      Extract<Message, { type: 'assistant' }>['message'],
      'content'
    >,
  ): void;
  handleToolResultMessage(message: Extract<Message, { type: 'user' }>): void;
  markToolResultsSubmitted(toolUseIds: string[]): void;
  flushPendingToHistory(options?: { skipEmptyAssistant?: boolean }): void;
  /**
   * Records how the current turn ended, committed by finishTurn(). Only the
   * last call before finishTurn() counts; cancelTurn() always wins.
   */
  recordTurnEnd(outcome: Exclude<TurnEnd, 'completed' | null>): void;
  finishTurn(): void;
  cancelTurn(): void;
  getStreamingState(): StreamingState;
  getToolCalls(): TrackedToolCall[];
  getAwaitingApprovalCalls(): TrackedWaitingToolCall[];
  cancelAllToolCalls(signal: AbortSignal): void;
}

/** No-op implementation for use as a ref initial value before the real controller is available. */
export const NOOP_RUNTIME_PROJECTION: RuntimeProjectionController = {
  getSnapshot: () => ({
    streamingState: StreamingState.Idle,
    isModelTurnActive: false,
    thought: null,
    pendingHistoryItems: [],
    pendingToolCalls: [],
    lastTurnEnd: null,
  }),
  startTurn: () => {},
  handleInputResolved: () => {},
  handleRequestStart: () => {},
  handleStreamEvent: () => {},
  handleAssistantBlock: () => {},
  handleAssistantMessage: () => {},
  handleToolResultMessage: () => {},
  markToolResultsSubmitted: () => {},
  flushPendingToHistory: () => {},
  recordTurnEnd: () => {},
  finishTurn: () => {},
  cancelTurn: () => {},
  getStreamingState: () => StreamingState.Idle,
  getToolCalls: () => [],
  getAwaitingApprovalCalls: () => [],
  cancelAllToolCalls: () => {},
};

export interface RuntimeProjectionSnapshot {
  streamingState: StreamingState;
  /** True once input is known to require the model and until its turn ends. */
  isModelTurnActive: boolean;
  thought: import('@qwen-code/core').ThoughtSummary | null;
  pendingHistoryItems: HistoryItemWithoutId[];
  pendingToolCalls: TrackedToolCall[];
  lastTurnEnd: TurnEnd;
}

/** Terminal outcome of a user-initiated shell mode command. */
export type BashCommandOutcome = UserShellCommandOutcome;

export interface ReplaceMessagesOptions {
  resume?: import('@qwen-code/core').AcquireSessionWriterOptions['resume'];
  coldResume?: import('@qwen-code/core').AcquireSessionWriterOptions['coldResume'];
  restoreExistingSession?: boolean;
  fileHistorySnapshots?: FileHistorySnapshot[];
  sourceSessionId?: string;
  /**
   * Override the resume-time file-history persistence decision. Fork handlers
   * pass false because the new transcript already carries every snapshot.
   */
  persistFileHistoryToTranscript?: boolean;
  /** Fork creation already copied every checkpoint blob; resume only restores memory. */
  copyFileHistoryBackups?: boolean;
  sessionPath?: string;
  setConfigSessionId?: boolean;
  targetWorkspaceDirectories?: readonly string[];
  transcriptProjectRoot?: string;
  originalCwd?: string;
  worktreeSession?:
    | import('@qwen-code/core').TranscriptWorktreeSession
    | null;
}

export type ReplaceMessagesFn = (
  messages: Message[],
  sessionId?: string,
  options?: ReplaceMessagesOptions,
) => Promise<void>;

export interface LocalRewindOptions {
  getExternalRevision(): number;
  assertReady(): void;
  commitView(plan: ConversationRewindPlan): void;
  restoreView(): void;
}

export type RewindConversationFn = (
  targetUuid: string,
  options: LocalRewindOptions,
) => Promise<ConversationRewindPlan>;

export interface LocalTuiSessionOrchestratorResult {
  /** Lazily expose this existing executor; the native owner releases the handle. */
  getSession(): import('../../session/localSession.js').LocalSessionHandle;
  /** 项目重建前等待 Writer、用量和后台请求收尾，不删除会话或 Worktree。 */
  dispose: () => Promise<void>;
  rewindFiles: (messageId: string) => Promise<FileHistoryRewindResult>;
  submitUserInput: (
    input: string,
    options?: SubmitUserInputOptions,
  ) => Promise<void>;
  submitQuery: (
    query: PartListUnion,
    options?: SubmitQueryOptions,
  ) => Promise<void>;
  cancelOngoingRequest: () => void;
  handlePermissionModeChange: (newMode: PermissionMode) => Promise<void>;
  replaceMessages: ReplaceMessagesFn;
  rewindConversation: RewindConversationFn;
  queueHookContext: (
    context: string,
    hookEventName?: HookEventName,
    sourceType?: PendingHookOutput['sourceType'],
  ) => void;
  recordSupplementaryHistoryItem: (item: HistoryItemWithoutId) => Promise<void>;
  recordMessage: (message: Message) => Promise<void>;
  runManualCompress: RunManualCompress;
  ensurePromptBuildResult: () => Promise<PromptBuildResult | undefined>;
  refreshContextTokenCount: () => Promise<void>;
  toolRegistry: import('@qwen-code/core').ToolRegistry;
  clearAssemblerCache: () => void;
  getIsResponding: () => boolean;
  getConversationMessages: () => Message[];
  getMessages: () => Message[];
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  externalImportApprovalState: ExternalImportApprovalState;
  handleExternalImportApproval: (result: ExternalImportApprovalResult) => void;
  ensureAiTitle: () => void;
  activeModelQueue: ModelQueueProps | null;
}
