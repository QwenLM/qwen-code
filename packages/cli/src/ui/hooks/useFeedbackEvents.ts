/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import {
  CoreEvent,
  coreEvents,
  runLogger,
  type UserFeedbackPayload,
} from '@qwen-code/core';
import { type HistoryItemInfo, MessageType } from '../types.js';

export interface UseFeedbackEventsParams {
  addItem: (
    item: { type: MessageType; text: string } | HistoryItemInfo,
    timestamp: number,
  ) => void;
}

/**
 * Routes UserFeedback core events into the history manager. Each event becomes
 * a single history item with the appropriate severity. Errors with an attached
 * `error` object are also dropped into the debug log.
 *
 * Hook lifecycle feedback (start/end/system-message) is now surfaced via the
 * attachment pipeline in useLocalTuiSessionOrchestrator.
 *
 * `coreEvents.drainBacklogs()` flushes any events that fired before this
 * component mounted (e.g. during startup).
 */
export function useFeedbackEvents({ addItem }: UseFeedbackEventsParams): void {
  useEffect(() => {
    const handleUserFeedback = (payload: UserFeedbackPayload) => {
      let type: MessageType;
      switch (payload.severity) {
        case 'error':
          type = MessageType.ERROR;
          break;
        case 'warning':
          type = MessageType.WARNING;
          break;
        case 'info':
          type = MessageType.INFO;
          break;
        default:
          throw new Error(
            `Unexpected severity for user feedback: ${payload.severity}`,
          );
      }

      addItem(
        {
          type,
          text: payload.message,
          ...(payload.omitFromTranscript
            ? { omitFromTranscript: true }
            : {}),
        },
        Date.now(),
      );

      if (payload.error) {
        runLogger.warn(
          `[Feedback Details for "${payload.message}"]`,
          payload.error,
        );
      }
    };

    coreEvents.on(CoreEvent.UserFeedback, handleUserFeedback);

    // Flush any messages that happened during startup before this component
    // mounted.
    coreEvents.drainBacklogs();

    return () => {
      coreEvents.off(CoreEvent.UserFeedback, handleUserFeedback);
    };
  }, [addItem]);
}
