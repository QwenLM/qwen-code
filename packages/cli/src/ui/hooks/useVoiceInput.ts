/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { Command, keyMatchers } from '../keyMatchers.js';
import type { HistoryItemWithoutId } from '../types.js';
import type { VoiceStreamSession } from '../voice/voiceStreamSession.js';
import type { Key } from './useKeypress.js';

export interface RecordedVoiceAudio {
  data: Uint8Array;
  mimeType: string;
}

export interface VoiceRecorderStartOptions {
  /** Enable amplitude-based auto-stop after sustained silence (tap mode). */
  silenceDetection?: boolean;
  /** Invoked if the recorder stops itself (silence detected) before stop(). */
  onAutoStop?: () => void;
}

export type MicrophonePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface VoiceRecorder {
  start: (options?: VoiceRecorderStartOptions) => Promise<void> | void;
  stop: () => Promise<RecordedVoiceAudio>;
  /** Optional: pre-load the backend so the first start() isn't cold. */
  warmup?: () => void | Promise<void>;
  /** Optional: query OS microphone permission (macOS TCC). */
  microphoneStatus?: () => Promise<MicrophonePermission>;
  /** Optional (streaming): return & clear PCM captured since the last call. */
  drain?: () => Uint8Array;
  /** Optional: whether this recorder can provide streaming PCM chunks. */
  supportsStreaming?: () => boolean;
  /** Optional: recent input level 0..1 for the waveform. */
  audioLevel?: () => number;
}

export type VoiceTranscriber = (
  audio: RecordedVoiceAudio,
  context: { voiceModel: string },
) => Promise<string>;

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing';

/** hold = hold-to-talk (release stops, dictation only). tap = tap to start, tap/silence to stop+submit. */
export type VoiceInputMode = 'hold' | 'tap';

const VOICE_ERROR_RETRY_DELAY_MS = 2000;
const PREVIOUS_STOP_WAIT_TIMEOUT_MS = 5000;
// Terminals emit no key-up event. In hold mode we infer release from the gap
// between auto-repeat keypresses: arm a longer timer on first press (covers the
// OS initial-repeat delay), then a short timer on each repeat. When repeats stop
// (key released) the timer fires and we finalize. Requires terminal key repeat.
// Kept above typical OS initial key-repeat delays so a held key isn't cut off
// before its first auto-repeat arrives (which would truncate the utterance).
const HOLD_FIRST_PRESS_RELEASE_MS = 800;
const HOLD_REPEAT_RELEASE_MS = 250;
const debugLogger = createDebugLogger('VOICE_INPUT');

interface UseVoiceInputArgs {
  enabled: boolean;
  mode?: VoiceInputMode;
  voiceModel?: string;
  buffer: Pick<TextBuffer, 'text' | 'insert'>;
  addItem?: (item: HistoryItemWithoutId, timestamp: number) => void;
  createRecorder: () => VoiceRecorder;
  transcribe: VoiceTranscriber;
  /** Called after a tap-mode transcript is inserted, to submit the prompt. */
  onSubmit?: () => void;
  /** Pre-load the recorder backend when voice turns on (avoids cold-start race). */
  warmup?: () => void | Promise<void>;
  /** Enable live streaming transcription (requires openStream + a drain-capable recorder). */
  streaming?: boolean;
  /** Open a streaming session; the hook pumps drained PCM into it while recording. */
  openStream?: (callbacks: {
    onInterim: (text: string) => void;
    onError?: (error: Error) => void;
  }) => Promise<VoiceStreamSession>;
}

interface UseVoiceInputReturn {
  status: VoiceInputStatus;
  /** Live partial transcript during streaming (empty otherwise). */
  interimText: string;
  /** Recent input level 0..1 during recording (for a waveform). */
  audioLevel: number;
  handleKeypress: (key: Key) => boolean;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForPreviousStop(stopPromise: Promise<void> | null): Promise<void> {
  if (!stopPromise) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PREVIOUS_STOP_WAIT_TIMEOUT_MS);
    void stopPromise
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

function insertTranscript(
  buffer: Pick<TextBuffer, 'text' | 'insert'>,
  transcript: string,
): boolean {
  const text = transcript.trim();
  if (!text) {
    return false;
  }
  const needsSpace = buffer.text.length > 0 && !/\s$/.test(buffer.text);
  buffer.insert(needsSpace ? ` ${text}` : text);
  return true;
}

function isCancelKey(key: Key): boolean {
  return key.name === 'escape' || (key.ctrl && key.name === 'c');
}

function logRecorderStopError(error: unknown): void {
  debugLogger.warn('[voice] recorder stop failed:', error);
}

export function useVoiceInput({
  enabled,
  mode = 'hold',
  voiceModel,
  buffer,
  addItem,
  createRecorder,
  transcribe,
  onSubmit,
  warmup,
  streaming,
  openStream,
}: UseVoiceInputArgs): UseVoiceInputReturn {
  const [status, setStatus] = useState<VoiceInputStatus>('idle');
  const [interimText, setInterimText] = useState('');
  const [audioLevel, setAudioLevelState] = useState(0);
  const statusRef = useRef<VoiceInputStatus>('idle');
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const retryAfterErrorAtRef = useRef(0);
  const mountedRef = useRef(true);
  const cancelRecordingRef = useRef<() => void>(() => {});
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeRef = useRef<(submit: boolean) => void>(() => {});
  const streamSessionRef = useRef<VoiceStreamSession | null>(null);
  const streamSessionPromiseRef = useRef<Promise<VoiceStreamSession> | null>(
    null,
  );
  const pumpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef(0);

  const isStreaming = streaming === true && typeof openStream === 'function';

  const clearPump = useCallback(() => {
    if (pumpTimerRef.current) {
      clearInterval(pumpTimerRef.current);
      pumpTimerRef.current = null;
    }
  }, []);

  const resetStreamUi = useCallback(() => {
    if (mountedRef.current) {
      setInterimText('');
      setAudioLevelState(0);
    }
  }, []);

  const setVoiceStatus = useCallback((next: VoiceInputStatus) => {
    statusRef.current = next;
    if (mountedRef.current) {
      setStatus(next);
    }
  }, []);

  const clearReleaseTimer = useCallback(() => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);

  const reportError = useCallback(
    (error: unknown) => {
      retryAfterErrorAtRef.current = Date.now() + VOICE_ERROR_RETRY_DELAY_MS;
      addItem?.(
        {
          type: 'error',
          text: `Voice transcription failed: ${formatError(error)}`,
        },
        Date.now(),
      );
    },
    [addItem],
  );

  const stopRecorderQuietly = useCallback(async (recorder: VoiceRecorder) => {
    try {
      await recorder.stop();
    } catch (error) {
      logRecorderStopError(error);
    }
  }, []);

  const isCurrentSession = useCallback(
    (recorder: VoiceRecorder, sessionId: number) =>
      recorderRef.current === recorder && sessionIdRef.current === sessionId,
    [],
  );

  const handleStreamError = useCallback(
    (recorder: VoiceRecorder, sessionId: number, error: Error) => {
      if (!isCurrentSession(recorder, sessionId)) {
        return;
      }
      clearReleaseTimer();
      clearPump();
      streamSessionRef.current?.abort();
      streamSessionRef.current = null;
      streamSessionPromiseRef.current = null;
      recorderRef.current = null;
      startPromiseRef.current = null;
      void stopRecorderQuietly(recorder);
      setVoiceStatus('idle');
      resetStreamUi();
      reportError(error);
    },
    [
      clearPump,
      clearReleaseTimer,
      isCurrentSession,
      reportError,
      resetStreamUi,
      setVoiceStatus,
      stopRecorderQuietly,
    ],
  );

  const startRecording = useCallback(
    (silenceDetection: boolean) => {
      const recorder = createRecorder();
      const sessionId = ++sessionIdRef.current;
      recorderRef.current = recorder;
      setVoiceStatus('recording');
      if (mountedRef.current) {
        setInterimText('');
        setAudioLevelState(0);
      }
      const startPromise = waitForPreviousStop(stopPromiseRef.current)
        .then(() =>
          Promise.resolve(
            recorder.start({
              silenceDetection,
              onAutoStop: () => finalizeRef.current(true),
            }),
          ),
        )
        .then(async () => {
          // Streaming: open the WS session and pump drained PCM into it while
          // recording, surfacing partial transcripts live.
          if (!isStreaming || !isCurrentSession(recorder, sessionId)) {
            return;
          }
          if (recorder.supportsStreaming?.() === false) {
            throw new Error(
              'Streaming voice transcription requires native audio capture. Install/rebuild @qwen-code/audio-capture or switch voiceModel to qwen3-asr-flash for batch transcription.',
            );
          }
          const streamPromise = openStream!({
            onInterim: (text) => {
              if (mountedRef.current && isCurrentSession(recorder, sessionId)) {
                setInterimText(text);
              }
            },
            onError: (error) => handleStreamError(recorder, sessionId, error),
          });
          streamSessionPromiseRef.current = streamPromise;
          const session = await streamPromise;
          if (!isCurrentSession(recorder, sessionId)) {
            session.abort();
            void stopRecorderQuietly(recorder);
            return;
          }
          streamSessionRef.current = session;
          if (statusRef.current !== 'recording') {
            return;
          }
          pumpTimerRef.current = setInterval(() => {
            try {
              if (!isCurrentSession(recorder, sessionId)) return;
              const active = recorderRef.current;
              if (!active) return;
              const pcm = active.drain?.();
              if (pcm && pcm.length > 0) session.pushAudio(pcm);
              const level = active.audioLevel?.();
              if (typeof level === 'number' && mountedRef.current) {
                setAudioLevelState(level);
              }
            } catch (error) {
              clearPump();
              clearReleaseTimer();
              const pendingStreamPromise = streamSessionRef.current
                ? null
                : streamSessionPromiseRef.current;
              streamSessionRef.current?.abort();
              streamSessionRef.current = null;
              streamSessionPromiseRef.current = null;
              void pendingStreamPromise
                ?.then((pendingSession) => pendingSession.abort())
                .catch(() => {});
              const active = recorderRef.current;
              recorderRef.current = null;
              startPromiseRef.current = null;
              if (active) {
                void stopRecorderQuietly(active);
              }
              setVoiceStatus('idle');
              resetStreamUi();
              reportError(error);
            }
          }, 100);
        });
      startPromiseRef.current = startPromise;
      void startPromise.catch((error: unknown) => {
        if (
          isCurrentSession(recorder, sessionId) &&
          statusRef.current === 'recording'
        ) {
          recorderRef.current = null;
          startPromiseRef.current = null;
          clearReleaseTimer();
          clearPump();
          void stopRecorderQuietly(recorder);
          streamSessionRef.current?.abort();
          streamSessionRef.current = null;
          void streamSessionPromiseRef.current
            ?.then((session) => session.abort())
            .catch(() => {});
          streamSessionPromiseRef.current = null;
          setVoiceStatus('idle');
          resetStreamUi();
          if (!(error instanceof Error && /empty audio/i.test(error.message))) {
            reportError(error);
          }
        }
      });
    },
    [
      clearPump,
      clearReleaseTimer,
      createRecorder,
      handleStreamError,
      isCurrentSession,
      isStreaming,
      openStream,
      reportError,
      resetStreamUi,
      setVoiceStatus,
      stopRecorderQuietly,
    ],
  );

  // Stop the active recorder, transcribe, and insert. In tap mode (submit) the
  // prompt is auto-submitted; in hold mode the transcript is inserted only.
  const finalize = useCallback(
    (submit: boolean) => {
      const recorder = recorderRef.current;
      // Single-shot guard: a tap-stop and the native silence auto-stop can both
      // fire. setVoiceStatus below flips statusRef synchronously, so the second
      // concurrent call sees a non-'recording' status here and bails — avoiding
      // a double recorder.stop() and the spurious "transcription failed" error.
      if (!recorder || !voiceModel || statusRef.current !== 'recording') {
        return;
      }
      const sessionId = sessionIdRef.current;
      clearReleaseTimer();
      clearPump();
      const startPromise = startPromiseRef.current ?? Promise.resolve();
      const wasStreaming = isStreaming;
      setVoiceStatus('transcribing');
      void startPromise
        .then(async () => {
          const session =
            streamSessionRef.current ??
            (wasStreaming ? await streamSessionPromiseRef.current : null);
          if (session) {
            // Push any remaining audio, tear down the device, then flush the
            // stream and await the final transcript.
            const pcm = recorder.drain?.();
            if (pcm && pcm.length > 0) session.pushAudio(pcm);
            await stopRecorderQuietly(recorder);
            return session.finish();
          }
          const audio = await recorder.stop();
          return transcribe(audio, { voiceModel });
        })
        .then((transcript) => {
          if (!mountedRef.current || !isCurrentSession(recorder, sessionId)) {
            return;
          }
          const inserted = insertTranscript(buffer, transcript);
          if (submit && inserted) {
            onSubmit?.();
          }
        })
        .catch((error: unknown) => {
          if (!isCurrentSession(recorder, sessionId)) {
            return;
          }
          if (wasStreaming) {
            void stopRecorderQuietly(recorder);
          }
          // A too-short/empty capture (quick tap, or cold-start race) isn't a
          // real failure — silently return to idle instead of a scary error.
          if (error instanceof Error && /empty audio/i.test(error.message)) {
            return;
          }
          reportError(error);
        })
        .finally(() => {
          if (!isCurrentSession(recorder, sessionId)) return;
          recorderRef.current = null;
          streamSessionRef.current = null;
          streamSessionPromiseRef.current = null;
          startPromiseRef.current = null;
          setVoiceStatus('idle');
          resetStreamUi();
        });
    },
    [
      buffer,
      clearPump,
      clearReleaseTimer,
      isCurrentSession,
      stopRecorderQuietly,
      isStreaming,
      onSubmit,
      reportError,
      resetStreamUi,
      setVoiceStatus,
      transcribe,
      voiceModel,
    ],
  );
  finalizeRef.current = finalize;

  const cancelRecording = useCallback(() => {
    sessionIdRef.current += 1;
    clearReleaseTimer();
    clearPump();
    const session = streamSessionRef.current;
    streamSessionRef.current = null;
    session?.abort();
    void streamSessionPromiseRef.current
      ?.then((pendingSession) => pendingSession.abort())
      .catch(() => {});
    streamSessionPromiseRef.current = null;
    resetStreamUi();
    const recorder = recorderRef.current;
    setVoiceStatus('idle');
    if (!recorder) {
      return;
    }

    const startPromise = startPromiseRef.current ?? Promise.resolve();
    recorderRef.current = null;
    startPromiseRef.current = null;
    const stopPromise = startPromise
      .then(async () => {
        await recorder.stop();
      })
      .catch(logRecorderStopError)
      .finally(() => {
        if (recorderRef.current === null) {
          setVoiceStatus('idle');
        }
      });
    stopPromiseRef.current = stopPromise;
    void stopPromise.finally(() => {
      if (stopPromiseRef.current === stopPromise) {
        stopPromiseRef.current = null;
      }
    });
  }, [clearPump, clearReleaseTimer, resetStreamUi, setVoiceStatus]);
  cancelRecordingRef.current = cancelRecording;

  const armReleaseTimer = useCallback(
    (ms: number) => {
      clearReleaseTimer();
      releaseTimerRef.current = setTimeout(() => {
        releaseTimerRef.current = null;
        finalizeRef.current(false);
      }, ms);
    },
    [clearReleaseTimer],
  );

  // Preload the recorder backend when voice turns on, so the first keypress
  // isn't delayed by a cold native-module load (which would otherwise race the
  // hold-release timer and capture nothing).
  useEffect(() => {
    if (enabled && voiceModel) {
      void Promise.resolve(warmup?.()).catch(() => {});
    }
  }, [enabled, voiceModel, warmup]);

  useEffect(() => {
    if (enabled && voiceModel) {
      return;
    }
    cancelRecording();
  }, [cancelRecording, enabled, voiceModel]);

  useEffect(() => {
    // Reset on (re)mount so StrictMode's mount→unmount→remount (active when
    // DEBUG is set) doesn't leave mountedRef stuck false, which would no-op
    // every gated setState and freeze the voice UI.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRecordingRef.current();
    };
  }, []);

  const handleKeypress = useCallback(
    (key: Key): boolean => {
      if (
        !enabled ||
        !voiceModel ||
        !keyMatchers[Command.VOICE_PUSH_TO_TALK](key)
      ) {
        if (statusRef.current !== 'idle' && isCancelKey(key)) {
          cancelRecording();
          return true;
        }
        return false;
      }

      if (statusRef.current === 'idle') {
        if (Date.now() < retryAfterErrorAtRef.current) {
          return true;
        }
        if (mode === 'hold') {
          startRecording(false);
          armReleaseTimer(HOLD_FIRST_PRESS_RELEASE_MS);
        } else {
          startRecording(true);
        }
        return true;
      }

      if (statusRef.current === 'recording') {
        if (mode === 'hold') {
          // Auto-repeat keypress while held: keep alive until repeats stop.
          armReleaseTimer(HOLD_REPEAT_RELEASE_MS);
        } else {
          finalize(true);
        }
        return true;
      }

      return true;
    },
    [
      armReleaseTimer,
      cancelRecording,
      enabled,
      finalize,
      mode,
      startRecording,
      voiceModel,
    ],
  );

  return { status, interimText, audioLevel, handleKeypress };
}
