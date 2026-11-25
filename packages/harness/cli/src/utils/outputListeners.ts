/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires `coreEvents` Output / ConsoleLog / UserFeedback channels to
 * `writeToStdout` / `writeToStderr` when there are no upstream listeners.
 * Extracted so headless entry paths (non-interactive, stream-json,
 * remote-control) can all install the same drain without importing back
 * through the TUI entry module (which would be a circular import for modules that
 * the entry module itself imports).
 */

import {
  coreEvents,
  CoreEvent,
  writeToStderr,
  writeToStdout,
  type ConsoleLogPayload,
  type OutputPayload,
  type UserFeedbackPayload,
} from '@qwen-code/core';

export function initializeOutputListenersAndFlush(opts?: {
  skipUserFeedback?: boolean;
}): void {
  if (coreEvents.listenerCount(CoreEvent.Output) === 0) {
    coreEvents.on(CoreEvent.Output, (payload: OutputPayload) => {
      if (payload.isStderr) {
        writeToStderr(payload.chunk, payload.encoding);
      } else {
        writeToStdout(payload.chunk, payload.encoding);
      }
    });
  }

  if (coreEvents.listenerCount(CoreEvent.ConsoleLog) === 0) {
    coreEvents.on(CoreEvent.ConsoleLog, (payload: ConsoleLogPayload) => {
      if (payload.type === 'error' || payload.type === 'warn') {
        writeToStderr(payload.content);
      } else {
        writeToStdout(payload.content);
      }
    });
  }

  if (!opts?.skipUserFeedback) {
    if (coreEvents.listenerCount(CoreEvent.UserFeedback) === 0) {
      const ensureNewline = (message: string) =>
        message.endsWith('\n') ? message : `${message}\n`;
      coreEvents.on(CoreEvent.UserFeedback, (payload: UserFeedbackPayload) => {
        if (payload.severity === 'error' || payload.severity === 'warning') {
          writeToStderr(ensureNewline(payload.message));
        } else {
          writeToStdout(ensureNewline(payload.message));
        }
      });
    }
  }

  coreEvents.drainBacklogs();
}
