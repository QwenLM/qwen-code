/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import type { HookExecutionOwner } from '../hooks/hook-execution-context.js';
import type { HookConfig, HookExecutionResult } from '../hooks/types.js';
import { isChatRecordingSuppressed } from '../utils/chat-recording-suppression-context.js';
import { isInternalPromptId } from '../utils/internalPromptIds.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  HookLifecycleBase,
  HookLifecycleEvent,
  HookLifecycleOutcome,
  HookLifecycleSource,
} from './hook-lifecycle-contract.js';

const logger = createDebugLogger('HOOK_LIFECYCLE');

export function startHookLifecycle(
  config: Config,
  owner: HookExecutionOwner,
  eventName: string,
  hook: HookConfig,
  index: number,
  source: HookLifecycleSource,
):
  | {
      started: HookLifecycleEvent;
      finish(
        result: HookExecutionResult,
        outcome: HookLifecycleOutcome,
      ): HookLifecycleEvent | undefined;
    }
  | undefined {
  try {
    if (
      !owner.historyPromptId ||
      owner.agentId !== null ||
      isInternalPromptId(owner.historyPromptId) ||
      isChatRecordingSuppressed() ||
      ['SessionStart', 'SessionEnd', 'SessionDelete'].includes(eventName) ||
      owner.sessionId !== config.getSessionId()
    )
      return undefined;
    const base: HookLifecycleBase = {
      v: 1,
      kind: 'hook',
      executionId: randomUUID(),
      runtimeId: owner.runtimeId,
      sessionId: owner.sessionId,
      promptId: owner.historyPromptId,
      agentId: null,
      eventName,
      hookType: hook.type,
      source,
      name:
        hook.name
          ?.replace(/\p{Cc}/gu, '')
          .trim()
          .slice(0, 80) || `${hook.type} #${index + 1}`,
      startedAt: Date.now(),
    };
    const recorder = config.getChatRecordingService?.();
    const monotonicStart = performance.now();
    const record = (event: HookLifecycleEvent) => {
      try {
        recorder?.recordUiTelemetryEvent({
          ...event,
          'event.name': 'hook_lifecycle',
        });
      } catch {
        logger.warn('Failed to record hook lifecycle');
      }
      return event;
    };
    let finished = false;
    return {
      started: record({ ...base, phase: 'started' }),
      finish(result, outcome) {
        if (finished) return undefined;
        finished = true;
        const endedAt = Math.max(base.startedAt, Date.now());
        return record(
          result.isAsync && result.success
            ? {
                ...base,
                phase: 'dispatched',
                dispatchedAt: endedAt,
                dispatchDurationMs: Math.max(
                  0,
                  performance.now() - monotonicStart,
                ),
              }
            : {
                ...base,
                phase: 'ended',
                endedAt,
                durationMs: Math.max(0, result.duration),
                outcome,
                ...(result.exitCode !== undefined
                  ? { exitCode: result.exitCode }
                  : {}),
              },
        );
      },
    };
  } catch {
    logger.warn('Failed to start hook lifecycle');
    return undefined;
  }
}
