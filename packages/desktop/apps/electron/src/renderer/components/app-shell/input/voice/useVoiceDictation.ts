/**
 * Composer-facing voice dictation state: resolves the loopback voice ws url,
 * wraps the capture hook, and derives the live waveform + elapsed timer the
 * recording bar renders. The voice (ASR) model is chosen elsewhere and read
 * server-side, so this hook doesn't need it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceCapture, type VoiceCaptureStatus } from './useVoiceCapture';

/** Waveform bar count across the recording bar. */
const BAR_COUNT = 32;

// Voice server cold start (OAuth refresh / slow disk) can outlast the renderer
// by a few seconds, so poll the loopback URL a bounded number of times.
const VOICE_URL_RETRY_INTERVAL_MS = 1500;
const MAX_VOICE_URL_RETRIES = 10;

/**
 * True once the retry budget is spent with no resolved URL. The effect uses
 * this to stop polling and surface the failure; exported so the retry-exhaustion
 * decision is unit-testable by driving the counter directly (no timers).
 */
export function isVoiceInitExhausted(
  wsUrl: string | null,
  retryCount: number,
): boolean {
  return !wsUrl && retryCount >= MAX_VOICE_URL_RETRIES;
}

/** Diagnostic logged once when voice-server URL resolution is abandoned. */
export function formatVoiceInitFailureWarning(): string {
  const seconds = Math.round(
    (MAX_VOICE_URL_RETRIES * VOICE_URL_RETRY_INTERVAL_MS) / 1000,
  );
  return (
    `[voice] voice server URL unavailable after ${MAX_VOICE_URL_RETRIES} retries ` +
    `(~${seconds}s); dictation will not be available this session.`
  );
}

export interface UseVoiceDictationReturn {
  available: boolean;
  /** True once the voice-server URL never resolved within the retry budget. */
  initFailed: boolean;
  status: VoiceCaptureStatus;
  isRecording: boolean;
  isConnecting: boolean;
  isTranscribing: boolean;
  isError: boolean;
  /** True while the recording bar should replace the normal toolbar. */
  isActive: boolean;
  /** Rolling waveform levels (0..1), oldest first. */
  levels: number[];
  elapsedMs: number;
  interimText: string;
  errorMessage: string | undefined;
  notice: string | undefined;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export function useVoiceDictation(options: {
  onInsert: (text: string) => void;
}): UseVoiceDictationReturn {
  const [wsUrl, setWsUrl] = useState<string | null>(
    () => window.electronAPI?.getVoiceStreamUrl?.() ?? null,
  );
  // The voice server may come up just after the renderer; retry on an interval
  // until the URL resolves. `setWsUrl(null)` is a no-op when the value stays
  // null, so a separate retry counter is what actually re-fires this effect on
  // each miss (re-running with only `[wsUrl]` would stall after the first try).
  const [retryCount, setRetryCount] = useState(0);
  // Set once the retry budget is exhausted with no URL — voice silently never
  // appears otherwise (wsUrl stays null → available=false with no signal).
  const [initFailed, setInitFailed] = useState(false);
  useEffect(() => {
    if (wsUrl) return;
    if (isVoiceInitExhausted(wsUrl, retryCount)) {
      // Surface the dead end exactly once so it's diagnosable in the renderer
      // console (and via the returned `initFailed` flag) instead of failing
      // silently. Guard on the transition so re-renders don't re-log.
      if (!initFailed) {
        setInitFailed(true);
        console.warn(formatVoiceInitFailureWarning());
      }
      return;
    }
    const id = setTimeout(() => {
      const next = window.electronAPI?.getVoiceStreamUrl?.() ?? null;
      if (next) setWsUrl(next);
      else setRetryCount((n) => n + 1);
    }, VOICE_URL_RETRY_INTERVAL_MS);
    return () => clearTimeout(id);
  }, [wsUrl, retryCount, initFailed]);

  const [notice, setNotice] = useState<string | undefined>(undefined);
  const onInsertRef = useRef(options.onInsert);
  onInsertRef.current = options.onInsert;

  const { status, interimText, audioLevel, errorMessage, start, stop, abort } =
    useVoiceCapture({
      wsUrl,
      onFinal: (text) => {
        const trimmed = text.trim();
        if (trimmed) {
          setNotice(undefined);
          onInsertRef.current(trimmed);
        } else {
          setNotice('No speech detected.');
        }
      },
    });

  const isRecording = status === 'recording';
  const isConnecting = status === 'connecting';
  const isTranscribing = status === 'transcribing';

  // Rolling waveform history, fed by the live RMS meter while recording.
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(0),
  );
  useEffect(() => {
    if (!isRecording) {
      setLevels(new Array(BAR_COUNT).fill(0));
      return;
    }
    setLevels((prev) => [...prev.slice(1), Math.min(1, audioLevel * 8)]);
  }, [audioLevel, isRecording]);

  // Elapsed timer, reset each recording session.
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  useEffect(() => {
    if (!isRecording) {
      setElapsedMs(0);
      return;
    }
    startedAtRef.current = performance.now();
    // Tick once per second: the bar floors elapsed to whole seconds, and each
    // tick lands on a second boundary (anchored to startedAtRef), so a finer
    // interval would only trigger ~10x redundant re-renders.
    const id = setInterval(
      () => setElapsedMs(performance.now() - startedAtRef.current),
      1000,
    );
    return () => clearInterval(id);
  }, [isRecording]);

  const startDictation = useCallback(() => {
    setNotice(undefined);
    start();
  }, [start]);

  return useMemo(
    () => ({
      available: Boolean(wsUrl),
      initFailed,
      status,
      isRecording,
      isConnecting,
      isTranscribing,
      isError: status === 'error',
      isActive: isRecording || isConnecting || isTranscribing,
      levels,
      elapsedMs,
      interimText,
      errorMessage,
      notice,
      start: startDictation,
      stop,
      abort,
    }),
    [
      wsUrl,
      initFailed,
      status,
      isRecording,
      isConnecting,
      isTranscribing,
      levels,
      elapsedMs,
      interimText,
      errorMessage,
      notice,
      startDictation,
      stop,
      abort,
    ],
  );
}
