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
  type Config,
  type EditorType,
  type GeminiClient,
  type Logger,
  type RetryInfo,
  type ServerGeminiChatCompressedEvent,
  type ServerGeminiContentEvent as ContentEvent,
  type ServerGeminiFinishedEvent,
  type ServerGeminiStreamEvent as GeminiEvent,
  type ThoughtSummary,
  type ToolCallRequestInfo,
  type GeminiErrorEventValue,
  type StopFailureErrorType,
  type ActiveGoal,
  type VisionBridgeResult,
  GeminiEventType as ServerGeminiEventType,
  SendMessageType,
  createDebugLogger,
  ToolNames,
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
  isSupportedImageMimeType,
  getUnsupportedImageFormatWarning,
  runVisionBridge,
  hasImageParts,
  generateToolUseSummary,
  getActiveGoal,
  activeGoalEquals,
  setActiveGoal,
  clearActiveGoal,
  formatOmittedReasons,
  createDuplicateProviderToolCallResponse,
} from '@qwen-code/qwen-code-core';
import { type Part, type PartListUnion, FinishReason } from '@google/genai';
import type {
  HistoryItem,
  HistoryItemGoalStatus,
  HistoryItemWithoutId,
  HistoryItemToolGroup,
  SlashCommandProcessorResult,
} from '../types.js';
import { StreamingState, MessageType, ToolCallStatus } from '../types.js';
import {
  isAtCommand,
  isBtwCommand,
  isSlashCommand,
} from '../utils/commandUtils.js';
import { useShellCommandProcessor } from './shellCommandProcessor.js';
import {
  handleAtCommand,
  resolveAtCommandQuery,
} from './atCommandProcessor.js';
import { findLastSafeSplitPoint } from '../utils/markdownUtilities.js';
import { useStateAndRef } from './useStateAndRef.js';
import { prefixMidTurnUserMessageParts } from '../../utils/midTurnUserMessage.js';
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
import { recordGoalStatusItem } from '../utils/restoreGoal.js';
import process from 'node:process';

const debugLogger = createDebugLogger('GEMINI_STREAM');
const MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MS = 10_000;
const MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MESSAGE =
  'Mid-turn @ command resolution timed out';
const VISION_BRIDGE_TRANSCRIPT_NOTICE_LIMIT = 2048;
const NOTICE_CONTROL_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

interface PendingDuplicateToolResponses {
  executableCallIds: Set<string>;
  promptId: string | undefined;
  responseParts: Part[];
}

function formatVisionBridgeNoticeLabel(label: string): string {
  return (
    label
      .replace(/\r\n?|[\u2028\u2029]/g, ' ')
      .replace(NOTICE_CONTROL_CHARS, '')
      .replace(/\s+/g, ' ')
      .trim() || 'vision model'
  );
}

function truncateVisionBridgeTranscript(transcript: string): string {
  if (transcript.length <= VISION_BRIDGE_TRANSCRIPT_NOTICE_LIMIT) {
    return transcript;
  }
  return `${transcript
    .slice(0, VISION_BRIDGE_TRANSCRIPT_NOTICE_LIMIT)
    .trimEnd()}\n[Transcript truncated]`;
}

/**
 * Build the user-facing notice shown when the vision bridge runs. On success it
 * states which model was used, how many images were converted (and omitted),
 * notes the data egress, and includes the generated transcription so the user
 * can catch misreads. On failure it surfaces the reason.
 *
 * @param result The structured result returned by the vision bridge.
 * @returns A multi-line notice string for the message history.
 */
function formatVisionBridgeNotice(result: VisionBridgeResult): string {
  const modelName = formatVisionBridgeNoticeLabel(
    result.modelId ?? 'vision model',
  );
  const target = result.modelEndpoint
    ? `${modelName} (${formatVisionBridgeNoticeLabel(result.modelEndpoint)})`
    : modelName;
  if (result.status === 'failed') {
    const egress = result.egressOccurred
      ? ` Your image and prompt/context were sent to ${target}.`
      : '';
    return `⚠ Vision bridge (${modelName}) failed: ${
      result.error ?? 'unknown error'
    }.${egress} The image was not interpreted.`;
  }
  if (result.status === 'skipped') {
    return `🔎 Vision bridge cancelled. Your image and prompt/context were sent to ${target}.`;
  }
  const omittedReasons = formatOmittedReasons(
    result.omittedInvalidCount,
    result.omittedCappedCount,
  );
  const omitted = omittedReasons ? ` (${omittedReasons})` : '';
  // The egress disclosure is always shown. Name the endpoint too - cross-provider
  // auto-select can route to a different
  // host than the primary model.
  const header = `🔎 Converted ${result.convertedCount} image(s)${omitted} to text via ${target}. Your image and prompt/context were sent to that model.`;
  return result.transcript
    ? `${header}\n${truncateVisionBridgeTranscript(result.transcript)}`
    : header;
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
 * Classify API error to StopFailureErrorType
 * @internal Exported for testing purposes
 */
export function classifyApiError(error: {
  message: string;
  status?: number;
}): StopFailureErrorType {
  const status = error.status;
  const message = error.message?.toLowerCase() ?? '';

  if (status === 429 || message.includes('rate limit')) {
    return 'rate_limit';
  }
  if (status === 401 || message.includes('unauthorized')) {
    return 'authentication_failed';
  }
  if (
    status === 402 ||
    status === 403 ||
    message.includes('billing') ||
    message.includes('quota')
  ) {
    return 'billing_error';
  }
  if (status === 400 || message.includes('invalid')) {
    return 'invalid_request';
  }
  if (status !== undefined && status >= 500) {
    return 'server_error';
  }
  if (message.includes('max_tokens') || message.includes('token limit')) {
    return 'max_output_tokens';
  }
  return 'unknown';
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

const EDIT_TOOL_NAMES = new Set([
  ToolNames.EDIT,
  'replace', // legacy alias, may still arrive from older providers
  ToolNames.WRITE_FILE,
  ToolNames.NOTEBOOK_EDIT,
]);
const STREAM_UPDATE_THROTTLE_MS = 60;
const STREAM_PENDING_ITEM_MAX_CHARS = 16_384;
const LOADING_THOUGHT_DESCRIPTION_MAX_CHARS = 4_096;

type BufferedStreamEvent =
  | { kind: 'content'; value: string }
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
  lastTurnUserItem: { id: number; text: string } | null;
  /**
   * True if a content event landed during this turn, including during
   * the pre-cancel flush of throttle-buffered events. Lets the
   * auto-restore guard reject a turn that produced meaningful text even
   * when the consumer's React history snapshot is still stale.
   */
  turnProducedMeaningfulContent: boolean;
}

/**
 * Manages the Gemini stream, including user input, command processing,
 * API interaction, and tool call lifecycle.
 */
export const useGeminiStream = (
  geminiClient: GeminiClient,
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
  midTurnDrainRef?: React.RefObject<(() => string[]) | null>,
  logger?: Logger | null,
) => {
  const [initError, setInitError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const flushBufferedStreamEventsRef = useRef<Set<() => void>>(new Set());
  const turnCancelledRef = useRef(false);
  const isSubmittingQueryRef = useRef(false);
  const lastPromptRef = useRef<PartListUnion | null>(null);
  // Records the USER history item that THIS turn's prepareQueryForGemini
  // added (if any). Reset to null at the start of every turn (including
  // Retry, which bypasses prepareQueryForGemini). Cron / Notification /
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
  const lastTurnUserItemRef = useRef<{ id: number; text: string } | null>(null);
  // Set to true the first time a content event lands this turn — even
  // during the pre-cancel flush. AppContainer's auto-restore guard
  // can't otherwise see content that was just addItem'd inside flush
  // (React history hasn't re-rendered) and would wrongly truncate the
  // committed text alongside the cancelled prompt. Reset at turn start
  // alongside lastTurnUserItemRef.
  const turnSawContentEventRef = useRef(false);
  const lastPromptErroredRef = useRef(false);
  const dualOutput = useDualOutput();
  const [isResponding, setIsResponding] = useState<boolean>(false);
  // React state can lag by one render; this tracks the actual stream lifetime.
  const activeModelStreamsRef = useRef(0);
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
  const retryCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const processedMemoryToolsRef = useRef<Set<string>>(new Set());
  const submitPromptOnCompleteRef = useRef<(() => Promise<void>) | null>(null);
  const modelOverrideRef = useRef<string | undefined>(undefined);
  const handledProviderToolCallIdsRef = useRef<Set<string>>(new Set());
  const pendingDuplicateToolResponsesRef = useRef<
    PendingDuplicateToolResponses[]
  >([]);
  const immediateDuplicateToolResponsesRef = useRef<{
    promptId: string | undefined;
    responseParts: Part[];
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

  const [toolCalls, scheduleToolCalls, markToolsAsSubmitted] =
    useReactToolScheduler(
      async (completedToolCallsFromScheduler) => {
        // This onComplete is called when ALL scheduled tools for a given batch are done.
        if (completedToolCallsFromScheduler.length > 0) {
          const projectRoot = config.getProjectRoot();
          // Add the final state of these tools to the history for display.
          const toolGroupDisplay = mapTrackedToolCallsToDisplay(
            completedToolCallsFromScheduler as TrackedToolCall[],
            projectRoot,
          );
          addItem(toolGroupDisplay, Date.now());

          // Handle tool response submission immediately when tools complete
          await handleCompletedTools(
            completedToolCallsFromScheduler as TrackedToolCall[],
          );
        }
      },
      config,
      getPreferredEditor,
      onEditorClose,
    );

  const pendingToolCallGroupDisplay = useMemo(
    () =>
      toolCalls.length
        ? mapTrackedToolCallsToDisplay(toolCalls, config.getProjectRoot())
        : undefined,
    [toolCalls, config],
  );

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
    geminiClient,
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
              .responseSubmittedToGemini),
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
      const lastUserMessageIndex = history.findLastIndex(
        (item: HistoryItem) => item.type === MessageType.USER,
      );

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
    if (streamingState !== StreamingState.Responding) {
      return;
    }
    if (turnCancelledRef.current) {
      return;
    }
    // Flush throttled stream chunks FIRST so anything sitting in the
    // per-turn bufferedEvents lands on `pendingHistoryItemRef.current`
    // before we snapshot. Snapshotting before flush would miss content
    // events that arrived inside the throttle window
    // (STREAM_UPDATE_THROTTLE_MS), making AppContainer's auto-restore
    // wrongly conclude the model produced nothing — and the subsequent
    // addItem(pendingHistoryItemRef.current) below would commit content
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
    isSubmittingQueryRef.current = false;
    abortControllerRef.current?.abort();
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
      config.getModel(),
      prompt_id,
      config.getContentGeneratorConfig()?.authType,
    );
    logApiCancel(config, cancellationEvent);

    if (pendingHistoryItemRef.current) {
      addItem(pendingHistoryItemRef.current, Date.now());
    }
    addItem(
      {
        type: MessageType.INFO,
        text: 'Request cancelled.',
      },
      Date.now(),
    );
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
        turnProducedMeaningfulContent: turnSawContentEventRef.current,
      });
    } finally {
      setIsResponding(false);
      setShellInputFocused(false);
    }
  }, [
    streamingState,
    addItem,
    setPendingHistoryItem,
    onCancelSubmit,
    pendingHistoryItemRef,
    setShellInputFocused,
    clearRetryCountdown,
    config,
    getPromptCount,
  ]);

  const prepareQueryForGemini = useCallback(
    async (
      query: PartListUnion,
      userMessageTimestamp: number,
      abortSignal: AbortSignal,
      prompt_id: string,
      submitType: SendMessageType,
    ): Promise<{
      queryToSend: PartListUnion | null;
      shouldProceed: boolean;
    }> => {
      if (turnCancelledRef.current) {
        return { queryToSend: null, shouldProceed: false };
      }
      if (typeof query === 'string' && query.trim().length === 0) {
        return { queryToSend: null, shouldProceed: false };
      }

      // Reset at turn start. Only the user-typed-text path below assigns
      // this — paths that don't add a USER history item (Cron /
      // Notification / slash submit_prompt) leave it null so cancel
      // never wrongly targets an older user item.
      lastTurnUserItemRef.current = null;

      let localQueryToSendToGemini: PartListUnion | null = null;

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
              scheduleToolCalls([toolCallRequest], abortSignal);
              return { queryToSend: null, shouldProceed: false };
            }
            case 'submit_prompt': {
              localQueryToSendToGemini = slashCommandResult.content;
              submitPromptOnCompleteRef.current =
                slashCommandResult.onComplete ?? null;

              return {
                queryToSend: localQueryToSendToGemini,
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

        localQueryToSendToGemini = trimmedQuery;

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
          lastTurnUserItemRef.current = {
            id: insertedId,
            text: trimmedQuery,
          };
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
          localQueryToSendToGemini = atCommandResult.processedQuery;
        }

        // Vision bridge: convert images to text only when the primary model is
        // known text-only and the resolved query actually carries image parts.
        const effectiveInputModalities = config.getEffectiveInputModalities?.();
        const visionBridgeModel = config.getDefaultVisionBridgeModel?.();
        if (
          visionBridgeModel !== undefined &&
          localQueryToSendToGemini !== null &&
          hasImageParts(localQueryToSendToGemini) &&
          effectiveInputModalities?.image !== true
        ) {
          debugLogger.debug('vision bridge: gate matched, running conversion');
          const bridgeResult = await runVisionBridge({
            config,
            parts: localQueryToSendToGemini,
            signal: abortSignal,
          });
          debugLogger.debug(
            `vision bridge: status=${bridgeResult.status} applied=${bridgeResult.applied} model=${bridgeResult.modelId ?? '(none)'}`,
          );
          // Always surface one notice: egress disclosure on success, reason on
          // failure, and egress disclosure after cancellation if data was sent.
          if (
            bridgeResult.status !== 'skipped' ||
            bridgeResult.egressOccurred
          ) {
            addItem(
              {
                type:
                  bridgeResult.status === 'failed'
                    ? MessageType.ERROR
                    : MessageType.INFO,
                text: formatVisionBridgeNotice(bridgeResult),
              },
              userMessageTimestamp,
            );
          }
          if (abortSignal.aborted) {
            return { queryToSend: null, shouldProceed: false };
          }
          if (bridgeResult.applied && bridgeResult.parts != null) {
            localQueryToSendToGemini = bridgeResult.parts;
          } else if (bridgeResult.status === 'failed') {
            // Defensive fallback for legacy/invalid failed results without
            // transformed text. Current failures include a no-image note.
            return { queryToSend: null, shouldProceed: false };
          }
        }
      } else {
        // It's a function response (PartListUnion that isn't a string)
        localQueryToSendToGemini = query;
      }

      if (localQueryToSendToGemini === null) {
        onDebugMessage(
          'Query processing resulted in null, not sending to Gemini.',
        );
        return { queryToSend: null, shouldProceed: false };
      }
      return { queryToSend: localQueryToSendToGemini, shouldProceed: true };
    },
    [
      config,
      addItem,
      onDebugMessage,
      handleShellCommand,
      handleSlashCommand,
      logger,
      shellModeActive,
      scheduleToolCalls,
    ],
  );

  // --- Stream Event Handlers ---

  const handleContentEvent = useCallback(
    (
      eventValue: ContentEvent['value'],
      currentGeminiMessageBuffer: string,
      userMessageTimestamp: number,
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
      let newGeminiMessageBuffer = currentGeminiMessageBuffer + eventValue;
      if (
        pendingHistoryItemRef.current?.type !== 'gemini' &&
        pendingHistoryItemRef.current?.type !== 'gemini_content'
      ) {
        if (newGeminiMessageBuffer.trim().length === 0) {
          return newGeminiMessageBuffer;
        }
        if (pendingHistoryItemRef.current) {
          addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        }
        setPendingHistoryItem({ type: 'gemini', text: '' });
        newGeminiMessageBuffer = stripLeadingBlankLines(newGeminiMessageBuffer);
      }
      // Split large messages for better rendering performance. Ideally,
      // we should maximize the amount of output sent to <Static />.
      let nextPendingType = pendingHistoryItemRef.current?.type as
        | 'gemini'
        | 'gemini_content';
      while (newGeminiMessageBuffer.length > STREAM_PENDING_ITEM_MAX_CHARS) {
        const splitPoint = findLastSafeSplitPoint(
          newGeminiMessageBuffer,
          STREAM_PENDING_ITEM_MAX_CHARS,
        );
        const safeSplitPoint =
          splitPoint > 0 && splitPoint < newGeminiMessageBuffer.length
            ? splitPoint
            : STREAM_PENDING_ITEM_MAX_CHARS;

        // This indicates that we need to split up this Gemini Message.
        // Splitting a message is primarily a performance consideration. There is a
        // <Static> component at the root of App.tsx which takes care of rendering
        // content statically or dynamically. Everything but the last message is
        // treated as static in order to prevent re-rendering an entire message history
        // multiple times per-second (as streaming occurs). Prior to this change you'd
        // see heavy flickering of the terminal. This ensures that larger messages get
        // broken up so that there are more "statically" rendered.
        const beforeText = newGeminiMessageBuffer.substring(0, safeSplitPoint);
        const afterText = newGeminiMessageBuffer.substring(safeSplitPoint);
        addItem(
          {
            type: nextPendingType,
            text: beforeText,
          },
          userMessageTimestamp,
        );
        nextPendingType = 'gemini_content';
        newGeminiMessageBuffer = afterText;
      }
      // Update the existing message with accumulated content.
      setPendingHistoryItem({
        type: nextPendingType,
        text: newGeminiMessageBuffer,
      });
      return newGeminiMessageBuffer;
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem],
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
        const beforeText = newThoughtBuffer.substring(0, safeSplitPoint);
        const afterText = newThoughtBuffer.substring(safeSplitPoint);
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
          addItem(pendingHistoryItemRef.current, userMessageTimestamp);
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
      pendingHistoryItemRef,
      setPendingHistoryItem,
      setThought,
      clearRetryCountdown,
    ],
  );

  const handleErrorEvent = useCallback(
    (eventValue: GeminiErrorEventValue, userMessageTimestamp: number) => {
      lastPromptErroredRef.current = true;
      // Persist any streamed reasoning (collapsed) above the error.
      commitPendingThought(userMessageTimestamp);
      if (pendingHistoryItemRef.current) {
        addItem(pendingHistoryItemRef.current, userMessageTimestamp);
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
        const retryHint = t('Press Ctrl+Y to retry');
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
      addItem,
      commitPendingThought,
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
        addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      addItem({ type: MessageType.INFO, text }, userMessageTimestamp);
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem, settings],
  );

  const handleFinishedEvent = useCallback(
    (event: ServerGeminiFinishedEvent, userMessageTimestamp: number) => {
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
            text: `⚠️  ${message}`,
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

  const handleChatCompressionEvent = useCallback(
    (
      eventValue: ServerGeminiChatCompressedEvent['value'],
      userMessageTimestamp: number,
    ) => {
      if (pendingHistoryItemRef.current) {
        addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      const reasonClause =
        eventValue?.triggerReason === 'image_overflow'
          ? `accumulated enough tool screenshots to trigger compaction for ${config.getModel()}`
          : `approached the input token limit for ${config.getModel()}`;
      return addItem(
        {
          type: 'info',
          text:
            `IMPORTANT: This conversation ${reasonClause}. ` +
            `A compressed context will be sent for future messages (compressed from: ` +
            `${eventValue?.originalTokenCount ?? 'unknown'} to ` +
            `${eventValue?.newTokenCount ?? 'unknown'} tokens).`,
        },
        Date.now(),
      );
    },
    [addItem, config, pendingHistoryItemRef, setPendingHistoryItem],
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
            `🚫 Session token limit exceeded: ${value.currentTokens.toLocaleString()} tokens > ${value.limit.toLocaleString()} limit.\n\n` +
            `💡 Solutions:\n` +
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
        config.getGeminiClient().getLoopDetectionService().disableForSession();
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
        addItem(pendingHistoryItemRef.current, userMessageTimestamp);
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
    [addItem, pendingHistoryItemRef, setPendingHistoryItem],
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
        addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        setPendingHistoryItem(null);
      }
      // When the active loop is driven by `/goal`, replace the generic
      // "Ran N stop hooks" chip with a goal-aware `goal_status`
      // `kind:'checking'` item. A not-met judge is the expected outcome of a
      // continuation, not a hook failure.
      const activeGoal = getActiveGoal(config.getSessionId());
      if (activeGoal && activeGoal.condition) {
        const item: HistoryItemGoalStatus = {
          type: MessageType.GOAL_STATUS,
          kind: 'checking',
          condition: activeGoal.condition,
          iterations: activeGoal.iterations,
          lastReason:
            activeGoal.lastReason ?? value.reasons[value.reasons.length - 1],
        };
        addItem(item, userMessageTimestamp);
        recordGoalStatusItem(config, item);
        return;
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
    [addItem, config, pendingHistoryItemRef, setPendingHistoryItem],
  );

  const handleActiveGoalEvent = useCallback(
    (activeGoal: ActiveGoal | null) => {
      const sessionId = config.getSessionId();
      const currentActiveGoal = getActiveGoal(sessionId);
      if (activeGoal) {
        if (activeGoalEquals(currentActiveGoal, activeGoal)) {
          return;
        }
        setActiveGoal(sessionId, activeGoal);
        return;
      }
      if (!currentActiveGoal) {
        return;
      }
      clearActiveGoal(sessionId);
    },
    [config],
  );

  const processGeminiStreamEvents = useCallback(
    async (
      stream: AsyncIterable<GeminiEvent>,
      userMessageTimestamp: number,
      signal: AbortSignal,
    ): Promise<StreamProcessingStatus> => {
      let geminiMessageBuffer = '';
      let thoughtBuffer = '';
      const toolCallRequests: ToolCallRequestInfo[] = [];
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

            geminiMessageBuffer = handleContentEvent(
              contentParts.join(''),
              geminiMessageBuffer,
              userMessageTimestamp,
            );
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
          dualOutput?.processEvent(event);
          switch (event.type) {
            case ServerGeminiEventType.Thought:
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
            case ServerGeminiEventType.Content:
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
              bufferedEvents.push({ kind: 'content', value: event.value });
              scheduleBufferedStreamFlush();
              break;
            case ServerGeminiEventType.ToolCallRequest:
              // Thinking is done once a tool call is issued; flush buffered
              // reasoning then commit it to history (collapsed) above the tool
              // output.
              flushBufferedStreamEvents();
              commitPendingThought(userMessageTimestamp);
              thoughtBuffer = '';
              setThought((prev) => (prev ? null : prev));
              toolCallRequests.push(event.value);
              // Count tool call args JSON toward token estimation.
              try {
                const argsJson = JSON.stringify(event.value.args);
                streamingResponseLengthRef.current += argsJson.length;
              } catch {
                // Best-effort — don't block on serialization errors
              }
              break;
            case ServerGeminiEventType.UserCancelled:
              flushBufferedStreamEvents();
              toolCallRequests.length = 0;
              handleUserCancelledEvent(userMessageTimestamp);
              break;
            case ServerGeminiEventType.Error:
              flushBufferedStreamEvents();
              handleErrorEvent(event.value, userMessageTimestamp);
              break;
            case ServerGeminiEventType.ChatCompressed:
              flushBufferedStreamEvents();
              handleChatCompressionEvent(event.value, userMessageTimestamp);
              break;
            case ServerGeminiEventType.ToolCallConfirmation:
            case ServerGeminiEventType.ToolCallResponse:
              flushBufferedStreamEvents();
              break;
            case ServerGeminiEventType.MaxSessionTurns:
              flushBufferedStreamEvents();
              handleMaxSessionTurnsEvent();
              break;
            case ServerGeminiEventType.SessionTokenLimitExceeded:
              flushBufferedStreamEvents();
              handleSessionTokenLimitExceededEvent(event.value);
              break;
            case ServerGeminiEventType.Finished:
              flushBufferedStreamEvents();
              // A thinking-only turn (no content/tool) still commits its
              // reasoning so it persists collapsed in history.
              commitPendingThought(userMessageTimestamp);
              handleFinishedEvent(
                event as ServerGeminiFinishedEvent,
                userMessageTimestamp,
              );
              // Seal off this turn's UI state before the parent re-enters
              // sendMessageStream for a continuation (Stop-hook block at
              // client.ts:1378 or next-speaker auto-continue at 1444). Both
              // paths yield* a fresh Turn through this same stream processor,
              // so without this seal the next turn's first content/thought
              // chunk appends to this turn's pending item — visible in the UI
              // as "t" → "te" → "tes" cumulative rendering even though each
              // turn is persisted as a clean, separate assistant message.
              if (pendingHistoryItemRef.current) {
                addItem(pendingHistoryItemRef.current, userMessageTimestamp);
                setPendingHistoryItem(null);
              }
              geminiMessageBuffer = '';
              thoughtBuffer = '';
              setThought(null);
              break;
            case ServerGeminiEventType.Citation:
              flushBufferedStreamEvents();
              handleCitationEvent(event.value, userMessageTimestamp);
              break;
            case ServerGeminiEventType.LoopDetected:
              flushBufferedStreamEvents();
              // handle later because we want to move pending history to history
              // before we add loop detected message to history
              loopDetectedRef.current = true;
              break;
            case ServerGeminiEventType.Retry:
              // On fresh restart (escalation / rate-limit / invalid stream),
              // clear pending content and buffers to discard the failed attempt.
              // On continuation (recovery), keep the pending gemini item AND
              // buffers so the model's continuation text appends to them —
              // otherwise handleContentEvent would see a null pending item,
              // create a fresh one, and reset the buffer to just the new chunk,
              // losing the partial text we meant to preserve.
              if (!event.isContinuation) {
                discardBufferedStreamEvents();
                if (pendingHistoryItemRef.current) {
                  setPendingHistoryItem(null);
                }
                commitPendingThought(userMessageTimestamp);
                thoughtBuffer = '';
                setThought(null);
                geminiMessageBuffer = '';
              } else {
                flushBufferedStreamEvents();
              }
              // Always discard tool call requests from the truncated/failed
              // attempt to prevent duplicate execution after escalation or
              // recovery. The recovery path now skips turns that already
              // contain a functionCall (see geminiChat.ts), so this only
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
            case ServerGeminiEventType.HookSystemMessage:
              flushBufferedStreamEvents();
              // Display system message from Stop hooks with "Stop says:" prefix
              // First commit any pending AI response to ensure correct ordering
              if (pendingHistoryItemRef.current) {
                addItem(pendingHistoryItemRef.current, userMessageTimestamp);
                setPendingHistoryItem(null);
              }
              addItem(
                {
                  type: 'stop_hook_system_message',
                  message: event.value,
                } as HistoryItemWithoutId,
                userMessageTimestamp,
              );
              break;
            case ServerGeminiEventType.UserPromptSubmitBlocked:
              flushBufferedStreamEvents();
              handleUserPromptSubmitBlockedEvent(
                event.value,
                userMessageTimestamp,
              );
              break;
            case ServerGeminiEventType.StopHookLoop:
              flushBufferedStreamEvents();
              handleStopHookLoopEvent(event.value, userMessageTimestamp);
              break;
            case ServerGeminiEventType.ActiveGoal:
              handleActiveGoalEvent(event.value);
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
      }
      dualOutput?.finalizeAssistantMessage();
      if (toolCallRequests.length > 0 && !signal.aborted) {
        const executableToolCallRequests: ToolCallRequestInfo[] = [];
        const duplicateResponseParts: Part[] = [];
        let duplicatePromptId: string | undefined;
        const historyCallIdsWithResponse: Set<string> = geminiClient
          ? geminiClient.getHistoryFunctionResponseIds()
          : new Set<string>();

        for (const request of toolCallRequests) {
          const providerCallId = request.providerCallId;
          if (!providerCallId) {
            executableToolCallRequests.push(request);
            continue;
          }

          if (
            handledProviderToolCallIdsRef.current.has(providerCallId) ||
            historyCallIdsWithResponse.has(providerCallId)
          ) {
            const response = createDuplicateProviderToolCallResponse(request);
            debugLogger.debug(
              `[processGeminiStreamEvents] Suppressing duplicate provider tool-call id: ${providerCallId} (tool: ${request.name})`,
            );
            dualOutput?.emitToolResult(request, response);
            duplicateResponseParts.push(...response.responseParts);
            duplicatePromptId ??= request.prompt_id;
            continue;
          }

          handledProviderToolCallIdsRef.current.add(providerCallId);
          executableToolCallRequests.push(request);
        }

        if (duplicateResponseParts.length > 0) {
          if (executableToolCallRequests.length > 0) {
            pendingDuplicateToolResponsesRef.current.push({
              executableCallIds: new Set(
                executableToolCallRequests.map((request) => request.callId),
              ),
              promptId:
                duplicatePromptId ?? executableToolCallRequests[0]?.prompt_id,
              responseParts: duplicateResponseParts,
            });
          } else {
            immediateDuplicateToolResponsesRef.current = {
              promptId: duplicatePromptId,
              responseParts: duplicateResponseParts,
            };
          }
        }

        if (executableToolCallRequests.length > 0) {
          scheduleToolCalls(executableToolCallRequests, signal);
        }
      }
      return StreamProcessingStatus.Completed;
    },
    [
      handleContentEvent,
      handleThoughtEvent,
      handleUserCancelledEvent,
      handleErrorEvent,
      scheduleToolCalls,
      geminiClient,
      handleChatCompressionEvent,
      handleFinishedEvent,
      handleMaxSessionTurnsEvent,
      handleSessionTokenLimitExceededEvent,
      handleCitationEvent,
      startRetryCountdown,
      clearRetryCountdown,
      setThought,
      commitPendingThought,
      pendingHistoryItemRef,
      pendingThoughtItemRef,
      setPendingHistoryItem,
      handleUserPromptSubmitBlockedEvent,
      handleStopHookLoopEvent,
      handleActiveGoalEvent,
      addItem,
      dualOutput,
    ],
  );

  const submitQuery = useCallback(
    async (
      query: PartListUnion,
      submitType: SendMessageType = SendMessageType.UserQuery,
      prompt_id?: string,
      metadata?: { notificationDisplayText?: string },
    ) => {
      const allowConcurrentBtwDuringResponse =
        submitType === SendMessageType.UserQuery &&
        streamingState === StreamingState.Responding &&
        typeof query === 'string' &&
        isBtwCommand(query);

      // Prevent concurrent executions of submitQuery, but allow continuations
      // which are part of the same logical flow (tool responses)
      if (
        isSubmittingQueryRef.current &&
        submitType !== SendMessageType.ToolResult &&
        !allowConcurrentBtwDuringResponse
      ) {
        return;
      }

      if (
        (streamingState === StreamingState.Responding ||
          streamingState === StreamingState.WaitingForConfirmation) &&
        submitType !== SendMessageType.ToolResult &&
        !allowConcurrentBtwDuringResponse
      )
        return;

      // Set the flag to indicate we're now executing
      isSubmittingQueryRef.current = true;

      // Reset turn-local ownership trackers at the very top of every
      // top-level submit (UserQuery, Retry, Cron, Notification, etc.).
      // `prepareQueryForGemini` also resets `lastTurnUserItemRef`, but
      // Retry skips that path — without this earlier reset, a stale
      // ownership snapshot from the prior UserQuery would survive into
      // the retry's cancel info and let auto-restore wrongly truncate
      // the original prompt.
      //
      // ToolResult continuations and same-turn btw concurrencies keep
      // the trackers untouched — they're piggybacking on an in-flight
      // turn that already owns its own snapshot.
      if (
        submitType !== SendMessageType.ToolResult &&
        !allowConcurrentBtwDuringResponse
      ) {
        lastTurnUserItemRef.current = null;
        turnSawContentEventRef.current = false;
        handledProviderToolCallIdsRef.current.clear();
        pendingDuplicateToolResponsesRef.current = [];
        immediateDuplicateToolResponsesRef.current = null;
      }

      const userMessageTimestamp = Date.now();

      // Reset quota error flag when starting a new query (not a continuation)
      if (
        submitType !== SendMessageType.ToolResult &&
        !allowConcurrentBtwDuringResponse
      ) {
        setModelSwitchedFromQuotaError(false);
        // Clear model override for new user turns, but preserve it on retry
        // so the same skill-selected model is used again.
        if (submitType !== SendMessageType.Retry) {
          modelOverrideRef.current = undefined;
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

      // Keep the main stream's cancellation state intact while /btw is handled
      // in parallel. The side-question can use its own local abort signal.
      if (!allowConcurrentBtwDuringResponse) {
        abortControllerRef.current = abortController;
        turnCancelledRef.current = false;
      }

      if (!prompt_id) {
        prompt_id = config.getSessionId() + '########' + getPromptCount();
      }

      return promptIdContext.run(prompt_id, async () => {
        const { queryToSend, shouldProceed } =
          submitType === SendMessageType.Retry
            ? { queryToSend: query, shouldProceed: true }
            : await prepareQueryForGemini(
                query,
                userMessageTimestamp,
                abortSignal,
                prompt_id!,
                submitType,
              );

        if (!shouldProceed || queryToSend === null) {
          isSubmittingQueryRef.current = false;
          return;
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
        lastPromptRef.current = finalQueryToSend;
        lastPromptErroredRef.current = false;

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
        if (submitType !== SendMessageType.ToolResult) {
          streamingResponseLengthRef.current = 0;
        }

        try {
          // Emit user message to dual output sidecar (if enabled).
          // Skip for tool-result submissions — those are emitted separately
          // when the tool completes.
          if (dualOutput && submitType !== SendMessageType.ToolResult) {
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

          const stream = geminiClient.sendMessageStream(
            finalQueryToSend,
            abortSignal,
            prompt_id!,
            {
              type: submitType,
              notificationDisplayText: metadata?.notificationDisplayText,
              modelOverride: modelOverrideRef.current,
            },
          );

          const processingStatus = await processGeminiStreamEvents(
            stream,
            userMessageTimestamp,
            abortSignal,
          );

          if (processingStatus === StreamProcessingStatus.UserCancelled) {
            submitPromptOnCompleteRef.current = null;
            isSubmittingQueryRef.current = false;
            return;
          }

          if (pendingHistoryItemRef.current) {
            addItem(pendingHistoryItemRef.current, userMessageTimestamp);
            setPendingHistoryItem(null);
          }

          const immediateDuplicateToolResponses =
            immediateDuplicateToolResponsesRef.current;
          if (immediateDuplicateToolResponses) {
            immediateDuplicateToolResponsesRef.current = null;
            await submitQuery(
              immediateDuplicateToolResponses.responseParts,
              SendMessageType.ToolResult,
              immediateDuplicateToolResponses.promptId,
            );
          }
          // Only clear auto-retry countdown errors (those with an active timer).
          // Do NOT clear static error+hint from handleErrorEvent — those should
          // remain visible until the user presses Ctrl+Y to retry or starts
          // a new conversation turn (cleared in submitQuery).
          if (retryCountdownTimerRef.current) {
            clearRetryCountdown();
          }
          if (loopDetectedRef.current) {
            loopDetectedRef.current = false;
            handleLoopDetectedEvent();
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
          if (geminiClient) {
            const memoryTaskPromises =
              geminiClient.consumePendingMemoryTaskPromises();
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
          if (error instanceof UnauthorizedError) {
            onAuthError('Session expired or is unauthorized.');
          } else if (!isNodeError(error) || error.name !== 'AbortError') {
            lastPromptErroredRef.current = true;
            const retryHint = t('Press Ctrl+Y to retry');
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
          submitPromptOnCompleteRef.current = null;
          activeModelStreamsRef.current = Math.max(
            0,
            activeModelStreamsRef.current - 1,
          );
          if (activeModelStreamsRef.current === 0) {
            setIsResponding(false);
          }
          isSubmittingQueryRef.current = false;
        }
      });
    },
    [
      streamingState,
      setModelSwitchedFromQuotaError,
      prepareQueryForGemini,
      processGeminiStreamEvents,
      pendingHistoryItemRef,
      addItem,
      setPendingHistoryItem,
      setInitError,
      geminiClient,
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
    ],
  );

  /**
   * Retries the last failed prompt when the user presses Ctrl+Y.
   *
   * Activation conditions for Ctrl+Y shortcut:
   * 1. ✅ The last request must have failed (lastPromptErroredRef.current === true)
   * 2. ✅ Current streaming state must NOT be "Responding" (avoid interrupting ongoing stream)
   * 3. ✅ Current streaming state must NOT be "WaitingForConfirmation" (avoid conflicting with tool confirmation flow)
   * 4. ✅ There must be a stored lastPrompt in lastPromptRef.current
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

  const handleApprovalModeChange = useCallback(
    async (newApprovalMode: ApprovalMode) => {
      // Auto-approve pending tool calls when switching to auto-approval modes
      if (
        newApprovalMode === ApprovalMode.YOLO ||
        newApprovalMode === ApprovalMode.AUTO_EDIT
      ) {
        let awaitingApprovalCalls = toolCalls.filter(
          (call): call is TrackedWaitingToolCall =>
            call.status === 'awaiting_approval',
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
      // Walk raw history WITHOUT cloning — `geminiClient.getHistory()`
      // returns `structuredClone(this.history)`, which on long sessions
      // (200+ entries with sizable tool outputs) costs several ms on
      // the React UI thread and visibly stalls streaming when the
      // dedup pass runs on every tool-completion batch.
      // `getHistoryFunctionResponseIds` walks history in place and
      // returns only the id Set this dispatcher needs. The
      // GeminiClient implementation is mandatory — production and
      // test mocks both expose it. Skip the dedup pass entirely if
      // the client is missing (only happens in unit tests that
      // construct a hook without a client).
      const historyCallIdsWithResponse: Set<string> = geminiClient
        ? geminiClient.getHistoryFunctionResponseIds()
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
        // `recordCompletedToolCall` loop below over `geminiTools` —
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
          geminiClient?.recordCompletedToolCall(
            tc.request.name,
            tc.request.args as Record<string, unknown>,
          );
        }
        markToolsAsSubmitted(dedupedCallIds);
      }

      if (activeModelStreamsRef.current > 0) {
        return;
      }

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

      if (newSuccessfulMemorySaves.length > 0) {
        // Perform the refresh only if there are new ones.
        void performMemoryRefresh();
        // Mark them as processed so we don't do this again on the next render.
        newSuccessfulMemorySaves.forEach((t) =>
          processedMemoryToolsRef.current.add(t.request.callId),
        );
      }

      const geminiTools = completedAndReadyToSubmitTools.filter(
        (t) =>
          !t.request.isClientInitiated &&
          !historyCallIdsWithResponse.has(t.request.callId),
      );
      const completedCallIds = new Set(
        completedAndReadyToSubmitTools.map(
          (toolCall) => toolCall.request.callId,
        ),
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
          return !isReady;
        });
      const pendingDuplicateResponseParts = readyDuplicateBatches.flatMap(
        (batch) => batch.responseParts,
      );
      const pendingDuplicatePromptId = readyDuplicateBatches[0]?.promptId;

      for (const toolCall of geminiTools) {
        geminiClient?.recordCompletedToolCall(
          toolCall.request.name,
          toolCall.request.args as Record<string, unknown>,
        );
      }

      if (
        geminiTools.length === 0 &&
        pendingDuplicateResponseParts.length === 0
      ) {
        return;
      }

      if (
        turnCancelledRef.current ||
        abortControllerRef.current?.signal.aborted
      ) {
        markToolsAsSubmitted(
          geminiTools.map((toolCall) => toolCall.request.callId),
        );
        return;
      }

      // If all the tools were cancelled, don't submit a response to Gemini.
      const allToolsCancelled = geminiTools.every(
        (tc) => tc.status === 'cancelled',
      );

      if (allToolsCancelled && pendingDuplicateResponseParts.length === 0) {
        if (geminiClient) {
          // We need to manually add the function responses to the history
          // so the model knows the tools were cancelled.
          const combinedParts = geminiTools.flatMap(
            (toolCall) => toolCall.response.responseParts,
          );
          geminiClient.addHistory({
            role: 'user',
            parts: combinedParts,
          });

          // Report cancellation to arena (safety net — cancelOngoingRequest
          config.getArenaAgentClient()?.reportCancelled();
        }

        const callIdsToMarkAsSubmitted = geminiTools.map(
          (toolCall) => toolCall.request.callId,
        );
        markToolsAsSubmitted(callIdsToMarkAsSubmitted);
        return;
      }

      const responsesToSend: Part[] = geminiTools.flatMap(
        (toolCall) => toolCall.response.responseParts,
      );
      responsesToSend.push(...pendingDuplicateResponseParts);
      const callIdsToMarkAsSubmitted = geminiTools.map(
        (toolCall) => toolCall.request.callId,
      );

      const prompt_ids = geminiTools.map(
        (toolCall) => toolCall.request.prompt_id,
      );
      const promptId = prompt_ids[0] ?? pendingDuplicatePromptId;

      // Persist model override from skill tool results (last one wins).
      // Uses `in` so that undefined (from inherit/no-model skills) clears a
      // prior override, while non-skill tools (field absent) leave it intact.
      for (const toolCall of geminiTools) {
        if ('modelOverride' in toolCall.response) {
          modelOverrideRef.current = toolCall.response.modelOverride;
        }
      }

      // Emit tool results to dual output sidecar (if enabled)
      if (dualOutput) {
        for (const toolCall of geminiTools) {
          dualOutput.emitToolResult(toolCall.request, toolCall.response);
        }
      }

      markToolsAsSubmitted(callIdsToMarkAsSubmitted);

      // Fire tool-use summary generation in parallel with the next API call.
      // The fast-model latency is hidden behind the main-model streaming.
      // Fire-and-forget: failures are silent and never block the turn.
      // Subagent exclusion is implicit — useGeminiStream only drives the
      // main session; subagents run through agents/runtime/ with their own loop.
      if (config.getEmitToolUseSummaries()) {
        // Only summarize successful tools. Error/cancelled entries push
        // "Cancelled by user" / retry-loop warnings into the summarizer
        // prompt and produce plausibly-worded but misleading labels (the
        // fast model happily synthesizes "Attempted to read files" from a
        // batch that was mostly failures). cleanSummary can reject output
        // prefixes but not prevent this kind of polluted-input hallucination.
        const successfulTools = geminiTools.filter(
          (tc) => tc.status === 'success',
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
        return;
      }

      // Mid-turn queue drain: inject queued user messages alongside tool
      // results so the model sees them in the next API call.
      // Skip if the turn was cancelled — messages stay in queue for next turn.
      const drained =
        turnCancelledRef.current || abortControllerRef.current?.signal.aborted
          ? []
          : (midTurnDrainRef?.current?.() ?? []);
      if (drained.length > 0) {
        const midTurnTimestamp = Date.now();
        const midTurnAbort =
          abortControllerRef.current ?? new AbortController();
        const shouldTrackMidTurnAbort = !abortControllerRef.current;
        if (shouldTrackMidTurnAbort) {
          auxiliaryAbortRefsRef.current.add(midTurnAbort);
        }
        try {
          for (let index = 0; index < drained.length; index += 1) {
            if (midTurnAbort.signal.aborted) {
              break;
            }
            const msg = drained[index];
            let resolvedMidTurnQuery: PartListUnion = [{ text: msg }];
            if (isAtCommand(msg)) {
              const atCommandTimeout = new AbortController();
              const atCommandSignal = AbortSignal.any([
                midTurnAbort.signal,
                atCommandTimeout.signal,
              ]);
              const atCommandTimeoutId = setTimeout(() => {
                atCommandTimeout.abort(
                  new Error(MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MESSAGE),
                );
              }, MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MS);
              try {
                const atCommandResult = await resolveWithAbort(
                  atCommandSignal,
                  () =>
                    resolveAtCommandQuery({
                      query: msg,
                      config,
                      onDebugMessage,
                      messageId: midTurnTimestamp + index,
                      signal: atCommandSignal,
                    }),
                );
                const shouldSkipMidTurnMessage =
                  !atCommandResult.shouldProceed &&
                  (atCommandResult.toolDisplays?.length ?? 0) > 0;
                if (
                  atCommandResult.shouldProceed &&
                  atCommandResult.processedQuery !== null
                ) {
                  resolvedMidTurnQuery = atCommandResult.processedQuery;
                } else if (atCommandResult.toolDisplays?.length) {
                  addItem(
                    { type: 'tool_group', tools: atCommandResult.toolDisplays },
                    midTurnTimestamp + index,
                  );
                }
                if (atCommandResult.recording) {
                  config.getChatRecordingService()?.recordAtCommand?.({
                    filesRead: atCommandResult.recording.filesRead,
                    status: atCommandResult.recording.status,
                    ...(atCommandResult.recording.message
                      ? { message: atCommandResult.recording.message }
                      : {}),
                    userText: msg,
                  });
                }
                if (shouldSkipMidTurnMessage) {
                  continue;
                }
              } catch (error) {
                const errorMessage = getErrorMessage(error);
                onDebugMessage(
                  `Failed to resolve mid-turn @ command: ${errorMessage}`,
                );
                if (!midTurnAbort.signal.aborted) {
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
                clearTimeout(atCommandTimeoutId);
              }
              if (midTurnAbort.signal.aborted) {
                break;
              }
            }

            const midTurnUserMessageParts = prefixMidTurnUserMessageParts(
              resolvedMidTurnQuery,
              msg,
            );
            const formatCheck = checkImageFormatsSupport(
              midTurnUserMessageParts,
            );
            if (formatCheck.hasUnsupportedFormats) {
              addItem(
                {
                  type: MessageType.INFO,
                  text: getUnsupportedImageFormatWarning(),
                },
                Date.now(),
              );
            }
            responsesToSend.push(...midTurnUserMessageParts);
            config
              .getChatRecordingService()
              ?.recordMidTurnUserMessage(midTurnUserMessageParts, msg);
            addItem({ type: MessageType.NOTIFICATION, text: msg }, Date.now());
          }
        } finally {
          if (shouldTrackMidTurnAbort) {
            auxiliaryAbortRefsRef.current.delete(midTurnAbort);
            midTurnAbort.abort();
          }
        }
      }

      if (
        turnCancelledRef.current ||
        abortControllerRef.current?.signal.aborted
      ) {
        return;
      }

      submitQuery(responsesToSend, SendMessageType.ToolResult, promptId);
    },
    [
      submitQuery,
      markToolsAsSubmitted,
      geminiClient,
      performMemoryRefresh,
      modelSwitchedFromQuotaError,
      config,
      midTurnDrainRef,
      addItem,
      dualOutput,
      onDebugMessage,
    ],
  );

  const pendingHistoryItems = useMemo(
    () =>
      [
        // Reasoning renders above the streaming answer.
        pendingThoughtItem,
        pendingHistoryItem,
        pendingRetryErrorItem,
        pendingRetryCountdownItem,
        pendingToolCallGroupDisplay,
      ].filter((i) => i !== undefined && i !== null),
    [
      pendingThoughtItem,
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
            const clientHistory = geminiClient?.getHistoryShallow();
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
  }, [toolCalls, config, onDebugMessage, history, geminiClient, storage]);

  // ─── Unified notification queue (cron + background agents) ──────
  const notificationQueueRef = useRef<
    Array<{
      displayText: string;
      modelText: string;
      sendMessageType: SendMessageType;
    }>
  >([]);
  const [notificationTrigger, setNotificationTrigger] = useState(0);
  const notificationQueueSessionIdRef = useRef(sessionStates.sessionId);

  useEffect(() => {
    if (notificationQueueSessionIdRef.current === sessionStates.sessionId) {
      return;
    }
    notificationQueueSessionIdRef.current = sessionStates.sessionId;
    notificationQueueRef.current = [];
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
        (job: { prompt: string; cronExpr?: string; missed?: boolean }) => {
          const label = job.prompt.slice(0, 40);
          const source = job.cronExpr === '@wakeup' ? 'Loop' : 'Cron';
          notificationQueueRef.current.push({
            displayText: `${job.missed ? 'Missed' : source}: ${label}`,
            modelText: job.prompt,
            sendMessageType: SendMessageType.Cron,
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
  }, [config, isConfigInitialized]);

  // Register background agent notification callback onto the shared queue.
  useEffect(() => {
    const registry = config.getBackgroundTaskRegistry();
    registry.setNotificationCallback((displayText, modelText) => {
      notificationQueueRef.current.push({
        displayText,
        modelText,
        sendMessageType: SendMessageType.Notification,
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
    registry.setNotificationCallback((displayText, modelText) => {
      notificationQueueRef.current.push({
        displayText,
        modelText,
        sendMessageType: SendMessageType.Notification,
      });
      setNotificationTrigger((n) => n + 1);
    });
    return () => {
      registry.setNotificationCallback(undefined);
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
      const queue = notificationQueueRef.current;
      const targetType = queue[0]!.sendMessageType;

      // Cron prompts must run as individual turns — each needs its own
      // slash/shell/@ preprocessing and approval cycle. Only batch
      // Notification items (which pass through without preprocessing).
      if (targetType === SendMessageType.Cron) {
        const item = queue.shift()!;
        addItem(
          { type: 'notification' as const, text: item.displayText },
          Date.now(),
        );
        submitQuery(item.modelText, item.sendMessageType, undefined, {
          notificationDisplayText: item.displayText,
        });
        return;
      }

      // Drain contiguous leading Notification items into one batch.
      let splitIdx = 0;
      while (
        splitIdx < queue.length &&
        queue[splitIdx]!.sendMessageType === targetType
      ) {
        splitIdx++;
      }
      const batch = queue.splice(0, splitIdx);

      const now = Date.now();
      for (const item of batch) {
        addItem({ type: 'notification' as const, text: item.displayText }, now);
      }

      const combinedModelText = batch.map((e) => e.modelText).join('\n\n');
      const combinedDisplayText = batch.map((e) => e.displayText).join('; ');
      submitQuery(combinedModelText, targetType, undefined, {
        notificationDisplayText: combinedDisplayText,
      });
    }
  }, [streamingState, submitQuery, notificationTrigger, addItem]);

  // ─── Teammate message integration ─────────────────────────
  // Each entry carries the full nonce-tagged envelope (`modelText`,
  // sent to the leader's model) and a compact `display` line (shown
  // to the user in its place) — the same two-text split the unified
  // notification queue uses, so teammate reports no longer dump the
  // whole raw envelope into the conversation as a user bubble.
  const teammateQueueRef = useRef<
    Array<{ modelText: string; display: string }>
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
      const batch = teammateQueueRef.current.splice(0);
      // Render one compact `● …` line per teammate report; the full
      // envelope goes only to the model (the USER bubble is suppressed
      // for SendMessageType.Teammate in prepareQueryForGemini).
      for (const entry of batch) {
        addItem(
          { type: 'notification' as const, text: entry.display },
          Date.now(),
        );
      }
      const modelText = batch.map((e) => e.modelText).join('\n\n');
      const display = batch.map((e) => e.display).join('; ');
      submitQuery(modelText, SendMessageType.Teammate, undefined, {
        notificationDisplayText: display,
      });
    }
  }, [streamingState, submitQuery, teammateTrigger, addItem]);

  return {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems,
    thought,
    cancelOngoingRequest,
    retryLastPrompt,
    pendingToolCalls: toolCalls,
    handleApprovalModeChange,
    activePtyId,
    loopDetectionConfirmationRequest,
    streamingResponseLengthRef,
    isReceivingContent,
  };
};
