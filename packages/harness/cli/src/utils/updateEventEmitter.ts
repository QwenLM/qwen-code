/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';

/**
 * A shared event emitter for application-wide communication
 * between decoupled parts of the CLI.
 */
export const updateEventEmitter = new EventEmitter();

/** Call `listener` after each successful CLI update. Returns an unsubscribe. */
export function onUpdateSuccess(listener: () => void): () => void {
  updateEventEmitter.on('update-success', listener);
  return () => {
    updateEventEmitter.off('update-success', listener);
  };
}
