/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformBackendName } from './platform.js';

export type MicrophoneAuthorizationStatus =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'unknown';

export interface AudioCaptureOptions {
  sampleRate: number;
  channels: number;
  /** Flag sustained silence so the caller can auto-stop (tap mode). */
  silenceDetection?: boolean;
}

export interface NativeAudioCaptureBackend {
  startRecording: (options: AudioCaptureOptions) => void;
  stopRecording: () => Uint8Array;
  isRecording: () => boolean;
  /** True once sustained silence was detected. Absent on older addons. */
  silenceDetected?: () => boolean;
  /** Return & clear PCM captured since the last call (for streaming uploads). */
  drainAudio?: () => Uint8Array;
  /** Recent input level 0..1 (for waveform display). */
  audioLevel?: () => number;
  microphoneAuthorizationStatus: () => MicrophoneAuthorizationStatus;
}

interface NativeBinding {
  startRecording: (options?: Partial<AudioCaptureOptions>) => void;
  stopRecording: () => Uint8Array;
  isRecording: () => boolean;
  silenceDetected?: () => boolean;
  drainAudio?: () => Uint8Array;
  audioLevel?: () => number;
  microphoneAuthorizationStatus?: () => MicrophoneAuthorizationStatus;
}

const nativeRequire = createRequire(import.meta.url);
// dist/index.js → package root, which holds prebuilds/ and build/.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadBinding(): NativeBinding {
  try {
    // Throws on unsupported platforms before touching the native layer.
    getPlatformBackendName();
    // node-gyp-build picks the matching prebuild from prebuilds/<platform>-<arch>,
    // falling back to a local build/Release compile — no compiler needed when a
    // prebuilt binary ships for the host.
    const loadPrebuild = nativeRequire('node-gyp-build') as (
      dir: string,
    ) => NativeBinding;
    return loadPrebuild(packageRoot);
  } catch (error) {
    throw new Error(
      'Native audio capture addon could not be loaded. Reinstall ' +
        '@qwen-code/audio-capture, or run "npm run build" in packages/audio-capture. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function createNativeAudioCaptureBackend(
  binding: NativeBinding = loadBinding(),
): NativeAudioCaptureBackend {
  const silenceDetected = binding.silenceDetected;
  const drainAudio = binding.drainAudio;
  const audioLevel = binding.audioLevel;
  return {
    startRecording: (options) => {
      binding.startRecording(options);
    },
    stopRecording: () => binding.stopRecording(),
    isRecording: () => binding.isRecording(),
    ...(drainAudio ? { drainAudio: () => drainAudio.call(binding) } : {}),
    ...(audioLevel ? { audioLevel: () => audioLevel.call(binding) } : {}),
    ...(silenceDetected
      ? { silenceDetected: () => silenceDetected.call(binding) }
      : {}),
    microphoneAuthorizationStatus: () =>
      binding.microphoneAuthorizationStatus?.() ?? 'unknown',
  };
}

export { getPlatformBackendName } from './platform.js';
