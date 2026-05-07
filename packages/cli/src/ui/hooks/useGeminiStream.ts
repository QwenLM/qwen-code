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
import type {
  Config,
  EditorType,
  GeminiClient,
  RetryInfo,
  ServerGeminiChatCompressedEvent,
  ServerGeminiContentEvent as ContentEvent,
  ServerGeminiFinishedEvent,
  ServerGeminiStreamEvent as GeminiEvent,
  ThoughtSummary,
  ToolCallRequestInfo,
  GeminiErrorEventValue,
  StopFailureErrorType,
} from '@qwen-code/qwen-code-core';
import {
  GeminiEventType as ServerGeminiEventType,
  SendMessageType,
  createDebugLogger,
  getErrorMessage,
  isNodeError,
  MessageSenderType,
  logUserPrompt,
  logUserRetry,
  GitService,
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
  generateToolUseSummary,
} from '@qwen-code/qwen-code-core';
import { type Part, type PartListUnion, FinishReason } from '@google/genai';
import type {
  HistoryItem,
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
import { handleAtCommand } from './atCommandProcessor.js';
import { findLastSafeSplitPoint } from '../utils/markdownUtilities.js';
import { useStateAndRef } from './useStateAndRef.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { useLogger } from './useLogger.js';
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

const debugLogger = createDebugLogger('GEMINI_STREAM');

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

const EDIT_TOOL_NAMES = new Set(['replace', 'write_file']);
const STREAM_UPDATE_THROTTLE_MS = 60;

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

/**
 * Manages the Gemini stream, including user input, command processing,
 * API interaction, and tool call lifecycle.
 */
export const useGeminiStream = (
  geminiClient: GeminiClient,
  history: HistoryItem[],
  addItem: UseHistoryManagerReturn['addItem'],
  config: Config,
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
  onCancelSubmit: () => void,
  setShellInputFocused: (value: boolean) => void,
  terminalWidth: number,
  terminalHeight: number,
  midTurnDrainRef?: React.RefObject<(() => string[]) | null>,
) => {
  const [initError, setInitError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const flushBufferedStreamEventsRef = useRef<Set<() => void>>(new Set());
  const turnCancelledRef = useRef(false);
  const isSubmittingQueryRef = useRef(false);
  const lastPromptRef = useRef<PartListUnion | null>(null);
  const lastPromptErroredRef = useRef(false);
  const dualOutput = useDualOutput();
  const [isResponding, setIsResponding] = useState<boolean>(false);
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
  // In-flight tool-use-summary aborters. Each batch gets its own AbortController
  // because the captured turn controller is replaced when submitQuery starts
  // the next turn, and the summary call outlives the current turn (that's the
  // whole point — it overlaps with the next turn's streaming). cancelOngoingRequest
  // aborts all in-flight summaries so Ctrl+C during the next turn also kills
  // this turn's stale summary work.
  const summaryAbortRefsRef = useRef<Set<AbortController>>(new Set());
  const [pendingHistoryItem, pendingHistoryItemRef, setPendingHistoryItem] =
    useStateAndRef<HistoryItemWithoutId | null>(null);
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
  const logger = useLogger(storage, sessionStates.sessionId);
  const gitService = useMemo(() => {
    if (!config.getProjectRoot()) {
      return;
    }
    return new GitService(config.getProjectRoot(), storage);
  }, [config, storage]);

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
    for (const flushBufferedStreamEvents of flushBufferedStreamEventsRef.current) {
      flushBufferedStreamEvents();
    }
    turnCancelledRef.current = true;
    isSubmittingQueryRef.current = false;
    abortControllerRef.current?.abort();
    // Cancel any in-flight tool-use-summary generations so their Promise.then
    // doesn't addItem a stale label after the user cancelled.
    for (const ac of summaryAbortRefsRef.current) {
      ac.abort();
    }
    summaryAbortRefsRef.current.clear();

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
    onCancelSubmit();
    setIsResponding(false);
    setShellInputFocused(false);
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

        // Cron prompts are already rendered as a `● Cron: …` notification by
        // the queue drain, so skip the user-message history item to avoid
        // a duplicate `> …` line. Preprocessing (@/slash/shell) still runs.
        if (submitType !== SendMessageType.Cron) {
          addItem(
            { type: MessageType.USER, text: trimmedQuery },
            userMessageTimestamp,
          );
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
      const splitPoint = findLastSafeSplitPoint(newGeminiMessageBuffer);
      if (splitPoint === newGeminiMessageBuffer.length) {
        // Update the existing message with accumulated content
        setPendingHistoryItem((item) => ({
          type: item?.type as 'gemini' | 'gemini_content',
          text: newGeminiMessageBuffer,
        }));
      } else {
        // This indicates that we need to split up this Gemini Message.
        // Splitting a message is primarily a performance consideration. There is a
        // <Static> component at the root of App.tsx which takes care of rendering
        // content statically or dynamically. Everything but the last message is
        // treated as static in order to prevent re-rendering an entire message history
        // multiple times per-second (as streaming occurs). Prior to this change you'd
        // see heavy flickering of the terminal. This ensures that larger messages get
        // broken up so that there are more "statically" rendered.
        const beforeText = newGeminiMessageBuffer.substring(0, splitPoint);
        const afterText = newGeminiMessageBuffer.substring(splitPoint);
        addItem(
          {
            type: pendingHistoryItemRef.current?.type as
              | 'gemini'
              | 'gemini_content',
            text: beforeText,
          },
          userMessageTimestamp,
        );
        setPendingHistoryItem({ type: 'gemini_content', text: afterText });
        newGeminiMessageBuffer = afterText;
      }
      return newGeminiMessageBuffer;
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem],
  );

  const mergeThought = useCallback(
    (incoming: ThoughtSummary) => {
      setThought((prev) => {
        if (!prev) {
          return incoming;
        }
        const subject = incoming.subject || prev.subject;
        const description = `${prev.description ?? ''}${incoming.description ?? ''}`;
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

      // Extract the description text from the thought summary
      const thoughtText = eventValue.description ?? '';
      if (!thoughtText) {
        return currentThoughtBuffer;
      }

      let newThoughtBuffer = currentThoughtBuffer + thoughtText;

      const pendingType = pendingHistoryItemRef.current?.type;
      const isPendingThought =
        pendingType === 'gemini_thought' ||
        pendingType === 'gemini_thought_content';
      let thoughtToMerge = eventValue;

      // If we're not already showing a thought, start a new one
      if (!isPendingThought) {
        if (newThoughtBuffer.trim().length === 0) {
          return newThoughtBuffer;
        }
        // If there's a pending non-thought item, finalize it first
        if (pendingHistoryItemRef.current) {
          addItem(pendingHistoryItemRef.current, userMessageTimestamp);
        }
        newThoughtBuffer = stripLeadingBlankLines(newThoughtBuffer);
        thoughtToMerge = {
          ...eventValue,
          description: newThoughtBuffer,
        };
        setPendingHistoryItem({ type: 'gemini_thought', text: '' });
      }

      // Split large thought messages for better rendering performance (same rationale
      // as regular content streaming). This helps avoid terminal flicker caused by
      // constantly re-rendering an ever-growing "pending" block.
      const splitPoint = findLastSafeSplitPoint(newThoughtBuffer);
      const nextPendingType: 'gemini_thought' | 'gemini_thought_content' =
        isPendingThought && pendingType === 'gemini_thought_content'
          ? 'gemini_thought_content'
          : 'gemini_thought';

      if (splitPoint === newThoughtBuffer.length) {
        // Update the existing thought message with accumulated content
        setPendingHistoryItem({
          type: nextPendingType,
          text: newThoughtBuffer,
        });
      } else {
        const beforeText = newThoughtBuffer.substring(0, splitPoint);
        const afterText = newThoughtBuffer.substring(splitPoint);
        addItem(
          {
            type: nextPendingType,
            text: beforeText,
          },
          userMessageTimestamp,
        );
        setPendingHistoryItem({
          type: 'gemini_thought_content',
          text: afterText,
        });
        newThoughtBuffer = afterText;
      }

      // Also update the thought state for the loading indicator
      mergeThought(thoughtToMerge);

      return newThoughtBuffer;
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem, mergeThought],
  );

  const handleUserCancelledEvent = useCallback(
    (userMessageTimestamp: number) => {
      if (turnCancelledRef.current) {
        return;
      }

      lastPromptErroredRef.current = false;
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
      pendingHistoryItemRef,
      setPendingHistoryItem,
      setThought,
      clearRetryCountdown,
    ],
  );

  const handleErrorEvent = useCallback(
    (eventValue: GeminiErrorEventValue, userMessageTimestamp: number) => {
      lastPromptErroredRef.current = true;
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
        [FinishReason.UNEXPECTED_TOOL_CALL]:
          'Response stopped due to unexpected tool call.',
        [FinishReason.IMAGE_PROHIBITED_CONTENT]:
          'Response stopped due to image prohibited content.',
        [FinishReason.NO_IMAGE]: 'Response stopped due to no image.',
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
      return addItem(
        {
          type: 'info',
          text:
            `IMPORTANT: This conversation approached the input token limit for ${config.getModel()}. ` +
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
    [addItem, pendingHistoryItemRef, setPendingHistoryItem],
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
            let mergedContent = nextEvent.value;

            while (bufferedEvents[0]?.kind === 'content') {
              const queuedContent = bufferedEvents.shift();
              if (queuedContent?.kind !== 'content') {
                break;
              }
              mergedContent += queuedContent.value;
            }

            geminiMessageBuffer = handleContentEvent(
              mergedContent,
              geminiMessageBuffer,
              userMessageTimestamp,
            );
            continue;
          }

          let mergedThought = nextEvent.value;

          while (bufferedEvents[0]?.kind === 'thought') {
            const queuedThought = bufferedEvents.shift();
            if (queuedThought?.kind !== 'thought') {
              break;
            }
            mergedThought = {
              subject: queuedThought.value.subject || mergedThought.subject,
              description: `${mergedThought.description ?? ''}${
                queuedThought.value.description ?? ''
              }`,
            };
          }

          thoughtBuffer = handleThoughtEvent(
            mergedThought,
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
              bufferedEvents.push({ kind: 'content', value: event.value });
              scheduleBufferedStreamFlush();
              break;
            case ServerGeminiEventType.ToolCallRequest:
              flushBufferedStreamEvents();
              toolCallRequests.push(event.value);
              // Count tool call args JSON toward token estimation (matches
              // Claude Code's input_json_delta handling).
              try {
                const argsJson = JSON.stringify(event.value.args);
                streamingResponseLengthRef.current += argsJson.length;
              } catch {
                // Best-effort — don't block on serialization errors
              }
              break;
            case ServerGeminiEventType.UserCancelled:
              flushBufferedStreamEvents();
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
              handleFinishedEvent(
                event as ServerGeminiFinishedEvent,
                userMessageTimestamp,
              );
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
                geminiMessageBuffer = '';
                thoughtBuffer = '';
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
            default: {
              // enforces exhaustive switch-case
              const unreachable: never = event;
              return unreachable;
            }
          }
        }
      } finally {
        flushBufferedStreamEvents();
        discardBufferedStreamEvents();
        flushBufferedStreamEventsRef.current.delete(flushBufferedStreamEvents);
      }
      dualOutput?.finalizeAssistantMessage();
      if (toolCallRequests.length > 0) {
        scheduleToolCalls(toolCallRequests, signal);
      }
      return StreamProcessingStatus.Completed;
    },
    [
      handleContentEvent,
      handleThoughtEvent,
      handleUserCancelledEvent,
      handleErrorEvent,
      scheduleToolCalls,
      handleChatCompressionEvent,
      handleFinishedEvent,
      handleMaxSessionTurnsEvent,
      handleSessionTokenLimitExceededEvent,
      handleCitationEvent,
      startRetryCountdown,
      clearRetryCountdown,
      setThought,
      pendingHistoryItemRef,
      setPendingHistoryItem,
      handleUserPromptSubmitBlockedEvent,
      handleStopHookLoopEvent,
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
          submitType === SendMessageType.Cron
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
          submitType === SendMessageType.Cron
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
        }

        if (submitType === SendMessageType.Retry) {
          logUserRetry(config, new UserRetryEvent(prompt_id));
        }

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
            isSubmittingQueryRef.current = false;
            return;
          }

          if (pendingHistoryItemRef.current) {
            addItem(pendingHistoryItemRef.current, userMessageTimestamp);
            setPendingHistoryItem(null);
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
            void onComplete();
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
          setIsResponding(false);
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

        // For AUTO_EDIT mode, only approve edit tools (replace, write_file)
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
      if (isResponding) {
        return;
      }

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

      // Finalize any client-initiated tools as soon as they are done.
      const clientTools = completedAndReadyToSubmitTools.filter(
        (t) => t.request.isClientInitiated,
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
        (t) => !t.request.isClientInitiated,
      );

      if (geminiTools.length === 0) {
        return;
      }

      // If all the tools were cancelled, don't submit a response to Gemini.
      const allToolsCancelled = geminiTools.every(
        (tc) => tc.status === 'cancelled',
      );

      if (allToolsCancelled) {
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
      const callIdsToMarkAsSubmitted = geminiTools.map(
        (toolCall) => toolCall.request.callId,
      );

      const prompt_ids = geminiTools.map(
        (toolCall) => toolCall.request.prompt_id,
      );

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
      // The fast-model Haiku-equivalent latency (~1s) is hidden behind the
      // main-model streaming (5-30s). Mirrors Claude Code's query.ts:1411-1482
      // behavior. Fire-and-forget: failures are silent and never block the turn.
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
          summaryAbortRefsRef.current.add(summaryAbort);

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
              summaryAbortRefsRef.current.delete(summaryAbort);
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
              summaryAbortRefsRef.current.delete(summaryAbort);
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
        for (const msg of drained) {
          responsesToSend.push({
            text: `\n[User message received during tool execution]: ${msg}`,
          });
          // Record in UI history so the transcript stays complete.
          addItem({ type: MessageType.USER, text: msg }, Date.now());
        }
      }

      submitQuery(responsesToSend, SendMessageType.ToolResult, prompt_ids[0]);
    },
    [
      isResponding,
      submitQuery,
      markToolsAsSubmitted,
      geminiClient,
      performMemoryRefresh,
      modelSwitchedFromQuotaError,
      config,
      midTurnDrainRef,
      addItem,
      dualOutput,
    ],
  );

  const pendingHistoryItems = useMemo(
    () =>
      [
        pendingHistoryItem,
        pendingRetryErrorItem,
        pendingRetryCountdownItem,
        pendingToolCallGroupDisplay,
      ].filter((i) => i !== undefined && i !== null),
    [
      pendingHistoryItem,
      pendingRetryErrorItem,
      pendingRetryCountdownItem,
      pendingToolCallGroupDisplay,
    ],
  );

  useEffect(() => {
    const saveRestorableToolCalls = async () => {
      if (!config.getCheckpointingEnabled()) {
        return;
      }
      const restorableToolCalls = toolCalls.filter(
        (toolCall) =>
          EDIT_TOOL_NAMES.has(toolCall.request.name) &&
          toolCall.status === 'awaiting_approval',
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
          const filePath = toolCall.request.args['file_path'] as string;
          if (!filePath) {
            onDebugMessage(
              `Skipping restorable tool call due to missing file_path: ${toolCall.request.name}`,
            );
            continue;
          }

          try {
            if (!gitService) {
              onDebugMessage(
                `Checkpointing is enabled but Git service is not available. Failed to create snapshot for ${filePath}. Ensure Git is installed and working properly.`,
              );
              continue;
            }

            let commitHash: string | undefined;
            try {
              commitHash = await gitService.createFileSnapshot(
                `Snapshot for ${toolCall.request.name}`,
              );
            } catch (error) {
              onDebugMessage(
                `Failed to create new snapshot: ${getErrorMessage(error)}. Attempting to use current commit.`,
              );
            }

            if (!commitHash) {
              commitHash = await gitService.getCurrentCommitHash();
            }

            if (!commitHash) {
              onDebugMessage(
                `Failed to create snapshot for ${filePath}. Checkpointing may not be working properly. Ensure Git is installed and the project directory is accessible.`,
              );
              continue;
            }

            const timestamp = new Date()
              .toISOString()
              .replace(/:/g, '-')
              .replace(/\./g, '_');
            const toolName = toolCall.request.name;
            const fileName = path.basename(filePath);
            const toolCallWithSnapshotFileName = `${timestamp}-${fileName}-${toolName}.json`;
            const clientHistory = await geminiClient?.getHistory();
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
                  commitHash,
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
              )}. This may indicate a problem with Git or file system permissions.`,
            );
          }
        }
      }
    };
    saveRestorableToolCalls();
  }, [
    toolCalls,
    config,
    onDebugMessage,
    gitService,
    history,
    geminiClient,
    storage,
  ]);

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

  // Start the cron scheduler on mount, stop on unmount.
  // Cron fires enqueue onto the shared notification queue.
  useEffect(() => {
    if (!config.isCronEnabled()) return;
    const scheduler = config.getCronScheduler();
    scheduler.start((job: { prompt: string }) => {
      const label = job.prompt.slice(0, 40);
      notificationQueueRef.current.push({
        displayText: `Cron: ${label}`,
        modelText: job.prompt,
        sendMessageType: SendMessageType.Cron,
      });
      setNotificationTrigger((n) => n + 1);
    });
    return () => {
      const summary = scheduler.getExitSummary();
      scheduler.stop();
      if (summary) {
        process.stderr.write(summary + '\n');
      }
    };
  }, [config]);

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

  // Register monitor notification callback onto the shared queue.
  useEffect(() => {
    const registry = config.getMonitorRegistry();
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

  // When idle, drain the unified queue one item at a time.
  useEffect(() => {
    if (
      streamingState === StreamingState.Idle &&
      notificationQueueRef.current.length > 0
    ) {
      const item = notificationQueueRef.current.shift()!;
      addItem(
        { type: 'notification' as const, text: item.displayText },
        Date.now(),
      );
      submitQuery(item.modelText, item.sendMessageType, undefined, {
        notificationDisplayText: item.displayText,
      });
    }
  }, [streamingState, submitQuery, notificationTrigger, addItem]);

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
