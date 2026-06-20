/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NativeAudioCaptureBackend } from '@qwen-code/audio-capture';
import type {
  RecordedVoiceAudio,
  VoiceRecorder,
  VoiceRecorderStartOptions,
} from '../hooks/useVoiceInput.js';

// Native silence detection sets a flag we poll for; older addons lack it.
const SILENCE_POLL_INTERVAL_MS = 200;

interface NativeAudioRecorderOptions {
  loadBackend?: () =>
    | NativeAudioCaptureBackend
    | Promise<NativeAudioCaptureBackend>;
}

class NativeAudioRecorder implements VoiceRecorder {
  private backend: NativeAudioCaptureBackend | null = null;
  private silencePoll: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly loadBackend: () =>
      | NativeAudioCaptureBackend
      | Promise<NativeAudioCaptureBackend>,
  ) {}

  private clearSilencePoll(): void {
    if (this.silencePoll) {
      clearInterval(this.silencePoll);
      this.silencePoll = null;
    }
  }

  // Pay the dynamic-import + dlopen cost up front so the first start() is warm.
  async warmup(): Promise<void> {
    await this.loadBackend();
  }

  async microphoneStatus(): Promise<
    'granted' | 'denied' | 'prompt' | 'unknown'
  > {
    const backend = await this.loadBackend();
    return backend.microphoneAuthorizationStatus();
  }

  drain(): Uint8Array {
    return this.backend?.drainAudio?.() ?? new Uint8Array(0);
  }

  supportsStreaming(): boolean {
    return typeof this.backend?.drainAudio === 'function';
  }

  audioLevel(): number {
    return this.backend?.audioLevel?.() ?? 0;
  }

  async start(options: VoiceRecorderStartOptions = {}): Promise<void> {
    const backend = await this.loadBackend();
    const silenceDetection = options.silenceDetection === true;
    backend.startRecording({
      sampleRate: 16000,
      channels: 1,
      silenceDetection,
    });
    this.backend = backend;

    const { onAutoStop } = options;
    if (silenceDetection && onAutoStop && backend.silenceDetected) {
      this.silencePoll = setInterval(() => {
        try {
          if (this.backend?.silenceDetected?.()) {
            this.clearSilencePoll();
            onAutoStop();
          }
        } catch {
          this.clearSilencePoll();
        }
      }, SILENCE_POLL_INTERVAL_MS);
    }
  }

  async stop(): Promise<RecordedVoiceAudio> {
    this.clearSilencePoll();
    if (!this.backend) {
      throw new Error('Native voice recorder was not started.');
    }

    const data = this.backend.stopRecording();
    this.backend = null;
    return {
      data,
      mimeType: 'audio/wav',
    };
  }
}

async function loadDefaultBackend(): Promise<NativeAudioCaptureBackend> {
  const { createNativeAudioCaptureBackend } = await import(
    '@qwen-code/audio-capture'
  );
  return createNativeAudioCaptureBackend();
}

export function createNativeAudioRecorder(
  options: NativeAudioRecorderOptions = {},
): VoiceRecorder {
  return new NativeAudioRecorder(options.loadBackend ?? loadDefaultBackend);
}
