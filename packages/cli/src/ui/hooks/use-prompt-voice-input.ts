/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, type RefObject } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import type { HistoryItemWithoutId } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  useVoiceInput,
  type MicrophonePermission,
  type VoiceTranscriber,
} from './use-voice-input.js';
import { createVoiceRecorder } from '../voice/voice-recorder.js';
import {
  assertVoiceBaseUrlNetworkAllowed,
  isKeytermEcho,
  isStreamingVoiceModel,
  resolveVoiceStreamConfig,
  transcribeVoiceAudio,
} from '../voice/voice-transcriber.js';
import { refineVoiceTranscript } from '../voice/voice-refine.js';
import { openQwenAsrRealtimeStream } from '../voice/qwen-asr-realtime-session.js';
import { openVoiceStream } from '../voice/voice-stream-session.js';
import { openVoiceStreamWithRetry } from '../voice/voice-stream-retry.js';

export interface PromptVoiceInputOptions {
  config?: Config;
  settings?: LoadedSettings;
  buffer: Pick<TextBuffer, 'text' | 'insert'>;
  addItem?: (item: HistoryItemWithoutId, timestamp: number) => void;
  onSubmit: (text: string) => void;
  voiceMicWarnedStatusRef?: RefObject<MicrophonePermission | null>;
}

export function usePromptVoiceInput({
  config,
  settings,
  buffer,
  addItem,
  onSubmit,
  voiceMicWarnedStatusRef: sessionVoiceMicWarnedStatusRef,
}: PromptVoiceInputOptions): ReturnType<typeof useVoiceInput> {
  const rawVoiceModel = settings?.merged.voiceModel;
  const voiceModel =
    typeof rawVoiceModel === 'string' && rawVoiceModel.trim().length > 0
      ? rawVoiceModel.trim()
      : undefined;
  const voiceEnabled = Boolean(
    config && settings?.merged.general?.voice?.enabled === true && voiceModel,
  );
  const voiceMode =
    settings?.merged.general?.voice?.mode === 'tap' ? 'tap' : 'hold';
  const transcribeVoice = useCallback<VoiceTranscriber>(
    (audio, { voiceModel }) =>
      transcribeVoiceAudio(audio, {
        config: config!,
        settings: settings!,
        voiceModel,
      }),
    [config, settings],
  );
  // Refine the transcript with the fast model before inserting. On by default,
  // but skipped when the user opted out or no fast model is configured.
  const voiceRefineEnabled =
    settings?.merged.general?.voice?.refineTranscript !== false &&
    config?.getFastModel?.() != null;
  const refineVoice = useCallback(
    (raw: string, signal: AbortSignal) =>
      refineVoiceTranscript(config!, raw, signal),
    [config],
  );
  const localVoiceMicWarnedStatusRef = useRef<MicrophonePermission | null>(
    null,
  );
  // Falls back to a local ref only when no session-scoped ref is supplied; the
  // session ref keeps the notice to once per run across InputPrompt remounts.
  const voiceMicWarnedStatusRef =
    sessionVoiceMicWarnedStatusRef ?? localVoiceMicWarnedStatusRef;
  const voiceRecorderRef = useRef<ReturnType<
    typeof createVoiceRecorder
  > | null>(null);
  const getVoiceRecorder = useCallback(() => {
    voiceRecorderRef.current ??= createVoiceRecorder();
    return voiceRecorderRef.current;
  }, []);
  const warmupVoice = useCallback(() => {
    const recorder = getVoiceRecorder();
    void Promise.resolve(recorder.warmup?.()).catch(() => {});
  }, [getVoiceRecorder]);
  // Runs when a recording starts, not on warmup: users who never dictate
  // should not be told about microphone access on every startup.
  const checkVoiceMicPermission = useCallback(() => {
    const recorder = getVoiceRecorder();
    void Promise.resolve(recorder.microphoneStatus?.())
      .then((status) => {
        if (voiceMicWarnedStatusRef.current === status) {
          return;
        }
        if (status === 'denied') {
          voiceMicWarnedStatusRef.current = status;
          addItem?.(
            {
              type: 'error',
              text: t(
                'Microphone access is denied. Enable it for your terminal in System Settings → Privacy & Security → Microphone, then restart voice dictation.',
              ),
            },
            Date.now(),
          );
        } else if (status === 'prompt') {
          // notDetermined: macOS raises the permission dialog on first capture,
          // so that first recording can come back empty. Tell the user once
          // instead of letting it look like a silent no-op.
          voiceMicWarnedStatusRef.current = status;
          addItem?.(
            {
              type: 'info',
              text: t(
                'Voice dictation needs microphone access. macOS will ask the first time you record — approve it, then start again. Your first recording may be empty while the dialog is open.',
              ),
            },
            Date.now(),
          );
        }
      })
      .catch(() => {});
  }, [getVoiceRecorder, addItem, voiceMicWarnedStatusRef]);
  const voiceStreaming = voiceModel ? isStreamingVoiceModel(voiceModel) : false;
  const openVoiceStreamSession = useCallback(
    (callbacks: {
      onInterim: (text: string) => void;
      onError?: (error: Error) => void;
    }) => {
      if (!voiceModel) {
        return Promise.reject(new Error('No voice model selected.'));
      }
      const streamConfig = resolveVoiceStreamConfig({
        config: config!,
        settings: settings!,
        voiceModel,
      });
      return assertVoiceBaseUrlNetworkAllowed(streamConfig)
        .then(() =>
          openVoiceStreamWithRetry(() =>
            streamConfig.transport === 'qwen-asr-realtime'
              ? openQwenAsrRealtimeStream(streamConfig, callbacks)
              : openVoiceStream(streamConfig, callbacks),
          ),
        )
        .then((session) => ({
          ...session,
          finish: async () => {
            const transcript = await session.finish();
            return isKeytermEcho(transcript, streamConfig.keytermsContext)
              ? ''
              : transcript;
          },
        }));
    },
    [config, settings, voiceModel],
  );
  return useVoiceInput({
    enabled: voiceEnabled,
    mode: voiceMode,
    voiceModel,
    buffer,
    addItem,
    createRecorder: getVoiceRecorder,
    transcribe: transcribeVoice,
    refine: voiceRefineEnabled ? refineVoice : undefined,
    onSubmit,
    warmup: warmupVoice,
    checkMicrophonePermission: checkVoiceMicPermission,
    streaming: voiceStreaming,
    openStream: voiceStreaming ? openVoiceStreamSession : undefined,
  });
}
