/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
// Terminals emit no key-up event. In hold mode we infer release from the gap
// between auto-repeat keypresses: arm a longer timer on first press (covers the
// OS initial-repeat delay), then a short timer on each repeat. When repeats stop
// (key released) the timer fires and we finalize. Requires terminal key repeat.
const HOLD_FIRST_PRESS_RELEASE_MS = 600;
const HOLD_REPEAT_RELEASE_MS = 250;

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
  const retryAfterErrorAtRef = useRef(0);
  const mountedRef = useRef(true);
  const cancelRecordingRef = useRef<() => void>(() => {});
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeRef = useRef<(submit: boolean) => void>(() => {});
  const streamSessionRef = useRef<VoiceStreamSession | null>(null);
  const pumpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const startRecording = useCallback(
    (silenceDetection: boolean) => {
      const recorder = createRecorder();
      recorderRef.current = recorder;
      setVoiceStatus('recording');
      if (mountedRef.current) {
        setInterimText('');
        setAudioLevelState(0);
      }
      const startPromise = Promise.resolve(
        recorder.start({
          silenceDetection,
          onAutoStop: () => finalizeRef.current(true),
        }),
      ).then(async () => {
        // Streaming: open the WS session and pump drained PCM into it while
        // recording, surfacing partial transcripts live.
        if (!isStreaming || recorderRef.current !== recorder) {
          return;
        }
        const session = await openStream!({
          onInterim: (text) => {
            if (mountedRef.current) setInterimText(text);
          },
        });
        if (recorderRef.current !== recorder) {
          session.abort();
          return;
        }
        streamSessionRef.current = session;
        pumpTimerRef.current = setInterval(() => {
          const active = recorderRef.current;
          if (!active) return;
          const pcm = active.drain?.();
          if (pcm && pcm.length > 0) session.pushAudio(pcm);
          const level = active.audioLevel?.();
          if (typeof level === 'number' && mountedRef.current) {
            setAudioLevelState(level);
          }
        }, 100);
      });
      startPromiseRef.current = startPromise;
      void startPromise.catch((error: unknown) => {
        if (recorderRef.current === recorder) {
          recorderRef.current = null;
          startPromiseRef.current = null;
          clearReleaseTimer();
          clearPump();
          streamSessionRef.current?.abort();
          streamSessionRef.current = null;
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
      isStreaming,
      openStream,
      reportError,
      resetStreamUi,
      setVoiceStatus,
    ],
  );

  // Stop the active recorder, transcribe, and insert. In tap mode (submit) the
  // prompt is auto-submitted; in hold mode the transcript is inserted only.
  const finalize = useCallback(
    (submit: boolean) => {
      const recorder = recorderRef.current;
      if (!recorder || !voiceModel) {
        return;
      }
      clearReleaseTimer();
      clearPump();
      const startPromise = startPromiseRef.current ?? Promise.resolve();
      const session = streamSessionRef.current;
      streamSessionRef.current = null;
      recorderRef.current = null;
      startPromiseRef.current = null;
      setVoiceStatus('transcribing');
      void startPromise
        .then(async () => {
          if (session) {
            // Push any remaining audio, tear down the device, then flush the
            // stream and await the final transcript.
            const pcm = recorder.drain?.();
            if (pcm && pcm.length > 0) session.pushAudio(pcm);
            await recorder.stop().catch(() => undefined);
            return session.finish();
          }
          const audio = await recorder.stop();
          return transcribe(audio, { voiceModel });
        })
        .then((transcript) => {
          if (!mountedRef.current) {
            return;
          }
          const inserted = insertTranscript(buffer, transcript);
          if (submit && inserted) {
            onSubmit?.();
          }
        })
        .catch((error: unknown) => {
          // A too-short/empty capture (quick tap, or cold-start race) isn't a
          // real failure — silently return to idle instead of a scary error.
          if (error instanceof Error && /empty audio/i.test(error.message)) {
            return;
          }
          reportError(error);
        })
        .finally(() => {
          setVoiceStatus('idle');
          resetStreamUi();
        });
    },
    [
      buffer,
      clearPump,
      clearReleaseTimer,
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
    clearReleaseTimer();
    clearPump();
    const session = streamSessionRef.current;
    streamSessionRef.current = null;
    session?.abort();
    resetStreamUi();
    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }

    const startPromise = startPromiseRef.current ?? Promise.resolve();
    recorderRef.current = null;
    startPromiseRef.current = null;
    void startPromise
      .then(() => recorder.stop())
      .catch(() => undefined)
      .finally(() => {
        setVoiceStatus('idle');
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

  useEffect(
    () => () => {
      mountedRef.current = false;
      cancelRecordingRef.current();
    },
    [],
  );

  const handleKeypress = useCallback(
    (key: Key): boolean => {
      if (
        !enabled ||
        !voiceModel ||
        !keyMatchers[Command.VOICE_PUSH_TO_TALK](key)
      ) {
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
    [armReleaseTimer, enabled, finalize, mode, startRecording, voiceModel],
  );

  return { status, interimText, audioLevel, handleKeypress };
}
