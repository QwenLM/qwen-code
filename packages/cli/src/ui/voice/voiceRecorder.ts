/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import type {
  RecordedVoiceAudio,
  VoiceRecorder,
  VoiceRecorderStartOptions,
} from '../hooks/useVoiceInput.js';
import { createArecordRecorder } from './arecordRecorder.js';
import { createNativeAudioRecorder } from './nativeAudioRecorder.js';
import { createSoxRecorder } from './soxRecorder.js';

interface VoiceRecorderOptions {
  createNativeRecorder?: () => VoiceRecorder;
  createArecordRecorder?: () => VoiceRecorder;
  createSoxRecorder?: () => VoiceRecorder;
  platform?: NodeJS.Platform;
}

class FallbackVoiceRecorder implements VoiceRecorder {
  private activeRecorder: VoiceRecorder | null = null;
  private readonly recorders = new Map<() => VoiceRecorder, VoiceRecorder>();

  constructor(private readonly factories: Array<() => VoiceRecorder>) {}

  private recorderFor(factory: () => VoiceRecorder): VoiceRecorder {
    let recorder = this.recorders.get(factory);
    if (!recorder) {
      recorder = factory();
      this.recorders.set(factory, recorder);
    }
    return recorder;
  }

  async start(options?: VoiceRecorderStartOptions): Promise<void> {
    const errors: string[] = [];

    for (const factory of this.factories) {
      const recorder = this.recorderFor(factory);
      try {
        await recorder.start(options);
        this.activeRecorder = recorder;
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(
      `Voice recording is unavailable. ${errors.filter(Boolean).join(' ')}`,
    );
  }

  async stop(): Promise<RecordedVoiceAudio> {
    const recorder = this.activeRecorder;
    if (!recorder) {
      throw new Error('Voice recorder was not started.');
    }
    this.activeRecorder = null;
    return recorder.stop();
  }

  // Best-effort preload of any backend that supports it (the native one).
  async warmup(): Promise<void> {
    for (const factory of this.factories) {
      try {
        await this.recorderFor(factory).warmup?.();
      } catch {
        // Ignore — start() will still try/fall back at record time.
      }
    }
  }

  drain(): Uint8Array {
    return this.activeRecorder?.drain?.() ?? new Uint8Array(0);
  }

  supportsStreaming(): boolean {
    return this.activeRecorder?.supportsStreaming?.() ?? false;
  }

  audioLevel(): number {
    return this.activeRecorder?.audioLevel?.() ?? 0;
  }

  // Permission from the first backend that can report it (the native one).
  async microphoneStatus(): Promise<
    'granted' | 'denied' | 'prompt' | 'unknown'
  > {
    for (const factory of this.factories) {
      const recorder = this.recorderFor(factory);
      if (recorder.microphoneStatus) {
        try {
          return await recorder.microphoneStatus();
        } catch {
          // Try the next backend.
        }
      }
    }
    return 'unknown';
  }
}

export function createVoiceRecorder(
  options: VoiceRecorderOptions = {},
): VoiceRecorder {
  const platform = options.platform ?? process.platform;
  const factories: Array<() => VoiceRecorder> = [
    options.createNativeRecorder ?? createNativeAudioRecorder,
  ];
  // arecord (ALSA) only exists on Linux; elsewhere it would just fail fast.
  if (platform === 'linux') {
    factories.push(options.createSoxRecorder ?? createSoxRecorder);
    factories.push(options.createArecordRecorder ?? createArecordRecorder);
  } else {
    factories.push(options.createSoxRecorder ?? createSoxRecorder);
  }
  return new FallbackVoiceRecorder(factories);
}
