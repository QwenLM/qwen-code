/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
} from 'react';
import {
  runOutsideAgentContext,
  type Config,
  type EditorType,
  type LlmClient,
  type Logger,
  type RetryInfo,
  type ServerLlmChatCompressedEvent,
  type ServerLlmContentEvent as ContentEvent,
  type ServerLlmFinishedEvent,
  type ServerLlmStreamEvent as LlmEvent,
  type ThoughtSummary,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
  type LlmErrorEventValue,
  type GoalTurnPermit,
  type SteerInput,
  LlmEventType as ServerLlmEventType,
  SendMessageType,
  createDebugLogger,
  ToolNames,
  goalToolResultProvenance,
  getErrorMessage,
  isNodeError,
  MessageSenderType,
  logUserPrompt,
  logUserRetry,
  UnauthorizedError,
  UserPromptEvent,
  UserRetryEvent,
  logConversationFinishedEvent,
  ConversationFinishedEvent,
  ApprovalMode,
  parseAndFormatApiError,
  promptIdContext,
  ToolConfirmationOutcome,
  logApiCancel,
  ApiCancelEvent,
  detectAutonomousSentinel,
  isSupportedImageMimeType,
  getUnsupportedImageFormatWarning,
  runVisionBridge,
  shouldRunVisionBridge,
  formatVisionBridgeNotice,
  formatFullTurnVisionNotice,
  getFullTurnVisionModelSelector,
  hasImageParts,
  clampInlineMediaPart,
  splitImageParts,
  generateToolUseSummary,
  goalRequiresExactPermit,
  createDuplicateProviderToolCallResponse,
  markDuplicateProviderToolCallResponseSent,
  findRepeatedDuplicateProviderToolCall,
  getCachedToolCallFingerprint,
  isReplayOfHandledToolCall,
  recordHandledToolCall,
  AutonomousLoopTickResolver,
  didWriteProjectContextFile,
  refreshMemoryAfterManagedWrite,
  refreshMemoryInstruction,
  finalizeToolResponses,
  endInteractionSpan,
  getActiveInteractionSpan,
  renderGoalContinuationPrompt,
} from '@qwen-code/qwen-code-core';
import { type Part, type PartListUnion, FinishReason } from '@google/genai';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  HistoryItemToolGroup,
  HistoryItemLlm,
  InlineImageData,
  SlashCommandProcessorResult,
} from '../types.js';
import { StreamingState, MessageType, ToolCallStatus } from '../types.js';
import {
  isAtCommand,
  isBtwCommand,
  isSlashCommand,
} from '../utils/commandUtils.js';
import { findLastUserItemIndex } from '../utils/historyUtils.js';
import { useShellCommandProcessor } from './shellCommandProcessor.js';
import {
  handleAtCommand,
  resolveAtCommandQuery,
} from './atCommandProcessor.js';
import {
  findLastSafeSplitPoint,
  splitFencedMarkdown,
  getEnclosingFenceInfo,
} from '../utils/markdownUtilities.js';
import { fitPendingSlice } from '../utils/pending-rendered-height.js';
import { useStateAndRef } from './useStateAndRef.js';
import { normalizePartList } from '../../utils/normalize-part-list.js';
import { isInlineModelOverrideAllowed } from '../../utils/acpModelUtils.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import {
  useReactToolScheduler,
  mapToDisplay as mapTrackedToolCallsToDisplay,
  type TrackedToolCall,
  type TrackedCompletedToolCall,
  type TrackedCancelledToolCall,
  type TrackedExecutingToolCall,
  type TrackedWaitingToolCall,
} from './useReactToolScheduler.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { useSessionStats } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { useDualOutput } from '../../dualOutput/DualOutputContext.js';
import { shouldDisplayGoalStateCause } from '../utils/goal-runtime.js';
import { sanitizeDisplayText } from '../../utils/extension-mention.js';
import process from 'node:process';
import {
  GOAL_COMMAND_RE,
  type DirectUserAdmission,
  type QueuedGoalTurn,
} from './useMessageQueue.js';
import { classifyApiError } from '../../utils/classify-api-error.js';
import { cleanupReviewWorktreeLeases } from '../../services/review-worktree-lease.js';
import {
  getInlineImageData,
  MAX_INLINE_IMAGES_PER_ITEM,
} from '../utils/inline-image-parts.js';

const debugLogger = createDebugLogger('GEMINI_STREAM');

interface ToolContinuationOwner {
  promptId: string;
  signal: AbortSignal;
  survivesGenerationChange: boolean;
  detachedAbortController?: AbortController;
  foregroundAbortController?: AbortController;
}

// The per-turn model override is held in two coupled refs: the model id and a
// flag marking whether it came from an explicit inline `/model <id> <prompt>`
// (which must win over skill-tool overrides for the rest of the turn). The two
// always move together; these helpers are the single place that writes both so
// the invariant (inline flag true => model id set) can't be broken by editing
// one ref in isolation, and every set/clear is traceable via debug logs.
function applyModelOverride(
  modelOverrideRef: { current: string | undefined },
  inlineActiveRef: { current: boolean },
  value: string | undefined,
  isInline: boolean,
): void {
  modelOverrideRef.current = value;
  inlineActiveRef.current = isInline;
  debugLogger.debug(
    `model override ${
      value === undefined ? 'cleared' : `set to ${value}`
    } (inline=${isInline})`,
  );
}

function clearModelOverride(
  modelOverrideRef: { current: string | undefined },
  inlineActiveRef: { current: boolean },
): void {
  applyModelOverride(modelOverrideRef, inlineActiveRef, undefined, false);
}

const MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MS = 10_000;
const MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MESSAGE =
  'Mid-turn @ command resolution timed out';

interface PendingDuplicateToolResponses {
  executableCallIds: Set<string>;
  promptId: string | undefined;
  callOrder: string[];
  duplicateResponses: Array<{
    request: ToolCallRequestInfo;
    response: ToolCallResponseInfo;
  }>;
}

interface ResolvedSteerMessages {
  parts: Part[];
  accept: () => void;
  restoreMessages: string[];
}

interface GoalTurnBinding {
  permit: GoalTurnPermit;
  turnKey: string;
  controller: AbortController;
  origin: 'runtime' | 'user';
}

type GoalTurnAdmission = Omit<GoalTurnBinding, 'permit'>;

function sameGoalPermit(left: GoalTurnPermit, right: GoalTurnPermit): boolean {
  return (
    left.goalId === right.goalId &&
    left.revision === right.revision &&
    left.turnId === right.turnId
  );
}

function sharedGoalPermit(
  contexts: Array<GoalTurnPermit | undefined>,
): GoalTurnPermit | undefined {
  const first = contexts[0];
  if (contexts.every((context) => context === undefined)) return undefined;
  if (
    !first ||
    contexts.some((context) => !context || !sameGoalPermit(first, context))
  ) {
    throw new Error('ToolResult batch has mixed Goal contexts');
  }
  return { ...first };
}

/**
 * Pull the assistant's most recent visible text from the UI history. Used as
 * an intent prefix for tool-use summary generation so the summarizer knows
 * what the user was trying to accomplish.
 */
function extractLastAssistantText(history: HistoryItem[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (
      (item.type === 'gemini' || item.type === 'gemini_content') &&
      typeof item.text === 'string' &&
      item.text.trim().length > 0
    ) {
      return item.text;
    }
  }
  return undefined;
}

function stripLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '');
}

async function resolveWithAbort<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Mid-turn @ command resolution aborted'),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([run(), abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Flatten `functionResponse` parts into a compact string for the summarizer.
 * The summarizer itself truncates to 300 chars per field, so we just join
 * whatever is available without re-serializing.
 */
function extractToolResultText(parts: Part[] | Part | undefined): unknown {
  if (!parts) return '';
  const list = Array.isArray(parts) ? parts : [parts];
  const chunks: unknown[] = [];
  for (const part of list) {
    if ('functionResponse' in part && part.functionResponse) {
      const response = (part.functionResponse as { response?: unknown })
        .response;
      if (response !== undefined) chunks.push(response);
    } else if ('text' in part && typeof part.text === 'string') {
      chunks.push(part.text);
    }
  }
  if (chunks.length === 0) return '';
  if (chunks.length === 1) return chunks[0];
  return chunks;
}

/**
 * Checks if image parts have supported formats and returns unsupported ones
 */
function checkImageFormatsSupport(parts: PartListUnion): {
  hasImages: boolean;
  hasUnsupportedFormats: boolean;
  unsupportedMimeTypes: string[];
} {
  const unsupportedMimeTypes: string[] = [];
  let hasImages = false;

  if (typeof parts === 'string') {
    return {
      hasImages: false,
      hasUnsupportedFormats: false,
      unsupportedMimeTypes: [],
    };
  }

  const partsArray = Array.isArray(parts) ? parts : [parts];

  for (const part of partsArray) {
    if (typeof part === 'string') continue;

    let mimeType: string | undefined;

    // Check inlineData
    if (
      'inlineData' in part &&
      part.inlineData?.mimeType?.startsWith('image/')
    ) {
      hasImages = true;
      mimeType = part.inlineData.mimeType;
    }

    // Check fileData
    if ('fileData' in part && part.fileData?.mimeType?.startsWith('image/')) {
      hasImages = true;
      mimeType = part.fileData.mimeType;
    }

    // Check if the mime type is supported
    if (mimeType && !isSupportedImageMimeType(mimeType)) {
      unsupportedMimeTypes.push(mimeType);
    }
  }

  return {
    hasImages,
    hasUnsupportedFormats: unsupportedMimeTypes.length > 0,
    unsupportedMimeTypes,
  };
}

enum StreamProcessingStatus {
  Completed,
  UserCancelled,
  Error,
}

interface StreamProcessingResult {
  status: StreamProcessingStatus;
  scheduledToolContinuation: boolean;
}

const EDIT_TOOL_NAMES = new Set([
  ToolNames.EDIT,
  'replace', // legacy alias, may still arrive from older providers
  ToolNames.WRITE_FILE,
  ToolNames.NOTEBOOK_EDIT,
]);
const STREAM_UPDATE_THROTTLE_MS = 60;
const STREAM_PENDING_ITEM_MAX_CHARS = 16_384;
// Rows kept in reserve below the commit budget so the incremental commit fires
// BEFORE MarkdownDisplay's safety-net clip (which reserves 2). Keeping the
// pending item's rendered height under the safety budget stops that clip from
// engaging and hiding a table (or slicing the tail) in step with the commit
// cycle.
const STREAM_PENDING_COMMIT_RESERVE_ROWS = 5;
// Conservative estimate of the rows the composer/footer occupy, used to derive
// a content-area height from terminalHeight before the live value is known.
const STREAM_PENDING_COMPOSER_RESERVE_ROWS = 12;
const LOADING_THOUGHT_DESCRIPTION_MAX_CHARS = 4_096;

type BufferedStreamEvent =
  | { kind: 'content'; value: string }
  | { kind: 'image'; value: InlineImageData }
  | { kind: 'thought'; value: ThoughtSummary };

function showCitations(settings: LoadedSettings): boolean {
  const enabled = settings?.merged?.ui?.showCitations;
  if (enabled !== undefined) {
    return enabled;
  }
  return true;
}

function clampLoadingThoughtDescription(description: string): string {
  if (description.length <= LOADING_THOUGHT_DESCRIPTION_MAX_CHARS) {
    return description;
  }

  return description.slice(0, LOADING_THOUGHT_DESCRIPTION_MAX_CHARS);
}

/**
 * Character index just after the `keptLines`-th source line of `text`, or -1 if
 * there are not that many lines. Converts a fitPendingSlice line count into a
 * commit boundary; callers pass it through `findLastSafeSplitPoint` so the cut
 * never lands inside a fenced code block.
 */
function charIndexAfterLine(text: string, keptLines: number): number {
  if (keptLines <= 0) return -1;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      count++;
      if (count === keptLines) return i + 1;
    }
  }
  return -1;
}

/**
 * Synchronous snapshot passed to `onCancelSubmit` so the cancel handler can
 * decide whether the model produced meaningful in-flight content WITHOUT
 * waiting for React state to flush. Closes the race where
 * `pendingHistoryItem` was just set from a stream chunk but the consumer's
 * React-state copy still reads as empty.
 */
export interface CancelSubmitInfo {
  /** `pendingHistoryItemRef.current` captured before any cancel mutation. */
  pendingItem: HistoryItemWithoutId | null;
  /**
   * The USER history item that this turn added, if any. `null` when the
   * turn took a path that does NOT push a user history item (Cron,
   * Notification, slash `submit_prompt`, Retry, etc.). The `id` lets
   * consumers verify identity even when `addItem` skipped a
   * consecutive-duplicate user message (text alone would wrongly match
   * the older row).
   */
  lastTurnUserItem: {
    id: number;
    text: string;
    submittedPrompt?: string;
  } | null;
  /**
   * Whether removing the Logger's latest USER entry can only target
   * `lastTurnUserItem`. A concurrent BTW command writes a newer USER entry,
   * so the cancel handler must keep the log intact rather than remove the
   * side-question by mistake.
   */
  canUndoLastLoggedUserMessage: boolean;
  /**
   * True if a content event landed during this turn, including during
   * the pre-cancel flush of throttle-buffered events. Lets the
   * auto-restore guard reject a turn that produced meaningful text even
   * when the consumer's React history snapshot is still stale.
   */
  turnProducedMeaningfulContent: boolean;
  /**
   * True when the cancelled turn was a Goal continuation turn. Such a turn
   * appends a synthetic continuation prompt to the chat history but, unlike a
   * UserQuery, adds no UI user item, so the cancel handler's auto-restore
   * branch bails before its orphan strip runs. The handler uses this flag to
   * strip that prompt so it can't merge into the user's next real message.
   */
  wasGoalTurn: boolean;
}

/**
 * Manages the LLM stream, including user input, command processing,
 * API interaction, and tool call lifecycle.
 */
export const useLlmStream = (
  llmClient: LlmClient,
  history: HistoryItem[],
  addItem: UseHistoryManagerReturn['addItem'],
  config: Config,
  isConfigInitialized: boolean,
  settings: LoadedSettings,
  onDebugMessage: (message: string) => void,
  handleSlashCommand: (
    cmd: PartListUnion,
  ) => Promise<SlashCommandProcessorResult | false>,
  shellModeActive: boolean,
  getPreferredEditor: () => EditorType | undefined,
  onAuthError: (error: string) => void,
  performMemoryRefresh: () => Promise<void>,
  modelSwitchedFromQuotaError: boolean,
  setModelSwitchedFromQuotaError: React.Dispatch<React.SetStateAction<boolean>>,
  onEditorClose: () => void,
  onCancelSubmit: (info?: CancelSubmitInfo) => void,
  setShellInputFocused: (value: boolean) => void,
  terminalWidth: number,
  terminalHeight: number,
  midTurnDrainRef?: React.RefObject<
    ((includeDeferred?: boolean, goalTurnActive?: boolean) => string[]) | null
  >,
  logger?: Logger | null,
  // Live content-area height (terminal minus composer/header). Used to bound the
  // pending item's rendered height so it commits to <Static> before it can grow
  // tall enough to trigger the scroll-to-top redraw. A ref (not a value) because
  // it is computed after this hook is called in AppContainer.
  availableTerminalHeightRef?: React.RefObject<number>,
  // Live terminal width, paired with the height ref so the commit loop reads
  // both dimensions consistently across a mid-stream resize.
  terminalWidthRef?: React.RefObject<number>,
  midTurnRestoreRef?: React.RefObject<((messages: string[]) => void) | null>,
  goalQueueRef?: React.RefObject<{
    peekNextUserBatchKey: (goalTurnActive?: boolean) => string | undefined;
    claimDirectUserAdmission?: () => DirectUserAdmission;
    claimGoalTurn?: () => QueuedGoalTurn | undefined;
    hasQueuedUserMessages?: () => boolean;
    getPendingSubmissionCount?: () => number;
    waitForReservationSettlement?: () => Promise<void>;
    submissionInFlightRef?: React.RefObject<boolean>;
    onSubmissionSettled?: () => void;
  } | null>,
) => {
  const [initError, setInitError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeInteractionPromptIdRef = useRef<string | undefined>(undefined);
  const activeInteractionOwnerRef = useRef<
    NonNullable<ReturnType<typeof getActiveInteractionSpan>> | undefined
  >(undefined);
  const activeGoalTurnRef = useRef<GoalTurnBinding | null>(null);
  const activeGoalAdmissionRef = useRef<GoalTurnAdmission | null>(null);
  const goalTurnBindingsRef = useRef(new Map<string, GoalTurnBinding>());
  const bindGoalTurn = useCallback(
    (
      permit: GoalTurnPermit,
      turnKey: string,
      origin: GoalTurnBinding['origin'],
      controller = new AbortController(),
    ): GoalTurnBinding => {
      const existing = goalTurnBindingsRef.current.get(permit.turnId);
      if (
        existing &&
        existing.turnKey === turnKey &&
        sameGoalPermit(existing.permit, permit) &&
        !existing.controller.signal.aborted
      ) {
        activeGoalTurnRef.current = existing;
        activeGoalAdmissionRef.current = existing;
        return existing;
      }
      const binding: GoalTurnBinding = {
        permit: { ...permit },
        turnKey,
        controller,
        origin,
      };
      goalTurnBindingsRef.current.set(permit.turnId, binding);
      activeGoalTurnRef.current = binding;
      activeGoalAdmissionRef.current = binding;
      return binding;
    },
    [],
  );
  const releaseGoalTurn = useCallback((binding: GoalTurnBinding) => {
    if (goalTurnBindingsRef.current.get(binding.permit.turnId) === binding) {
      goalTurnBindingsRef.current.delete(binding.permit.turnId);
    }
    if (activeGoalTurnRef.current === binding) {
      activeGoalTurnRef.current = null;
    }
    if (
      activeGoalAdmissionRef.current?.controller === binding.controller &&
      activeGoalAdmissionRef.current.turnKey === binding.turnKey
    ) {
      activeGoalAdmissionRef.current = null;
    }
  }, []);
  const failClosedGoalTurn = useCallback(
    async (binding: GoalTurnBinding, reason: string): Promise<void> => {
      if (!binding.controller.signal.aborted) {
        binding.controller.abort(reason);
      }

      try {
        const runtime = await config.getGoalRuntimeReady();
        const admittedPermit = runtime.permitForTurn(binding.turnKey);
        if (
          !admittedPermit ||
          !sameGoalPermit(admittedPermit, binding.permit)
        ) {
          return;
        }

        if (runtime.getSnapshot().goal?.status === 'active') {
          try {
            await runtime.dispatch({
              action: 'pause',
              expectedGoalId: binding.permit.goalId,
              expectedRevision: binding.permit.revision,
            });
          } catch (error) {
            debugLogger.warn('Failed to pause invalid Goal tool batch', error);
          }
        }

        try {
          await config.getChatRecordingService()?.flush();
        } catch (error) {
          debugLogger.warn('Failed to flush invalid Goal tool batch', error);
        }

        const currentPermit = runtime.permitForTurn(binding.turnKey);
        if (currentPermit && sameGoalPermit(currentPermit, binding.permit)) {
          await runtime.finishTurn(binding.permit);
        }
      } catch (error) {
        debugLogger.warn('Failed to close invalid Goal tool batch', error);
      } finally {
        releaseGoalTurn(binding);
      }
    },
    [config, releaseGoalTurn],
  );
  const releaseUndeliveredGoalTurn = useCallback(
    async (turnKey: string | undefined): Promise<void> => {
      if (!turnKey) return;
      try {
        const runtime = await config.getGoalRuntimeReady();
        await runtime.releaseTurn(turnKey);
      } catch (error) {
        debugLogger.warn(
          `Failed to release undelivered Goal turn ${turnKey}`,
          error,
        );
      }
    },
    [config],
  );
  const flushBufferedStreamEventsRef = useRef<Set<() => void>>(new Set());
  const turnCancelledRef = useRef(false);
  const isSubmittingQueryRef = useRef(false);
  const submissionLeaseGenerationRef = useRef(0);
  const setSubmissionInFlight = useCallback(
    (inFlight: boolean) => {
      const changed = isSubmittingQueryRef.current !== inFlight;
      isSubmittingQueryRef.current = inFlight;
      const sharedRef = goalQueueRef?.current?.submissionInFlightRef;
      if (sharedRef) sharedRef.current = inFlight;
      if (changed && !inFlight) {
        goalQueueRef?.current?.onSubmissionSettled?.();
      }
    },
    [goalQueueRef],
  );
  const lastPromptRef = useRef<PartListUnion | null>(null);
  // Records the USER history item that THIS turn's prepareQueryForLlm
  // added (if any). Reset to null at the start of every turn (including
  // Retry, which bypasses prepareQueryForLlm). Cron / Notification /
  // slash submit_prompt paths don't add a user item, so this stays null
  // on those turns. The cancel handler uses this to verify that the
  // candidate `lastUserItem` it's about to rewind actually came from the
  // cancelled turn — without the guard, an older user item with
  // only-synthetic trailing could be wrongly truncated when a non-USER
  // turn is cancelled.
  //
  // Identity is carried as `{ id, text }` (not just text) because
  // `useHistoryManager.addItem` skips consecutive-duplicate user
  // messages while still returning a freshly-generated id — text alone
  // would let the auto-restore guard wrongly match an older USER row
  // when the user re-submits the same prompt.
  const lastTurnUserItemRef = useRef<{
    id: number;
    text: string;
    submittedPrompt?: string;
  } | null>(null);
  const canUndoLastLoggedUserMessageRef = useRef(false);
  // Set to true the first time a content event lands this turn — even
  // during the pre-cancel flush. AppContainer's auto-restore guard
  // can't otherwise see content that was just addItem'd inside flush
  // (React history hasn't re-rendered) and would wrongly truncate the
  // committed text alongside the cancelled prompt. Reset at turn start
  // alongside lastTurnUserItemRef.
  const turnSawContentEventRef = useRef(false);
  const lastPromptErroredRef = useRef(false);
  const goalTerminalErrorRef = useRef(false);

  // Wrapper around addItem that attaches timestamp to gemini items for display.
  // Only 'gemini' (new assistant turn) gets a timestamp; 'gemini_content'
  // (same turn, performance-split continuation) does not.
  const commitItem = useCallback(
    (item: HistoryItemWithoutId, userMessageTimestamp: number): number => {
      if (item.type === 'gemini' && !(item as HistoryItemLlm).timestamp) {
        (item as HistoryItemLlm).timestamp = Date.now();
      }
      return addItem(item, userMessageTimestamp);
    },
    [addItem],
  );

  const dualOutput = useDualOutput();
  const [isResponding, setIsResponding] = useState<boolean>(false);
  // React state can lag by one render; this tracks the actual stream lifetime.
  const activeModelStreamsRef = useRef(0);
  // A continuation may be admitted while an earlier submission is finalizing.
  const submissionActivitiesByGenerationRef = useRef(new Map<number, number>());
  const settleSubmissionStateIfIdle = useCallback(() => {
    const currentGeneration = submissionLeaseGenerationRef.current;
    if (
      (submissionActivitiesByGenerationRef.current.get(currentGeneration) ??
        0) === 0 &&
      activeModelStreamsRef.current === 0
    ) {
      setIsResponding(false);
      setSubmissionInFlight(false);
    }
  }, [setSubmissionInFlight]);
  const retainSubmissionActivity = useCallback(
    (generation: number) => {
      submissionActivitiesByGenerationRef.current.set(
        generation,
        (submissionActivitiesByGenerationRef.current.get(generation) ?? 0) + 1,
      );
      return () => {
        const remainingActivities = Math.max(
          0,
          (submissionActivitiesByGenerationRef.current.get(generation) ?? 1) -
            1,
        );
        if (remainingActivities === 0) {
          submissionActivitiesByGenerationRef.current.delete(generation);
        } else {
          submissionActivitiesByGenerationRef.current.set(
            generation,
            remainingActivities,
          );
        }
        settleSubmissionStateIfIdle();
      };
    },
    [settleSubmissionStateIfIdle],
  );
  const [thought, setThought] = useState<ThoughtSummary | null>(null);
  // Hold the latest history in a ref so handleCompletedTools can read it
  // without depending on `history` (which would recreate the tool scheduler
  // every render). Use useLayoutEffect instead of writing during render —
  // writing refs in the render phase is unsafe under React's concurrent
  // rendering (a bailed-out render could leave the ref with a dropped value).
  const historyRef = useRef<HistoryItem[]>(history);
  useLayoutEffect(() => {
    historyRef.current = history;
  }, [history]);
  // In-flight auxiliary work. Some work is batch-scoped rather than turn-scoped:
  // summaries intentionally outlive the turn, and mid-turn @ resolution may run
  // before submitQuery installs the next turn controller.
  // cancelOngoingRequest aborts these controllers so Ctrl+C still cancels them.
  const auxiliaryAbortRefsRef = useRef<Set<AbortController>>(new Set());
  const [pendingHistoryItem, pendingHistoryItemRef, setPendingHistoryItem] =
    useStateAndRef<HistoryItemWithoutId | null>(null);
  // Mixed assistant output needs multiple live rows to preserve
  // text/image/text ordering. Keep completed runs in the dynamic region until
  // the response reaches a normal commit boundary so a fresh retry or model
  // fallback can still discard the entire failed attempt.
  const [
    pendingAssistantItems,
    pendingAssistantItemsRef,
    setPendingAssistantItems,
  ] = useStateAndRef<HistoryItemWithoutId[]>([]);
  const commitPendingAssistantItems = useCallback(
    (userMessageTimestamp: number) => {
      const items = pendingAssistantItemsRef.current;
      if (items.length === 0) {
        return;
      }
      for (const item of items) {
        commitItem(item, userMessageTimestamp);
      }
      setPendingAssistantItems([]);
    },
    [commitItem, pendingAssistantItemsRef, setPendingAssistantItems],
  );
  const commitItemInOrder = useCallback(
    (item: HistoryItemWithoutId, userMessageTimestamp: number): number => {
      commitPendingAssistantItems(userMessageTimestamp);
      return commitItem(item, userMessageTimestamp);
    },
    [commitItem, commitPendingAssistantItems],
  );
  const stagePendingAssistantItem = useCallback((): boolean => {
    const item = pendingHistoryItemRef.current;
    if (item?.type !== 'gemini' && item?.type !== 'gemini_content') {
      return false;
    }
    setPendingAssistantItems((items) => [...items, item]);
    setPendingHistoryItem(null);
    return true;
  }, [pendingHistoryItemRef, setPendingAssistantItems, setPendingHistoryItem]);
  // Streamed model reasoning for the current turn. Rendered (height-limited)
  // above the answer while thinking, then committed to history as a
  // collapsible `gemini_thought` block when the answer/tool/turn begins.
  const [pendingThoughtItem, pendingThoughtItemRef, setPendingThoughtItem] =
    useStateAndRef<HistoryItemWithoutId | null>(null);
  const thoughtStartTimeRef = useRef<number | null>(null);
  const [
    pendingRetryErrorItem,
    pendingRetryErrorItemRef,
    setPendingRetryErrorItem,
  ] = useStateAndRef<HistoryItemWithoutId | null>(null);
  const [
    pendingRetryCountdownItem,
    pendingRetryCountdownItemRef,
    setPendingRetryCountdownItem,
  ] = useStateAndRef<HistoryItemWithoutId | null>(null);
  const clearPendingState = useCallback(() => {
    setPendingAssistantItems([]);
    setPendingHistoryItem(null);
    setPendingRetryErrorItem(null);
  }, [
    setPendingAssistantItems,
    setPendingHistoryItem,
    setPendingRetryErrorItem,
  ]);
  const retryCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const processedMemoryToolsRef = useRef<Set<string>>(new Set());
  const submitPromptOnCompleteRef = useRef<(() => Promise<void>) | null>(null);
  const refreshContextFilesOnWriteRef = useRef(false);
  const modelOverrideRef = useRef<string | undefined>(undefined);
  // True when the current turn's model override came from an explicit inline
  // `/model <id> <prompt>`. Skill-tool overrides must not clobber a user's
  // explicit choice mid-turn, so this takes precedence until the next user turn.
  const inlineModelOverrideActiveRef = useRef<boolean>(false);
  const canUseToolResultFullTurnModel = useCallback((model: string) => {
    const current = modelOverrideRef.current;
    return (
      !inlineModelOverrideActiveRef.current &&
      (!current?.endsWith('\0') || current === model)
    );
  }, []);
  // Provider tool-call id → (name, args) fingerprint of calls admitted for
  // execution in the current submit; merged with the history-derived map for
  // duplicate provider-id replay detection.
  const handledToolCallFingerprintsRef = useRef<Map<string, string>>(new Map());
  // Scoped to a top-level submit and cleared below before a new user prompt.
  // Repeated duplicate provider ids within that submit are terminal/drop-only.
  const duplicateProviderToolCallResponseIdsRef = useRef<Set<string>>(
    new Set(),
  );
  const pendingDuplicateToolResponsesRef = useRef<
    PendingDuplicateToolResponses[]
  >([]);
  const interactionOwnersByToolCallIdRef = useRef(
    new Map<string, NonNullable<ReturnType<typeof getActiveInteractionSpan>>>(),
  );
  const continuationOwnersByToolCallIdRef = useRef(
    new Map<string, ToolContinuationOwner>(),
  );
  const detachedToolContinuationAbortControllersRef = useRef(
    new Set<AbortController>(),
  );
  const pendingCompletedToolBatchesRef = useRef<TrackedToolCall[][]>([]);
  const handleCompletedToolsRef = useRef<
    (completedTools: TrackedToolCall[]) => Promise<void>
  >(async () => {});
  const immediateDuplicateToolResponsesRef = useRef<{
    promptId: string | undefined;
    responses: Array<{
      request: ToolCallRequestInfo;
      response: ToolCallResponseInfo;
    }>;
  } | null>(null);
  // --- Real-time token display ---
  // Accumulates output character count across the whole turn (not per API call).
  // Uses a ref to avoid re-renders on every text_delta.
  const streamingResponseLengthRef = useRef(0);
  // Tracks whether we are receiving content (↓) or waiting for API (↑).
  const [isReceivingContent, setIsReceivingContent] = useState(false);
  const {
    startNewPrompt,
    getPromptCount,
    stats: sessionStates,
  } = useSessionStats();
  const storage = config.storage;

  // Batch identity for tool_group duplicate collapsing (#9420): minted when
  // a batch is scheduled, stamped on both the live pending display group and
  // the history item committed by onComplete below, so MainContent can
  // collapse the transient double render of one batch by identity — callIds
  // are not an identity (ids are re-minted after core-history compaction and
  // providers can reuse wire ids across turns).
  const toolBatchIdByCallIdRef = useRef(new Map<string, string>());
  const toolBatchCounterRef = useRef(0);
  // Per-mount nonce: checkpoint JSON persists stamped history and /restore
  // loads it into a session whose counter restarts at 0 — without it, a
  // restored committed row would collide with a freshly minted batch and
  // the collapse would drop the wrong row.
  const toolBatchNonceRef = useRef(Math.random().toString(36).slice(2));
  const registerToolBatch = useCallback(
    (requests: ToolCallRequestInfo | ToolCallRequestInfo[]) => {
      const batchNumber = ++toolBatchCounterRef.current;
      const batchId = `tool-batch-${toolBatchNonceRef.current}-${batchNumber}`;
      for (const request of Array.isArray(requests) ? requests : [requests]) {
        toolBatchIdByCallIdRef.current.set(request.callId, batchId);
      }
    },
    [],
  );
  const getToolBatchId = useCallback(
    (callId: string): string | undefined =>
      toolBatchIdByCallIdRef.current.get(callId),
    [],
  );

  const [toolCalls, scheduleToolCalls, markToolsAsSubmitted] =
    useReactToolScheduler(
      async (completedToolCallsFromScheduler) => {
        // This onComplete is called when ALL scheduled tools for a given batch are done.
        if (completedToolCallsFromScheduler.length > 0) {
          // The scheduler empties the display list before this callback
          // (#9420), so once the issuing stream has settled nothing else
          // keeps streamingState off Idle while the callback runs. A
          // phantom Idle commit mid-turn would drain queued turns
          // concurrently with the pending ToolResult continuation, fire
          // YOLO turn-finished telemetry at the batch boundary, and no-op
          // Esc cancellation. Re-assert the in-flight flags for the whole
          // window; the release in finally settles them once the
          // continuation is done.
          setSubmissionInFlight(true);
          setIsResponding(true);
          const releaseToolCompletionActivity = retainSubmissionActivity(
            submissionLeaseGenerationRef.current,
          );
          // Captured before the await: the continuation scheduled inside
          // handleCompletedTools may re-register a reused callId for the
          // NEXT batch, and the cleanup below must not delete that entry.
          const batchId = getToolBatchId(
            completedToolCallsFromScheduler[0].request.callId,
          );
          try {
            const projectRoot = config.getProjectRoot();
            // Add the final state of these tools to the history for display.
            const toolGroupDisplay = mapTrackedToolCallsToDisplay(
              completedToolCallsFromScheduler as TrackedToolCall[],
              projectRoot,
            );
            toolGroupDisplay.batchId = batchId;
            addItem(toolGroupDisplay, Date.now());

            // Handle tool response submission immediately when tools complete
            await handleCompletedTools(
              completedToolCallsFromScheduler as TrackedToolCall[],
            );
          } finally {
            releaseToolCompletionActivity();
            // Entries are only needed until the batch commits; the scheduler
            // clears its display copy right after this callback returns.
            // Delete only entries still pointing at this batch's id: a
            // provider reusing a wire callId may have already registered
            // the next batch under the same key during the await above.
            for (const tc of completedToolCallsFromScheduler) {
              if (
                toolBatchIdByCallIdRef.current.get(tc.request.callId) ===
                batchId
              ) {
                toolBatchIdByCallIdRef.current.delete(tc.request.callId);
              }
            }
          }
        }
      },
      config,
      getPreferredEditor,
      onEditorClose,
      canUseToolResultFullTurnModel,
    );

  const pendingToolCallGroupDisplay = useMemo(() => {
    if (!toolCalls.length) return undefined;
    const group = mapTrackedToolCallsToDisplay(
      toolCalls,
      config.getProjectRoot(),
    );
    group.batchId = getToolBatchId(toolCalls[0].request.callId);
    return group;
  }, [toolCalls, config, getToolBatchId]);

  const activeToolPtyId = useMemo(() => {
    const executingShellTool = toolCalls?.find(
      (tc) =>
        tc.status === 'executing' && tc.request.name === 'run_shell_command',
    );
    if (executingShellTool) {
      return (executingShellTool as { pid?: number }).pid;
    }
    return undefined;
  }, [toolCalls]);

  const loopDetectedRef = useRef(false);
  const [
    loopDetectionConfirmationRequest,
    setLoopDetectionConfirmationRequest,
  ] = useState<{
    onComplete: (result: { userSelection: 'disable' | 'keep' }) => void;
  } | null>(null);

  const stopRetryCountdownTimer = useCallback(() => {
    if (retryCountdownTimerRef.current) {
      clearInterval(retryCountdownTimerRef.current);
      retryCountdownTimerRef.current = null;
    }
  }, []);

  /**
   * Clears the retry countdown timer and pending retry items.
   */
  const clearRetryCountdown = useCallback(() => {
    stopRetryCountdownTimer();
    skipRetryDelayRef.current = null;
    setPendingRetryErrorItem(null);
    setPendingRetryCountdownItem(null);
  }, [
    setPendingRetryErrorItem,
    setPendingRetryCountdownItem,
    stopRetryCountdownTimer,
  ]);

  // Holds the skipDelay callback from the current rate-limit RetryInfo.
  // Managed symmetrically: set in startRetryCountdown, cleared in clearRetryCountdown.
  const skipRetryDelayRef = useRef<(() => void) | null>(null);

  const startRetryCountdown = useCallback(
    (retryInfo: RetryInfo) => {
      stopRetryCountdownTimer();
      skipRetryDelayRef.current = retryInfo.skipDelay;
      const startTime = Date.now();
      const { message, attempt, maxRetries, delayMs } = retryInfo;
      const retryReasonText =
        message ?? t('Rate limit exceeded. Please wait and try again.');

      // Countdown line updates every second (dim/secondary color)
      const updateCountdown = () => {
        const elapsedMs = Date.now() - startTime;
        const remainingMs = Math.max(0, delayMs - elapsedMs);
        const remainingSec = Math.ceil(remainingMs / 1000);

        // Update error item with hint containing countdown info (short format)
        const hintText = `Retrying in ${remainingSec}s… (attempt ${attempt}/${maxRetries})`;

        setPendingRetryErrorItem({
          type: MessageType.ERROR,
          text: retryReasonText,
          hint: hintText,
        });

        setPendingRetryCountdownItem({
          type: 'retry_countdown',
          text: t(
            'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})',
            {
              seconds: String(remainingSec),
              attempt: String(attempt),
              maxRetries: String(maxRetries),
            },
          ),
        } as HistoryItemWithoutId);

        if (remainingMs <= 0) {
          stopRetryCountdownTimer();
        }
      };

      updateCountdown();
      retryCountdownTimerRef.current = setInterval(updateCountdown, 1000);
    },
    [
      setPendingRetryErrorItem,
      setPendingRetryCountdownItem,
      stopRetryCountdownTimer,
    ],
  );

  useEffect(() => () => stopRetryCountdownTimer(), [stopRetryCountdownTimer]);

  const onExec = useCallback(async (done: Promise<void>) => {
    setIsResponding(true);
    await done;
    setIsResponding(false);
  }, []);
  const { handleShellCommand, activeShellPtyId } = useShellCommandProcessor(
    addItem,
    setPendingHistoryItem,
    onExec,
    onDebugMessage,
    config,
    llmClient,
    setShellInputFocused,
    terminalWidth,
    terminalHeight,
  );

  const activePtyId = activeShellPtyId || activeToolPtyId;

  useEffect(() => {
    if (!activePtyId) {
      setShellInputFocused(false);
    }
  }, [activePtyId, setShellInputFocused]);

  const streamingState = useMemo(() => {
    if (toolCalls.some((tc) => tc.status === 'awaiting_approval')) {
      return StreamingState.WaitingForConfirmation;
    }
    // Check if any executing subagent task has a pending confirmation
    if (
      toolCalls.some((tc) => {
        if (tc.status !== 'executing') return false;
        const liveOutput = (tc as TrackedExecutingToolCall).liveOutput;
        return (
          typeof liveOutput === 'object' &&
          liveOutput !== null &&
          'type' in liveOutput &&
          liveOutput.type === 'task_execution' &&
          'pendingConfirmation' in liveOutput &&
          liveOutput.pendingConfirmation != null
        );
      })
    ) {
      return StreamingState.WaitingForConfirmation;
    }
    if (
      isResponding ||
      toolCalls.some(
        (tc) =>
          tc.status === 'executing' ||
          tc.status === 'scheduled' ||
          tc.status === 'validating' ||
          ((tc.status === 'success' ||
            tc.status === 'error' ||
            tc.status === 'cancelled') &&
            !(tc as TrackedCompletedToolCall | TrackedCancelledToolCall)
              .responseSubmittedToLlm),
      )
    ) {
      return StreamingState.Responding;
    }
    return StreamingState.Idle;
  }, [isResponding, toolCalls]);

  useEffect(() => {
    if (
      config.getApprovalMode() === ApprovalMode.YOLO &&
      streamingState === StreamingState.Idle
    ) {
      const lastUserMessageIndex = findLastUserItemIndex(history);

      const turnCount =
        lastUserMessageIndex === -1 ? 0 : history.length - lastUserMessageIndex;

      if (turnCount > 0) {
        logConversationFinishedEvent(
          config,
          new ConversationFinishedEvent(config.getApprovalMode(), turnCount),
        );
      }
    }
  }, [streamingState, config, history]);

  const cancelOngoingRequest = useCallback(() => {
    if (turnCancelledRef.current) {
      for (const controller of detachedToolContinuationAbortControllersRef.current) {
        controller.abort();
      }
      detachedToolContinuationAbortControllersRef.current.clear();
      return;
    }
    if (streamingState !== StreamingState.Responding) {
      return;
    }
    // Flush throttled stream chunks FIRST so anything sitting in the
    // per-turn bufferedEvents lands on `pendingHistoryItemRef.current`
    // before we snapshot. Snapshotting before flush would miss content
    // events that arrived inside the throttle window
    // (STREAM_UPDATE_THROTTLE_MS), making AppContainer's auto-restore
    // wrongly conclude the model produced nothing — and the subsequent
    // commitItem(pendingHistoryItemRef.current) below would commit content
    // that auto-restore then truncates away.
    for (const flushBufferedStreamEvents of flushBufferedStreamEventsRef.current) {
      flushBufferedStreamEvents();
    }
    // Snapshot AFTER flush, BEFORE any addItem / setPendingHistoryItem(null)
    // mutate the ref. This is what `onCancelSubmit` consumers (auto-restore
    // in AppContainer) need to decide whether the model produced meaningful
    // in-flight content — reading the React-state copy at the consumer
    // would race with stream chunks that haven't re-rendered yet.
    const pendingItemAtCancel = pendingHistoryItemRef.current;
    turnCancelledRef.current = true;
    submissionLeaseGenerationRef.current += 1;
    setSubmissionInFlight(false);
    const foregroundAbortController = abortControllerRef.current;
    if (
      foregroundAbortController &&
      !foregroundAbortController.signal.aborted
    ) {
      foregroundAbortController.abort();
    } else {
      for (const controller of detachedToolContinuationAbortControllersRef.current) {
        controller.abort();
      }
      detachedToolContinuationAbortControllersRef.current.clear();
    }
    const activeInteractionPromptId = activeInteractionPromptIdRef.current;
    const activeInteractionOwner = activeInteractionOwnerRef.current;
    if (
      activeInteractionPromptId &&
      activeInteractionOwner &&
      getActiveInteractionSpan(activeInteractionPromptId) ===
        activeInteractionOwner
    ) {
      endInteractionSpan('cancelled', {
        promptId: activeInteractionPromptId,
      });
      activeInteractionOwnerRef.current = undefined;
    }
    // Aborting a tick-in-flight ends any self-paced /loop: drop pending loop
    // wakeups so the loop doesn't resume after the cancelled tick. Only clears
    // session wakeups (never cron jobs); lazily-creating an empty scheduler
    // here is inert.
    const loopWakeupsCancelled =
      config.getCronScheduler()?.cancelAllWakeups() ?? 0;
    // Cancel any in-flight auxiliary work so its Promise.then doesn't add
    // stale content after the user cancelled.
    for (const ac of auxiliaryAbortRefsRef.current) {
      ac.abort();
    }
    auxiliaryAbortRefsRef.current.clear();

    // Report cancellation to arena status reporter (if in arena mode).
    // This is needed because cancellation during tool execution won't
    // flow through sendMessageStream where the inline reportCancelled()
    // lives — tools get cancelled and handleCompletedTools returns early.
    config.getArenaAgentClient()?.reportCancelled();

    // Log API cancellation
    const prompt_id = config.getSessionId() + '########' + getPromptCount();
    const cancellationEvent = new ApiCancelEvent(
      modelOverrideRef.current ?? config.getModel(),
      prompt_id,
      config.getContentGeneratorConfig()?.authType,
      loopWakeupsCancelled > 0 ? loopWakeupsCancelled : undefined,
    );
    logApiCancel(config, cancellationEvent);

    if (pendingHistoryItemRef.current) {
      commitItemInOrder(pendingHistoryItemRef.current, Date.now());
    }
    addItem(
      {
        type: MessageType.INFO,
        text: 'Request cancelled.',
      },
      Date.now(),
    );
    if (loopWakeupsCancelled > 0) {
      addItem(
        {
          type: MessageType.INFO,
          text: `Stopped the self-paced loop: cancelled ${loopWakeupsCancelled} pending wakeup${
            loopWakeupsCancelled === 1 ? '' : 's'
          }.`,
        },
        Date.now(),
      );
    }
    setPendingHistoryItem(null);
    clearRetryCountdown();
    // Wrap the consumer callback so a throw in AppContainer's cancel
    // handler can't strand the stream in `Responding` (which would lock
    // the UI — Esc would no-op, the user would have to restart). State
    // resets always run.
    //
    // Coupling note: AppContainer's auto-restore guard reads
    // `historyRef.current` which does NOT yet contain the INFO/pending
    // items we just enqueued via addItem above (React batches updates).
    // That guard's correctness depends on the items added here staying
    // synthetic (info/error/etc.) so the trailing-only-synthetic check
    // returns the same answer with or without them. If you ever add a
    // non-synthetic item here (e.g., a meaningful assistant block),
    // either move the auto-restore check to read functional setState
    // or revisit isSyntheticHistoryItem.
    try {
      onCancelSubmit({
        pendingItem: pendingItemAtCancel,
        lastTurnUserItem: lastTurnUserItemRef.current,
        canUndoLastLoggedUserMessage: canUndoLastLoggedUserMessageRef.current,
        turnProducedMeaningfulContent: turnSawContentEventRef.current,
        wasGoalTurn: activeGoalTurnRef.current !== null,
      });
    } finally {
      setIsResponding(false);
      setShellInputFocused(false);
    }
  }, [
    streamingState,
    addItem,
    commitItemInOrder,
    setPendingHistoryItem,
    onCancelSubmit,
    pendingHistoryItemRef,
    setShellInputFocused,
    clearRetryCountdown,
    config,
    getPromptCount,
    setSubmissionInFlight,
  ]);

  const applyVisionBridgeIfNeeded = useCallback(
    async (
      parts: PartListUnion | null,
      timestamp: number,
      signal: AbortSignal,
    ): Promise<{ parts: PartListUnion | null; shouldProceed: boolean }> => {
      if (parts === null || !hasImageParts(parts)) {
        return { parts, shouldProceed: true };
      }
      if (modelOverrideRef.current?.endsWith('\0')) {
        return { parts, shouldProceed: true };
      }
      if (inlineModelOverrideActiveRef.current) {
        return { parts, shouldProceed: true };
      }
      if (!shouldRunVisionBridge(config)) {
        return { parts, shouldProceed: true };
      }
      if (signal.aborted) {
        return { parts: null, shouldProceed: false };
      }

      debugLogger.debug('vision bridge: gate matched, running conversion');
      const fullTurnModel = config.getDefaultVisionBridgeModel();
      if (fullTurnModel?.agentCapable) {
        const fullTurnParts = (Array.isArray(parts) ? parts : [parts]).map(
          (part) =>
            typeof part === 'string'
              ? { text: part }
              : clampInlineMediaPart(part),
        );
        if (!hasImageParts(fullTurnParts)) {
          return { parts: fullTurnParts, shouldProceed: true };
        }
        applyModelOverride(
          modelOverrideRef,
          inlineModelOverrideActiveRef,
          getFullTurnVisionModelSelector(fullTurnModel),
          false,
        );
        addItem(
          {
            type: MessageType.VISION_NOTICE,
            text: formatFullTurnVisionNotice(fullTurnModel),
          },
          timestamp,
        );
        return { parts: fullTurnParts, shouldProceed: true };
      }

      const bridgeResult = await runVisionBridge({ config, parts, signal });
      debugLogger.debug(
        `vision bridge: status=${bridgeResult.status} applied=${bridgeResult.applied} model=${bridgeResult.modelId ?? '(none)'}`,
      );
      // Surface one notice: egress + transcript on success, reason on failure,
      // and egress disclosure after cancellation if data was already sent.
      if (bridgeResult.status !== 'skipped' || bridgeResult.egressOccurred) {
        addItem(
          {
            type:
              bridgeResult.status === 'failed'
                ? MessageType.ERROR
                : MessageType.VISION_NOTICE,
            text: formatVisionBridgeNotice(bridgeResult),
          },
          timestamp,
        );
      }
      if (signal.aborted) {
        return { parts: null, shouldProceed: false };
      }
      if (bridgeResult.applied && bridgeResult.parts != null) {
        return { parts: bridgeResult.parts, shouldProceed: true };
      }
      // The bridge produced no usable replacement. Never forward images to a
      // text-only model (it can't read them): drop them and proceed on the
      // remaining text, or stop if nothing is left.
      const textOnly = splitImageParts(parts).nonImageParts;
      return textOnly.length > 0
        ? { parts: textOnly, shouldProceed: true }
        : { parts: null, shouldProceed: false };
    },
    [addItem, config],
  );

  const prepareQueryForLlm = useCallback(
    async (
      query: PartListUnion,
      userMessageTimestamp: number,
      abortSignal: AbortSignal,
      prompt_id: string,
      submitType: SendMessageType,
      submittedPrompt: string | undefined,
      preserveTurnOwnership: boolean,
    ): Promise<{
      queryToSend: PartListUnion | null;
      shouldProceed: boolean;
      scheduledToolCallId?: string;
    }> => {
      if (turnCancelledRef.current && !preserveTurnOwnership) {
        return { queryToSend: null, shouldProceed: false };
      }
      if (typeof query === 'string' && query.trim().length === 0) {
        return { queryToSend: null, shouldProceed: false };
      }

      // Reset at turn start. Only the user-typed-text path below assigns
      // this — paths that don't add a USER history item (Cron /
      // Notification / slash submit_prompt) leave it null so cancel
      // never wrongly targets an older user item.
      if (!preserveTurnOwnership) {
        lastTurnUserItemRef.current = null;
      }

      let localQueryToSendToLlm: PartListUnion | null = null;

      if (typeof query === 'string') {
        const trimmedQuery = query.trim();

        // Notification messages (e.g. background agent completions) are
        // pre-processed by the notification drain loop which already
        // added the display item to history. Just pass the model text
        // through to the API. Cron prompts still go through the normal
        // slash/@-command/shell preprocessing path below.
        if (submitType === SendMessageType.Notification) {
          onDebugMessage(
            `Received notification (${trimmedQuery.length} chars)`,
          );
          return { queryToSend: trimmedQuery, shouldProceed: true };
        }

        // Teammate envelopes are model-authored text already rendered
        // as a `● …` notification by the teammate drain. They must NOT
        // enter the slash/shell/@ preprocessing below: with `!` shell
        // mode active a teammate report would be EXECUTED as a shell
        // command, and a leading `/` or an `@path` would be
        // reinterpreted against the leader's session. Pass the
        // envelope straight through to the model, like Notification.
        if (submitType === SendMessageType.Teammate) {
          onDebugMessage(
            `Received teammate message (${trimmedQuery.length} chars)`,
          );
          return { queryToSend: trimmedQuery, shouldProceed: true };
        }

        onDebugMessage(`Received user query (${trimmedQuery.length} chars)`);
        await logger?.logMessage(MessageSenderType.USER, trimmedQuery);
        canUndoLastLoggedUserMessageRef.current =
          !preserveTurnOwnership && logger != null;

        // Handle UI-only commands first
        const slashCommandResult = isSlashCommand(trimmedQuery)
          ? await handleSlashCommand(trimmedQuery)
          : false;

        if (slashCommandResult) {
          switch (slashCommandResult.type) {
            case 'schedule_tool': {
              const { toolName, toolArgs } = slashCommandResult;
              const toolCallRequest: ToolCallRequestInfo = {
                callId: `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                name: toolName,
                args: toolArgs,
                isClientInitiated: true,
                prompt_id,
              };
              registerToolBatch(toolCallRequest);
              scheduleToolCalls([toolCallRequest], abortSignal);
              return {
                queryToSend: null,
                shouldProceed: false,
                scheduledToolCallId: toolCallRequest.callId,
              };
            }
            case 'submit_prompt': {
              localQueryToSendToLlm = slashCommandResult.content;
              submitPromptOnCompleteRef.current =
                slashCommandResult.onComplete ?? null;
              refreshContextFilesOnWriteRef.current = Boolean(
                slashCommandResult.refreshContextFilesOnWrite,
              );
              // Per-turn model override (e.g. inline `/model <id> <prompt>`).
              // Runs after the new-user-turn reset above and before the stream
              // is sent, so it applies to this turn and — because the reset is
              // skipped for ToolResult/Retry — persists across the tool loop,
              // then clears on the next user turn. Re-validate provider identity
              // here rather than trust the producer: any slash command can set
              // `modelOverride`, so the consumer enforces that it names a model
              // on the active provider before redirecting API calls to it.
              if (slashCommandResult.modelOverride) {
                if (
                  isInlineModelOverrideAllowed(
                    config,
                    slashCommandResult.modelOverride,
                  )
                ) {
                  applyModelOverride(
                    modelOverrideRef,
                    inlineModelOverrideActiveRef,
                    slashCommandResult.modelOverride,
                    true,
                  );
                } else {
                  debugLogger.warn(
                    `ignoring model override '${slashCommandResult.modelOverride}': not a model on the active provider`,
                  );
                }
              }

              const bridgeResult = await applyVisionBridgeIfNeeded(
                localQueryToSendToLlm,
                userMessageTimestamp,
                abortSignal,
              );
              if (!bridgeResult.shouldProceed) {
                return { queryToSend: null, shouldProceed: false };
              }
              localQueryToSendToLlm = bridgeResult.parts;

              return {
                queryToSend: localQueryToSendToLlm,
                shouldProceed: true,
              };
            }
            case 'handled': {
              return { queryToSend: null, shouldProceed: false };
            }
            default: {
              const unreachable: never = slashCommandResult;
              throw new Error(
                `Unhandled slash command result type: ${unreachable}`,
              );
            }
          }
        }

        if (shellModeActive && handleShellCommand(trimmedQuery, abortSignal)) {
          return { queryToSend: null, shouldProceed: false };
        }

        localQueryToSendToLlm = trimmedQuery;

        // Cron prompts are already rendered as a `● …` notification by
        // their queue drain, so skip the user-message history item to
        // avoid a duplicate `> …` line. Preprocessing (@/slash/shell)
        // still runs for Cron. (Teammate envelopes returned earlier
        // and never reach this point.)
        if (submitType !== SendMessageType.Cron) {
          const insertedId = addItem(
            {
              type: MessageType.USER,
              text: trimmedQuery,
              promptId: prompt_id,
            } as HistoryItemWithoutId,
            userMessageTimestamp,
          );
          // Capture id+text so the cancel handler can verify identity,
          // not just text. `addItem` returns a fresh id even when it
          // skipped insertion (consecutive-duplicate user); the older
          // matching USER in history carries a DIFFERENT id, so the
          // mismatch makes auto-restore bail correctly in that case.
          if (!preserveTurnOwnership) {
            lastTurnUserItemRef.current = {
              id: insertedId,
              text: trimmedQuery,
              ...(submittedPrompt === undefined ? {} : { submittedPrompt }),
            };
          }

          // Yield via macrotask to let Ink/React flush the user message
          // render before continuing with @-command processing and API
          // call. React 19.2.4 (Ink 7.0.3) schedules renders via
          // MessageChannel.postMessage (a macrotask), so a microtask yield
          // (await Promise.resolve()) does NOT give React a chance to
          // render — the continuation runs first. setImmediate fires in
          // the check phase after I/O events (where MessageChannel
          // delivers its postMessage), guaranteeing React renders first
          // without the ~1ms timer overhead of setTimeout(0).
          // Only needed for non-Cron submissions since Cron skips addItem().
          await new Promise((r) => setImmediate(r));
        }

        // Handle @-commands (which might involve tool calls)
        if (isAtCommand(trimmedQuery)) {
          const atCommandResult = await handleAtCommand({
            query: trimmedQuery,
            config,
            onDebugMessage,
            messageId: userMessageTimestamp,
            signal: abortSignal,
            addItem,
          });

          if (!atCommandResult.shouldProceed) {
            return { queryToSend: null, shouldProceed: false };
          }
          localQueryToSendToLlm = atCommandResult.processedQuery;
        }

        const bridgeResult = await applyVisionBridgeIfNeeded(
          localQueryToSendToLlm,
          userMessageTimestamp,
          abortSignal,
        );
        if (!bridgeResult.shouldProceed) {
          return { queryToSend: null, shouldProceed: false };
        }
        localQueryToSendToLlm = bridgeResult.parts;
      } else {
        // It's a function response (PartListUnion that isn't a string)
        localQueryToSendToLlm = query;
      }

      if (localQueryToSendToLlm === null) {
        onDebugMessage(
          'Query processing resulted in null, not sending to the model.',
        );
        return { queryToSend: null, shouldProceed: false };
      }
      return { queryToSend: localQueryToSendToLlm, shouldProceed: true };
    },
    [
      config,
      addItem,
      onDebugMessage,
      handleShellCommand,
      handleSlashCommand,
      logger,
      shellModeActive,
      registerToolBatch,
      scheduleToolCalls,
      applyVisionBridgeIfNeeded,
    ],
  );

  // --- Stream Event Handlers ---

  const handleContentEvent = useCallback(
    (
      eventValue: ContentEvent['value'],
      currentLlmMessageBuffer: string,
      userMessageTimestamp: number,
      startAsContinuation = false,
    ): string => {
      if (turnCancelledRef.current) {
        // Prevents additional output after a user initiated cancel.
        return '';
      }
      // Track output chars for real-time token estimation & mark as receiving.
      streamingResponseLengthRef.current += eventValue.length;
      setIsReceivingContent(true);
      // Pin "this turn produced meaningful content" so the cancel
      // handler's snapshot reflects content events even when they land
      // during the pre-cancel flush (their addItem hasn't re-rendered
      // React history by the time AppContainer's guard runs).
      turnSawContentEventRef.current = true;
      let newLlmMessageBuffer = currentLlmMessageBuffer + eventValue;
      const pendingItem = pendingHistoryItemRef.current;
      if (
        (pendingItem?.type === 'gemini' ||
          pendingItem?.type === 'gemini_content') &&
        (pendingItem.images?.length || pendingItem.omittedImageCount)
      ) {
        if (newLlmMessageBuffer.trim().length === 0) {
          return newLlmMessageBuffer;
        }
        stagePendingAssistantItem();
      }
      if (
        pendingHistoryItemRef.current?.type !== 'gemini' &&
        pendingHistoryItemRef.current?.type !== 'gemini_content'
      ) {
        if (newLlmMessageBuffer.trim().length === 0) {
          return newLlmMessageBuffer;
        }
        if (pendingHistoryItemRef.current) {
          commitItemInOrder(
            pendingHistoryItemRef.current,
            userMessageTimestamp,
          );
        }
        setPendingHistoryItem(
          startAsContinuation
            ? { type: 'gemini_content', text: '' }
            : { type: 'gemini', text: '', timestamp: Date.now() },
        );
        newLlmMessageBuffer = stripLeadingBlankLines(newLlmMessageBuffer);
      }
      // Split large messages for better rendering performance. Ideally,
      // we should maximize the amount of output sent to <Static />.
      let nextPendingType: 'gemini' | 'gemini_content' =
        pendingHistoryItemRef.current?.type === 'gemini_content'
          ? 'gemini_content'
          : pendingHistoryItemRef.current?.type === 'gemini'
            ? 'gemini'
            : startAsContinuation
              ? 'gemini_content'
              : 'gemini';
      while (newLlmMessageBuffer.length > STREAM_PENDING_ITEM_MAX_CHARS) {
        const splitPoint = findLastSafeSplitPoint(
          newLlmMessageBuffer,
          STREAM_PENDING_ITEM_MAX_CHARS,
        );
        const safeSplitPoint =
          splitPoint > 0 && splitPoint < newLlmMessageBuffer.length
            ? splitPoint
            : STREAM_PENDING_ITEM_MAX_CHARS;

        // This indicates that we need to split up this LLM message.
        // Splitting a message is primarily a performance consideration. There is a
        // <Static> component at the root of App.tsx which takes care of rendering
        // content statically or dynamically. Everything but the last message is
        // treated as static in order to prevent re-rendering an entire message history
        // multiple times per-second (as streaming occurs). Prior to this change you'd
        // see heavy flickering of the terminal. This ensures that larger messages get
        // broken up so that there are more "statically" rendered.
        // Repair fences when the split lands inside a code block so the tail
        // does not render as prose (see splitFencedMarkdown).
        const { before: beforeText, after: afterText } = splitFencedMarkdown(
          newLlmMessageBuffer,
          safeSplitPoint,
        );
        commitItemInOrder(
          {
            type: nextPendingType,
            text: beforeText,
          },
          userMessageTimestamp,
        );
        nextPendingType = 'gemini_content';
        newLlmMessageBuffer = afterText;
      }
      // Rendered-height-aware incremental commit. Commit whole chunks to
      // <Static> so the pending (live) item's ESTIMATED rendered height stays
      // within the viewport budget. Uses the SAME accounting as
      // MarkdownDisplay's safety-net slice (fitPendingSlice — tables counted as
      // blocks, wide/CJK lines wrapped) so the two agree and the clip never
      // engages / flickers in step with the commit cycle.
      //
      //  - `while`, not `if`: a single throttled update can append many lines, so
      //    keep committing until the remainder fits.
      //  - Commit ONLY at a blank-line block boundary so a table / list / code
      //    block is never cut into a headerless continuation (which would render
      //    as raw "| ... |" text). A table that is still streaming (no trailing
      //    blank line yet) stays pending — bounded in view by MarkdownDisplay's
      //    clamp — until it is complete, then commits whole.
      //  - `findLastSafeSplitPoint`: also never cut inside a fenced code block.
      //  - Conservative fallback when the content-area height is not yet known
      //    (ref is 0 before the first render populates it): derive from
      //    terminalHeight so a short terminal does not use an over-large budget.
      const viewportRows =
        (availableTerminalHeightRef?.current ?? 0) > 0
          ? availableTerminalHeightRef!.current
          : Math.max(4, terminalHeight - STREAM_PENDING_COMPOSER_RESERVE_ROWS);
      // Read width from the same live ref as the height so a mid-stream resize
      // is handled consistently; fall back to the render-time width.
      const commitWidth =
        (terminalWidthRef?.current ?? 0) > 0
          ? terminalWidthRef!.current
          : terminalWidth;
      const commitRowBudget = Math.max(
        4,
        viewportRows - STREAM_PENDING_COMMIT_RESERVE_ROWS,
      );
      const tableClampRows = Math.max(2, viewportRows - 3);
      while (true) {
        const bufferLines = newLlmMessageBuffer.split('\n');
        const { keptLines, clipped } = fitPendingSlice(
          bufferLines,
          commitWidth,
          commitRowBudget,
          tableClampRows,
        );
        if (!clipped) break;
        // Back up to the last blank line at or before the kept prefix — the only
        // place it is safe to end a committed chunk without orphaning a block.
        // Start AT keptLines (not keptLines - 1): when a single block is taller
        // than the budget, fitPendingSlice charges the whole block and returns
        // kept = the block's trailing blank line, so the boundary sits exactly at
        // keptLines. Searching from keptLines - 1 misses it, finds no earlier
        // blank (the block has none, and the blank before it was already
        // committed), and stalls — every later block then appends past keptLines,
        // so nothing ever commits until the stream finalizes and dumps it all at
        // once. Committing an over-tall completed block to <Static> is fine; only
        // the live pending frame must stay within the viewport.
        let boundaryLine = -1;
        for (let k = Math.min(keptLines, bufferLines.length - 1); k >= 0; k--) {
          if (bufferLines[k]!.trim() === '') {
            boundaryLine = k;
            break;
          }
        }
        let target: number;
        if (boundaryLine < 0) {
          // No blank-line boundary at/before the kept prefix. A fenced code
          // block taller than the viewport never provides one mid-block, so the
          // whole block would stay pending — frozen on its head — and only land
          // in scrollback when it finally closes (the "stall then dump" seen on
          // a 100-line code block). Hard-splitting inside a fence is now safe
          // (splitFencedMarkdown closes/re-opens the fence and continues the
          // gutter), so commit the budget-fit prefix and keep streaming. Restrict
          // this to code blocks: other tall blocks (tables/lists) must stay whole
          // and are still kept pending.
          const capIndex = charIndexAfterLine(newLlmMessageBuffer, keptLines);
          const fenceInfo =
            capIndex > 0
              ? getEnclosingFenceInfo(newLlmMessageBuffer, capIndex)
              : null;
          // Only hard-split a real code block. Other tall blocks (tables/lists)
          // must stay whole, and mermaid needs its whole source to render a
          // diagram — splitting it mid-block would break the render — so both
          // stay pending until they complete.
          if (!fenceInfo || fenceInfo.lang?.toLowerCase() === 'mermaid') {
            break; // no safe boundary yet → keep pending
          }
          target = capIndex;
        } else {
          target = charIndexAfterLine(newLlmMessageBuffer, boundaryLine + 1);
          if (target <= 0) break;
        }
        const splitPoint = findLastSafeSplitPoint(newLlmMessageBuffer, target);
        if (splitPoint <= 0 || splitPoint >= newLlmMessageBuffer.length) {
          break;
        }
        // Repair fences when the split lands inside a code block so the tail
        // does not render as prose (see splitFencedMarkdown).
        const { before: beforeText, after: afterText } = splitFencedMarkdown(
          newLlmMessageBuffer,
          splitPoint,
        );
        commitItemInOrder(
          {
            type: nextPendingType,
            text: beforeText,
          },
          userMessageTimestamp,
        );
        nextPendingType = 'gemini_content';
        newLlmMessageBuffer = afterText;
      }
      // Update the existing message with accumulated content.
      setPendingHistoryItem((item) => {
        const base: HistoryItemWithoutId = {
          type: nextPendingType,
          text: newLlmMessageBuffer,
        };
        if (item && 'timestamp' in item) {
          (base as HistoryItemLlm).timestamp = (
            item as HistoryItemLlm
          ).timestamp;
        }
        return base;
      });
      return newLlmMessageBuffer;
    },
    [
      commitItemInOrder,
      pendingHistoryItemRef,
      setPendingHistoryItem,
      stagePendingAssistantItem,
      terminalWidth,
      terminalHeight,
      availableTerminalHeightRef,
      terminalWidthRef,
    ],
  );

  const mergeThought = useCallback(
    (incoming: ThoughtSummary) => {
      setThought((prev) => {
        const incomingDescription = incoming.description
          ? clampLoadingThoughtDescription(incoming.description)
          : incoming.description;
        if (!prev) {
          if (debugLogger.isEnabled()) {
            debugLogger.debug(
              `[THOUGHT_MERGE] New thought: ` +
                `subjectLength=${incoming.subject?.length ?? 0}, ` +
                `description length=${incomingDescription?.length ?? 0}`,
            );
          }
          return {
            ...incoming,
            description: incomingDescription,
          };
        }
        const subject = incoming.subject || prev.subject;
        const description = clampLoadingThoughtDescription(
          `${prev.description ?? ''}${incomingDescription ?? ''}`,
        );
        if (debugLogger.isEnabled()) {
          debugLogger.debug(
            `[THOUGHT_MERGE] Accumulating thought: ` +
              `prev length=${prev.description?.length ?? 0}, ` +
              `incoming length=${incomingDescription?.length ?? 0}, ` +
              `total length=${description.length}`,
          );
        }
        return { subject, description };
      });
    },
    [setThought],
  );

  const handleThoughtEvent = useCallback(
    (
      eventValue: ThoughtSummary,
      currentThoughtBuffer: string,
      userMessageTimestamp: number,
    ): string => {
      if (turnCancelledRef.current) {
        return '';
      }

      const thoughtText = eventValue.description ?? '';
      if (!thoughtText) {
        return currentThoughtBuffer;
      }

      let newThoughtBuffer = currentThoughtBuffer + thoughtText;
      if (newThoughtBuffer.trim().length === 0) {
        return newThoughtBuffer;
      }

      streamingResponseLengthRef.current += thoughtText.length;
      const startingNewThought = currentThoughtBuffer.trim().length === 0;
      const description = startingNewThought
        ? stripLeadingBlankLines(newThoughtBuffer)
        : thoughtText;

      if (startingNewThought) {
        thoughtStartTimeRef.current = Date.now();
        newThoughtBuffer = description;
      }

      // Keep the transient `thought` (subject) in sync for the window title.
      mergeThought({
        ...eventValue,
        description,
      });

      // Stream the accumulated reasoning into a pending history item so it
      // renders height-limited above the answer and can later be committed as
      // a collapsible block.
      let pendingThoughtType: 'gemini_thought' | 'gemini_thought_content' =
        startingNewThought
          ? 'gemini_thought'
          : pendingThoughtItemRef.current?.type === 'gemini_thought_content'
            ? 'gemini_thought_content'
            : 'gemini_thought';
      const getThoughtDurationMs = () =>
        thoughtStartTimeRef.current
          ? Date.now() - thoughtStartTimeRef.current
          : 0;
      const buildThoughtItem = (
        type: 'gemini_thought' | 'gemini_thought_content',
        text: string,
      ): HistoryItemWithoutId =>
        type === 'gemini_thought'
          ? {
              type,
              text,
              durationMs: getThoughtDurationMs(),
            }
          : {
              type,
              text,
            };

      let splitPoint = findLastSafeSplitPoint(
        newThoughtBuffer,
        STREAM_PENDING_ITEM_MAX_CHARS,
      );
      while (newThoughtBuffer.length > STREAM_PENDING_ITEM_MAX_CHARS) {
        const safeSplitPoint =
          splitPoint > 0 && splitPoint < newThoughtBuffer.length
            ? splitPoint
            : STREAM_PENDING_ITEM_MAX_CHARS;
        // Repair fences when the split lands inside a code block so the tail
        // does not render as prose (see splitFencedMarkdown).
        const { before: beforeText, after: afterText } = splitFencedMarkdown(
          newThoughtBuffer,
          safeSplitPoint,
        );
        addItem(
          buildThoughtItem(pendingThoughtType, beforeText),
          userMessageTimestamp,
        );
        pendingThoughtType = 'gemini_thought_content';
        newThoughtBuffer = afterText;
        splitPoint = findLastSafeSplitPoint(
          newThoughtBuffer,
          STREAM_PENDING_ITEM_MAX_CHARS,
        );
      }

      setPendingThoughtItem(
        buildThoughtItem(pendingThoughtType, newThoughtBuffer),
      );

      return newThoughtBuffer;
    },
    [addItem, mergeThought, pendingThoughtItemRef, setPendingThoughtItem],
  );

  // Commit the streamed reasoning to history as a collapsible block (or drop
  // it). Called when the answer/tool/turn begins, or on cancel/error.
  const commitPendingThought = useCallback(
    (userMessageTimestamp: number) => {
      if (pendingThoughtItemRef.current) {
        const item = { ...pendingThoughtItemRef.current };
        if (item.type === 'gemini_thought' && thoughtStartTimeRef.current) {
          item.durationMs = Date.now() - thoughtStartTimeRef.current;
        }
        addItem(item, userMessageTimestamp);
      }
      setPendingThoughtItem(null);
      thoughtStartTimeRef.current = null;
    },
    [addItem, pendingThoughtItemRef, setPendingThoughtItem],
  );

  const handleUserCancelledEvent = useCallback(
    (userMessageTimestamp: number) => {
      if (turnCancelledRef.current) {
        return;
      }

      lastPromptErroredRef.current = false;
      // Persist any streamed reasoning (collapsed) above the cancelled answer.
      commitPendingThought(userMessageTimestamp);
      if (pendingHistoryItemRef.current) {
        if (pendingHistoryItemRef.current.type === 'tool_group') {
          const updatedTools = pendingHistoryItemRef.current.tools.map(
            (tool) =>
              tool.status === ToolCallStatus.Pending ||
              tool.status === ToolCallStatus.Confirming ||
              tool.status === ToolCallStatus.Executing
                ? { ...tool, status: ToolCallStatus.Canceled }
                : tool,
          );
          const pendingItem: HistoryItemToolGroup = {
            ...pendingHistoryItemRef.current,
            tools: updatedTools,
          };
          addItem(pendingItem, userMessageTimestamp);
        } else {
          commitItemInOrder(
            pendingHistoryItemRef.current,
            userMessageTimestamp,
          );
        }
        setPendingHistoryItem(null);
      }
      addItem(
        { type: MessageType.INFO, text: 'User cancelled the request.' },
        userMessageTimestamp,
      );
      clearRetryCountdown();
      setIsResponding(false);
      setThought(null); // Reset thought when user cancels
    },
    [
      addItem,
      commitPendingThought,
      commitItemInOrder,
      pendingHistoryItemRef,
      setPendingHistoryItem,
      setThought,
      clearRetryCountdown,
    ],
  );

  const handleErrorEvent = useCallback(
    (
      eventValue: LlmErrorEventValue,
      userMessageTimestamp: number,
      submitType: SendMessageType,
    ) => {
      if (submitType !== SendMessageType.Goal) {
        lastPromptErroredRef.current = true;
      } else {
        goalTerminalErrorRef.current = true;
      }
      // Persist any streamed reasoning (collapsed) above the error.
      commitPendingThought(userMessageTimestamp);
      if (pendingHistoryItemRef.current) {
        commitItemInOrder(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      // Only show Ctrl+Y hint if not already showing an auto-retry countdown
      // (auto-retry countdown is shown when retryCountdownTimerRef is active)
      const isShowingAutoRetry = retryCountdownTimerRef.current !== null;
      clearRetryCountdown();

      const formattedErrorText = parseAndFormatApiError(
        eventValue.error,
        config.getContentGeneratorConfig()?.authType,
      );

      if (!isShowingAutoRetry) {
        const retryHint =
          submitType !== SendMessageType.Goal
            ? t('Press Ctrl+Y to retry')
            : undefined;
        // Store error with hint as a pending item (not in history).
        // This allows the hint to be removed when the user retries with Ctrl+Y,
        // since pending items are in the dynamic rendering area (not <Static>).
        setPendingRetryErrorItem({
          type: 'error' as const,
          text: formattedErrorText,
          hint: retryHint,
        });
      }
      setThought(null); // Reset thought when there's an error

      // Fire StopFailure hook (fire-and-forget, replaces Stop event for API errors)
      const errorType = classifyApiError(eventValue.error);
      config
        .getHookSystem()
        ?.fireStopFailureEvent(
          errorType,
          eventValue.error.message,
          formattedErrorText,
        )
        .catch((err) => {
          debugLogger.warn(`StopFailure hook failed: ${err}`);
        });
    },
    [
      commitPendingThought,
      commitItemInOrder,
      pendingHistoryItemRef,
      setPendingHistoryItem,
      setPendingRetryErrorItem,
      config,
      setThought,
      clearRetryCountdown,
    ],
  );

  const handleCitationEvent = useCallback(
    (text: string, userMessageTimestamp: number) => {
      if (!showCitations(settings)) {
        return;
      }

      if (pendingHistoryItemRef.current) {
        commitItemInOrder(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      addItem({ type: MessageType.INFO, text }, userMessageTimestamp);
    },
    [
      addItem,
      commitItemInOrder,
      pendingHistoryItemRef,
      setPendingHistoryItem,
      settings,
    ],
  );

  const handleFinishedEvent = useCallback(
    (event: ServerLlmFinishedEvent, userMessageTimestamp: number) => {
      const finishReason = event.value.reason;
      if (!finishReason) {
        return;
      }

      const finishReasonMessages: Record<FinishReason, string | undefined> = {
        [FinishReason.FINISH_REASON_UNSPECIFIED]: undefined,
        [FinishReason.STOP]: undefined,
        [FinishReason.MAX_TOKENS]: 'Response truncated due to token limits.',
        [FinishReason.SAFETY]: 'Response stopped due to safety reasons.',
        [FinishReason.RECITATION]: 'Response stopped due to recitation policy.',
        [FinishReason.LANGUAGE]:
          'Response stopped due to unsupported language.',
        [FinishReason.BLOCKLIST]: 'Response stopped due to forbidden terms.',
        [FinishReason.PROHIBITED_CONTENT]:
          'Response stopped due to prohibited content.',
        [FinishReason.SPII]:
          'Response stopped due to sensitive personally identifiable information.',
        [FinishReason.OTHER]: 'Response stopped for other reasons.',
        [FinishReason.MALFORMED_FUNCTION_CALL]:
          'Response stopped due to malformed function call.',
        [FinishReason.IMAGE_SAFETY]:
          'Response stopped due to image safety violations.',
        [FinishReason.IMAGE_PROHIBITED_CONTENT]:
          'Response stopped due to image prohibited content.',
        [FinishReason.IMAGE_RECITATION]:
          'Response stopped due to image recitation policy.',
        [FinishReason.IMAGE_OTHER]:
          'Response stopped due to other image-related reasons.',
        [FinishReason.NO_IMAGE]: 'Response stopped due to no image.',
        [FinishReason.UNEXPECTED_TOOL_CALL]:
          'Response stopped due to unexpected tool call.',
      };

      const message = finishReasonMessages[finishReason];
      if (message) {
        addItem(
          {
            type: 'info',
            text: `⚠  ${message}`,
          },
          userMessageTimestamp,
        );
      }
      // Only clear auto-retry countdown errors (those with active timer)
      if (retryCountdownTimerRef.current) {
        clearRetryCountdown();
      }
    },
    [addItem, clearRetryCountdown],
  );

  const autonomousLoopTickResolverRef =
    useRef<AutonomousLoopTickResolver | null>(null);

  const handleChatCompressionEvent = useCallback(
    (
      eventValue: ServerLlmChatCompressedEvent['value'],
      userMessageTimestamp: number,
    ) => {
      autonomousLoopTickResolverRef.current?.resetCache();
      if (pendingHistoryItemRef.current) {
        commitItemInOrder(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      const activeModel = modelOverrideRef.current ?? config.getModel();
      const reasonClause =
        eventValue?.triggerReason === 'image_overflow'
          ? `accumulated enough tool screenshots to trigger compaction for ${activeModel}`
          : `approached the input token limit for ${activeModel}`;
      const warningSuffix = eventValue?.warning
        ? `\n⚠️ ${eventValue.warning}`
        : '';
      // Estimated counts (#9309) get a '~' prefix so the notice doesn't read
      // as an API-reported figure on a different scale than a later banner.
      const formatCount = (count?: number, isEstimated?: boolean) =>
        count === undefined
          ? 'unknown'
          : isEstimated
            ? `~${count}`
            : String(count);
      return addItem(
        {
          type: 'info',
          text:
            `IMPORTANT: This conversation ${reasonClause}. ` +
            `A compressed context will be sent for future messages (compressed from: ` +
            `${formatCount(eventValue?.originalTokenCount, eventValue?.originalTokenCountIsEstimated)} to ` +
            `${formatCount(eventValue?.newTokenCount, eventValue?.newTokenCountIsEstimated)} tokens).` +
            warningSuffix,
        },
        Date.now(),
      );
    },
    [
      addItem,
      commitItemInOrder,
      config,
      pendingHistoryItemRef,
      setPendingHistoryItem,
    ],
  );

  const handleMaxSessionTurnsEvent = useCallback(
    () =>
      addItem(
        {
          type: 'info',
          text:
            `The session has reached the maximum number of turns: ${config.getMaxSessionTurns()}. ` +
            `Please update this limit in your setting.json file.`,
        },
        Date.now(),
      ),
    [addItem, config],
  );

  const handleSessionTokenLimitExceededEvent = useCallback(
    (value: { currentTokens: number; limit: number; message: string }) =>
      addItem(
        {
          type: 'error',
          text:
            `✗ Session token limit exceeded: ${value.currentTokens.toLocaleString()} tokens > ${value.limit.toLocaleString()} limit.\n\n` +
            `★ Solutions:\n` +
            `   • Start a new session: Use /clear command\n` +
            `   • Increase limit: Add "sessionTokenLimit": (e.g., 128000) to your settings.json\n` +
            `   • Compress history: Use /compress command to compress history`,
        },
        Date.now(),
      ),
    [addItem],
  );

  const handleLoopDetectionConfirmation = useCallback(
    (result: { userSelection: 'disable' | 'keep' }) => {
      setLoopDetectionConfirmationRequest(null);

      if (result.userSelection === 'disable') {
        config.getLlmClient().getLoopDetectionService().disableForSession();
        addItem(
          {
            type: 'info',
            text: `Loop detection has been disabled for this session. Please try your request again.`,
          },
          Date.now(),
        );
      } else {
        addItem(
          {
            type: 'info',
            text: `A potential loop was detected. This can happen due to repetitive tool calls or other model behavior. The request has been halted.`,
          },
          Date.now(),
        );
      }
    },
    [config, addItem],
  );

  const handleLoopDetectedEvent = useCallback(() => {
    // Show the confirmation dialog to choose whether to disable loop detection
    setLoopDetectionConfirmationRequest({
      onComplete: handleLoopDetectionConfirmation,
    });
  }, [handleLoopDetectionConfirmation]);

  const handleUserPromptSubmitBlockedEvent = useCallback(
    (
      value: { reason: string; originalPrompt: string },
      userMessageTimestamp: number,
    ) => {
      if (pendingHistoryItemRef.current) {
        commitItemInOrder(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      addItem(
        {
          type: 'user_prompt_submit_blocked',
          reason: value.reason,
          originalPrompt: value.originalPrompt,
        } as HistoryItemWithoutId,
        userMessageTimestamp,
      );
    },
    [addItem, commitItemInOrder, pendingHistoryItemRef, setPendingHistoryItem],
  );

  const handleStopHookLoopEvent = useCallback(
    (
      value: {
        iterationCount: number;
        reasons: string[];
        stopHookCount: number;
      },
      userMessageTimestamp: number,
    ) => {
      if (pendingHistoryItemRef.current) {
        commitItemInOrder(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      addItem(
        {
          type: 'stop_hook_loop',
          iterationCount: value.iterationCount,
          reasons: value.reasons,
          stopHookCount: value.stopHookCount,
        } as HistoryItemWithoutId,
        userMessageTimestamp,
      );
    },
    [addItem, commitItemInOrder, pendingHistoryItemRef, setPendingHistoryItem],
  );

  const processLlmStreamEvents = useCallback(
    async (
      stream: AsyncIterable<LlmEvent>,
      userMessageTimestamp: number,
      signal: AbortSignal,
      submitType: SendMessageType,
      turnAdmission?: GoalTurnAdmission,
      promptId?: string,
      trackInteractionOwner = true,
      toolContinuationOwner?: ToolContinuationOwner,
    ): Promise<StreamProcessingResult> => {
      let llmMessageBuffer = '';
      let thoughtBuffer = '';
      let scheduledToolContinuation = false;
      let assistantOutputStarted =
        pendingHistoryItemRef.current?.type === 'gemini' ||
        pendingHistoryItemRef.current?.type === 'gemini_content';
      let assistantInlineImageCount = [
        ...pendingAssistantItemsRef.current,
        pendingHistoryItemRef.current,
      ].reduce(
        (count, item) =>
          item?.type === 'gemini' || item?.type === 'gemini_content'
            ? count + (item.images?.length ?? 0)
            : count,
        0,
      );
      const toolCallRequests: ToolCallRequestInfo[] = [];
      let streamInteractionOwner = trackInteractionOwner
        ? activeInteractionOwnerRef.current
        : undefined;
      const bufferedEvents: BufferedStreamEvent[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const discardBufferedStreamEvents = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        bufferedEvents.length = 0;
      };

      const flushBufferedStreamEvents = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }

        if (bufferedEvents.length === 0) {
          return;
        }

        while (bufferedEvents.length > 0) {
          const nextEvent = bufferedEvents.shift()!;

          if (nextEvent.kind === 'content') {
            const contentParts = [nextEvent.value];

            while (bufferedEvents[0]?.kind === 'content') {
              const queuedContent = bufferedEvents.shift();
              if (queuedContent?.kind !== 'content') {
                break;
              }
              contentParts.push(queuedContent.value);
            }

            llmMessageBuffer = handleContentEvent(
              contentParts.join(''),
              llmMessageBuffer,
              userMessageTimestamp,
              assistantOutputStarted,
            );
            if (contentParts.some((part) => part.trim().length > 0)) {
              assistantOutputStarted = true;
            }
            continue;
          }

          if (nextEvent.kind === 'image') {
            if (turnCancelledRef.current) {
              continue;
            }
            setIsReceivingContent(true);
            turnSawContentEventRef.current = true;
            const pendingItem = pendingHistoryItemRef.current;
            const isOverflowOnlyItem =
              (pendingItem?.type === 'gemini' ||
                pendingItem?.type === 'gemini_content') &&
              pendingItem.text.length === 0 &&
              !pendingItem.images?.length &&
              Boolean(pendingItem.omittedImageCount);
            const shouldDisplayImage =
              assistantInlineImageCount < MAX_INLINE_IMAGES_PER_ITEM;

            if (!shouldDisplayImage && isOverflowOnlyItem) {
              setPendingHistoryItem({
                ...pendingItem,
                omittedImageCount: (pendingItem.omittedImageCount ?? 0) + 1,
              });
              llmMessageBuffer = '';
              assistantOutputStarted = true;
              continue;
            }

            if (pendingHistoryItemRef.current) {
              if (!stagePendingAssistantItem()) {
                commitItemInOrder(
                  pendingHistoryItemRef.current,
                  userMessageTimestamp,
                );
                setPendingHistoryItem(null);
              }
            }
            llmMessageBuffer = '';
            if (shouldDisplayImage) {
              setPendingHistoryItem({
                type: assistantOutputStarted ? 'gemini_content' : 'gemini',
                text: '',
                images: [nextEvent.value],
                ...(!assistantOutputStarted ? { timestamp: Date.now() } : {}),
              });
              assistantInlineImageCount++;
            } else {
              setPendingHistoryItem({
                type: assistantOutputStarted ? 'gemini_content' : 'gemini',
                text: '',
                omittedImageCount: 1,
                ...(!assistantOutputStarted ? { timestamp: Date.now() } : {}),
              });
            }
            assistantOutputStarted = true;
            continue;
          }

          let subject = nextEvent.value.subject;
          const thoughtDescriptions: string[] = [];
          if (nextEvent.value.description) {
            thoughtDescriptions.push(nextEvent.value.description);
          }

          while (bufferedEvents[0]?.kind === 'thought') {
            const queuedThought = bufferedEvents.shift();
            if (queuedThought?.kind !== 'thought') {
              break;
            }
            subject = queuedThought.value.subject || subject;
            if (queuedThought.value.description) {
              thoughtDescriptions.push(queuedThought.value.description);
            }
          }

          thoughtBuffer = handleThoughtEvent(
            {
              subject,
              description: thoughtDescriptions.join(''),
            },
            thoughtBuffer,
            userMessageTimestamp,
          );
        }
      };

      const scheduleBufferedStreamFlush = () => {
        if (flushTimer) {
          return;
        }

        flushTimer = setTimeout(() => {
          flushBufferedStreamEvents();
        }, STREAM_UPDATE_THROTTLE_MS);
      };

      flushBufferedStreamEventsRef.current.add(flushBufferedStreamEvents);
      dualOutput?.startAssistantMessage();
      try {
        for await (const event of stream) {
          if (!streamInteractionOwner && promptId) {
            streamInteractionOwner = getActiveInteractionSpan(promptId);
            if (trackInteractionOwner && streamInteractionOwner) {
              activeInteractionOwnerRef.current ??= streamInteractionOwner;
            }
          }
          dualOutput?.processEvent(event);
          switch (event.type) {
            case ServerLlmEventType.Thought:
              // Subject-only chunks are discrete status updates for the
              // loading indicator and render immediately. Anything carrying
              // streamed text (with or without a subject) goes through the
              // throttled buffer so it batches with adjacent reasoning
              // chunks; the flush merger preserves the subject.
              if (event.value.subject && !event.value.description) {
                flushBufferedStreamEvents();
                setThought(event.value);
              } else {
                bufferedEvents.push({ kind: 'thought', value: event.value });
                scheduleBufferedStreamFlush();
              }
              break;
            case ServerLlmEventType.Content: {
              // Thinking is done once the answer starts streaming; reset the
              // title status. On the thinking→answer transition, flush any
              // buffered reasoning so the full thought is captured, then commit
              // it to history (collapsed) above the answer. After that the
              // condition is false, so normal content batching resumes.
              if (
                pendingThoughtItemRef.current ||
                bufferedEvents.some((e) => e.kind === 'thought')
              ) {
                flushBufferedStreamEvents();
                commitPendingThought(userMessageTimestamp);
                thoughtBuffer = '';
              }
              setThought((prev) => (prev ? null : prev));
              const displayParts = event.parts ?? [{ text: event.value }];
              for (const part of displayParts) {
                if ('text' in part) {
                  if (part.text.length > 0) {
                    bufferedEvents.push({ kind: 'content', value: part.text });
                  }
                } else {
                  const image = getInlineImageData({
                    inlineData: part.inlineData,
                  });
                  if (image) {
                    bufferedEvents.push({ kind: 'image', value: image });
                  }
                }
              }
              scheduleBufferedStreamFlush();
              break;
            }
            case ServerLlmEventType.ToolCallRequest:
              // Thinking is done once a tool call is issued; flush buffered
              // reasoning then commit it to history (collapsed) above the tool
              // output.
              flushBufferedStreamEvents();
              commitPendingThought(userMessageTimestamp);
              thoughtBuffer = '';
              setThought((prev) => (prev ? null : prev));
              if (event.value.goalContext && turnAdmission) {
                bindGoalTurn(
                  event.value.goalContext,
                  turnAdmission.turnKey,
                  turnAdmission.origin,
                  turnAdmission.controller,
                );
              }
              toolCallRequests.push(event.value);
              // Count tool call args JSON toward token estimation.
              try {
                const argsJson = JSON.stringify(event.value.args);
                streamingResponseLengthRef.current += argsJson.length;
              } catch {
                // Best-effort — don't block on serialization errors
              }
              break;
            case ServerLlmEventType.UserCancelled:
              flushBufferedStreamEvents();
              toolCallRequests.length = 0;
              handleUserCancelledEvent(userMessageTimestamp);
              return {
                status: StreamProcessingStatus.UserCancelled,
                scheduledToolContinuation: false,
              };
            case ServerLlmEventType.Error:
              flushBufferedStreamEvents();
              handleErrorEvent(event.value, userMessageTimestamp, submitType);
              break;
            case ServerLlmEventType.ChatCompressed:
              flushBufferedStreamEvents();
              handleChatCompressionEvent(event.value, userMessageTimestamp);
              llmMessageBuffer = '';
              assistantOutputStarted = false;
              break;
            case ServerLlmEventType.ToolCallConfirmation:
            case ServerLlmEventType.ToolCallResponse:
              flushBufferedStreamEvents();
              break;
            case ServerLlmEventType.MaxSessionTurns:
              flushBufferedStreamEvents();
              if (pendingHistoryItemRef.current) {
                commitItemInOrder(
                  pendingHistoryItemRef.current,
                  userMessageTimestamp,
                );
                setPendingHistoryItem(null);
              }
              handleMaxSessionTurnsEvent();
              llmMessageBuffer = '';
              assistantOutputStarted = false;
              break;
            case ServerLlmEventType.SessionTokenLimitExceeded:
              flushBufferedStreamEvents();
              if (pendingHistoryItemRef.current) {
                commitItemInOrder(
                  pendingHistoryItemRef.current,
                  userMessageTimestamp,
                );
                setPendingHistoryItem(null);
              }
              handleSessionTokenLimitExceededEvent(event.value);
              llmMessageBuffer = '';
              assistantOutputStarted = false;
              break;
            case ServerLlmEventType.Finished:
              flushBufferedStreamEvents();
              // A thinking-only turn (no content/tool) still commits its
              // reasoning so it persists collapsed in history.
              commitPendingThought(userMessageTimestamp);
              // Seal off this turn's UI state before the parent re-enters
              // sendMessageStream for a continuation (Stop-hook block at
              // client.ts:1378 or next-speaker auto-continue at 1444). Both
              // paths yield* a fresh Turn through this same stream processor,
              // so without this seal the next turn's first content/thought
              // chunk appends to this turn's pending item — visible in the UI
              // as "t" → "te" → "tes" cumulative rendering even though each
              // turn is persisted as a clean, separate assistant message.
              if (pendingHistoryItemRef.current) {
                commitItemInOrder(
                  pendingHistoryItemRef.current,
                  userMessageTimestamp,
                );
                setPendingHistoryItem(null);
              }
              llmMessageBuffer = '';
              thoughtBuffer = '';
              assistantOutputStarted = false;
              assistantInlineImageCount = 0;
              setThought(null);
              handleFinishedEvent(
                event as ServerLlmFinishedEvent,
                userMessageTimestamp,
              );
              break;
            case ServerLlmEventType.Citation:
              flushBufferedStreamEvents();
              handleCitationEvent(event.value, userMessageTimestamp);
              if (showCitations(settings)) {
                llmMessageBuffer = '';
                assistantOutputStarted = false;
              }
              break;
            case ServerLlmEventType.LoopDetected:
              flushBufferedStreamEvents();
              // handle later because we want to move pending history to history
              // before we add loop detected message to history
              loopDetectedRef.current = true;
              break;
            case ServerLlmEventType.Retry:
              // On fresh restart (escalation / rate-limit / invalid stream),
              // clear pending content and buffers to discard the failed attempt.
              // On continuation (recovery), keep the pending gemini item AND
              // buffers so the model's continuation text appends to them —
              // otherwise handleContentEvent would see a null pending item,
              // create a fresh one, and reset the buffer to just the new chunk,
              // losing the partial text we meant to preserve.
              if (!event.isContinuation) {
                discardBufferedStreamEvents();
                setPendingAssistantItems([]);
                if (pendingHistoryItemRef.current) {
                  setPendingHistoryItem(null);
                }
                commitPendingThought(userMessageTimestamp);
                thoughtBuffer = '';
                setThought(null);
                llmMessageBuffer = '';
                assistantOutputStarted = false;
                assistantInlineImageCount = 0;
              } else {
                flushBufferedStreamEvents();
              }
              // Always discard tool call requests from the truncated/failed
              // attempt to prevent duplicate execution after escalation or
              // recovery. The recovery path now skips turns that already
              // contain a functionCall (see llm-chat.ts), so this only
              // clears stale requests from pre-RETRY accumulation.
              toolCallRequests.length = 0;
              // Show retry info if available (rate-limit / throttling errors)
              if (event.retryInfo) {
                startRetryCountdown(event.retryInfo);
              } else {
                // The retry attempt is starting now, so any prior retry UI is stale.
                clearRetryCountdown();
              }
              break;
            case ServerLlmEventType.ModelFallback: {
              // The primary model (or a prior fallback) exhausted its retry
              // budget on a capacity/availability error and the system is
              // switching to the next fallback model. Discard partial content
              // from the failed attempt and show a notification.
              discardBufferedStreamEvents();
              setPendingAssistantItems([]);
              if (pendingHistoryItemRef.current) {
                setPendingHistoryItem(null);
              }
              commitPendingThought(userMessageTimestamp);
              thoughtBuffer = '';
              setThought(null);
              llmMessageBuffer = '';
              assistantOutputStarted = false;
              assistantInlineImageCount = 0;
              toolCallRequests.length = 0;
              clearRetryCountdown();
              const fromModel =
                sanitizeDisplayText(event.fromModel) ?? '(unknown)';
              const toModel = sanitizeDisplayText(event.toModel) ?? '(unknown)';
              addItem(
                {
                  type: 'notification',
                  text: `Model ${fromModel} unavailable, falling back to ${toModel}`,
                },
                userMessageTimestamp,
              );
              break;
            }
            case ServerLlmEventType.HookSystemMessage:
              flushBufferedStreamEvents();
              // Display system message from Stop hooks with "Stop says:" prefix
              // First commit any pending AI response to ensure correct ordering
              if (pendingHistoryItemRef.current) {
                commitItemInOrder(
                  pendingHistoryItemRef.current,
                  userMessageTimestamp,
                );
                setPendingHistoryItem(null);
              }
              addItem(
                {
                  type: 'stop_hook_system_message',
                  message: event.value,
                } as HistoryItemWithoutId,
                userMessageTimestamp,
              );
              llmMessageBuffer = '';
              assistantOutputStarted = false;
              break;
            case ServerLlmEventType.UserPromptSubmitBlocked:
              flushBufferedStreamEvents();
              handleUserPromptSubmitBlockedEvent(
                event.value,
                userMessageTimestamp,
              );
              llmMessageBuffer = '';
              assistantOutputStarted = false;
              break;
            case ServerLlmEventType.StopHookLoop:
              flushBufferedStreamEvents();
              handleStopHookLoopEvent(event.value, userMessageTimestamp);
              llmMessageBuffer = '';
              assistantOutputStarted = false;
              break;
            case ServerLlmEventType.ActiveGoal:
              break;
            case ServerLlmEventType.GoalState:
              if (event.cause && shouldDisplayGoalStateCause(event.cause)) {
                flushBufferedStreamEvents();
                if (pendingHistoryItemRef.current) {
                  commitItemInOrder(
                    pendingHistoryItemRef.current,
                    userMessageTimestamp,
                  );
                  setPendingHistoryItem(null);
                }
                addItem(
                  {
                    type: 'goal_state',
                    snapshot: event.value,
                    cause: event.cause,
                  },
                  userMessageTimestamp,
                );
                llmMessageBuffer = '';
                assistantOutputStarted = false;
              }
              break;
            default: {
              // enforces exhaustive switch-case
              const unreachable: never = event;
              return unreachable;
            }
          }
        }
      } finally {
        flushBufferedStreamEvents();
        commitPendingThought(userMessageTimestamp);
        discardBufferedStreamEvents();
        flushBufferedStreamEventsRef.current.delete(flushBufferedStreamEvents);
        dualOutput?.finalizeAssistantMessage();
      }
      // When a loop was detected, halt without scheduling the calls collected
      // before the guard fired. The core splice/clear only touches
      // turn.pendingToolCalls, which the TUI does not execute from — without
      // this gate the pre-detection (and, for the always-on consecutive guard,
      // potentially repeated) calls would still run before the halt dialog
      // appears. Mirrors the non-interactive runner, which returns on
      // LoopDetected before scheduling.
      if (
        toolCallRequests.length > 0 &&
        !signal.aborted &&
        !loopDetectedRef.current
      ) {
        const executableToolCallRequests: ToolCallRequestInfo[] = [];
        const duplicateResponses: Array<{
          request: ToolCallRequestInfo;
          response: ToolCallResponseInfo;
        }> = [];
        let duplicatePromptId: string | undefined;
        // The accessor returns a fresh map per call; copy anyway so a future
        // cached accessor cannot turn per-batch recording into shared-state
        // mutation. In-flight entries from this submit fill ids not already
        // present in history (the history fingerprint for an id wins).
        const handledToolCallFingerprints = new Map(
          llmClient ? llmClient.getHistoryToolCallFingerprints() : [],
        );
        for (const [
          providerCallId,
          fingerprint,
        ] of handledToolCallFingerprintsRef.current) {
          if (!handledToolCallFingerprints.has(providerCallId)) {
            handledToolCallFingerprints.set(providerCallId, fingerprint);
          }
        }
        const isReplayOfHandledRequest = (
          request: ToolCallRequestInfo,
        ): boolean =>
          request.providerCallId
            ? isReplayOfHandledToolCall(
                handledToolCallFingerprints,
                request.providerCallId,
                getCachedToolCallFingerprint(
                  request,
                  request.name,
                  request.args,
                ),
              )
            : false;
        const repeatedDuplicateRequest = findRepeatedDuplicateProviderToolCall(
          toolCallRequests,
          (request) => request.providerCallId,
          isReplayOfHandledRequest,
          duplicateProviderToolCallResponseIdsRef.current,
        );
        if (repeatedDuplicateRequest?.providerCallId) {
          debugLogger.debug(
            `[processLlmStreamEvents] Dropping batch after repeated duplicate provider tool-call id: ${repeatedDuplicateRequest.providerCallId} (tool: ${repeatedDuplicateRequest.name})`,
          );
          loopDetectedRef.current = true;
          return {
            status: StreamProcessingStatus.Completed,
            scheduledToolContinuation: false,
          };
        }

        for (const request of toolCallRequests) {
          const providerCallId = request.providerCallId;
          if (!providerCallId) {
            executableToolCallRequests.push(request);
            continue;
          }

          if (isReplayOfHandledRequest(request)) {
            markDuplicateProviderToolCallResponseSent(
              providerCallId,
              duplicateProviderToolCallResponseIdsRef.current,
            );

            const response = createDuplicateProviderToolCallResponse(request);
            debugLogger.debug(
              `[processLlmStreamEvents] Suppressing duplicate provider tool-call id: ${providerCallId} (tool: ${request.name})`,
            );
            dualOutput?.emitToolResult(request, response);
            duplicateResponses.push({ request, response });
            duplicatePromptId ??= request.prompt_id;
            continue;
          }

          const requestFingerprint = getCachedToolCallFingerprint(
            request,
            request.name,
            request.args,
          );
          recordHandledToolCall(
            handledToolCallFingerprints,
            providerCallId,
            requestFingerprint,
          );
          recordHandledToolCall(
            handledToolCallFingerprintsRef.current,
            providerCallId,
            requestFingerprint,
          );
          executableToolCallRequests.push(request);
        }

        if (duplicateResponses.length > 0) {
          if (executableToolCallRequests.length > 0) {
            pendingDuplicateToolResponsesRef.current.push({
              executableCallIds: new Set(
                executableToolCallRequests.map((request) => request.callId),
              ),
              promptId:
                duplicatePromptId ?? executableToolCallRequests[0]?.prompt_id,
              callOrder: toolCallRequests.map((request) => request.callId),
              duplicateResponses,
            });
          } else {
            immediateDuplicateToolResponsesRef.current = {
              promptId: duplicatePromptId,
              responses: duplicateResponses,
            };
          }
        }

        if (executableToolCallRequests.length > 0) {
          // The scheduler may complete a fast tool before this stream's caller
          // regains control. Seal streamed assistant text first so the tool
          // group cannot enter static history ahead of it.
          if (pendingHistoryItemRef.current) {
            commitItemInOrder(
              pendingHistoryItemRef.current,
              userMessageTimestamp,
            );
            setPendingHistoryItem(null);
          }
          if (toolContinuationOwner) {
            for (const request of executableToolCallRequests) {
              continuationOwnersByToolCallIdRef.current.set(
                request.callId,
                toolContinuationOwner,
              );
            }
          }
          if (streamInteractionOwner) {
            for (const request of executableToolCallRequests) {
              interactionOwnersByToolCallIdRef.current.set(
                request.callId,
                streamInteractionOwner,
              );
            }
          }
          scheduledToolContinuation = true;
          registerToolBatch(executableToolCallRequests);
          scheduleToolCalls(
            executableToolCallRequests,
            signal,
            modelOverrideRef.current,
          );
        }
      }
      return {
        status: StreamProcessingStatus.Completed,
        scheduledToolContinuation,
      };
    },
    [
      handleContentEvent,
      handleThoughtEvent,
      handleUserCancelledEvent,
      handleErrorEvent,
      registerToolBatch,
      scheduleToolCalls,
      llmClient,
      handleChatCompressionEvent,
      handleFinishedEvent,
      handleMaxSessionTurnsEvent,
      handleSessionTokenLimitExceededEvent,
      handleCitationEvent,
      settings,
      startRetryCountdown,
      clearRetryCountdown,
      setThought,
      commitPendingThought,
      pendingHistoryItemRef,
      pendingAssistantItemsRef,
      pendingThoughtItemRef,
      setPendingHistoryItem,
      handleUserPromptSubmitBlockedEvent,
      handleStopHookLoopEvent,
      bindGoalTurn,
      addItem,
      commitItemInOrder,
      stagePendingAssistantItem,
      setPendingAssistantItems,
      dualOutput,
    ],
  );

  const resolveSteeredMessages = useCallback(
    async (
      messages: string[],
      signal: AbortSignal,
    ): Promise<ResolvedSteerMessages> => {
      const resolvedSegments: Part[][] = [];
      const resolvedForRecording: Array<{
        message: string;
        parts: Part[];
        sideEffects: Array<() => void>;
      }> = [];
      const restoreMessages: string[] = [];
      const timestamp = Date.now();

      for (let index = 0; index < messages.length; index += 1) {
        if (signal.aborted) {
          restoreMessages.push(...messages.slice(index));
          break;
        }

        const message = messages[index];
        if (GOAL_COMMAND_RE.test(message)) {
          await handleSlashCommand(message);
          continue;
        }

        restoreMessages.push(message);
        const sideEffects: Array<() => void> = [];
        let resolvedQuery: PartListUnion = [{ text: message }];
        if (isAtCommand(message)) {
          const timeout = new AbortController();
          const atCommandSignal = AbortSignal.any([signal, timeout.signal]);
          const timeoutId = setTimeout(() => {
            timeout.abort(
              new Error(MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MESSAGE),
            );
          }, MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MS);
          try {
            const atCommandResult = await resolveWithAbort(
              atCommandSignal,
              () =>
                resolveAtCommandQuery({
                  query: message,
                  config,
                  onDebugMessage,
                  messageId: timestamp + index,
                  signal: atCommandSignal,
                }),
            );
            const shouldSkipMessage =
              !atCommandResult.shouldProceed &&
              (atCommandResult.toolDisplays?.length ?? 0) > 0;
            if (
              atCommandResult.shouldProceed &&
              atCommandResult.processedQuery !== null
            ) {
              resolvedQuery = atCommandResult.processedQuery;
            } else if (atCommandResult.toolDisplays?.length) {
              const toolDisplays = atCommandResult.toolDisplays;
              const showToolDisplays = () =>
                addItem(
                  { type: 'tool_group', tools: toolDisplays },
                  timestamp + index,
                );
              if (shouldSkipMessage) showToolDisplays();
              else sideEffects.push(showToolDisplays);
            }
            if (atCommandResult.recording) {
              const recordAtCommand = () =>
                config.getChatRecordingService?.()?.recordAtCommand?.({
                  filesRead: atCommandResult.recording!.filesRead,
                  status: atCommandResult.recording!.status,
                  ...(atCommandResult.recording!.message
                    ? { message: atCommandResult.recording!.message }
                    : {}),
                  userText: message,
                });
              if (shouldSkipMessage) recordAtCommand();
              else sideEffects.push(recordAtCommand);
            }
            if (shouldSkipMessage) continue;
          } catch (error) {
            const errorMessage = getErrorMessage(error);
            onDebugMessage(
              `Failed to resolve mid-turn @ command: ${errorMessage}`,
            );
            if (!signal.aborted) {
              addItem(
                {
                  type: MessageType.WARNING,
                  text: `Could not attach file: ${errorMessage}`,
                },
                Date.now(),
              );
            }
            continue;
          } finally {
            clearTimeout(timeoutId);
          }
          if (signal.aborted) {
            restoreMessages.push(...messages.slice(index + 1));
            break;
          }
        }

        const bridgeResult = await applyVisionBridgeIfNeeded(
          resolvedQuery,
          timestamp + index,
          signal,
        );
        if (!bridgeResult.shouldProceed) {
          if (signal.aborted) {
            restoreMessages.push(...messages.slice(index + 1));
            break;
          }
          continue;
        }

        const messageParts = normalizePartList(
          bridgeResult.parts ?? resolvedQuery,
        );
        const formatCheck = checkImageFormatsSupport(messageParts);
        if (formatCheck.hasUnsupportedFormats) {
          sideEffects.push(() =>
            addItem(
              {
                type: MessageType.INFO,
                text: getUnsupportedImageFormatWarning(),
              },
              Date.now(),
            ),
          );
        }

        resolvedSegments.push(messageParts);
        resolvedForRecording.push({
          message,
          parts: messageParts,
          sideEffects,
        });
      }

      const resolvedMessages: Part[] = [];
      for (const segment of resolvedSegments) {
        if (segment.length === 0) continue;
        if (resolvedMessages.length > 0) {
          resolvedMessages.push({ text: '\n\n' });
        }
        resolvedMessages.push(...segment);
      }

      return {
        parts: resolvedMessages,
        restoreMessages,
        accept: () => {
          for (const { message, parts, sideEffects } of resolvedForRecording) {
            for (const sideEffect of sideEffects) sideEffect();
            const recorder = config.getChatRecordingService?.();
            const goalPermit = activeGoalTurnRef.current?.permit;
            if (goalPermit) {
              recorder?.recordMidTurnUserMessage(parts, message, goalPermit);
            } else {
              recorder?.recordMidTurnUserMessage(parts, message);
            }
            addItem(
              {
                type: MessageType.USER,
                text: message,
                // Intentionally false: preserves isRealUserTurn/rewind semantics (steer is not a standalone user turn).
                sentToModel: false,
              },
              Date.now(),
            );
          }
        },
      };
    },
    [
      addItem,
      applyVisionBridgeIfNeeded,
      config,
      handleSlashCommand,
      onDebugMessage,
    ],
  );

  const resolveDrainedSteerMessages = useCallback(
    async (
      messages: string[],
      signal: AbortSignal,
    ): Promise<SteerInput | undefined> => {
      try {
        const resolved = await resolveSteeredMessages(messages, signal);
        if (signal.aborted) {
          if (resolved.restoreMessages.length > 0) {
            midTurnRestoreRef?.current?.(resolved.restoreMessages);
          }
          return undefined;
        }
        if (resolved.parts.length === 0) return undefined;
        let settled = false;
        return {
          parts: resolved.parts,
          accept: () => {
            if (settled) return;
            settled = true;
            resolved.accept();
          },
          restore: () => {
            if (settled) return;
            settled = true;
            if (resolved.restoreMessages.length > 0) {
              midTurnRestoreRef?.current?.(resolved.restoreMessages);
            }
          },
        };
      } catch (error) {
        midTurnRestoreRef?.current?.(messages);
        onDebugMessage(
          `Failed to prepare steer input: ${getErrorMessage(error)}`,
        );
        return undefined;
      }
    },
    [midTurnRestoreRef, onDebugMessage, resolveSteeredMessages],
  );

  const drainSteerAtBoundary = useCallback(
    async (signal: AbortSignal): Promise<SteerInput | undefined> => {
      const messages =
        midTurnDrainRef?.current?.(
          false,
          Boolean(activeGoalAdmissionRef.current),
        ) ?? [];
      if (messages.length === 0) return undefined;
      return resolveDrainedSteerMessages(messages, signal);
    },
    [midTurnDrainRef, resolveDrainedSteerMessages],
  );

  const submitQuery = useCallback(
    async (
      query: PartListUnion,
      submitType: SendMessageType = SendMessageType.UserQuery,
      prompt_id?: string,
      metadata?: {
        notificationDisplayText?: string;
        todoWorkChainId?: string;
        onDelivered?: () => void;
        onDeliveryFailed?: () => void;
        onAdmissionFailed?: () => void;
        onGoalClaimDeferred?: () => void;
        steerInput?: SteerInput;
        submittedPrompt?: string;
        goal?: QueuedGoalTurn;
        claimGoalTurn?: () => QueuedGoalTurn | undefined;
        userAdmission?: DirectUserAdmission;
        goalBinding?: GoalTurnBinding;
        toolContinuationOwner?: ToolContinuationOwner;
      },
    ) => {
      const allowConcurrentBtwDuringResponse =
        submitType === SendMessageType.UserQuery &&
        streamingState === StreamingState.Responding &&
        activeModelStreamsRef.current > 0 &&
        typeof query === 'string' &&
        isBtwCommand(query) &&
        !activeGoalAdmissionRef.current;
      let ownsSubmissionLease = false;
      let submissionLeaseGeneration: number | undefined;
      const acquireSubmissionLease = () => {
        if (isSubmittingQueryRef.current) return;
        ownsSubmissionLease = true;
        submissionLeaseGeneration = submissionLeaseGenerationRef.current + 1;
        submissionLeaseGenerationRef.current = submissionLeaseGeneration;
        setSubmissionInFlight(true);
      };
      const releaseSubmissionLease = () => {
        if (!ownsSubmissionLease) return;
        ownsSubmissionLease = false;
        if (
          submissionLeaseGeneration !== submissionLeaseGenerationRef.current
        ) {
          return;
        }
        setSubmissionInFlight(false);
      };
      const isTurnContinuation =
        submitType === SendMessageType.ToolResult ||
        submitType === SendMessageType.Steer;
      const submittedPrompt =
        submitType === SendMessageType.UserQuery
          ? metadata?.submittedPrompt
          : undefined;

      // Prevent concurrent executions of submitQuery, but allow continuations
      // which are part of the same logical flow (tool responses)
      if (
        isSubmittingQueryRef.current &&
        !isTurnContinuation &&
        !allowConcurrentBtwDuringResponse
      ) {
        await releaseUndeliveredGoalTurn(metadata?.userAdmission?.turnKey);
        metadata?.onAdmissionFailed?.();
        metadata?.onDeliveryFailed?.();
        return;
      }

      if (
        (streamingState === StreamingState.Responding ||
          streamingState === StreamingState.WaitingForConfirmation) &&
        !isTurnContinuation &&
        !allowConcurrentBtwDuringResponse
      ) {
        await releaseUndeliveredGoalTurn(metadata?.userAdmission?.turnKey);
        metadata?.onAdmissionFailed?.();
        metadata?.onDeliveryFailed?.();
        return;
      }

      // Set the flag to indicate we're now executing
      acquireSubmissionLease();
      const submissionGeneration = submissionLeaseGenerationRef.current;

      // loopDetectedRef now gates tool-call scheduling (see processLlmStream
      // events), so it must reflect only this turn's state. Reset it
      // unconditionally at entry: if the previous turn detected a loop but threw
      // before its own post-stream reset, a stuck `true` would otherwise make
      // every later turn silently drop its tool calls. A ToolResult/btw
      // continuation never carries a pending loop (a detected loop schedules
      // nothing), so clearing it here is a no-op for those paths.
      loopDetectedRef.current = false;

      // Reset turn-local ownership trackers at the very top of every
      // top-level submit (UserQuery, Retry, Cron, Notification, etc.).
      // `prepareQueryForLlm` also resets `lastTurnUserItemRef`, but
      // Retry skips that path — without this earlier reset, a stale
      // ownership snapshot from the prior UserQuery would survive into
      // the retry's cancel info and let auto-restore wrongly truncate
      // the original prompt.
      //
      // ToolResult continuations and same-turn btw concurrencies keep
      // the trackers untouched — they're piggybacking on an in-flight
      // turn that already owns its own snapshot.
      if (!isTurnContinuation && !allowConcurrentBtwDuringResponse) {
        lastTurnUserItemRef.current = null;
        canUndoLastLoggedUserMessageRef.current = false;
        turnSawContentEventRef.current = false;
        handledToolCallFingerprintsRef.current.clear();
        duplicateProviderToolCallResponseIdsRef.current.clear();
        pendingDuplicateToolResponsesRef.current = [];
        immediateDuplicateToolResponsesRef.current = null;
        if (
          submitType !== SendMessageType.Retry &&
          submitType !== SendMessageType.Notification &&
          submitType !== SendMessageType.Goal
        ) {
          refreshContextFilesOnWriteRef.current = false;
        }
      }

      const userMessageTimestamp = Date.now();

      // A thrown stream can leave partial assistant runs in the dynamic
      // region. An explicit Ctrl+Y retry is a fresh attempt, matching a core
      // non-continuation Retry event, so discard every run from the failed
      // attempt before the replacement stream starts. A different top-level
      // turn preserves what the user already saw, but must commit it before
      // prepareQueryForLlm appends the next user item.
      if (submitType === SendMessageType.Retry) {
        setPendingAssistantItems([]);
        const pendingItem = pendingHistoryItemRef.current;
        if (
          pendingItem?.type === 'gemini' ||
          pendingItem?.type === 'gemini_content'
        ) {
          setPendingHistoryItem(null);
        }
      } else if (!isTurnContinuation && !allowConcurrentBtwDuringResponse) {
        const pendingItem = pendingHistoryItemRef.current;
        if (
          pendingItem?.type === 'gemini' ||
          pendingItem?.type === 'gemini_content'
        ) {
          commitItemInOrder(pendingItem, userMessageTimestamp);
          setPendingHistoryItem(null);
        } else {
          commitPendingAssistantItems(userMessageTimestamp);
        }
      }

      // Reset quota error flag when starting a new query (not a continuation).
      // Notifications (background agent/shell/monitor completions) are system
      // events, not new user turns: they must not clear the user's model
      // override or an in-flight retry countdown — clearing the override here
      // silently reverted the session to the default model whenever a
      // background agent finished, and a long history could then overflow the
      // default model's smaller context window (#7114).
      if (
        !isTurnContinuation &&
        submitType !== SendMessageType.Notification &&
        submitType !== SendMessageType.Goal &&
        !allowConcurrentBtwDuringResponse
      ) {
        setModelSwitchedFromQuotaError(false);
        // Clear model override for new user turns. On retry, preserve a
        // skill-selected override so the same model is used again, but drop an
        // explicit inline `/model <id> <prompt>` override: that is a one-off
        // for the original prompt, so a retry reverts to the session model and
        // lets skill-tool overrides apply again.
        const droppingInlineOverrideOnRetry =
          submitType === SendMessageType.Retry &&
          inlineModelOverrideActiveRef.current;
        if (
          submitType !== SendMessageType.Retry ||
          inlineModelOverrideActiveRef.current
        ) {
          // The retry re-sends the same prompt on the session model, which may
          // differ from the one-shot override. Tell the user so the model
          // switch isn't silent.
          if (droppingInlineOverrideOnRetry) {
            addItem(
              {
                type: 'info',
                text: `Inline model override cleared on retry — retrying on the session model (${config.getModel()}).`,
              },
              userMessageTimestamp,
            );
          }
          clearModelOverride(modelOverrideRef, inlineModelOverrideActiveRef);
        }
        // Commit any pending retry error to history (without hint) since the
        // user is starting a new conversation turn.
        // Clear both countdown-based errors AND static errors (those without
        // an active countdown timer, e.g. "Press Ctrl+Y to retry").
        if (
          pendingRetryCountdownItemRef.current ||
          pendingRetryErrorItemRef.current
        ) {
          const pendingError = pendingRetryErrorItemRef.current;
          if (pendingError && pendingError.type === 'error') {
            const { hint: _hint, ...errorWithoutHint } = pendingError;
            addItem(errorWithoutHint, userMessageTimestamp);
          }
          clearRetryCountdown();
        }
      }

      const abortController = new AbortController();
      const abortSignal = abortController.signal;
      const inheritedToolContinuationOwner = metadata?.toolContinuationOwner;
      const isDetachedToolContinuation =
        inheritedToolContinuationOwner?.survivesGenerationChange === true;
      const detachedAbortController =
        inheritedToolContinuationOwner?.detachedAbortController ??
        (allowConcurrentBtwDuringResponse ? abortController : undefined);
      const foregroundAbortController =
        allowConcurrentBtwDuringResponse || isDetachedToolContinuation
          ? undefined
          : abortController;
      let keepToolContinuationAbortController = false;
      if (detachedAbortController) {
        detachedToolContinuationAbortControllersRef.current.add(
          detachedAbortController,
        );
      }

      // Keep the main stream's cancellation state intact while /btw is handled
      // in parallel. The side-question can use its own local abort signal.
      if (!allowConcurrentBtwDuringResponse && !isDetachedToolContinuation) {
        abortControllerRef.current = abortController;
        turnCancelledRef.current = false;
      }

      if (!prompt_id) {
        prompt_id = config.getSessionId() + '########' + getPromptCount();
      }
      if (!allowConcurrentBtwDuringResponse) {
        activeInteractionPromptIdRef.current = prompt_id;
        if (
          submitType !== SendMessageType.ToolResult &&
          submitType !== SendMessageType.Hook &&
          submitType !== SendMessageType.Steer
        ) {
          activeInteractionOwnerRef.current = undefined;
        }
      }

      const releaseSubmissionActivity =
        retainSubmissionActivity(submissionGeneration);
      const submission = promptIdContext.run(prompt_id, async () => {
        let queuedGoal = metadata?.goal;
        let preparedQuery: {
          queryToSend: PartListUnion | null;
          shouldProceed: boolean;
          scheduledToolCallId?: string;
        };
        try {
          preparedQuery =
            submitType === SendMessageType.Goal
              ? queuedGoal
                ? {
                    queryToSend: renderGoalContinuationPrompt({
                      goalId: queuedGoal.permit.goalId,
                      revision: queuedGoal.permit.revision,
                      objective: queuedGoal.continuationContext,
                      objectiveUpdated: queuedGoal.objectiveUpdated,
                      windDown: queuedGoal.windDown,
                      verifierFeedback: queuedGoal.verifierFeedback,
                    }),
                    shouldProceed: true,
                  }
                : { queryToSend: null, shouldProceed: false }
              : submitType === SendMessageType.Retry
                ? { queryToSend: query, shouldProceed: true }
                : await prepareQueryForLlm(
                    query,
                    userMessageTimestamp,
                    abortSignal,
                    prompt_id!,
                    submitType,
                    submittedPrompt,
                    allowConcurrentBtwDuringResponse ||
                      isDetachedToolContinuation,
                  );
        } catch (error) {
          await releaseUndeliveredGoalTurn(metadata?.userAdmission?.turnKey);
          releaseSubmissionLease();
          metadata?.onAdmissionFailed?.();
          throw error;
        }
        const { queryToSend, shouldProceed, scheduledToolCallId } =
          preparedQuery;

        if (scheduledToolCallId && foregroundAbortController) {
          keepToolContinuationAbortController = true;
          continuationOwnersByToolCallIdRef.current.set(scheduledToolCallId, {
            promptId: prompt_id!,
            signal: abortSignal,
            survivesGenerationChange: false,
            foregroundAbortController,
          });
        }

        if (!shouldProceed || queryToSend === null) {
          await releaseUndeliveredGoalTurn(metadata?.userAdmission?.turnKey);
          releaseSubmissionLease();
          metadata?.onDeliveryFailed?.();
          return;
        }

        await goalQueueRef?.current?.waitForReservationSettlement?.();

        if (!queuedGoal && metadata?.claimGoalTurn) {
          queuedGoal = metadata.claimGoalTurn();
          if (!queuedGoal) {
            releaseSubmissionLease();
            metadata.onGoalClaimDeferred?.();
            return;
          }
        }

        let userAdmission: DirectUserAdmission | undefined;
        if (submitType === SendMessageType.UserQuery) {
          if (metadata?.userAdmission) {
            const goal =
              metadata.userAdmission.goal ??
              goalQueueRef?.current?.claimGoalTurn?.();
            userAdmission = {
              turnKey: metadata.userAdmission.turnKey,
              ...(goal ? { goal } : {}),
            };
          } else {
            userAdmission =
              goalQueueRef?.current?.claimDirectUserAdmission?.() ?? {
                turnKey: prompt_id!,
              };
          }
        }
        const goal = queuedGoal ?? userAdmission?.goal;
        let goalBinding =
          metadata?.goalBinding ??
          (goal
            ? bindGoalTurn(
                goal.permit,
                goal.turnKey,
                submitType === SendMessageType.UserQuery ? 'user' : 'runtime',
              )
            : undefined);
        const turnKey = goalBinding?.turnKey ?? userAdmission?.turnKey;
        const turnController =
          goalBinding?.controller ??
          (turnKey ? new AbortController() : undefined);
        const processingSignals = [abortSignal];
        if (turnController) {
          processingSignals.push(turnController.signal);
        }
        if (inheritedToolContinuationOwner) {
          processingSignals.push(inheritedToolContinuationOwner.signal);
        }
        const processingSignal =
          processingSignals.length > 1
            ? AbortSignal.any(processingSignals)
            : abortSignal;
        const toolContinuationOwner: ToolContinuationOwner = {
          promptId: prompt_id!,
          signal: processingSignal,
          survivesGenerationChange:
            allowConcurrentBtwDuringResponse ||
            inheritedToolContinuationOwner?.survivesGenerationChange === true,
          detachedAbortController,
          foregroundAbortController,
        };
        const turnAdmission =
          turnKey && turnController
            ? {
                turnKey,
                controller: turnController,
                origin: goalBinding?.origin ?? ('user' as const),
              }
            : undefined;
        if (
          turnAdmission &&
          !goalBinding &&
          submitType === SendMessageType.UserQuery &&
          !allowConcurrentBtwDuringResponse &&
          !activeGoalAdmissionRef.current
        ) {
          try {
            if (
              config.getGoalRuntime().getSnapshot().goal?.status === 'active'
            ) {
              activeGoalAdmissionRef.current = turnAdmission;
            }
          } catch {
            // Goal runtime is optional during early initialization.
          }
        }

        // Check image format support for non-continuations
        if (
          submitType === SendMessageType.UserQuery ||
          submitType === SendMessageType.Cron ||
          submitType === SendMessageType.Teammate
        ) {
          const formatCheck = checkImageFormatsSupport(queryToSend);
          if (formatCheck.hasUnsupportedFormats) {
            addItem(
              {
                type: MessageType.INFO,
                text: getUnsupportedImageFormatWarning(),
              },
              userMessageTimestamp,
            );
          }
        }

        const finalQueryToSend = queryToSend;
        goalTerminalErrorRef.current = false;
        if (submitType !== SendMessageType.Goal) {
          lastPromptRef.current = finalQueryToSend;
          lastPromptErroredRef.current = false;
        }

        if (
          submitType === SendMessageType.UserQuery ||
          submitType === SendMessageType.Cron ||
          submitType === SendMessageType.Teammate
        ) {
          // trigger new prompt event for session stats in CLI
          startNewPrompt();

          // log user prompt event for telemetry, only text prompts for now
          if (typeof queryToSend === 'string') {
            logUserPrompt(
              config,
              new UserPromptEvent(
                queryToSend.length,
                prompt_id,
                config.getContentGeneratorConfig()?.authType,
                queryToSend,
                modelOverrideRef.current ?? config.getModel(),
              ),
            );
          }

          // Reset thought when starting a new prompt
          setThought(null);
          setPendingThoughtItem(null);
        }

        if (submitType === SendMessageType.Retry) {
          logUserRetry(config, new UserRetryEvent(prompt_id));
        }

        activeModelStreamsRef.current += 1;
        setIsResponding(true);
        setInitError(null);
        // Entering "requesting" phase — no content yet for this API call.
        setIsReceivingContent(false);
        // Reset char counter only on new user queries; tool-result continuations
        // keep accumulating so the token count only goes up within a turn.
        if (!isTurnContinuation) {
          streamingResponseLengthRef.current = 0;
        }

        let cleanupReviewLease = false;
        let keepGoalBinding = false;
        try {
          // Emit user message to dual output sidecar (if enabled).
          // Skip for tool-result submissions — those are emitted separately
          // when the tool completes.
          if (
            dualOutput &&
            submitType !== SendMessageType.ToolResult &&
            submitType !== SendMessageType.Goal
          ) {
            const rawParts =
              typeof finalQueryToSend === 'string'
                ? [finalQueryToSend]
                : Array.isArray(finalQueryToSend)
                  ? finalQueryToSend
                  : [finalQueryToSend];
            const userParts: Part[] = rawParts.map((p) =>
              typeof p === 'string' ? { text: p } : p,
            );
            dualOutput.emitUserMessage(userParts);
          }

          const sendOptions = {
            type: submitType,
            notificationDisplayText: metadata?.notificationDisplayText,
            todoWorkChainId: metadata?.todoWorkChainId,
            modelOverride: modelOverrideRef.current,
            steerInput: metadata?.steerInput,
            ...(submittedPrompt !== undefined ? { submittedPrompt } : {}),
            ...(!allowConcurrentBtwDuringResponse &&
            !isDetachedToolContinuation &&
            midTurnDrainRef
              ? { getSteerInput: drainSteerAtBoundary }
              : {}),
          };
          if (submitType === SendMessageType.Goal && goalBinding) {
            try {
              config.getGoalRuntime().markTurnDelivered(goalBinding.turnKey);
            } catch {
              // Goal runtime is optional during early initialization.
            }
          }
          const providerSignal = inheritedToolContinuationOwner
            ? processingSignal
            : abortSignal;
          const stream = llmClient.sendMessageStream(
            finalQueryToSend,
            providerSignal,
            prompt_id!,
            {
              ...sendOptions,
              ...(goalBinding
                ? {
                    goalPermit: goalBinding.permit,
                    goalTurnKey: goalBinding.turnKey,
                    goalSignal: goalBinding.controller.signal,
                    goalOrigin: goalBinding.origin,
                    getQueuedGoalTurnKey: () =>
                      goalQueueRef?.current?.peekNextUserBatchKey(true),
                  }
                : userAdmission
                  ? {
                      goalTurnKey: userAdmission.turnKey,
                      goalSignal: turnController!.signal,
                      goalOrigin: 'user' as const,
                      getQueuedGoalTurnKey: () =>
                        goalQueueRef?.current?.peekNextUserBatchKey(true),
                    }
                  : {}),
            },
          );

          const processingResult = await processLlmStreamEvents(
            stream,
            userMessageTimestamp,
            processingSignal,
            submitType,
            turnAdmission,
            prompt_id,
            !allowConcurrentBtwDuringResponse,
            toolContinuationOwner,
          );
          if (
            !goalBinding &&
            turnAdmission &&
            activeGoalTurnRef.current?.controller ===
              turnAdmission.controller &&
            activeGoalTurnRef.current.turnKey === turnAdmission.turnKey
          ) {
            goalBinding = activeGoalTurnRef.current;
          }
          keepGoalBinding = processingResult.scheduledToolContinuation;
          keepToolContinuationAbortController =
            processingResult.scheduledToolContinuation;

          if (
            processingResult.status === StreamProcessingStatus.UserCancelled
          ) {
            cleanupReviewLease = true;
            submitPromptOnCompleteRef.current = null;
            metadata?.onDeliveryFailed?.();
            return;
          }

          if (pendingHistoryItemRef.current) {
            commitItemInOrder(
              pendingHistoryItemRef.current,
              userMessageTimestamp,
            );
            setPendingHistoryItem(null);
          }

          const immediateDuplicateToolResponses =
            immediateDuplicateToolResponsesRef.current;
          if (immediateDuplicateToolResponses) {
            immediateDuplicateToolResponsesRef.current = null;
            const finalized = await finalizeToolResponses(
              config,
              immediateDuplicateToolResponses.responses.map(
                ({ request, response }) => ({
                  callId: request.callId,
                  toolName: request.name,
                  responseParts: response.responseParts,
                  persistedOutputFiles: response.persistedOutputFiles,
                  artifacts: response.artifacts,
                }),
              ),
              new Map(
                immediateDuplicateToolResponses.responses.flatMap(
                  ({ request }) => {
                    const promptId =
                      request.prompt_id ??
                      immediateDuplicateToolResponses.promptId;
                    return promptId
                      ? [[request.callId, promptId] as const]
                      : [];
                  },
                ),
              ),
            );
            const responseParts = finalized.flatMap(
              (entry) => entry.responseParts,
            );
            immediateDuplicateToolResponses.responses.forEach(
              ({ request, response }, index) => {
                config.getChatRecordingService?.()?.recordToolResult?.(
                  finalized[index].responseParts,
                  {
                    callId: request.callId,
                    status: response.error ? 'error' : 'success',
                    resultDisplay: response.resultDisplay,
                    persistedOutputFiles: finalized[index].persistedOutputFiles,
                    artifacts: finalized[index].artifacts,
                    error: response.error,
                    errorType: response.errorType,
                    executionStatus: response.executionStatus,
                  },
                  goalToolResultProvenance(request),
                );
              },
            );
            await submitQuery(
              responseParts,
              SendMessageType.ToolResult,
              immediateDuplicateToolResponses.promptId,
              { goalBinding },
            );
            if (
              goalBinding &&
              !turnCancelledRef.current &&
              !abortControllerRef.current?.signal.aborted &&
              goalTurnBindingsRef.current.get(goalBinding.permit.turnId) ===
                goalBinding &&
              !goalBinding.controller.signal.aborted
            ) {
              keepGoalBinding = true;
            }
          }
          // Only clear auto-retry countdown errors (those with an active timer).
          // Do NOT clear static error+hint from handleErrorEvent — those should
          // remain visible until the user presses Ctrl+Y to retry or starts
          // a new conversation turn (cleared in submitQuery).
          if (retryCountdownTimerRef.current) {
            clearRetryCountdown();
          } else if (
            pendingRetryErrorItemRef.current &&
            !lastPromptErroredRef.current &&
            !goalTerminalErrorRef.current
          ) {
            // A countdown-originated error item lingers after the timer
            // expired and the retry succeeded. Clear it so it does not
            // stay on screen. Terminal errors (handleErrorEvent) set
            // lastPromptErroredRef (or goalTerminalErrorRef for Goal turns)
            // and are intentionally left visible.
            clearRetryCountdown();
          }
          const loopDetected = loopDetectedRef.current;
          if (loopDetected) {
            cleanupReviewLease = true;
            loopDetectedRef.current = false;
            handleLoopDetectedEvent();
          }

          if (lastPromptErroredRef.current || goalTerminalErrorRef.current) {
            metadata?.onDeliveryFailed?.();
          } else {
            metadata?.onDelivered?.();
          }

          // If the turn was initiated by a submit_prompt with an onComplete
          // callback (e.g. /dream recording lastDreamAt), fire it now.
          const onComplete = submitPromptOnCompleteRef.current;
          if (onComplete) {
            submitPromptOnCompleteRef.current = null;
            void onComplete().catch((err) => {
              debugLogger.error('onComplete callback failed:', err);
            });
          }

          // After the turn completes, wire up notifications for any background
          // dream / extraction tasks that were kicked off by the client.
          if (llmClient) {
            const memoryTaskPromises =
              llmClient.consumePendingMemoryTaskPromises();
            for (const p of memoryTaskPromises) {
              void p.then((count) => {
                if (count > 0) {
                  addItem(
                    {
                      type: 'memory_saved',
                      writtenCount: count,
                      verb: 'Updated',
                    } as HistoryItemWithoutId,
                    Date.now(),
                  );
                }
              });
            }
          }
        } catch (error: unknown) {
          cleanupReviewLease = true;
          metadata?.onDeliveryFailed?.();
          if (error instanceof UnauthorizedError) {
            onAuthError('Session expired or is unauthorized.');
          } else if (!isNodeError(error) || error.name !== 'AbortError') {
            if (submitType !== SendMessageType.Goal) {
              lastPromptErroredRef.current = true;
            }
            const retryHint =
              submitType !== SendMessageType.Goal
                ? t('Press Ctrl+Y to retry')
                : undefined;
            // Store error with hint as a pending item (same as handleErrorEvent)
            setPendingRetryErrorItem({
              type: 'error' as const,
              text: parseAndFormatApiError(
                getErrorMessage(error) || 'Unknown error',
                config.getContentGeneratorConfig()?.authType,
              ),
              hint: retryHint,
            });
          }
        } finally {
          if (cleanupReviewLease) {
            cleanupReviewWorktreeLeases({
              sessionId: config.getSessionId(),
              promptId: prompt_id!,
              repositoryRoot: config.getProjectRoot(),
            });
          }
          submitPromptOnCompleteRef.current = null;
          activeModelStreamsRef.current = Math.max(
            0,
            activeModelStreamsRef.current - 1,
          );
          const shouldDrainCompletedToolBatches =
            activeModelStreamsRef.current === 0;
          if (goalBinding) {
            let retainGoalBinding =
              keepGoalBinding && !goalBinding.controller.signal.aborted;
            if (retainGoalBinding) {
              try {
                const currentPermit = config
                  .getGoalRuntime()
                  .permitForTurn(goalBinding.turnKey);
                retainGoalBinding =
                  currentPermit !== undefined &&
                  sameGoalPermit(currentPermit, goalBinding.permit);
              } catch {
                // Tests and early initialization may not expose a ready runtime.
              }
            }
            if (!retainGoalBinding) {
              await failClosedGoalTurn(
                goalBinding,
                'Goal turn ended without a valid continuation',
              );
            }
          }
          if (
            turnAdmission &&
            !goalBinding &&
            activeGoalAdmissionRef.current?.controller ===
              turnAdmission.controller &&
            activeGoalAdmissionRef.current.turnKey === turnAdmission.turnKey
          ) {
            activeGoalAdmissionRef.current = null;
          }
          if (shouldDrainCompletedToolBatches) {
            const pendingCompletedToolBatches =
              pendingCompletedToolBatchesRef.current.splice(0);
            const pendingCompletedTools = new Map<string, TrackedToolCall>();
            for (const pendingBatch of pendingCompletedToolBatches) {
              for (const toolCall of pendingBatch) {
                pendingCompletedTools.set(toolCall.request.callId, toolCall);
              }
            }
            if (pendingCompletedTools.size > 0) {
              await handleCompletedToolsRef.current([
                ...pendingCompletedTools.values(),
              ]);
            }
          }
        }
      });
      return submission.finally(() => {
        releaseSubmissionActivity();
        if (detachedAbortController && !keepToolContinuationAbortController) {
          detachedToolContinuationAbortControllersRef.current.delete(
            detachedAbortController,
          );
        }
        if (
          foregroundAbortController &&
          !keepToolContinuationAbortController &&
          abortControllerRef.current === foregroundAbortController
        ) {
          abortControllerRef.current = null;
        }
      });
    },
    [
      streamingState,
      setModelSwitchedFromQuotaError,
      prepareQueryForLlm,
      processLlmStreamEvents,
      pendingHistoryItemRef,
      addItem,
      commitPendingAssistantItems,
      commitItemInOrder,
      setPendingAssistantItems,
      setPendingHistoryItem,
      setInitError,
      llmClient,
      onAuthError,
      config,
      startNewPrompt,
      getPromptCount,
      handleLoopDetectedEvent,
      clearRetryCountdown,
      pendingRetryCountdownItemRef,
      pendingRetryErrorItemRef,
      setPendingRetryErrorItem,
      setPendingThoughtItem,
      dualOutput,
      drainSteerAtBoundary,
      midTurnDrainRef,
      goalQueueRef,
      bindGoalTurn,
      failClosedGoalTurn,
      releaseUndeliveredGoalTurn,
      retainSubmissionActivity,
      setSubmissionInFlight,
    ],
  );

  /**
   * Retries the last failed prompt when the user presses Ctrl+Y.
   *
   * Activation conditions for Ctrl+Y shortcut:
   * 1. ✓ The last request must have failed (lastPromptErroredRef.current === true)
   * 2. ✓ Current streaming state must NOT be "Responding" (avoid interrupting ongoing stream)
   * 3. ✓ Current streaming state must NOT be "WaitingForConfirmation" (avoid conflicting with tool confirmation flow)
   * 4. ✓ There must be a stored lastPrompt in lastPromptRef.current
   *
   * When conditions are not met:
   * - If streaming is active (Responding/WaitingForConfirmation): silently return without action
   * - If no failed request exists: display "No failed request to retry." info message
   *
   * When conditions are met:
   * - Clears any pending auto-retry countdown to avoid duplicate retries
   * - Re-submits the last query with isRetry: true, reusing the same prompt_id
   *
   * This function is exposed via UIActionsContext and triggered by InputPrompt
   * when the user presses Ctrl+Y (bound to Command.RETRY_LAST in keyBindings.ts).
   */
  const retryLastPrompt = useCallback(async () => {
    // During a rate-limit retry countdown, skip the delay so the generator
    // retries immediately — no abort/re-submit needed.
    if (skipRetryDelayRef.current) {
      skipRetryDelayRef.current();
      skipRetryDelayRef.current = null;
      clearRetryCountdown();
      return;
    }

    if (
      streamingState === StreamingState.Responding ||
      streamingState === StreamingState.WaitingForConfirmation
    ) {
      return;
    }

    const lastPrompt = lastPromptRef.current;
    if (!lastPrompt || !lastPromptErroredRef.current) {
      addItem(
        {
          type: MessageType.INFO,
          text: t('No failed request to retry.'),
        },
        Date.now(),
      );
      return;
    }

    clearRetryCountdown();

    await submitQuery(lastPrompt, SendMessageType.Retry);
  }, [streamingState, addItem, clearRetryCountdown, submitQuery]);

  const preemptGoalTurn = useCallback((reason: string) => {
    const active = activeGoalAdmissionRef.current;
    if (!active || active.controller.signal.aborted) return;
    active.controller.abort(reason);
  }, []);

  const handleApprovalModeChange = useCallback(
    async (newApprovalMode: ApprovalMode) => {
      // Auto-approve pending tool calls when switching to auto-approval modes
      if (
        newApprovalMode === ApprovalMode.YOLO ||
        newApprovalMode === ApprovalMode.AUTO_EDIT
      ) {
        let awaitingApprovalCalls = toolCalls.filter(
          (call): call is TrackedWaitingToolCall => {
            if (call.status !== 'awaiting_approval') {
              return false;
            }
            const { confirmationDetails } = call;
            return !(
              confirmationDetails &&
              'hideAlwaysAllow' in confirmationDetails &&
              confirmationDetails.hideAlwaysAllow === true
            );
          },
        );

        // For AUTO_EDIT mode, only approve edit tools (edit/replace, write_file, notebook_edit)
        if (newApprovalMode === ApprovalMode.AUTO_EDIT) {
          awaitingApprovalCalls = awaitingApprovalCalls.filter((call) =>
            EDIT_TOOL_NAMES.has(call.request.name),
          );
        }

        // Process pending tool calls sequentially to reduce UI chaos
        for (const call of awaitingApprovalCalls) {
          if (call.confirmationDetails?.onConfirm) {
            try {
              await call.confirmationDetails.onConfirm(
                ToolConfirmationOutcome.ProceedOnce,
              );
            } catch (error) {
              debugLogger.error(
                `Failed to auto-approve tool call ${call.request.callId}:`,
                error,
              );
            }
          }
        }
      }
    },
    [toolCalls],
  );

  const handleCompletedTools = useCallback(
    async (completedToolCallsFromScheduler: TrackedToolCall[]) => {
      const completedAndReadyToSubmitTools =
        completedToolCallsFromScheduler.filter(
          (
            tc: TrackedToolCall,
          ): tc is TrackedCompletedToolCall | TrackedCancelledToolCall => {
            const isTerminalState =
              tc.status === 'success' ||
              tc.status === 'error' ||
              tc.status === 'cancelled';

            if (isTerminalState) {
              const completedOrCancelledCall = tc as
                | TrackedCompletedToolCall
                | TrackedCancelledToolCall;
              return (
                completedOrCancelledCall.response?.responseParts !== undefined
              );
            }
            return false;
          },
        );
      // History-based dedup MUST run before the active-stream early-return.
      // If a synthetic `functionResponse` for this callId is already in
      // chat.history (planted on session-load by
      // `client.repairOrphanedToolUseTurnsInHistory` or on every
      // `chat.sendMessageStream` push by the inline repair pass), the
      // in-flight scheduler result must be marked submitted NOW —
      // `useReactToolScheduler.allToolCallsCompleteHandler` is single-shot
      // per batch, so a later active-stream early-return would leave
      // the tool stuck in `completed-but-not-submitted` forever (Race A
      // surfaced in PR #4176 review). The real result is dropped on the
      // wire — same trade-off upstream Claude Code makes when its
      // `StreamingToolExecutor.discard()` follows a
      // `yieldMissingToolResultBlocks` synthesis (`query.ts:733` + `:984`).
      // Walk raw history WITHOUT cloning — `llmClient.getHistory()`
      // returns `structuredClone(this.history)`, which on long sessions
      // (200+ entries with sizable tool outputs) costs several ms on
      // the React UI thread and visibly stalls streaming when the
      // dedup pass runs on every tool-completion batch.
      // `getHistoryFunctionResponseIds` walks history in place and
      // returns only the id Set this dispatcher needs. The
      // LlmClient implementation is mandatory — production and
      // test mocks both expose it. Skip the dedup pass entirely if
      // the client is missing (only happens in unit tests that
      // construct a hook without a client).
      const historyCallIdsWithResponse: Set<string> = llmClient
        ? llmClient.getHistoryFunctionResponseIds()
        : new Set<string>();
      const dedupedTools = completedAndReadyToSubmitTools.filter((tc) =>
        historyCallIdsWithResponse.has(tc.request.callId),
      );
      const dedupedCallIds = dedupedTools.map((tc) => tc.request.callId);
      if (dedupedCallIds.length > 0) {
        debugLogger.warn(
          `[REPAIR] Dropping ${dedupedCallIds.length} late tool result(s) ` +
            `whose callId already has a functionResponse in history: ` +
            `${dedupedCallIds.join(', ')}`,
        );
        // Even though the wire-side submission is dropped, the tool DID
        // run locally — `toolCallCount` and `skillsModifiedInSession`
        // must reflect that. Without this, deduped skill-write tools
        // (e.g. write_file under a project SKILLS path) would silently
        // skip the `skillsModifiedInSession` flip that gates the
        // skills-reload prompt at end-of-turn. Mirrors the
        // `recordCompletedToolCall` loop below over `llmTools` —
        // filter to the same shape (non-client-initiated) so client
        // tools (which the original loop also skipped) stay skipped.
        //
        // Cancelled tools are also skipped: `dedupedTools` includes
        // anything in a terminal state (success | error | cancelled),
        // but cancelled means the tool never actually ran end-to-end —
        // the `allToolsCancelled` branch below would have surfaced
        // them via `addHistory + reportCancelled` rather than the
        // completed-call metric, and the metric should match. Without
        // this filter, a deduped + cancelled tool would inflate
        // `toolCallCount` for a call that never produced a result
        // (and could also flip `skillsModifiedInSession` for a
        // never-executed skill-write).
        for (const tc of dedupedTools) {
          if (tc.request.isClientInitiated) continue;
          if (tc.status === 'cancelled') continue;
          llmClient?.recordCompletedToolCall(
            tc.request.name,
            tc.request.args as Record<string, unknown>,
          );
        }
        markToolsAsSubmitted(dedupedCallIds);
        const detachedAbortControllers = new Set<AbortController>();
        const foregroundAbortControllers = new Set<AbortController>();
        for (const callId of dedupedCallIds) {
          const continuationOwner =
            continuationOwnersByToolCallIdRef.current.get(callId);
          if (continuationOwner?.detachedAbortController) {
            detachedAbortControllers.add(
              continuationOwner.detachedAbortController,
            );
          }
          if (continuationOwner?.foregroundAbortController) {
            foregroundAbortControllers.add(
              continuationOwner.foregroundAbortController,
            );
          }
          interactionOwnersByToolCallIdRef.current.delete(callId);
          continuationOwnersByToolCallIdRef.current.delete(callId);
        }
        for (const controller of detachedAbortControllers) {
          const isStillOwned = [
            ...continuationOwnersByToolCallIdRef.current.values(),
          ].some((owner) => owner.detachedAbortController === controller);
          if (!isStillOwned) {
            detachedToolContinuationAbortControllersRef.current.delete(
              controller,
            );
          }
        }
        for (const controller of foregroundAbortControllers) {
          const isStillOwned = [
            ...continuationOwnersByToolCallIdRef.current.values(),
          ].some((owner) => owner.foregroundAbortController === controller);
          if (!isStillOwned && abortControllerRef.current === controller) {
            abortControllerRef.current = null;
          }
        }
      }

      if (activeModelStreamsRef.current > 0) {
        const deferredTools = completedAndReadyToSubmitTools.filter(
          (toolCall) =>
            !historyCallIdsWithResponse.has(toolCall.request.callId),
        );
        if (deferredTools.length > 0) {
          pendingCompletedToolBatchesRef.current.push(deferredTools);
        }
        return;
      }

      const continuationOwner = completedAndReadyToSubmitTools
        .filter(
          (toolCall) =>
            !historyCallIdsWithResponse.has(toolCall.request.callId),
        )
        .map((toolCall) =>
          continuationOwnersByToolCallIdRef.current.get(
            toolCall.request.callId,
          ),
        )
        .find((owner) => owner !== undefined);
      const continuationWasCancelled = () =>
        continuationOwner
          ? continuationOwner.signal.aborted
          : turnCancelledRef.current ||
            abortControllerRef.current?.signal.aborted === true;

      // Finalize any client-initiated tools as soon as they are done.
      // Skip ones whose callId already lives in chat history with a
      // matching `functionResponse` — the dedup block above already
      // called `markToolsAsSubmitted` for those, and re-dispatching
      // the same callIds here would queue an extra React render.
      const clientTools = completedAndReadyToSubmitTools.filter(
        (t) =>
          t.request.isClientInitiated &&
          !historyCallIdsWithResponse.has(t.request.callId),
      );
      if (clientTools.length > 0) {
        markToolsAsSubmitted(clientTools.map((t) => t.request.callId));
      }

      // Identify new, successful save_memory calls that we haven't processed yet.
      const newSuccessfulMemorySaves = completedAndReadyToSubmitTools.filter(
        (t) =>
          t.request.name === 'save_memory' &&
          t.status === 'success' &&
          !processedMemoryToolsRef.current.has(t.request.callId),
      );

      let llmTools = completedAndReadyToSubmitTools.filter(
        (t) =>
          !t.request.isClientInitiated &&
          !historyCallIdsWithResponse.has(t.request.callId),
      );
      const terminalPromptId = completedAndReadyToSubmitTools.find(
        (toolCall) => !toolCall.request.isClientInitiated,
      )?.request.prompt_id;
      const ownerForToolCall = (toolCall: TrackedToolCall) =>
        interactionOwnersByToolCallIdRef.current.get(toolCall.request.callId) ??
        (activeInteractionPromptIdRef.current === toolCall.request.prompt_id
          ? activeInteractionOwnerRef.current
          : undefined);
      const liveOwnerForToolCall = (toolCall: TrackedToolCall) => {
        const owner = ownerForToolCall(toolCall);
        const ownerPromptId = toolCall.request.prompt_id;
        return owner &&
          ownerPromptId &&
          getActiveInteractionSpan(ownerPromptId) === owner
          ? owner
          : undefined;
      };
      const liveActiveInteractionOwner =
        activeInteractionPromptIdRef.current &&
        activeInteractionOwnerRef.current &&
        getActiveInteractionSpan(activeInteractionPromptIdRef.current) ===
          activeInteractionOwnerRef.current
          ? activeInteractionOwnerRef.current
          : undefined;
      const ownerToolCall =
        (liveActiveInteractionOwner
          ? llmTools.find(
              (toolCall) =>
                liveOwnerForToolCall(toolCall) === liveActiveInteractionOwner,
            )
          : undefined) ??
        llmTools.find((toolCall) => liveOwnerForToolCall(toolCall)) ??
        llmTools[0] ??
        completedAndReadyToSubmitTools.find(
          (toolCall) => !toolCall.request.isClientInitiated,
        );
      const interactionOwner = ownerToolCall
        ? liveOwnerForToolCall(ownerToolCall)
        : undefined;
      const secondaryInteractionOwners = new Map<
        NonNullable<ReturnType<typeof getActiveInteractionSpan>>,
        string
      >();
      const secondaryTools = interactionOwner
        ? llmTools.filter(
            (toolCall) => ownerForToolCall(toolCall) !== interactionOwner,
          )
        : [];
      for (const toolCall of secondaryTools) {
        const secondaryOwner = ownerForToolCall(toolCall);
        if (secondaryOwner && toolCall.request.prompt_id) {
          secondaryInteractionOwners.set(
            secondaryOwner,
            toolCall.request.prompt_id,
          );
        }
        if (toolCall.status !== 'cancelled') {
          llmClient?.recordCompletedToolCall(
            toolCall.request.name,
            toolCall.request.args as Record<string, unknown>,
          );
        }
        dualOutput?.emitToolResult(toolCall.request, toolCall.response);
      }
      if (secondaryTools.length > 0) {
        const secondaryCallIds = new Set(
          secondaryTools.map((toolCall) => toolCall.request.callId),
        );
        markToolsAsSubmitted([...secondaryCallIds]);
        llmTools = llmTools.filter(
          (toolCall) => !secondaryCallIds.has(toolCall.request.callId),
        );
      }
      for (const toolCall of completedAndReadyToSubmitTools) {
        interactionOwnersByToolCallIdRef.current.delete(
          toolCall.request.callId,
        );
        continuationOwnersByToolCallIdRef.current.delete(
          toolCall.request.callId,
        );
      }
      for (const [owner, ownerPromptId] of secondaryInteractionOwners) {
        if (getActiveInteractionSpan(ownerPromptId) === owner) {
          endInteractionSpan('cancelled', { promptId: ownerPromptId });
        }
      }
      let promptId =
        ownerToolCall?.request.prompt_id ?? continuationOwner?.promptId;
      const endToolInteraction = (
        status: 'ok' | 'error' | 'cancelled',
        errorMessage?: string,
        errorType?: string,
      ) => {
        if (continuationOwner?.detachedAbortController) {
          detachedToolContinuationAbortControllersRef.current.delete(
            continuationOwner.detachedAbortController,
          );
        }
        if (
          continuationOwner?.foregroundAbortController &&
          abortControllerRef.current ===
            continuationOwner.foregroundAbortController
        ) {
          abortControllerRef.current = null;
        }
        if (
          !promptId ||
          !interactionOwner ||
          getActiveInteractionSpan(promptId) !== interactionOwner
        ) {
          return;
        }
        endInteractionSpan(status, {
          promptId,
          ...(errorMessage ? { errorMessage } : {}),
          ...(errorType ? { errorType } : {}),
        });
        if (activeInteractionOwnerRef.current === interactionOwner) {
          activeInteractionOwnerRef.current = undefined;
        }
      };
      let toolGoalPermit: GoalTurnPermit | undefined;
      const toolGoalContexts = llmTools.map(
        (toolCall) => toolCall.request.goalContext,
      );
      try {
        toolGoalPermit = sharedGoalPermit(toolGoalContexts);
      } catch (error) {
        const callIds = llmTools.map((toolCall) => toolCall.request.callId);
        markToolsAsSubmitted(callIds);
        const reason = getErrorMessage(error);
        const bindings = new Map<string, GoalTurnBinding>();
        const active = activeGoalTurnRef.current;
        if (active) {
          bindings.set(active.turnKey, active);
        }
        for (const permit of toolGoalContexts) {
          if (!permit) continue;
          const existing = goalTurnBindingsRef.current.get(permit.turnId);
          const binding =
            existing ??
            ({
              permit: { ...permit },
              turnKey: `goal-runtime:${permit.turnId}`,
              controller: new AbortController(),
              origin: 'runtime',
            } satisfies GoalTurnBinding);
          bindings.set(binding.turnKey, binding);
        }
        for (const binding of bindings.values()) {
          await failClosedGoalTurn(binding, reason);
        }
        addItem(
          {
            type: MessageType.ERROR,
            text: reason,
          },
          Date.now(),
        );
        endToolInteraction(
          'error',
          'invalid Goal tool context',
          'continuation_goal_context_invalid',
        );
        return;
      }
      if (!toolGoalPermit && toolGoalContexts.length > 0) {
        const active = activeGoalTurnRef.current;
        let activeGoalPermitValid = false;
        if (active) {
          try {
            const runtime = config.getGoalRuntime();
            const currentPermit = runtime.permitForTurn(active.turnKey);
            activeGoalPermitValid =
              currentPermit !== undefined &&
              sameGoalPermit(currentPermit, active.permit);
          } catch {
            // A missing runtime means this is an ordinary non-Goal batch.
          }
        }
        if (active && activeGoalPermitValid) {
          markToolsAsSubmitted(
            llmTools.map((toolCall) => toolCall.request.callId),
          );
          const reason = 'ToolResult batch is missing the active Goal context';
          await failClosedGoalTurn(active, reason);
          addItem(
            {
              type: MessageType.ERROR,
              text: reason,
            },
            Date.now(),
          );
          endToolInteraction(
            'error',
            'missing Goal tool context',
            'continuation_goal_context_missing',
          );
          return;
        }
      }
      let toolGoalBinding: GoalTurnBinding | undefined;
      if (toolGoalPermit) {
        const existing = goalTurnBindingsRef.current.get(toolGoalPermit.turnId);
        if (existing && !sameGoalPermit(existing.permit, toolGoalPermit)) {
          markToolsAsSubmitted(
            llmTools.map((toolCall) => toolCall.request.callId),
          );
          const reason = 'ToolResult batch has a stale Goal context';
          await failClosedGoalTurn(existing, reason);
          addItem(
            {
              type: MessageType.ERROR,
              text: reason,
            },
            Date.now(),
          );
          endToolInteraction(
            'error',
            'stale Goal tool context',
            'continuation_goal_context_stale',
          );
          return;
        }
        toolGoalBinding =
          existing ??
          bindGoalTurn(
            toolGoalPermit,
            `goal-runtime:${toolGoalPermit.turnId}`,
            'runtime',
          );
      }
      const memoryWriteCandidates = completedAndReadyToSubmitTools.map(
        (toolCall) => ({
          toolName: toolCall.request.name,
          args: toolCall.request.args as Record<string, unknown>,
          status: toolCall.status,
        }),
      );
      const didRefreshManagedMemory = await refreshMemoryAfterManagedWrite(
        config,
        memoryWriteCandidates,
        { logContext: 'interactive memory tool batch' },
      );
      if (refreshContextFilesOnWriteRef.current) {
        const matchedContextFileWrite = didWriteProjectContextFile(
          memoryWriteCandidates,
          config.getProjectRoot(),
        );
        debugLogger.debug(
          `Checked marked context-file memory tool batch; matched=${matchedContextFileWrite}`,
        );
        if (matchedContextFileWrite) {
          debugLogger.debug(
            'Refreshing memory after context-file memory write',
          );
          await refreshMemoryInstruction(config, {
            logContext: 'interactive context-file memory tool batch',
          });
        }
      }
      if (newSuccessfulMemorySaves.length > 0) {
        if (!didRefreshManagedMemory) {
          // Perform the legacy save_memory refresh only when the managed-memory
          // write refresh did not already rebuild and publish a fresher state.
          void performMemoryRefresh().catch((err) => {
            debugLogger.warn(`save_memory refresh failed: ${err}`);
          });
        }
        // Mark them as processed so we don't do this again on the next render.
        newSuccessfulMemorySaves.forEach((t) =>
          processedMemoryToolsRef.current.add(t.request.callId),
        );
      }
      const completedCallIds = new Set(
        llmTools.map((toolCall) => toolCall.request.callId),
      );
      const secondaryCallIds = new Set(
        secondaryTools.map((toolCall) => toolCall.request.callId),
      );
      const readyDuplicateBatches: PendingDuplicateToolResponses[] = [];
      pendingDuplicateToolResponsesRef.current =
        pendingDuplicateToolResponsesRef.current.filter((batch) => {
          const isReady = [...batch.executableCallIds].some((callId) =>
            completedCallIds.has(callId),
          );
          if (isReady) {
            readyDuplicateBatches.push(batch);
          }
          const belongsToSecondaryOwner = [...batch.executableCallIds].some(
            (callId) => secondaryCallIds.has(callId),
          );
          return !isReady && !belongsToSecondaryOwner;
        });
      const pendingDuplicateResponses = readyDuplicateBatches
        .flatMap((batch) => batch.duplicateResponses)
        .filter(
          ({ request }) =>
            !interactionOwner ||
            !request.prompt_id ||
            request.prompt_id === promptId,
        );
      const pendingDuplicatePromptId = readyDuplicateBatches[0]?.promptId;
      if (!promptId && pendingDuplicatePromptId) {
        promptId = pendingDuplicatePromptId;
      }

      for (const toolCall of llmTools) {
        llmClient?.recordCompletedToolCall(
          toolCall.request.name,
          toolCall.request.args as Record<string, unknown>,
        );
      }

      if (llmTools.length === 0 && pendingDuplicateResponses.length === 0) {
        if (!promptId && terminalPromptId) {
          promptId = terminalPromptId;
        }
        if (toolGoalBinding) {
          await failClosedGoalTurn(
            toolGoalBinding,
            'Goal tool continuation ended without a result',
          );
        }
        if (
          completedAndReadyToSubmitTools.length > 0 &&
          completedAndReadyToSubmitTools.every(
            (toolCall) => toolCall.status === 'cancelled',
          )
        ) {
          endToolInteraction('cancelled');
        } else if (
          completedAndReadyToSubmitTools.some(
            (toolCall) => toolCall.status === 'error',
          )
        ) {
          endToolInteraction(
            'error',
            'tool continuation ended with an error',
            'continuation_tool_error',
          );
        } else {
          endToolInteraction('ok');
        }
        return;
      }

      type ReadyToolResponse = {
        request: ToolCallRequestInfo;
        response: ToolCallResponseInfo;
        status: 'success' | 'error' | 'cancelled';
      };
      const executableQueues = new Map<string, ReadyToolResponse[]>();
      for (const toolCall of llmTools) {
        const queue = executableQueues.get(toolCall.request.callId) ?? [];
        queue.push({
          request: toolCall.request,
          response: toolCall.response,
          status: toolCall.status,
        });
        executableQueues.set(toolCall.request.callId, queue);
      }
      const duplicateQueues = new Map<string, ReadyToolResponse[]>();
      for (const duplicate of pendingDuplicateResponses) {
        const queue = duplicateQueues.get(duplicate.request.callId) ?? [];
        queue.push({
          ...duplicate,
          status: duplicate.response.error ? 'error' : 'success',
        });
        duplicateQueues.set(duplicate.request.callId, queue);
      }
      const orderedResponses: ReadyToolResponse[] = [];
      for (const batch of readyDuplicateBatches) {
        for (const callId of batch.callOrder) {
          const executable = executableQueues.get(callId)?.shift();
          if (executable) {
            orderedResponses.push(executable);
            continue;
          }
          const duplicate = duplicateQueues.get(callId)?.shift();
          if (duplicate) orderedResponses.push(duplicate);
        }
      }
      for (const queue of executableQueues.values()) {
        orderedResponses.push(...queue);
      }
      for (const queue of duplicateQueues.values()) {
        orderedResponses.push(...queue);
      }

      const finalizedResponses = await finalizeToolResponses(
        config,
        orderedResponses.map(({ request, response }) => ({
          callId: request.callId,
          toolName: request.name,
          responseParts: response.responseParts,
          persistedOutputFiles: response.persistedOutputFiles,
          artifacts: response.artifacts,
        })),
        new Map(
          orderedResponses.flatMap(({ request }) =>
            request.prompt_id
              ? [[request.callId, request.prompt_id] as const]
              : [],
          ),
        ),
      );
      const responsesToSend = finalizedResponses.flatMap(
        (entry) => entry.responseParts,
      );
      orderedResponses.forEach(({ request, response, status }, index) => {
        config.getChatRecordingService?.()?.recordToolResult?.(
          finalizedResponses[index].responseParts,
          {
            callId: request.callId,
            status,
            resultDisplay: response.resultDisplay,
            persistedOutputFiles:
              finalizedResponses[index].persistedOutputFiles,
            artifacts: finalizedResponses[index].artifacts,
            error: response.error,
            errorType: response.errorType,
            executionStatus: response.executionStatus,
          },
          goalToolResultProvenance(request),
        );
      });

      if (continuationWasCancelled()) {
        markToolsAsSubmitted(
          llmTools.map((toolCall) => toolCall.request.callId),
        );
        if (toolGoalBinding) {
          await failClosedGoalTurn(
            toolGoalBinding,
            'Goal tool continuation was cancelled',
          );
        }
        endToolInteraction('cancelled');
        return;
      }

      // If all the tools were cancelled, don't submit a response to the model.
      const allToolsCancelled = llmTools.every(
        (tc) => tc.status === 'cancelled',
      );

      if (allToolsCancelled && pendingDuplicateResponses.length === 0) {
        if (llmClient) {
          // We need to manually add the function responses to the history
          // so the model knows the tools were cancelled.
          llmClient.addHistory({
            role: 'user',
            parts: responsesToSend,
          });

          // Report cancellation to arena (safety net — cancelOngoingRequest
          config.getArenaAgentClient()?.reportCancelled();
        }

        const callIdsToMarkAsSubmitted = llmTools.map(
          (toolCall) => toolCall.request.callId,
        );
        markToolsAsSubmitted(callIdsToMarkAsSubmitted);
        if (toolGoalBinding) {
          await failClosedGoalTurn(
            toolGoalBinding,
            'Goal tool continuation was cancelled',
          );
        }
        endToolInteraction('cancelled');
        return;
      }

      const callIdsToMarkAsSubmitted = llmTools.map(
        (toolCall) => toolCall.request.callId,
      );

      // Persist model override from skill tool results (last one wins).
      // Uses `in` so that undefined (from inherit/no-model skills) clears a
      // prior override, while non-skill tools (field absent) leave it intact.
      // An explicit inline `/model <id> <prompt>` override wins for the whole
      // turn, so skip skill-tool writes (including the undefined-clears case)
      // while it is active.
      for (const toolCall of llmTools) {
        if ('modelOverride' in toolCall.response) {
          if (
            inlineModelOverrideActiveRef.current ||
            modelOverrideRef.current?.endsWith('\0')
          ) {
            debugLogger.debug(
              `skill-tool model override (${String(
                toolCall.response.modelOverride,
              )}) blocked: ${
                inlineModelOverrideActiveRef.current
                  ? 'inline override active'
                  : 'full-turn override active'
              }`,
            );
          } else {
            applyModelOverride(
              modelOverrideRef,
              inlineModelOverrideActiveRef,
              toolCall.response.modelOverride,
              false,
            );
          }
        }
      }

      // Emit tool results to dual output sidecar (if enabled)
      if (dualOutput) {
        for (const toolCall of llmTools) {
          dualOutput.emitToolResult(toolCall.request, toolCall.response);
        }
      }

      markToolsAsSubmitted(callIdsToMarkAsSubmitted);

      const terminatesGoalTurn = llmTools.some(
        (toolCall) => toolCall.response.terminateTurn === true,
      );
      if (terminatesGoalTurn && toolGoalBinding) {
        llmClient.addHistory({ role: 'user', parts: responsesToSend });
        let goalFinishFailed = false;
        try {
          await config.getChatRecordingService()?.flush();
          const runtime = await config.getGoalRuntimeReady();
          const currentPermit = runtime.permitForTurn(toolGoalBinding.turnKey);
          if (
            currentPermit &&
            sameGoalPermit(currentPermit, toolGoalBinding.permit)
          ) {
            await runtime.finishTurn(toolGoalBinding.permit);
            const snapshot = runtime.getSnapshot();
            const status = snapshot.goal?.status;
            if (
              status === 'complete' ||
              status === 'blocked' ||
              status === 'usage_limited'
            ) {
              addItem(
                {
                  type: 'goal_state',
                  snapshot,
                  cause: status,
                },
                Date.now(),
              );
            }
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          goalFinishFailed = true;
          await failClosedGoalTurn(
            toolGoalBinding,
            `Goal turn could not finish: ${errorMessage}`,
          );
        } finally {
          // Idempotent with the release inside failClosedGoalTurn; also covers the success path.
          releaseGoalTurn(toolGoalBinding);
        }
        if (goalFinishFailed) {
          endToolInteraction(
            'error',
            'Goal tool continuation could not finish',
            'continuation_goal_finish_failed',
          );
        } else {
          endToolInteraction('ok');
        }
        return;
      }

      // Fire tool-use summary generation in parallel with the next API call.
      // The fast-model latency is hidden behind the main-model streaming.
      // Fire-and-forget: failures are silent and never block the turn.
      // Subagent exclusion is implicit — useLlmStream only drives the
      // main session; subagents run through agents/runtime/ with their own loop.
      if (config.getEmitToolUseSummaries()) {
        // Only summarize successful tools. Error/cancelled entries push
        // "Cancelled by user" / retry-loop warnings into the summarizer
        // prompt and produce plausibly-worded but misleading labels (the
        // fast model happily synthesizes "Attempted to read files" from a
        // batch that was mostly failures). cleanSummary can reject output
        // prefixes but not prevent this kind of polluted-input hallucination.
        // Goal tools already render authoritative lifecycle copy, which a
        // generated summary can contradict while verification is pending.
        const successfulTools = llmTools.filter(
          (tc) =>
            tc.status === 'success' &&
            tc.request.name !== ToolNames.GET_GOAL &&
            tc.request.name !== ToolNames.UPDATE_GOAL,
        );
        if (successfulTools.length > 0) {
          const toolInfoForSummary = successfulTools.map((tc) => ({
            name: tc.request.name,
            input: tc.request.args,
            output: extractToolResultText(tc.response.responseParts),
          }));
          const toolUseIds = successfulTools.map((tc) => tc.request.callId);
          const lastAssistantText = extractLastAssistantText(
            historyRef.current,
          );
          // Dedicated AbortController for this batch. Scoping it to the
          // current turn via abortControllerRef.current would be wrong —
          // submitQuery() below allocates a new controller for the next
          // turn, so the captured signal becomes stale the moment the
          // next turn starts. Instead, check the live abort state at
          // resolve time (which covers both Ctrl+C on the next turn and
          // mid-flight cancellation of this batch via turnCancelledRef).
          const summaryAbort = new AbortController();
          auxiliaryAbortRefsRef.current.add(summaryAbort);

          // Capture the first callId so we can locate "our" tool_group at
          // resolve time. If a newer tool_group has been added since we
          // fired (i.e., the conversation moved on), we drop the summary
          // rather than wedging the `● <label>` line between later items.
          const anchorCallId = toolUseIds[0];

          void generateToolUseSummary({
            config,
            tools: toolInfoForSummary,
            signal: summaryAbort.signal,
            lastAssistantText,
          })
            .then((summary) => {
              auxiliaryAbortRefsRef.current.delete(summaryAbort);
              const cancelled =
                turnCancelledRef.current ||
                abortControllerRef.current?.signal.aborted ||
                summaryAbort.signal.aborted;
              if (!summary || cancelled) return;

              // Stale-summary check: only append if our tool_group is still
              // the latest one in history. If a newer batch landed while
              // the fast-model call was in flight, the conversation has
              // moved past this batch and dropping in a `● <label>` line
              // now would land it after later content (full mode) or
              // attribute it to the wrong group (compact mode).
              const currentHistory = historyRef.current;
              const ourIdx = currentHistory.findIndex(
                (h) =>
                  h.type === 'tool_group' &&
                  h.tools.some((t) => t.callId === anchorCallId),
              );
              if (ourIdx < 0) return;
              const laterToolGroupExists = currentHistory
                .slice(ourIdx + 1)
                .some((h) => h.type === 'tool_group');
              if (laterToolGroupExists) return;

              if (summary && !cancelled) {
                addItem(
                  {
                    type: 'tool_use_summary',
                    summary,
                    precedingToolUseIds: toolUseIds,
                  } as HistoryItemWithoutId,
                  Date.now(),
                );
              }
            })
            .catch(() => {
              auxiliaryAbortRefsRef.current.delete(summaryAbort);
            });
        }
      }

      // Don't continue if model was switched due to quota error
      if (modelSwitchedFromQuotaError) {
        if (toolGoalBinding) {
          await failClosedGoalTurn(
            toolGoalBinding,
            'Goal tool continuation stopped after a model switch',
          );
        }
        endToolInteraction('cancelled');
        return;
      }

      const backgroundTaskRegistry = config.getBackgroundTaskRegistry();
      const backgroundLaunchExhaustedCapacity =
        backgroundTaskRegistry.getMaxConcurrentBackgroundAgents() === 1 &&
        !backgroundTaskRegistry.canStartBackgroundAgent() &&
        llmTools.some((toolCall) => {
          const display = toolCall.response.resultDisplay;
          return (
            toolCall.request.name === ToolNames.AGENT &&
            typeof display === 'object' &&
            display !== null &&
            'type' in display &&
            'status' in display &&
            display.type === 'task_execution' &&
            display.status === 'background'
          );
        });
      if (backgroundLaunchExhaustedCapacity) {
        llmClient?.addHistory({ role: 'user', parts: responsesToSend });
        if (toolGoalBinding) {
          await failClosedGoalTurn(
            toolGoalBinding,
            'Goal tool continuation stopped: background capacity exhausted',
          );
        }
        endToolInteraction(
          'error',
          'tool continuation capacity exhausted',
          'continuation_capacity_exhausted',
        );
        return;
      }

      // Drain steerable user messages at this sampling boundary and append
      // them after the tool responses as genuine user content.
      // Skip if the turn was cancelled — messages stay in queue for next turn.
      const drained =
        continuationOwner?.survivesGenerationChange ||
        continuationWasCancelled()
          ? []
          : (midTurnDrainRef?.current?.(
              false,
              Boolean(activeGoalAdmissionRef.current),
            ) ?? []);
      let drainedSteer: SteerInput | undefined;
      if (drained.length > 0) {
        const midTurnAbort =
          abortControllerRef.current ?? new AbortController();
        const shouldTrackMidTurnAbort = !abortControllerRef.current;
        if (shouldTrackMidTurnAbort) {
          auxiliaryAbortRefsRef.current.add(midTurnAbort);
        }
        try {
          drainedSteer = await resolveDrainedSteerMessages(
            drained,
            midTurnAbort.signal,
          );
          if (drainedSteer) {
            responsesToSend.push(...drainedSteer.parts);
          }
        } finally {
          if (shouldTrackMidTurnAbort) {
            auxiliaryAbortRefsRef.current.delete(midTurnAbort);
            midTurnAbort.abort();
          }
        }
      }

      if (continuationWasCancelled()) {
        drainedSteer?.restore();
        if (toolGoalBinding) {
          await failClosedGoalTurn(
            toolGoalBinding,
            'Goal tool continuation was cancelled',
          );
        }
        endToolInteraction('cancelled');
        return;
      }
      if (toolGoalBinding?.controller.signal.aborted) {
        drainedSteer?.restore();
        await failClosedGoalTurn(
          toolGoalBinding,
          'Goal tool continuation was preempted',
        );
        endToolInteraction('cancelled');
        return;
      }

      await submitQuery(responsesToSend, SendMessageType.ToolResult, promptId, {
        steerInput: drainedSteer,
        onDelivered: drainedSteer?.accept,
        onAdmissionFailed: () => {
          endToolInteraction(
            'error',
            'tool continuation admission failed',
            'continuation_admission_failed',
          );
        },
        onDeliveryFailed: () => {
          drainedSteer?.restore();
          endToolInteraction(
            'error',
            'tool continuation delivery failed',
            'continuation_delivery_failed',
          );
        },
        goalBinding: toolGoalBinding,
        toolContinuationOwner: continuationOwner,
      });
    },
    [
      submitQuery,
      markToolsAsSubmitted,
      llmClient,
      performMemoryRefresh,
      modelSwitchedFromQuotaError,
      config,
      midTurnDrainRef,
      addItem,
      dualOutput,
      resolveDrainedSteerMessages,
      bindGoalTurn,
      failClosedGoalTurn,
      releaseGoalTurn,
    ],
  );

  useLayoutEffect(() => {
    handleCompletedToolsRef.current = handleCompletedTools;
  }, [handleCompletedTools]);

  const pendingHistoryItems = useMemo(
    () =>
      [
        // Reasoning renders above the streaming answer.
        pendingThoughtItem,
        ...pendingAssistantItems,
        pendingToolCallGroupDisplay,
        pendingHistoryItem,
        pendingRetryErrorItem,
        pendingRetryCountdownItem,
      ].filter((i) => i !== undefined && i !== null),
    [
      pendingThoughtItem,
      pendingAssistantItems,
      pendingHistoryItem,
      pendingRetryErrorItem,
      pendingRetryCountdownItem,
      pendingToolCallGroupDisplay,
    ],
  );

  useEffect(() => {
    const saveRestorableToolCalls = async () => {
      if (!config.getFileCheckpointingEnabled()) {
        return;
      }
      const restorableToolCalls = toolCalls.filter(
        (toolCall) =>
          EDIT_TOOL_NAMES.has(toolCall.request.name) &&
          toolCall.status === 'awaiting_approval' &&
          !toolCall.request.isClientInitiated,
      );

      if (restorableToolCalls.length > 0) {
        const checkpointDir = storage.getProjectTempCheckpointsDir();

        if (!checkpointDir) {
          return;
        }

        try {
          await fs.mkdir(checkpointDir, { recursive: true });
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'EEXIST') {
            onDebugMessage(
              `Failed to create checkpoint directory: ${getErrorMessage(error)}`,
            );
            return;
          }
        }

        for (const toolCall of restorableToolCalls) {
          const filePath = (toolCall.request.args['file_path'] ??
            toolCall.request.args['notebook_path']) as string;
          if (!filePath) {
            onDebugMessage(
              `Skipping restorable tool call due to missing file_path: ${toolCall.request.name}`,
            );
            continue;
          }

          try {
            const promptId = toolCall.request.prompt_id;
            const timestamp = new Date()
              .toISOString()
              .replace(/:/g, '-')
              .replace(/\./g, '_');
            const toolName = toolCall.request.name;
            const fileName = path.basename(filePath);
            const toolCallWithSnapshotFileName = `${timestamp}-${fileName}-${toolName}.json`;
            const clientHistory = llmClient?.getHistoryShallow();
            const toolCallWithSnapshotFilePath = path.join(
              checkpointDir,
              toolCallWithSnapshotFileName,
            );

            await fs.writeFile(
              toolCallWithSnapshotFilePath,
              JSON.stringify(
                {
                  history,
                  clientHistory,
                  toolCall: {
                    name: toolCall.request.name,
                    args: toolCall.request.args,
                  },
                  promptId,
                  filePath,
                },
                null,
                2,
              ),
            );
          } catch (error) {
            onDebugMessage(
              `Failed to create checkpoint for ${filePath}: ${getErrorMessage(
                error,
              )}. This may indicate a problem with file system permissions.`,
            );
          }
        }
      }
    };
    saveRestorableToolCalls();
  }, [toolCalls, config, onDebugMessage, history, llmClient, storage]);

  // ─── Unified notification queue (cron + background agents) ──────
  const notificationQueueRef = useRef<
    Array<{
      displayText: string;
      modelText: string;
      sendMessageType: SendMessageType;
      monitor?: { id: string; status: string };
      todoWorkChainId?: string;
      onDelivered?: () => void;
      onDeliveryFailed?: () => void;
      displayed?: boolean;
    }>
  >([]);
  const [notificationTrigger, setNotificationTrigger] = useState(0);
  const goalQueuePendingCount =
    goalQueueRef?.current?.getPendingSubmissionCount?.() ?? 0;
  const claimSystemGoalTurn = useCallback((): {
    ready: boolean;
    claimGoalTurn?: () => QueuedGoalTurn | undefined;
  } => {
    if (goalQueueRef?.current?.hasQueuedUserMessages?.()) {
      return { ready: false };
    }
    let goalOwnsTurn = false;
    try {
      goalOwnsTurn = goalRequiresExactPermit(
        config.getGoalRuntime().getSnapshot(),
      );
    } catch {
      goalOwnsTurn = false;
    }
    if (!goalOwnsTurn) return { ready: true };
    if ((goalQueueRef?.current?.getPendingSubmissionCount?.() ?? 0) === 0) {
      return { ready: false };
    }
    return {
      ready: true,
      claimGoalTurn: () => {
        if (goalQueueRef?.current?.hasQueuedUserMessages?.()) return undefined;
        return goalQueueRef?.current?.claimGoalTurn?.();
      },
    };
  }, [config, goalQueueRef]);

  const getAutonomousLoopTickResolver = useCallback(() => {
    autonomousLoopTickResolverRef.current ??= new AutonomousLoopTickResolver();
    return autonomousLoopTickResolverRef.current;
  }, []);
  const notificationQueueSessionIdRef = useRef(sessionStates.sessionId);

  useEffect(() => {
    if (notificationQueueSessionIdRef.current === sessionStates.sessionId) {
      return;
    }
    notificationQueueSessionIdRef.current = sessionStates.sessionId;
    notificationQueueRef.current = [];
    autonomousLoopTickResolverRef.current?.resetCache();
  }, [sessionStates.sessionId]);

  // Current sessionId for the cron effect, read through a ref so the
  // effect doesn't list sessionId as a dep. Keeping it out of the deps is
  // deliberate: /clear swaps the sessionId mid-session, and a re-run would
  // fire the cleanup below — printing a false "loops cancelled" notice and
  // tearing down a scheduler that immediately restarts. The effect should
  // run once on mount and clean up only on real unmount.
  const cronSessionIdRef = useRef(sessionStates.sessionId);
  cronSessionIdRef.current = sessionStates.sessionId;

  // Start the cron scheduler once config is initialized, stop on unmount.
  // Cron fires enqueue onto the shared notification queue.
  // Gated on isConfigInitialized: without this gate, enableDurable() runs
  // before config.initialize() completes, and overdue-task fires delivered
  // through the notification drain reach a chat client whose startChat() has
  // not yet run — producing "Chat not initialized" on every fresh launch
  // that has pending durable work (#5022). This matches the ordering the
  // ACP (Session.ts) and headless (nonInteractiveCli.ts) paths already use.
  useEffect(() => {
    if (!isConfigInitialized) return;
    if (!config.isCronEnabled()) return;
    const scheduler = config.getCronScheduler();

    let stopped = false;
    // Await enableDurable before start so overdue fires buffer into
    // pendingFires (onFire is still null) and flush through start()'s
    // buffer-drain — matching the ACP and headless startup order.
    void (async () => {
      try {
        // Enable durable (file-backed) cron support (loads tasks from the
        // user's per-project runtime dir, acquires the lock). The tasks file
        // lives under ~/.qwen, not the working tree, so it's user-owned
        // rather than project-controlled — no folder-trust gate needed; the
        // user's own loops run regardless of how the folder is trusted.
        // Missed one-shots arrive as late fires through the start() callback.
        await scheduler.enableDurable(cronSessionIdRef.current);
      } catch (err) {
        // Fall through (no `return`): a failed enableDurable must NOT skip
        // start(), or session-only cron tasks (created via cron_create during
        // this session) would silently never fire. Only durable/persistent
        // tasks are lost when enableDurable fails. Pre-#5022 the unconditional
        // start() preserved this; keep that behavior.
        debugLogger.warn(
          `Durable cron init failed — persistent tasks will not fire in this session: ${err}`,
        );
      }
      // Unmount may have happened during the await above; the cleanup below
      // already ran scheduler.stop(), so do not (re)install onFire.
      if (stopped) return;
      scheduler.start(
        (job: {
          id?: string;
          prompt: string;
          cronExpr?: string;
          missed?: boolean;
          todoWorkChainId?: string;
        }) => {
          const source = job.cronExpr === '@wakeup' ? 'Loop' : 'Cron';
          const autonomousMode = detectAutonomousSentinel(job.prompt);
          let label = job.prompt.slice(0, 40);
          let modelText = job.prompt;
          if (autonomousMode) {
            if (job.missed) return;
            const resolver = getAutonomousLoopTickResolver();
            const tick = resolver.resolveAutonomous(autonomousMode);
            label = 'Autonomous loop tick';
            modelText = tick.modelText;
            notificationQueueRef.current.push({
              displayText: `${job.missed ? 'Missed' : source}: ${label}`,
              modelText,
              sendMessageType: SendMessageType.Cron,
              todoWorkChainId: job.todoWorkChainId,
              onDelivered: () => resolver.markDelivered(),
            });
            setNotificationTrigger((n) => n + 1);
            return;
          }
          notificationQueueRef.current.push({
            displayText: `${job.missed ? 'Missed' : source}: ${label}`,
            modelText,
            sendMessageType: SendMessageType.Cron,
            todoWorkChainId: job.todoWorkChainId,
          });
          setNotificationTrigger((n) => n + 1);
        },
      );
    })();

    return () => {
      stopped = true;
      const summary = scheduler.getExitSummary();
      scheduler.stop();
      if (summary) {
        process.stderr.write(summary + '\n');
      }
    };
  }, [config, getAutonomousLoopTickResolver, isConfigInitialized]);

  // Register background agent notification callback onto the shared queue.
  useEffect(() => {
    const registry = config.getBackgroundTaskRegistry();
    registry.setNotificationCallback((displayText, modelText, meta) => {
      notificationQueueRef.current.push({
        displayText,
        modelText,
        sendMessageType: SendMessageType.Notification,
        todoWorkChainId: meta?.todoWorkChainId,
      });
      setNotificationTrigger((n) => n + 1);
    });
    return () => {
      registry.setNotificationCallback(undefined);
    };
  }, [config]);

  // Register background shell terminal notification callback onto the shared queue.
  useEffect(() => {
    const registry = config.getBackgroundShellRegistry();
    registry.setNotificationCallback((displayText, modelText, meta) => {
      notificationQueueRef.current.push({
        displayText,
        modelText,
        sendMessageType: SendMessageType.Notification,
        todoWorkChainId: meta?.todoWorkChainId,
      });
      setNotificationTrigger((n) => n + 1);
    });
    return () => {
      registry.setNotificationCallback(undefined);
    };
  }, [config]);

  // Register background workflow completions onto the shared queue. The
  // registry keeps this separate from its terminal-bell subscriber.
  useEffect(() => {
    const registry = config.getWorkflowRunRegistry();
    registry.setCompletionCallback((displayText, modelText, meta) => {
      notificationQueueRef.current.push({
        displayText,
        modelText,
        sendMessageType: SendMessageType.Notification,
        todoWorkChainId: meta.todoWorkChainId,
      });
      setNotificationTrigger((n) => n + 1);
    });
    return () => {
      registry.setCompletionCallback(undefined);
    };
  }, [config]);

  // Register monitor notification callback onto the shared queue.
  useEffect(() => {
    const registry = config.getMonitorRegistry();
    registry.setNotificationCallback((displayText, modelText, meta) => {
      if (meta.status === 'running' && typeof registry.get === 'function') {
        const entry = registry.get(meta.monitorId);
        if (!entry || entry.status !== 'running') return;
      }
      notificationQueueRef.current.push({
        displayText,
        modelText,
        sendMessageType: SendMessageType.Notification,
        monitor: { id: meta.monitorId, status: meta.status },
        todoWorkChainId: meta.todoWorkChainId,
      });
      setNotificationTrigger((n) => n + 1);
    });
    return () => {
      registry.setNotificationCallback(undefined);
    };
  }, [config]);

  // When idle, batch-drain all contiguous same-type notifications from the
  // front of the queue into a single API call. This reduces token waste: N
  // notifications that accumulate while the model is busy become 1 roundtrip
  // instead of N sequential ones. Skip when another submission is in flight
  // (e.g. the teammate drain effect won this render) — the queue stays
  // intact and the effect will re-fire when streamingState returns to Idle.
  useEffect(() => {
    if (
      streamingState === StreamingState.Idle &&
      !isSubmittingQueryRef.current &&
      notificationQueueRef.current.length > 0
    ) {
      // Consumer-side guard for #7156: this effect can run on a render pass
      // that React batched together with progress setState calls issued from
      // INSIDE a subagent's AsyncLocalStorage frame, in which case the whole
      // synchronous effect stack — and every async continuation submitQuery
      // starts — inherits the subagent's runtime view, and the notification
      // turn resolves Config.getModel() to the SUBAGENT's model. Exiting the
      // frame here guarantees the drained turn always runs on the main
      // session's configuration, regardless of which producer's setState
      // triggered the commit.
      runOutsideAgentContext(() => {
        const admission = claimSystemGoalTurn();
        if (!admission.ready) return;
        const queue = notificationQueueRef.current;
        const monitorRegistry = config.getMonitorRegistry();
        for (let i = queue.length - 1; i >= 0; i--) {
          const monitor = queue[i]!.monitor;
          if (
            monitor?.status === 'running' &&
            monitorRegistry.get(monitor.id)?.status === 'cancelled'
          ) {
            queue.splice(i, 1);
          }
        }
        if (queue.length === 0) {
          return;
        }
        const targetType = queue[0]!.sendMessageType;

        // Cron prompts must run as individual turns — each needs its own
        // slash/shell/@ preprocessing and approval cycle. Only batch
        // Notification items (which pass through without preprocessing).
        if (targetType === SendMessageType.Cron) {
          const item = queue.shift()!;
          if (!item.displayed) {
            addItem(
              { type: 'notification' as const, text: item.displayText },
              Date.now(),
            );
            item.displayed = true;
          }
          void submitQuery(item.modelText, item.sendMessageType, undefined, {
            notificationDisplayText: item.displayText,
            todoWorkChainId: item.todoWorkChainId,
            onDelivered: item.onDelivered,
            onDeliveryFailed: item.onDeliveryFailed,
            onAdmissionFailed: () => {
              queue.unshift(item);
            },
            claimGoalTurn: admission.claimGoalTurn,
            onGoalClaimDeferred: () => {
              queue.unshift(item);
              setNotificationTrigger((n) => n + 1);
            },
          }).catch((error) => {
            debugLogger.warn('Failed to admit cron notification', error);
          });
          return;
        }

        // Drain contiguous leading Notification items into one batch.
        let splitIdx = 0;
        while (
          splitIdx < queue.length &&
          queue[splitIdx]!.sendMessageType === targetType &&
          queue[splitIdx]!.todoWorkChainId === queue[0]!.todoWorkChainId
        ) {
          splitIdx++;
        }
        const batch = queue.splice(0, splitIdx);

        const now = Date.now();
        for (const item of batch) {
          if (!item.displayed) {
            addItem(
              { type: 'notification' as const, text: item.displayText },
              now,
            );
            item.displayed = true;
          }
        }

        const combinedModelText = batch.map((e) => e.modelText).join('\n\n');
        const combinedDisplayText = batch.map((e) => e.displayText).join('; ');
        void submitQuery(combinedModelText, targetType, undefined, {
          notificationDisplayText: combinedDisplayText,
          todoWorkChainId: batch[0]?.todoWorkChainId,
          onAdmissionFailed: () => {
            queue.unshift(...batch);
          },
          claimGoalTurn: admission.claimGoalTurn,
          onGoalClaimDeferred: () => {
            queue.unshift(...batch);
            setNotificationTrigger((n) => n + 1);
          },
        }).catch((error) => {
          debugLogger.warn('Failed to admit background notification', error);
        });
      });
    }
  }, [
    streamingState,
    submitQuery,
    notificationTrigger,
    addItem,
    config,
    claimSystemGoalTurn,
    goalQueuePendingCount,
  ]);

  // ─── Teammate message integration ─────────────────────────
  // Each entry carries the full nonce-tagged envelope (`modelText`,
  // sent to the leader's model) and a compact `display` line (shown
  // to the user in its place) — the same two-text split the unified
  // notification queue uses, so teammate reports no longer dump the
  // whole raw envelope into the conversation as a user bubble.
  const teammateQueueRef = useRef<
    Array<{ modelText: string; display: string; displayed?: boolean }>
  >([]);
  const [teammateTrigger, setTeammateTrigger] = useState(0);

  // Subscribe to TeamManager's leader message callback.
  // Track the bound manager so we can detach the callback
  // before a new manager replaces it (and on unmount) —
  // otherwise a stale TeamManager could keep pushing into
  // the active queue ref after team recreation/remount.
  useEffect(() => {
    let boundManager: import('@qwen-code/qwen-code-core').TeamManager | null =
      null;
    const handleManagerChange = (
      manager: import('@qwen-code/qwen-code-core').TeamManager | null,
    ) => {
      if (boundManager && boundManager !== manager) {
        boundManager.setLeaderMessageCallback(null);
        // Drop any messages the old team's teammates queued but that
        // weren't drained before the swap — they belong to a team that
        // no longer exists and must not be submitted into the new
        // team's session. Only fires on a genuine manager swap; a React
        // remount re-binds the same manager (boundManager is null here)
        // and preserves the queue.
        teammateQueueRef.current.length = 0;
      }
      boundManager = manager;
      if (manager) {
        manager.setLeaderMessageCallback(
          (modelText: string, display: string) => {
            teammateQueueRef.current.push({ modelText, display });
            setTeammateTrigger((n) => n + 1);
          },
        );
      }
    };

    config.onTeamManagerChange(handleManagerChange);

    // Catch manager that was set before this effect ran
    const current = config.getTeamManager();
    if (current) {
      handleManagerChange(current);
    }

    return () => {
      config.onTeamManagerChange(null, handleManagerChange);
      if (boundManager) {
        boundManager.setLeaderMessageCallback(null);
        boundManager = null;
      }
    };
  }, [config]);

  // When idle, drain teammate messages one batch at a time.
  // Skip when another submission is in flight (e.g. the
  // notification effect won this render and called submitQuery
  // synchronously, flipping isSubmittingQueryRef). Without this
  // guard the splice would drain the queue and submitQuery
  // would early-return, permanently losing those messages.
  useEffect(() => {
    if (
      streamingState === StreamingState.Idle &&
      !isSubmittingQueryRef.current &&
      teammateQueueRef.current.length > 0
    ) {
      // React can flush this effect after restoring the teammate frame.
      runOutsideAgentContext(() => {
        const admission = claimSystemGoalTurn();
        if (!admission.ready) return;
        const batch = teammateQueueRef.current.splice(0);
        // Render one compact `● …` line per teammate report; the full
        // envelope goes only to the model (the USER bubble is suppressed
        // for SendMessageType.Teammate in prepareQueryForLlm).
        for (const entry of batch) {
          if (!entry.displayed) {
            addItem(
              { type: 'notification' as const, text: entry.display },
              Date.now(),
            );
            entry.displayed = true;
          }
        }
        const modelText = batch.map((e) => e.modelText).join('\n\n');
        const display = batch.map((e) => e.display).join('; ');
        void submitQuery(modelText, SendMessageType.Teammate, undefined, {
          notificationDisplayText: display,
          onAdmissionFailed: () => {
            teammateQueueRef.current.unshift(...batch);
          },
          claimGoalTurn: admission.claimGoalTurn,
          onGoalClaimDeferred: () => {
            teammateQueueRef.current.unshift(...batch);
            setTeammateTrigger((n) => n + 1);
          },
        }).catch((error) => {
          debugLogger.warn('Failed to admit teammate notification', error);
        });
      });
    }
  }, [
    streamingState,
    submitQuery,
    teammateTrigger,
    addItem,
    claimSystemGoalTurn,
    goalQueuePendingCount,
  ]);

  return {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems,
    clearPendingState,
    thought,
    cancelOngoingRequest,
    preemptGoalTurn,
    retryLastPrompt,
    pendingToolCalls: toolCalls,
    handleApprovalModeChange,
    activePtyId,
    loopDetectionConfirmationRequest,
    streamingResponseLengthRef,
    isReceivingContent,
  };
};
