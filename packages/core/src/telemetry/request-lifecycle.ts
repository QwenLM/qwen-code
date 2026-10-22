/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { subagentIdentityContext } from '../utils/subagentNameContext.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isInternalPromptId } from '../utils/internalPromptIds.js';
import { isChatRecordingSuppressed } from '../utils/chat-recording-suppression-context.js';

const debugLogger = createDebugLogger('REQUEST_LIFECYCLE');

interface RequestLifecycleBase {
  v: 1;
  kind: 'request';
  executionId: string;
  sessionId: string;
  promptId: string;
  model: string;
  startedAt: number;
  subagentId?: string;
}

export type RequestLifecycleOutcome =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'interrupted';

export type RequestLifecycleEvent = RequestLifecycleBase &
  (
    | { phase: 'started' }
    | {
        phase: 'ended';
        endedAt: number;
        durationMs: number;
        outcome: RequestLifecycleOutcome;
        reason?: 'consumer_closed';
      }
  );

export type RequestLifecycleRecord = RequestLifecycleEvent & {
  'event.name': 'request_lifecycle';
};

export function startRequestLifecycle(
  config: Config,
  executionId: string,
  promptId: string,
  model: string,
) {
  const suppressed =
    isInternalPromptId(promptId) || isChatRecordingSuppressed();
  const identity = subagentIdentityContext.getStore();
  const base: RequestLifecycleBase = {
    v: 1,
    kind: 'request',
    executionId,
    sessionId: config.getSessionId(),
    promptId,
    model,
    startedAt: Date.now(),
    ...(identity ? { subagentId: identity.id } : {}),
  };
  const recorder = config.getChatRecordingService();
  const publish = (event: RequestLifecycleEvent) => {
    if (suppressed) return;
    try {
      recorder?.recordUiTelemetryEvent({
        ...event,
        'event.name': 'request_lifecycle',
      });
    } catch (error) {
      debugLogger.warn('Failed to record request lifecycle:', error);
    }
    try {
      config.notifyRequestLifecycle(event);
    } catch (error) {
      debugLogger.warn('Failed to notify request lifecycle:', error);
    }
  };
  publish({ ...base, phase: 'started' });
  let ended = false;
  return {
    finish(outcome: RequestLifecycleOutcome) {
      if (ended) return;
      ended = true;
      const endedAt = Math.max(base.startedAt, Date.now());
      publish({
        ...base,
        phase: 'ended',
        endedAt,
        durationMs: endedAt - base.startedAt,
        outcome,
        ...(outcome === 'interrupted'
          ? { reason: 'consumer_closed' as const }
          : {}),
      });
    },
  };
}
