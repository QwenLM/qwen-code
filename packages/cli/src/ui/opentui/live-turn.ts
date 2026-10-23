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

import { expandPendingPastePlaceholders } from '../utils/paste-placeholders.js';
import type { HumanPromptInput } from '@qwen-code/qwen-code-core/core/workflow-intent.js';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { readFileSync } from 'node:fs';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  collectText,
  normalizeParts,
} from '@qwen-code/qwen-code-core/services/visionBridge/image-part-utils.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { Part, PartListUnion } from '@google/genai';
import type { DualOutputBridge } from '../../dualOutput/DualOutputBridge.js';
import {
  foldLiveEvent,
  settleOpenTools,
  type LiveHistoryItem,
} from './live-session-model.js';
import {
  livePromptEvents,
  nextLivePromptId,
  type OpenTuiSteeringSubmission,
  type WaitingCallInfo,
} from './live-session.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import {
  restoreInputSubmissions,
  type OpenTuiRestoredDraft,
  type OpenTuiInputSubmission,
  type OpenTuiCancelSettled,
} from './input-submission.js';

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
}

/**
 * Options a `submit_prompt` dispatcher outcome carries into the turn
 * (ink SubmitPromptResult parity): per-turn model override, context-file
 * memory refresh, and the post-turn callback.
 */
export interface OpenTuiSubmitOptions {
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
  /** Replaces the transcript from a replay batch (session switch/resume). */
  resetTranscript(events: readonly OpenTuiStreamEvent[]): void;
  /** Folds one externally produced event (update notices, startup warnings). */
  applyEvent(event: OpenTuiStreamEvent): void;
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
  const { config, dualOutput } = options;
  const [items, setItems] = useState<readonly LiveHistoryItem[]>([]);
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
  const activeTurnRef = useRef<{
    seq: number;
    prompt?: OpenTuiInputSubmission;
    toolStarted: boolean;
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
    setItems((prev) => foldLiveEvent(prev, ev));
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
    ) => {
      const seq = ++turnSeqRef.current;
      const active: NonNullable<typeof activeTurnRef.current> = {
        seq,
        prompt: editablePrompt,
        toolStarted: false,
      };
      activeTurnRef.current = active;
      const abort = new AbortController();
      abortRef.current = abort;
      // A runTurn is a new user query, so the counter restarts; tool-result
      // continuations happen inside this same loop and keep accumulating.
      streamingCharsRef.current = 0;
      setReceiving(false);
      setBusy(true);
      try {
        for await (const ev of livePromptEvents(config, prompt, abort.signal, {
          promptId,
          dualOutput,
          modelOverride: turnOptions?.modelOverride,
          submittedPrompt: turnOptions?.submittedPrompt,
          humanInput: turnOptions?.humanInput,
          refreshContextFilesOnWrite: turnOptions?.refreshContextFilesOnWrite,
          isCurrentTurn: () => seq === turnSeqRef.current,
          drainSteering: () => (seq === turnSeqRef.current ? drainQueue() : []),
          restoreSteering: (submissions) => {
            if (seq === turnSeqRef.current) restoreQueue(submissions);
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
          // ink counts model text, thoughts and tool-args JSON toward the
          // token estimate, but only model text means content is arriving.
          // Tool output is tool-generated, so it counts nowhere.
          if (ev.type === 'tool-start') active.toolStarted = true;
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
        if (seq === turnSeqRef.current && !abort.signal.aborted) {
          void turnOptions?.onComplete?.().catch(() => {});
        }
      } catch (error) {
        if (seq !== turnSeqRef.current) return;
        if (abort.signal.aborted) {
          // Esc: ink settles every open tool as interrupted.
          setItems((prev) => settleOpenTools([...prev], 'interrupted'));
        } else {
          apply({
            type: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        // A stale turn must not clear a successor's controller.
        if (abortRef.current === abort) abortRef.current = null;
        if (seq === turnSeqRef.current) {
          waitingCallsRef.current = [];
          setWaitingCalls([]);
          setBusy(false);
          if (activeTurnRef.current === active) activeTurnRef.current = null;
          if (abort.signal.aborted) {
            const settled = active.onCancelSettled;
            const queued = settled ? popQueue() : null;
            queueRef.current = queueRef.current.filter(
              (entry) => !entry.generated,
            );
            syncQueue();
            settled?.({
              kind: 'cancelled',
              queued,
              prompt: active.toolStarted ? null : (active.prompt ?? null),
            });
          } else {
            // A declined read consumes only its own queued submission.
            // Explicit aborts above never start another turn.
            const rest = queueRef.current;
            if (rest.length > 0) {
              const [entry, ...remaining] = rest;
              queueRef.current = remaining;
              syncQueue();
              const promptId = nextLivePromptId(config);
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
      dualOutput,
      apply,
      drainQueue,
      restoreQueue,
      setBusy,
      setReceiving,
      syncQueue,
      popQueue,
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
      const promptId = nextLivePromptId(config);
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

  const interrupt = useCallback((onSettled?: OpenTuiCancelSettled) => {
    const active = activeTurnRef.current;
    if (active && active.seq === turnSeqRef.current) {
      active.onCancelSettled ??= onSettled;
      abortRef.current?.abort();
    } else {
      onSettled?.({ kind: 'cancelled', queued: null, prompt: null });
    }
  }, []);

  const resetTranscript = useCallback(
    (events: readonly OpenTuiStreamEvent[]) => {
      const onReset = activeTurnRef.current?.onCancelSettled;
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
      queueRef.current = [];
      syncQueue();
      waitingCallsRef.current = [];
      setWaitingCalls([]);
      // Synchronous: a submit right after the reset must start a fresh turn,
      // not land in the dying one's queue.
      setBusy(false);
      setItems(foldBatch(events));
      onReset?.({ kind: 'reset' });
    },
    [dualOutput, setBusy, syncQueue],
  );

  const settleWaitingCall = useCallback((callId: string) => {
    setWaitingCalls((prev) => prev.filter((c) => c.callId !== callId));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
    messageQueue: queue,
    popQueue,
    submit,
    interrupt,
    resetTranscript,
    applyEvent: apply,
    settleWaitingCall,
  };
}
