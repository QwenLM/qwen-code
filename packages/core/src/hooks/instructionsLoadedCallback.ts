/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { InstructionsLoadedNotification } from '../utils/memoryDiscovery.js';
import type { HookSystem } from './hookSystem.js';

export type InstructionsLoadedCallback = (
  notification: InstructionsLoadedNotification,
) => Promise<void>;

/**
 * Create the informational InstructionsLoaded callback used by memory loaders.
 * The hook result is intentionally ignored: this event reports loaded
 * instruction files and does not gate memory discovery.
 */
export function createInstructionsLoadedCallback(
  getHookSystem: () => HookSystem | undefined,
): InstructionsLoadedCallback {
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
