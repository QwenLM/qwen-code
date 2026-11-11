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
  formatAgentsMdSizeWarning,
  type Config,
  type AgentsMdSizeSnapshot,
} from '@qwen-code/core';
import { MessageType } from '../types.js';
import type { UseFeedbackEventsParams } from './useFeedbackEvents.js';

export function useAgentsMdSizeWarning(
  config: Config,
  addItem: UseFeedbackEventsParams['addItem'],
): void {
  useEffect(() => {
    const show = (snapshot?: AgentsMdSizeSnapshot) => {
      if (snapshot?.thresholdReached) {
        const item = {
          type: MessageType.WARNING,
          text: formatAgentsMdSizeWarning(snapshot),
          omitFromTranscript: true,
        };
        addItem(item, Date.now());
      }
    };
    const handle = (event: {
      sessionId: string;
      snapshot: AgentsMdSizeSnapshot;
      notifyWarning?: boolean;
    }) => {
      if (
        event.sessionId === config.getSessionId() &&
        event.notifyWarning !== false
      )
        show(event.snapshot);
    };
    coreEvents.on(CoreEvent.AgentsMdSizeEvaluated, handle);
    show(config.getMemoryContextManager()?.getAgentsMdSizeSnapshot?.());
    return () => {
      coreEvents.off(CoreEvent.AgentsMdSizeEvaluated, handle);
    };
  }, [config, addItem]);
}
