/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelQueueProps } from '../types.js';
import type { SystemMessage } from '@qwen-code/core';
import { clamp } from '../../ink/layout/geometry.js';

function asNonEmptyString(value: unknown): string | undefined {
  return value != null &&
    (value as { constructor?: unknown }).constructor === String
    ? (value as string) || undefined
    : undefined;
}

export type ModelQueueStatusLike = Pick<
  SystemMessage,
  | 'status'
  | 'request_id'
  | 'request_set_id'
  | 'model_key'
  | 'queue_type'
  | 'queue_count'
  | 'wait_time_ms'
  | 'queue_wait_elapsed_ms'
  | 'queue_max_wait_ms'
  | 'service_available'
>;

const MAX_QUEUED_PROGRESS = 95;
const DEFAULT_INITIAL_PROGRESS = 3;
const FALLBACK_PROGRESS_STEP = 4;

function calculateQueueProgress(
  previous: ModelQueueProps | undefined,
  queueCount: number | undefined,
  initialQueueCount: number | undefined,
  waitElapsedMs: number | undefined,
  maxWaitMs: number | undefined,
): number {
  if (
    queueCount !== undefined &&
    initialQueueCount !== undefined &&
    initialQueueCount > 0
  ) {
    const remaining = clamp(queueCount, 0, initialQueueCount);
    const completedRatio = (initialQueueCount - remaining) / initialQueueCount;
    return clamp(
      Math.round(completedRatio * MAX_QUEUED_PROGRESS),
      DEFAULT_INITIAL_PROGRESS,
      MAX_QUEUED_PROGRESS,
    );
  }

  if (
    waitElapsedMs !== undefined &&
    maxWaitMs !== undefined &&
    maxWaitMs > 0
  ) {
    const elapsedRatio = clamp(waitElapsedMs / maxWaitMs, 0, 1);
    return clamp(
      Math.round(elapsedRatio * MAX_QUEUED_PROGRESS),
      DEFAULT_INITIAL_PROGRESS,
      MAX_QUEUED_PROGRESS,
    );
  }

  return clamp(
    (previous?.progress ?? 0) + FALLBACK_PROGRESS_STEP,
    DEFAULT_INITIAL_PROGRESS,
    MAX_QUEUED_PROGRESS,
  );
}

function isSameQueue(
  previous: ModelQueueProps | undefined,
  requestSetId: string | undefined,
  requestId: string | undefined,
): boolean {
  if (previous === undefined) {
    return false;
  }
  if (previous.requestSetId !== undefined || requestSetId !== undefined) {
    return previous.requestSetId === requestSetId;
  }
  return previous.requestId === requestId;
}

export function modelQueueFromStatusEvent(
  event: ModelQueueStatusLike,
  previous?: ModelQueueProps,
): ModelQueueProps {
  const status = event.status === 'ready' ? 'ready' : 'queued';
  const queueCount = event.queue_count;
  const waitTimeMs = event.wait_time_ms;
  const waitElapsedMs = event.queue_wait_elapsed_ms;
  const maxWaitMs = event.queue_max_wait_ms;
  const requestId = asNonEmptyString(event.request_id);
  const requestSetId = asNonEmptyString(event.request_set_id);
  const previousForQueue =
    isSameQueue(previous, requestSetId, requestId) &&
    !(previous?.status === 'ready' && status !== 'ready')
      ? previous
      : undefined;
  const initialQueueCount =
    previousForQueue?.initialQueueCount ??
    (queueCount !== undefined && queueCount > 0 ? queueCount : undefined);
  const progress =
    status === 'ready'
      ? 100
      : Math.max(
          previousForQueue?.progress ?? 0,
          calculateQueueProgress(
            previousForQueue,
            queueCount,
            initialQueueCount,
            waitElapsedMs,
            maxWaitMs,
          ),
        );

  return {
    status,
    requestId,
    requestSetId,
    modelKey: asNonEmptyString(event.model_key),
    queueType: asNonEmptyString(event.queue_type),
    queueCount,
    initialQueueCount,
    waitTimeMs,
    waitElapsedMs,
    maxWaitMs,
    serviceAvailable: event.service_available,
    progress,
  };
}
