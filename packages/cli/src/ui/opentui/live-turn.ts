/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-turn driver for the OpenTUI backend (Batch 6): wraps
 * {@link livePromptEvents} in a React hook that folds stream events into
 * {@link LiveHistoryItem}s, tracks scheduler confirmation requests, supports
 * Esc-interrupt, and queues prompts submitted mid-turn.
 *
 * Mid-turn input semantics (ink useGeminiStream parity): a prompt submitted
 * while a turn is in flight is queued; queued texts drain at the next tool
 * boundary as genuine steering content (`drainSteering`), and whatever is
 * still queued when the turn ends becomes the next turn — so user input is
 * never silently dropped.
 *
 * `@path` mentions are expanded where a prompt enters the stream
 * ({@link livePromptEvents}), never here: an idle submit, queued text that
 * becomes the next turn, and text drained as in-flight steering all reach the
 * model with file content, while the transcript keeps what was typed. A
 * steering resolution the user interrupts mid-read hands its texts back to this
 * queue instead of dropping them.
 */

import type { RestoreToolResponseBinding } from '../utils/restore-tool-response.js';
import { expandPendingPastePlaceholders } from '../utils/paste-placeholders.js';
import { stripSuppressOnRestore } from '../utils/resumeHistoryUtils.js';
import type { HumanPromptInput } from '@qwen-code/qwen-code-core/core/workflow-intent.js';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { readFileSync } from 'node:fs';
import { ShellExecutionService } from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  MessageSenderType,
  type Logger,
} from '@qwen-code/qwen-code-core/core/logger.js';
import {
  collectText,
  normalizeParts,
} from '@qwen-code/qwen-code-core/services/visionBridge/image-part-utils.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { Part, PartListUnion } from '@google/genai';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { DualOutputBridge } from '../../dualOutput/DualOutputBridge.js';
import {
  foldLiveEvent,
  settleOpenTools,
  snapshotCanonicalHistory,
  allocateCanonicalHistoryId,
  type LiveHistoryItem,
} from './live-session-model.js';
import { getInteractiveModSession } from '../../services/interactive-mod-session.js';
import type { ModTurn } from '../../services/mod-session.js';
import type { ServerLlmStreamEvent } from '@qwen-code/qwen-code-core';
import {
  livePromptEvents,
  nextLivePromptId,
  type OpenTuiSteeringSubmission,
  type WaitingCallInfo,
  type ExecutingShellCall,
  type PreparedLiveRequest,
} from './live-session.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import {
  restoreInputSubmissions,
  type OpenTuiRestoredDraft,
  type OpenTuiInputSubmission,
  type OpenTuiCancelSettled,
} from './input-submission.js';

const debugLogger = createDebugLogger('OPENTUI_LIVE_TURN');

/** Extension → MIME for composer attachments (core SUPPORTED subset). */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  tiff: 'image/tiff',
  webp: 'image/webp',
  heic: 'image/heic',
};

/**
 * Converts pasted/composer image paths into inlineData parts. Unreadable or
 * unsupported paths come back as notices so nothing disappears silently.
 */
export function imagePathsToParts(imagePaths: readonly string[]): {
  parts: Part[];
  notices: string[];
} {
  const parts: Part[] = [];
  const notices: string[] = [];
  for (const path of imagePaths) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const mimeType = IMAGE_MIME_BY_EXTENSION[ext];
    if (!mimeType) {
      notices.push(`Unsupported image type: ${path}`);
      continue;
    }
    try {
      const data = readFileSync(path).toString('base64');
      parts.push({ inlineData: { mimeType, data } });
    } catch {
      notices.push(`Could not read image: ${path}`);
    }
  }
  return { parts, notices };
}

export interface UseOpenTuiLiveTurnOptions {
  config: Config;
  dualOutput?: DualOutputBridge | null;
  logger?: Logger | null;
}

/**
 * Options a `submit_prompt` dispatcher outcome carries into the turn
 * (ink SubmitPromptResult parity): per-turn model override, context-file
 * memory refresh, and the post-turn callback.
 */
export interface OpenTuiSubmitOptions {
  promptId?: string;
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
    restoreResponseBinding?: RestoreToolResponseBinding;
  };
  deferUntilIdle?: boolean;
  modelOverride?: string;
  refreshContextFilesOnWrite?: boolean;
  onComplete?: () => Promise<void>;
  /**
   * Raw typed text for `UserPromptSubmit` provenance. Set by the composer
   * submit and by the follow-on turn built from the mid-turn queue; a slash
   * command's `submit_prompt` outcome carries generated content, which ink
   * also submits without provenance.
   */
  submittedPrompt?: string;
  humanInput?: HumanPromptInput;
  hasUnknownInput?: boolean;
  displayText?: string;
  pasteExpansions?: ReadonlyMap<string, string>;
  restoredDraft?: OpenTuiRestoredDraft;
  /**
   * The transcript already holds the user row for this submit, because the
   * dispatcher echoed the typed invocation. Set by a `submit_prompt` outcome:
   * its content is generated, never typed, and ink's `submit_prompt` case
   * returns before adding a USER history item for it.
   */
  invocationEchoed?: boolean;
}

export interface ForegroundShellOwner {
  callId: string;
  pid: number;
  turn: number;
}

export interface OpenTuiLiveTurn {
  items: readonly LiveHistoryItem[];
  streaming: boolean;
  /**
   * Output characters streamed so far this turn. A ref so per-delta events
   * never re-render the transcript; the loading indicator polls it.
   */
  streamingCharsRef: RefObject<number>;
  /** False while waiting on the API (↑), true once content arrives (↓). */
  isReceivingContent: boolean;
  /** Scheduler calls parked in awaiting_approval, awaiting a dialog. */
  waitingCalls: readonly WaitingCallInfo[];
  foregroundShell: ForegroundShellOwner | null;
  promoteShellToBackground(): boolean;
  writeShellInput(owner: ForegroundShellOwner, input: string): boolean;
  resizeShell(
    owner: ForegroundShellOwner,
    columns: number,
    rows: number,
  ): boolean;
  scrollShell(owner: ForegroundShellOwner, lines: number): boolean;
  /** Mid-turn queued prompts, oldest first (composer badge + Esc pop-back). */
  messageQueue: readonly string[];
  /** Pops composer submissions back together; generated turns stay queued. */
  popQueue(): OpenTuiInputSubmission | null;
  /**
   * Submits a prompt (or queues it when a turn is in flight). A
   * `submit_prompt` outcome's per-turn options travel in `options`.
   */
  submit(
    content: PartListUnion,
    imagePaths?: readonly string[],
    options?: OpenTuiSubmitOptions,
  ): boolean;
  /** Aborts the in-flight turn (Esc). */
  interrupt(onSettled?: OpenTuiCancelSettled): void;
  retryLastPrompt(): void;
  notifyInputProcessed(): void;
  scheduleTool(
    name: string,
    args: Record<string, unknown>,
    restoreResponseBinding?: RestoreToolResponseBinding,
  ): boolean;
  isCurrentHistory(snapshot: readonly LiveHistoryItem[]): boolean;
  rewindTranscript(userId: string): readonly LiveHistoryItem[] | undefined;
  /** Replaces the transcript from a replay batch (session switch/resume). */
  resetTranscript(events: readonly OpenTuiStreamEvent[]): void;
  /** Folds one externally produced event (update notices, startup warnings). */
  applyEvent(event: OpenTuiStreamEvent): readonly LiveHistoryItem[] | undefined;
  /** Drops a waiting call after its dialog settled. */
  settleWaitingCall(callId: string): void;
}

interface QueuedSubmission extends OpenTuiSteeringSubmission {
  turnOptions?: OpenTuiSubmitOptions;
  generated?: boolean;
}

/** Folds a replay batch into a fresh item list (single commit). */
export function foldBatch(
  events: readonly OpenTuiStreamEvent[],
): readonly LiveHistoryItem[] {
  let items: readonly LiveHistoryItem[] = [];
  for (const ev of events) items = foldLiveEvent(items, ev);
  return items;
}

export function useOpenTuiLiveTurn(
  options: UseOpenTuiLiveTurnOptions,
): OpenTuiLiveTurn {
  const { config, dualOutput, logger } = options;
  const [items, setItems] = useState<readonly LiveHistoryItem[]>([]);
  const itemsRef = useRef<readonly LiveHistoryItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [waitingCalls, setWaitingCalls] = useState<readonly WaitingCallInfo[]>(
    [],
  );
  const queueRef = useRef<QueuedSubmission[]>([]);
  // queueRef stays the synchronous source — a turn drains and restores within
  // one tick, before any render. This mirror only exists to be displayed.
  const [queue, setQueue] = useState<readonly string[]>([]);
  const syncQueue = useCallback(
    () =>
      setQueue(
        queueRef.current.map(
          ({ text, displayText, imagePaths }) =>
            displayText ?? (text || `[${imagePaths?.length ?? 0} image]`),
        ),
      ),
    [],
  );
  const abortRef = useRef<AbortController | null>(null);
  const skipRetryDelayRef = useRef<(() => void) | undefined>(undefined);
  const failedRequestRef = useRef<{
    request: PreparedLiveRequest;
    promptId: string;
    options?: OpenTuiSubmitOptions;
  } | null>(null);
  const activeTurnRef = useRef<{
    seq: number;
    prompt?: OpenTuiInputSubmission;
    toolStarted: boolean;
    meaningfulContent: boolean;
    canUndoLog: boolean;
    // Set by Esc or another interrupt, even after a Mod ended the turn.
    interrupted?: boolean;
    onCancelSettled?: OpenTuiCancelSettled;
  } | null>(null);
  const mountedRef = useRef(true);

  const streamingRef = useRef(false);
  // Output chars streamed this turn (ink streamingResponseLengthRef parity):
  // the loading indicator divides by 4 to estimate tokens and polls this ref,
  // so per-delta events must not re-render anything.
  const streamingCharsRef = useRef(0);
  const receivingRef = useRef(false);
  const [isReceivingContent, setIsReceivingContent] = useState(false);
  // Generation counter: resetTranscript invalidates the in-flight turn so
  // its late events, settles, and queue resubmits cannot touch the fresh
  // transcript (P2-2).
  const turnSeqRef = useRef(0);
  // Render-synced mirror: resetTranscript reads parked calls synchronously.
  const waitingCallsRef = useRef<readonly WaitingCallInfo[]>([]);
  waitingCallsRef.current = waitingCalls;

  const [, setExecutingShells] = useState<readonly ExecutingShellCall[]>([]);
  const executingShellsRef = useRef<readonly ExecutingShellCall[]>([]);
  const updateExecutingShells = useCallback(
    (calls: readonly ExecutingShellCall[]) => {
      executingShellsRef.current = calls;
      setExecutingShells(calls);
    },
    [],
  );
  const getForegroundShell = useCallback((): ForegroundShellOwner | null => {
    if (
      !mountedRef.current ||
      !activeTurnRef.current ||
      abortRef.current?.signal.aborted
    )
      return null;
    const shells = executingShellsRef.current.filter(
      (call) =>
        call.pid !== undefined &&
        call.pid > 0 &&
        !call.promoteAbortController?.signal.aborted,
    );
    return shells.length === 1
      ? {
          callId: shells[0].callId,
          pid: shells[0].pid!,
          turn: turnSeqRef.current,
        }
      : null;
  }, []);
  const ownsShell = useCallback(
    (owner: ForegroundShellOwner) => {
      const current = getForegroundShell();
      return (
        current !== null &&
        current.callId === owner.callId &&
        current.pid === owner.pid &&
        current.turn === owner.turn
      );
    },
    [getForegroundShell],
  );
  const promoteShellToBackground = useCallback(() => {
    if (
      !mountedRef.current ||
      !activeTurnRef.current ||
      abortRef.current?.signal.aborted
    )
      return false;
    const shells = executingShellsRef.current.filter(
      (call) =>
        call.promoteAbortController &&
        !call.promoteAbortController.signal.aborted,
    );
    if (shells.length !== 1) return false;
    shells[0].promoteAbortController!.abort({ kind: 'background' });
    updateExecutingShells(
      executingShellsRef.current.filter((call) => call !== shells[0]),
    );
    return true;
  }, [updateExecutingShells]);
  const writeShellInput = useCallback(
    (owner: ForegroundShellOwner, input: string) => {
      if (!ownsShell(owner)) return false;
      ShellExecutionService.writeToPty(owner.pid, input);
      return true;
    },
    [ownsShell],
  );
  const resizeShell = useCallback(
    (owner: ForegroundShellOwner, columns: number, rows: number) => {
      if (!ownsShell(owner)) return false;
      ShellExecutionService.resizePty(owner.pid, columns, rows);
      return true;
    },
    [ownsShell],
  );
  const scrollShell = useCallback(
    (owner: ForegroundShellOwner, lines: number) => {
      if (!ownsShell(owner)) return false;
      ShellExecutionService.scrollPty(owner.pid, lines);
      return true;
    },
    [ownsShell],
  );

  const setBusy = useCallback((busy: boolean) => {
    if (streamingRef.current === busy) return;
    streamingRef.current = busy;
    setStreaming(busy);
  }, []);

  const setReceiving = useCallback((receiving: boolean) => {
    if (receivingRef.current === receiving) return;
    receivingRef.current = receiving;
    setIsReceivingContent(receiving);
  }, []);

  const apply = useCallback((ev: OpenTuiStreamEvent) => {
    if (!mountedRef.current) return;
    itemsRef.current = foldLiveEvent(itemsRef.current, ev);
    setItems(itemsRef.current);
    return itemsRef.current;
  }, []);

  const pushQueue = useCallback(
    (submission: QueuedSubmission) => {
      queueRef.current.push(submission);
      syncQueue();
    },
    [syncQueue],
  );

  const drainQueue = useCallback((): OpenTuiSteeringSubmission[] => {
    const drained = queueRef.current.filter((entry) => !entry.deferUntilIdle);
    queueRef.current = queueRef.current.filter((entry) => entry.deferUntilIdle);
    syncQueue();
    return drained;
  }, [syncQueue]);

  const restoreQueue = useCallback(
    (submissions: readonly OpenTuiSteeringSubmission[]) => {
      if (submissions.length === 0) return;
      queueRef.current = [...submissions, ...queueRef.current];
      syncQueue();
    },
    [syncQueue],
  );

  const popQueue = useCallback((): OpenTuiInputSubmission | null => {
    const entries = queueRef.current.filter((entry) => !entry.generated);
    if (entries.length === 0) return null;
    // U-11 (ink aggregateUserMessages parity): the Esc restore joins with a
    // blank line, not a single newline. Generated command payloads cannot
    // be reconstructed as editable composer text, so they remain queued.
    queueRef.current = queueRef.current.filter((entry) => entry.generated);
    syncQueue();
    return restoreInputSubmissions(entries);
  }, [syncQueue]);

  const runTurn = useCallback(
    async (
      prompt: PartListUnion,
      promptId: string,
      turnOptions?: OpenTuiSubmitOptions,
      editablePrompt?: OpenTuiInputSubmission,
      retry?: PreparedLiveRequest,
    ) => {
      const seq = ++turnSeqRef.current;
      const active: NonNullable<typeof activeTurnRef.current> = {
        seq,
        prompt: editablePrompt,
        toolStarted: turnOptions?.toolCall !== undefined,
        meaningfulContent: false,
        canUndoLog: Boolean(editablePrompt && logger),
      };
      activeTurnRef.current = active;
      const abort = new AbortController();
      abortRef.current = abort;
      // The Mods hear the turn from its admission to its end below.
      const mods = getInteractiveModSession(config);
      let modTurn: ModTurn | undefined;
      let modEnded = false;
      // Declining every tool ends the turn as a cancel, as it does in ink.
      let toolsCancelled = false;
      // A runTurn is a new user query, so the counter restarts; tool-result
      // continuations happen inside this same loop and keep accumulating.
      streamingCharsRef.current = 0;
      setReceiving(false);
      setBusy(true);
      let prepared: PreparedLiveRequest | undefined;
      let failed = false;
      failedRequestRef.current = null;
      skipRetryDelayRef.current = undefined;
      try {
        if (editablePrompt && logger) {
          await logger.logMessage(
            MessageSenderType.USER,
            editablePrompt.displayText ??
              editablePrompt.submittedPrompt ??
              editablePrompt.text,
          );
        }
        if (seq !== turnSeqRef.current || abort.signal.aborted) return;
        for await (const ev of livePromptEvents(config, prompt, abort.signal, {
          promptId,
          checkpointHistory: {
            allocateId: () => allocateCanonicalHistoryId(itemsRef.current),
            snapshot: () =>
              snapshotCanonicalHistory(
                itemsRef.current.filter(
                  (item) =>
                    item.canonicalPending !== true &&
                    !(item.kind === 'assistant' && item.streaming) &&
                    !(item.kind === 'thinking' && !item.done) &&
                    !(item.kind === 'tool' && !item.done),
                ),
              ),
          },
          dualOutput,
          modelOverride: turnOptions?.modelOverride,
          toolCall: turnOptions?.toolCall,
          retry,
          onAcceptedSteering: (messages) => {
            if (seq !== turnSeqRef.current) return;
            active.canUndoLog = false;
            for (const message of messages) {
              void logger
                ?.logMessage(MessageSenderType.USER, message)
                .catch((error: unknown) =>
                  debugLogger.debug('Could not log steering input', error),
                );
            }
          },
          onPreparedRequest: (request) => {
            if (seq === turnSeqRef.current) prepared = request;
          },
          submittedPrompt: turnOptions?.submittedPrompt,
          humanInput: turnOptions?.humanInput,
          workflowModeEligible: editablePrompt !== undefined,
          refreshContextFilesOnWrite: turnOptions?.refreshContextFilesOnWrite,
          isCurrentTurn: () => seq === turnSeqRef.current,
          ...(mods && {
            onPromptAdmitted: () => {
              // A retry, like ink's, has no typed prompt.
              modTurn = mods.startTurn(
                retry
                  ? ''
                  : (turnOptions?.humanInput?.text ??
                      turnOptions?.submittedPrompt ??
                      ''),
                abort.signal,
                () => {
                  if (abort.signal.aborted) return false;
                  // Ends the turn as Esc does; nothing returns to the composer.
                  modEnded = true;
                  abort.abort();
                  return true;
                },
                promptId,
              );
            },
            onStreamEvent: (event: ServerLlmStreamEvent) => modTurn?.saw(event),
            onToolsCancelled: () => {
              toolsCancelled = true;
            },
          }),
          drainSteering: () => (seq === turnSeqRef.current ? drainQueue() : []),
          restoreSteering: (submissions) => {
            if (seq === turnSeqRef.current) restoreQueue(submissions);
          },
          onExecutingShells: (calls) => {
            if (mountedRef.current && seq === turnSeqRef.current) {
              updateExecutingShells(abort.signal.aborted ? [] : calls);
            }
          },
          onWaitingCall: (call) => {
            if (seq !== turnSeqRef.current) return;
            active.toolStarted = true;
            setWaitingCalls((prev) =>
              prev.some((c) => c.callId === call.callId)
                ? prev
                : [...prev, call],
            );
          },
        })) {
          if (seq !== turnSeqRef.current) return;
          if (ev.type === 'retry-countdown')
            skipRetryDelayRef.current = ev.skipDelay;
          if (
            ev.type === 'retry-countdown-clear' ||
            ev.type === 'error' ||
            ev.type === 'done'
          )
            skipRetryDelayRef.current = undefined;
          if (ev.type === 'error') failed = true;
          // ink counts model text, thoughts and tool-args JSON toward the
          // token estimate, but only model text means content is arriving.
          // Tool output is tool-generated, so it counts nowhere.
          if (ev.type === 'tool-start') active.toolStarted = true;
          if (
            (ev.type === 'text' && ev.delta.length > 0) ||
            ev.type === 'image'
          )
            active.meaningfulContent = true;
          switch (ev.type) {
            case 'text':
              streamingCharsRef.current += ev.delta.length;
              setReceiving(true);
              break;
            case 'thinking':
              streamingCharsRef.current += ev.delta.length;
              break;
            case 'tool-args':
              streamingCharsRef.current += ev.args.length;
              break;
            case 'tool-end':
              // The results go back to the model here, so the next API call
              // starts with no content yet — ink's ↑ phase.
              setReceiving(false);
              break;
            default:
              break;
          }
          apply(ev);
        }
        // ink parity (use-llm-stream submitPromptOnCompleteRef): fired once
        // after the turn completes successfully, never on error/abort. The
        // abort paths inside the generator end it with a normal return, so
        // the seq guard alone cannot tell them apart — gate on the signal
        // (R6-6). A decline of every confirmation without Esc is a genuinely
        // completed turn and keeps firing.
        if (seq === turnSeqRef.current && !abort.signal.aborted && !failed) {
          void turnOptions?.onComplete?.().catch(() => {});
        }
      } catch (error) {
        failed = true;
        if (seq !== turnSeqRef.current) return;
        if (abort.signal.aborted) {
          // Esc: ink settles every open tool as interrupted.
          itemsRef.current = settleOpenTools(
            [...itemsRef.current],
            'interrupted',
          );
          setItems(itemsRef.current);
        } else {
          apply({ type: 'thinking-end' });
          apply({ type: 'segment-end' });
          apply({
            type: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        void modTurn?.complete(
          abort.signal.aborted || toolsCancelled
            ? 'aborted'
            : failed
              ? 'error'
              : undefined,
        );
        // A stale turn must not clear a successor's controller.
        if (abortRef.current === abort) abortRef.current = null;
        if (seq === turnSeqRef.current) {
          if (abort.signal.aborted) {
            apply({ type: 'thinking-end' });
            apply({ type: 'segment-end' });
          }
          skipRetryDelayRef.current = undefined;
          if (failed && prepared && !abort.signal.aborted) {
            failedRequestRef.current = {
              request: prepared,
              promptId,
              options: turnOptions,
            };
          }
          updateExecutingShells([]);
          waitingCallsRef.current = [];
          setWaitingCalls([]);
          setBusy(false);
          if (activeTurnRef.current === active) activeTurnRef.current = null;
          // An interrupt settles as a cancel whether or not a Mod ended the
          // turn first; only a Mod's end alone lets the queue go on.
          if (abort.signal.aborted && (!modEnded || active.interrupted)) {
            const settled = active.onCancelSettled;
            const queued = settled ? popQueue() : null;
            queueRef.current = queueRef.current.filter(
              (entry) => !entry.generated,
            );
            syncQueue();
            const restored = settled?.({
              kind: 'cancelled',
              queued,
              prompt: active.toolStarted ? null : (active.prompt ?? null),
            });
            if (
              restored === true &&
              !active.toolStarted &&
              !active.meaningfulContent &&
              queueRef.current.length === 0
            ) {
              const history = itemsRef.current;
              const index = history.findLastIndex(
                (item) => item.kind === 'user',
              );
              const user = history[index];
              const onlySynthetic = history
                .slice(index + 1)
                .every((item) =>
                  item.kind === 'info'
                    ? (item.historyIsSynthetic ?? true)
                    : [
                        'error',
                        'warning',
                        'retry',
                        'thinking',
                        'away-recap',
                        'stop-hook',
                      ].includes(item.kind),
                );
              if (
                user?.kind === 'user' &&
                user.promptId === promptId &&
                user.text ===
                  (active.prompt?.displayText ?? active.prompt?.text) &&
                onlySynthetic
              ) {
                itemsRef.current = history.slice(0, index);
                setItems(itemsRef.current);
                config
                  .getLlmClient()
                  ?.stripOrphanedUserEntriesFromHistory(true);
                if (active.canUndoLog)
                  void logger
                    ?.removeLastUserMessage()
                    .catch((error: unknown) =>
                      debugLogger.debug(
                        'Could not undo cancelled input log',
                        error,
                      ),
                    );
              }
            }
          } else {
            // A declined read consumes only its own queued submission.
            // Explicit aborts above never start another turn.
            const rest = queueRef.current;
            if (rest.length > 0) {
              const [entry, ...remaining] = rest;
              queueRef.current = remaining;
              syncQueue();
              const promptId =
                entry.turnOptions?.promptId ?? nextLivePromptId(config);
              if (!entry.turnOptions?.invocationEchoed) {
                apply({
                  type: 'user',
                  text: entry.displayText ?? entry.text,
                  ...(entry.pasteExpansions?.size
                    ? {
                        recallText: expandPendingPastePlaceholders(
                          entry.displayText ?? entry.text,
                          entry.pasteExpansions,
                        ),
                      }
                    : {}),
                  promptId,
                  sentToModel: true,
                });
              }
              // ink keeps provenance for a queued submission, and the raw text
              // is what the stream layer expands `@path` mentions from.
              void runTurn(
                entry.content,
                promptId,
                entry.generated
                  ? entry.turnOptions
                  : {
                      ...entry.turnOptions,
                      humanInput: entry.humanInput,
                      displayText: entry.displayText,
                      hasUnknownInput: entry.hasUnknownInput,
                      pasteExpansions: entry.pasteExpansions,
                      submittedPrompt: entry.submittedPrompt ?? entry.text,
                    },
                entry.generated ? undefined : entry,
              );
            }
          }
        }
      }
    },
    [
      config,
      logger,
      dualOutput,
      apply,
      drainQueue,
      restoreQueue,
      setBusy,
      setReceiving,
      syncQueue,
      popQueue,
      updateExecutingShells,
    ],
  );

  const submit = useCallback(
    (
      content: PartListUnion,
      imagePaths?: readonly string[],
      options?: OpenTuiSubmitOptions,
    ): boolean => {
      if (!mountedRef.current) return false;
      let text =
        typeof content === 'string'
          ? content
          : collectText(normalizeParts(content));
      const popped = options?.restoredDraft;
      if (popped) {
        options = { ...options };
        delete options.restoredDraft;
        const displayText = options.displayText ?? text;
        if (displayText === popped.displayText) {
          content = popped.modelText;
          text = popped.modelText;
          options = {
            ...options,
            displayText: popped.displayText,
            submittedPrompt: popped.submittedPrompt,
            humanInput: popped.humanInput,
            hasUnknownInput: popped.hasUnknownInput,
            pasteExpansions: popped.pasteExpansions,
          };
        } else {
          if (popped.pasteExpansions?.size && !options.pasteExpansions?.size) {
            content = expandPendingPastePlaceholders(
              text,
              popped.pasteExpansions,
            );
            text = content;
            options.pasteExpansions = popped.pasteExpansions;
          }
          if (popped.hasUnknownInput) {
            options.humanInput = undefined;
            options.hasUnknownInput = true;
          }
        }
      }
      const { parts, notices } = imagePathsToParts(imagePaths ?? []);
      for (const notice of notices) apply({ type: 'warning', text: notice });
      if (notices.length > 0) return false;
      const prompt: PartListUnion =
        parts.length > 0 ? [...normalizeParts(content), ...parts] : content;
      if (
        !text.trim() &&
        normalizeParts(prompt).every((part) => part.text !== undefined)
      ) {
        return false;
      }
      const generated =
        options?.invocationEchoed === true ||
        options?.modelOverride !== undefined ||
        options?.refreshContextFilesOnWrite !== undefined ||
        options?.onComplete !== undefined ||
        (typeof content !== 'string' && options?.submittedPrompt === undefined);
      const inputMetadata = {
        displayText: options?.displayText,
        humanInput: options?.humanInput,
        hasUnknownInput: options?.hasUnknownInput,
        pasteExpansions: options?.pasteExpansions,
      };
      if (streamingRef.current) {
        pushQueue({
          ...inputMetadata,
          text,
          content: prompt,
          imagePaths: imagePaths ? [...imagePaths] : undefined,
          submittedPrompt: generated
            ? options?.submittedPrompt
            : (options?.submittedPrompt ?? text),
          deferUntilIdle: generated || options?.deferUntilIdle,
          turnOptions: generated
            ? options
            : { ...options, submittedPrompt: options?.submittedPrompt ?? text },
          generated,
        });
        return true;
      }
      const promptId = options?.promptId ?? nextLivePromptId(config);
      if (!options?.invocationEchoed) {
        apply({
          type: 'user',
          text: options?.displayText ?? text,
          ...(options?.pasteExpansions?.size
            ? {
                recallText: expandPendingPastePlaceholders(
                  options.displayText ?? text,
                  options.pasteExpansions,
                ),
              }
            : {}),
          promptId,
          sentToModel: true,
        });
      }
      void runTurn(
        prompt,
        promptId,
        options,
        generated
          ? undefined
          : {
              ...inputMetadata,
              text,
              imagePaths: imagePaths ? [...imagePaths] : undefined,
              submittedPrompt: options?.submittedPrompt ?? text,
            },
      );
      return true;
    },
    [config, apply, pushQueue, runTurn],
  );

  const interrupt = useCallback(
    (onSettled?: OpenTuiCancelSettled) => {
      skipRetryDelayRef.current = undefined;
      failedRequestRef.current = null;
      const active = activeTurnRef.current;
      if (active && active.seq === turnSeqRef.current) {
        active.interrupted = true;
        active.onCancelSettled ??= onSettled;
        updateExecutingShells([]);
        abortRef.current?.abort();
      } else {
        onSettled?.({ kind: 'cancelled', queued: null, prompt: null });
      }
    },
    [updateExecutingShells],
  );

  const scheduleTool = useCallback(
    (
      name: string,
      args: Record<string, unknown>,
      restoreResponseBinding?: RestoreToolResponseBinding,
    ) => {
      if (!mountedRef.current || streamingRef.current) return false;
      void runTurn([], nextLivePromptId(config), {
        toolCall: {
          name,
          args,
          ...(restoreResponseBinding ? { restoreResponseBinding } : {}),
        },
      });
      return true;
    },
    [config, runTurn],
  );

  const notifyInputProcessed = useCallback(() => {
    if (activeTurnRef.current) activeTurnRef.current.canUndoLog = false;
  }, []);

  const retryLastPrompt = useCallback(() => {
    const skip = skipRetryDelayRef.current;
    if (skip) {
      skipRetryDelayRef.current = undefined;
      apply({ type: 'retry-countdown-clear', isContinuation: true });
      skip();
      return;
    }
    if (streamingRef.current || waitingCallsRef.current.length) return;
    const failed = failedRequestRef.current;
    if (!failed) {
      apply({ type: 'info', text: 'No failed request to retry.' });
      return;
    }
    let request = failed.request;
    if (request.inlineModelOverride) {
      request = {
        ...request,
        modelOverride: undefined,
        inlineModelOverride: false,
      };
      apply({
        type: 'info',
        text: `Inline model override cleared on retry — retrying on the session model (${config.getModel()}).`,
      });
    }
    void runTurn(
      request.content,
      failed.promptId,
      failed.options,
      undefined,
      request,
    );
  }, [apply, config, runTurn]);

  const resetTranscript = useCallback(
    (events: readonly OpenTuiStreamEvent[]) => {
      const onReset = activeTurnRef.current?.onCancelSettled;
      skipRetryDelayRef.current = undefined;
      failedRequestRef.current = null;
      // Commit the accepted partial before invalidating its generation; a late
      // finally must not finalize the successor adapter.
      dualOutput?.finalizeAssistantMessage();
      turnSeqRef.current += 1;
      activeTurnRef.current = null;
      const abort = abortRef.current;
      abortRef.current = null;
      // Settle parked confirmations as Cancel so the scheduler's queue wakes
      // and its completion callback fires — otherwise the generator parks
      // forever (P2-3). Post-abort answers are treated as Cancel anyway
      // (coreToolScheduler handleConfirmationResponse).
      for (const call of waitingCallsRef.current) {
        void call.confirmationDetails
          .onConfirm(ToolConfirmationOutcome.Cancel)
          .catch(() => {});
      }
      abort?.abort();
      updateExecutingShells([]);
      queueRef.current = [];
      syncQueue();
      waitingCallsRef.current = [];
      setWaitingCalls([]);
      // Synchronous: a submit right after the reset must start a fresh turn,
      // not land in the dying one's queue.
      setBusy(false);
      itemsRef.current = foldBatch(events);
      setItems(itemsRef.current);
      onReset?.({ kind: 'reset' });
    },
    [dualOutput, setBusy, syncQueue, updateExecutingShells],
  );

  const rewindTranscript = useCallback(
    (userId: string) => {
      const index = itemsRef.current.findIndex((item) => item.id === userId);
      if (index < 0) return;
      const retained = itemsRef.current
        .slice(0, index)
        .filter((item) => item.display?.kind !== 'collapse-summary')
        .map(stripSuppressOnRestore);
      resetTranscript([]);
      itemsRef.current = retained;
      setItems(retained);
      return retained;
    },
    [resetTranscript],
  );

  const isCurrentHistory = useCallback(
    (snapshot: readonly LiveHistoryItem[]) =>
      mountedRef.current &&
      !streamingRef.current &&
      itemsRef.current === snapshot,
    [],
  );

  const settleWaitingCall = useCallback((callId: string) => {
    setWaitingCalls((prev) => prev.filter((c) => c.callId !== callId));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      executingShellsRef.current = [];
      skipRetryDelayRef.current = undefined;
      failedRequestRef.current = null;
      dualOutput?.finalizeAssistantMessage();
      turnSeqRef.current += 1;
      activeTurnRef.current = null;
      queueRef.current = [];
      abortRef.current?.abort();
    };
  }, [dualOutput]);

  return {
    items,
    streaming,
    streamingCharsRef,
    isReceivingContent,
    waitingCalls,
    foregroundShell: getForegroundShell(),
    promoteShellToBackground,
    writeShellInput,
    resizeShell,
    scrollShell,
    messageQueue: queue,
    popQueue,
    submit,
    interrupt,
    retryLastPrompt,
    notifyInputProcessed,
    scheduleTool,
    isCurrentHistory,
    rewindTranscript,
    resetTranscript,
    applyEvent: apply,
    settleWaitingCall,
  };
}
