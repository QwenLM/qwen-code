/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { InstructionsLoadedNotification } from '../utils/memoryDiscovery.js';
import type { HookSystem } from './hookSystem.js';

export function createInstructionsLoadedCallback(
  getHookSystem: () => HookSystem | undefined,
) {
  return async (notification: InstructionsLoadedNotification) => {
    await getHookSystem()?.fireInstructionsLoadedEvent(
      notification.filePath,
      notification.memoryType,
      notification.loadReason,
      {
        triggerFilePath: notification.triggerFilePath,
        parentFilePath: notification.parentFilePath,
      },
    );
  };
}
