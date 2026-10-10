/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { subagentIdentityContext } from '../utils/subagentNameContext.js';
import { isChatRecordingSuppressed } from '../utils/chat-recording-suppression-context.js';
import { createDebugLogger } from '../utils/debugLogger.js';

export const TOOL_LIFECYCLE_DRAIN_MS = 30_000;

export type ToolLifecycleOutcome = 'success' | 'error' | 'cancelled';
export type ToolExecutionStatus = 'not_started' | ToolLifecycleOutcome;
interface ToolLifecycleBase {
  v: 1;
  kind: 'tool';
  sessionId: string;
  executionId: string;
  callId: string;
  toolName: string;
  subagentId?: string;
}
export type ToolLifecycleEvent = ToolLifecycleBase &
  (
    | { phase: 'started'; executionStatus: 'running'; startedAt: number }
    | {
        phase: 'ended';
        executionStatus: 'not_started';
        outcome: ToolLifecycleOutcome;
        endedAt: number;
      }
    | {
        phase: 'ended';
        executionStatus: ToolLifecycleOutcome;
        outcome: ToolLifecycleOutcome;
        endedAt: number;
        startedAt: number;
        executionDurationMs: number;
      }
  );
export type ToolLifecycleRecord = ToolLifecycleEvent & {
  'event.name': 'tool_lifecycle';
};
const logger = createDebugLogger('TOOL_LIFECYCLE');

export function createToolLifecycle(
  config: Config,
  callId: string,
  toolName: string,
  options: { subagentId?: string; persist?: boolean } = {},
) {
  const suppressed = isChatRecordingSuppressed();
  const subagentId =
    options.subagentId ?? subagentIdentityContext.getStore()?.id;
  const base: ToolLifecycleBase = {
    v: 1,
    kind: 'tool',
    sessionId: config.getSessionId(),
    executionId: randomUUID(),
    callId,
    toolName,
    ...(subagentId ? { subagentId } : {}),
  };
  const recorder =
    options.persist === false ? undefined : config.getChatRecordingService();
  let startedAt: number | undefined;
  let monotonicStart: number | undefined;
  let ended = false;
  const publish = (event: ToolLifecycleEvent) => {
    if (suppressed) return undefined;
    if (options.persist !== false) {
      try {
        recorder?.recordUiTelemetryEvent({
          ...event,
          'event.name': 'tool_lifecycle',
        });
      } catch (error) {
        logger.warn('Failed to record tool lifecycle:', error);
      }
    }
    return event;
  };
  return {
    start(
      epoch = Date.now(),
      resolvedToolName?: string,
    ): ToolLifecycleEvent | undefined {
      if (ended || startedAt !== undefined) return undefined;
      startedAt = epoch;
      monotonicStart = performance.now();
      if (resolvedToolName) base.toolName = resolvedToolName;
      return publish({
        ...base,
        phase: 'started',
        executionStatus: 'running',
        startedAt,
      });
    },
    finish(
      outcome: ToolLifecycleOutcome,
      executionStatus: ToolExecutionStatus,
      executionDurationMs?: number,
    ): ToolLifecycleEvent | undefined {
      if (ended) return undefined;
      ended = true;
      const terminal = {
        ...base,
        phase: 'ended' as const,
        outcome,
        endedAt: Math.max(startedAt ?? 0, Date.now()),
      };
      if (startedAt === undefined) {
        return publish({ ...terminal, executionStatus: 'not_started' });
      }
      return publish({
        ...terminal,
        executionStatus:
          executionStatus === 'not_started' ? 'error' : executionStatus,
        startedAt,
        executionDurationMs:
          executionDurationMs ??
          Math.max(0, Math.round(performance.now() - monotonicStart!)),
      });
    },
  };
}
