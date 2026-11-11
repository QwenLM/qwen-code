/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NativeEvent } from './nativeInstallationService.js';

export function createManualUpdateProgress(writeLine: (message: string) => void) {
  return {
    checking: () => writeLine('Checking for updates...'),
    onUpdateAvailable: (current: string, target: string) =>
      writeLine(`Update available: ${current} -> ${target}`),
    onNativeEvent: ({ stage, phase }: NativeEvent) => {
      if (phase !== 'start') return;
      switch (stage) {
        case 'download':
          writeLine('Downloading update...');
          break;
        case 'install':
          writeLine('Installing update...');
          break;
        case 'link':
          writeLine('Activating update...');
          break;
        default:
          break;
      }
    },
  };
}
