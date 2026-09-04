/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type NativeAudioBackendName = 'coreaudio' | 'alsa-pulse' | 'wasapi';

export function getPlatformBackendName(
  platform: NodeJS.Platform = process.platform,
): NativeAudioBackendName {
  switch (platform) {
    case 'darwin':
      return 'coreaudio';
    case 'linux':
      return 'alsa-pulse';
    case 'win32':
      return 'wasapi';
    default:
      throw new Error(`Native audio capture is not available for ${platform}.`);
  }
}
