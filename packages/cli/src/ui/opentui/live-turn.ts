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

import { useCallback, useEffect, useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  collectText,
  normalizeParts,
} from '@qwen-code/qwen-code-core/services/visionBridge/image-part-utils.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { Part, PartListUnion } from '@google/genai';
import {
  foldLiveEvent,
  settleOpenTools,
  type LiveHistoryItem,
} from './live-session-model.js';
import {
  livePromptEvents,
  nextLivePromptId,
  type WaitingCallInfo,
} from './live-session.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

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
}

/**
 * Options a `submit_prompt` dispatcher outcome carries into the turn
 * (ink SubmitPromptResult parity): per-turn model override, context-file
 * memory refresh, and the post-turn callback.
 */
export interface OpenTuiSubmitOptions {
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
}

export interface OpenTuiLiveTurn {
  items: readonly LiveHistoryItem[];
  streaming: boolean;
  /** Scheduler calls parked in awaiting_approval, awaiting a dialog. */
  waitingCalls: readonly WaitingCallInfo[];
  /** Number of mid-turn prompts queued (composer queueLength parity). */
  queueLength: number;
  /** Pops the whole queue back into the composer (Esc parity). */
  popQueue(): string | null;
  /**
   * Submits a prompt (or queues it when a turn is in flight). A
   * `submit_prompt` outcome's per-turn options travel in `options`.
   */
  submit(
    content: PartListUnion,
    imagePaths?: readonly string[],
    options?: OpenTuiSubmitOptions,
  ): void;
  /** Aborts the in-flight turn (Esc). */
  interrupt(): void;
  /** Replaces the transcript from a replay batch (session switch/resume). */
  resetTranscript(events: readonly OpenTuiStreamEvent[]): void;
  /** Folds one externally produced event (update notices, startup warnings). */
  applyEvent(event: OpenTuiStreamEvent): void;
  /** Drops a waiting call after its dialog settled. */
  settleWaitingCall(callId: string): void;
}

/** Folds a replay batch into a fresh item list (single commit). */
export function foldBatch(
  events: readonly OpenTuiStreamEvent[],
): LiveHistoryItem[] {
  let items: LiveHistoryItem[] = [];
  for (const ev of events) items = foldLiveEvent(items, ev);
  return items;
}

export function useOpenTuiLiveTurn(
  options: UseOpenTuiLiveTurnOptions,
): OpenTuiLiveTurn {
  const { config } = options;
  const [items, setItems] = useState<readonly LiveHistoryItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [waitingCalls, setWaitingCalls] = useState<readonly WaitingCallInfo[]>(
    [],
  );
  const queueRef = useRef<string[]>([]);
  const [queueLength, setQueueLength] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const streamingRef = useRef(false);
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

  const apply = useCallback((ev: OpenTuiStreamEvent) => {
    setItems((prev) => foldLiveEvent(prev, ev));
  }, []);

  const pushQueue = useCallback((text: string) => {
    queueRef.current.push(text);
    setQueueLength(queueRef.current.length);
  }, []);

  const drainQueue = useCallback((): string[] => {
    const drained = queueRef.current;
    queueRef.current = [];
    setQueueLength(0);
    return drained;
  }, []);

  const restoreQueue = useCallback((texts: readonly string[]) => {
    const restored = texts.map((text) => text.trim()).filter(Boolean);
    if (restored.length === 0) return;
    queueRef.current = [...restored, ...queueRef.current];
    setQueueLength(queueRef.current.length);
  }, []);

  const runTurn = useCallback(
    async (
      prompt: PartListUnion,
      promptId: string,
      turnOptions?: OpenTuiSubmitOptions,
    ) => {
      const seq = ++turnSeqRef.current;
      const abort = new AbortController();
      abortRef.current = abort;
      setBusy(true);
      try {
        for await (const ev of livePromptEvents(config, prompt, abort.signal, {
          promptId,
          modelOverride: turnOptions?.modelOverride,
          submittedPrompt: turnOptions?.submittedPrompt,
          refreshContextFilesOnWrite: turnOptions?.refreshContextFilesOnWrite,
          drainSteering: drainQueue,
          restoreSteering: restoreQueue,
          onWaitingCall: (call) => {
            if (seq !== turnSeqRef.current) return;
            setWaitingCalls((prev) =>
              prev.some((c) => c.callId === call.callId)
                ? prev
                : [...prev, call],
            );
          },
        })) {
          if (seq !== turnSeqRef.current) return;
          apply(ev);
        }
        // ink parity (use-llm-stream submitPromptOnCompleteRef): fired once
        // after the turn completes successfully, never on error/abort.
        if (seq === turnSeqRef.current) {
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
          setBusy(false);
          // One queued submission per chained turn: a decline (e.g. an abort
          // landing inside an @-expansion read) must consume only its own
          // submission — the rest stay queued for the following boundaries,
          // matching ink's pop-one-submission-per-settle drain.
          const rest = queueRef.current;
          if (rest.length > 0) {
            const [text, ...remaining] = rest;
            queueRef.current = remaining;
            setQueueLength(remaining.length);
            apply({ type: 'user', text });
            // ink keeps provenance for a queued submission, and the raw text
            // is what the stream layer expands `@path` mentions from.
            void runTurn(text, nextLivePromptId(config), {
              submittedPrompt: text,
            });
          }
        }
      }
    },
    [config, apply, drainQueue, restoreQueue, setBusy],
  );

  const submit = useCallback(
    (
      content: PartListUnion,
      imagePaths?: readonly string[],
      options?: OpenTuiSubmitOptions,
    ) => {
      const text =
        typeof content === 'string'
          ? content
          : collectText(normalizeParts(content));
      if (streamingRef.current) {
        // The steering queue is text-only; say so instead of losing the
        // attachments without a trace. Per-turn options ride on the queued
        // text's own submit_prompt, never on the steering drain.
        if (imagePaths && imagePaths.length > 0) {
          apply({
            type: 'warning',
            text: 'Image attachments cannot be queued mid-turn and were dropped.',
          });
        }
        if (text.trim()) pushQueue(text);
        return;
      }
      const { parts, notices } = imagePathsToParts(imagePaths ?? []);
      for (const notice of notices) apply({ type: 'warning', text: notice });
      const prompt: PartListUnion =
        parts.length > 0 ? [{ text }, ...parts] : content;
      const promptId = nextLivePromptId(config);
      apply({ type: 'user', text, promptId, sentToModel: true });
      void runTurn(prompt, promptId, options);
    },
    [config, apply, pushQueue, runTurn],
  );

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetTranscript = useCallback(
    (events: readonly OpenTuiStreamEvent[]) => {
      // Invalidate the in-flight generation first: its late events and
      // settles are dead on arrival (P2-2).
      turnSeqRef.current += 1;
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
      setQueueLength(0);
      waitingCallsRef.current = [];
      setWaitingCalls([]);
      // Synchronous: a submit right after the reset must start a fresh turn,
      // not land in the dying one's queue.
      setBusy(false);
      setItems(foldBatch(events));
    },
    [setBusy],
  );

  const settleWaitingCall = useCallback((callId: string) => {
    setWaitingCalls((prev) => prev.filter((c) => c.callId !== callId));
  }, []);

  const popQueue = useCallback((): string | null => {
    if (queueRef.current.length === 0) return null;
    return drainQueue().join('\n');
  }, [drainQueue]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    items,
    streaming,
    waitingCalls,
    queueLength,
    popQueue,
    submit,
    interrupt,
    resetTranscript,
    applyEvent: apply,
    settleWaitingCall,
  };
}
