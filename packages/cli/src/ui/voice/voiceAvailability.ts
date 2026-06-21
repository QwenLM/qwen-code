/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import process from 'node:process';

// Pre-flight environment check so users get a clear message at /voice-enable
// time, instead of a cryptic recorder failure when no microphone can work
// (e.g. WSL without WSLg/PulseAudio, or an unsupported platform).

export interface VoiceEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = [
  'darwin',
  'linux',
  'win32',
];

function isWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WSL_DISTRO_NAME'] || env['WSL_INTEROP']);
}

/**
 * Returns a human-readable reason if voice dictation cannot work in this
 * environment, or undefined when it should be available.
 */
export function getVoiceUnavailableReason(
  environment: VoiceEnvironment = {
    platform: process.platform,
    env: process.env,
  },
): string | undefined {
  const { platform, env } = environment;
  const fileExists = environment.fileExists ?? existsSync;

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return `Voice dictation is not supported on ${platform}.`;
  }

  if (
    platform === 'linux' &&
    isWsl(env) &&
    !env['PULSE_SERVER'] &&
    !fileExists('/mnt/wslg/PulseServer')
  ) {
    return (
      'Voice dictation needs microphone access, which is unavailable in this WSL ' +
      'session. Use WSLg/PulseAudio, or run Qwen Code on a host with a microphone.'
    );
  }

  return undefined;
}
