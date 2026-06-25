/**
 * Composer-facing voice dictation state: resolves the loopback voice ws url,
 * wraps the capture hook, and derives the live waveform + elapsed timer the
 * recording bar renders. The voice (ASR) model is chosen elsewhere and read
 * server-side, so this hook doesn't need it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceCapture, type VoiceCaptureStatus } from './useVoiceCapture';

/** Waveform bar count across the recording bar. */
const BAR_COUNT = 32;

export interface UseVoiceDictationReturn {
  available: boolean;
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
  // The voice server may come up just after the renderer; retry once.
  useEffect(() => {
    if (wsUrl) return;
    const id = setTimeout(() => {
      setWsUrl(window.electronAPI?.getVoiceStreamUrl?.() ?? null);
    }, 1500);
    return () => clearTimeout(id);
  }, [wsUrl]);

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
    const id = setInterval(
      () => setElapsedMs(performance.now() - startedAtRef.current),
      100,
    );
    return () => clearInterval(id);
  }, [isRecording]);

  const startDictation = useCallback(() => {
    setNotice(undefined);
    start();
  }, [start]);

  return {
    available: Boolean(wsUrl),
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
  };
}
