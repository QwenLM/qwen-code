/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useMemo } from 'react';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import {
  detectBackend,
  startRecording,
  stopRecording,
} from '../../services/audioCapture.js';
import { transcribe } from '../../services/sttClient.js';

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'error';

export function useVoice(sttEndpoint: string) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const procRef = useRef<ChildProcess | null>(null);
  const audioPathRef = useRef<string | null>(null);
  // Detect backend once at hook initialisation time.
  const backend = useMemo(() => detectBackend(), []);

  const start = useCallback(async () => {
    if (voiceState !== 'idle') return;
    const tmpPath = path.join(os.tmpdir(), `proto-voice-${Date.now()}.wav`);
    audioPathRef.current = tmpPath;
    setVoiceState('recording');
    setError(null);
    try {
      procRef.current = await startRecording(tmpPath, backend);
    } catch (e) {
      setVoiceState('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [voiceState, backend]);

  const stop = useCallback(async (): Promise<string> => {
    if (
      voiceState !== 'recording' ||
      !procRef.current ||
      !audioPathRef.current
    ) {
      return '';
    }
    setVoiceState('transcribing');
    const audioPath = audioPathRef.current;
    try {
      await stopRecording(procRef.current);
      const text = await transcribe(audioPath, sttEndpoint);
      setVoiceState('idle');
      fs.unlink(audioPath, () => {});
      audioPathRef.current = null;
      return text;
    } catch (e) {
      setVoiceState('error');
      setError(e instanceof Error ? e.message : String(e));
      return '';
    }
  }, [voiceState, sttEndpoint]);

  const reset = useCallback(() => {
    setVoiceState('idle');
    setError(null);
  }, []);

  return {
    voiceState,
    error,
    start,
    stop,
    reset,
    backendAvailable: backend !== 'none',
  };
}
