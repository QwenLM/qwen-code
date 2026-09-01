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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import type { Config } from '@qwen-code/qwen-code-core';
import { collectText, normalizeParts } from '@qwen-code/qwen-code-core';
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
  /** Called whenever the in-flight state flips (drives host.setStreaming). */
  onStreamingChange?: (streaming: boolean) => void;
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
  /** Submits a prompt (or queues it when a turn is in flight). */
  submit(content: PartListUnion, imagePaths?: readonly string[]): void;
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
  const onStreamingChangeRef = useRef(options.onStreamingChange);
  onStreamingChangeRef.current = options.onStreamingChange;

  const setBusy = useCallback((busy: boolean) => {
    if (streamingRef.current === busy) return;
    streamingRef.current = busy;
    setStreaming(busy);
    onStreamingChangeRef.current?.(busy);
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

  const runTurn = useCallback(
    async (prompt: PartListUnion, promptId: string) => {
      const abort = new AbortController();
      abortRef.current = abort;
      setBusy(true);
      try {
        for await (const ev of livePromptEvents(config, prompt, abort.signal, {
          promptId,
          drainSteering: drainQueue,
          onWaitingCall: (call) => {
            setWaitingCalls((prev) =>
              prev.some((c) => c.callId === call.callId)
                ? prev
                : [...prev, call],
            );
          },
        })) {
          apply(ev);
        }
      } catch (error) {
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
        abortRef.current = null;
        setBusy(false);
        // Whatever survived the tool-boundary drain becomes the next turn.
        const rest = queueRef.current;
        if (rest.length > 0) {
          const text = drainQueue().join('\n');
          if (text.trim()) {
            apply({ type: 'user', text });
            void runTurn(text, nextLivePromptId(config));
          }
        }
      }
    },
    [config, apply, drainQueue, setBusy],
  );

  const submit = useCallback(
    (content: PartListUnion, imagePaths?: readonly string[]) => {
      const text =
        typeof content === 'string'
          ? content
          : collectText(normalizeParts(content));
      if (streamingRef.current) {
        // The steering queue is text-only; say so instead of losing the
        // attachments without a trace.
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
      void runTurn(prompt, promptId);
    },
    [config, apply, pushQueue, runTurn],
  );

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetTranscript = useCallback(
    (events: readonly OpenTuiStreamEvent[]) => {
      setItems(foldBatch(events));
      setWaitingCalls([]);
    },
    [],
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
