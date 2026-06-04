/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Counter, Histogram } from '@opentelemetry/api';
import { ValueType } from '@opentelemetry/api';
import { SERVICE_NAME } from './constants.js';
import { getMeter } from './metrics.js';

const DAEMON_HTTP_REQUEST_COUNT = `${SERVICE_NAME}.daemon.http.request.count`;
const DAEMON_HTTP_REQUEST_DURATION = `${SERVICE_NAME}.daemon.http.request.duration`;
const DAEMON_SESSION_ACTIVE = `${SERVICE_NAME}.daemon.session.active`;
const DAEMON_SESSION_LIFECYCLE = `${SERVICE_NAME}.daemon.session.lifecycle`;
const DAEMON_CHANNEL_LIFECYCLE = `${SERVICE_NAME}.daemon.channel.lifecycle`;
const DAEMON_PROMPT_QUEUE_WAIT = `${SERVICE_NAME}.daemon.prompt.queue_wait`;
const DAEMON_PROMPT_DURATION = `${SERVICE_NAME}.daemon.prompt.duration`;
const DAEMON_BRIDGE_ERROR_COUNT = `${SERVICE_NAME}.daemon.bridge.error.count`;
const DAEMON_CANCEL_COUNT = `${SERVICE_NAME}.daemon.cancel.count`;
const DAEMON_SSE_ACTIVE = `${SERVICE_NAME}.daemon.sse.active`;
const DAEMON_PROCESS_HEAP_USED = `${SERVICE_NAME}.daemon.process.heap_used`;

const KNOWN_ERROR_TYPES = new Set([
  'SessionNotFoundError',
  'WorkspaceMismatchError',
  'InvalidClientIdError',
  'SessionLimitExceededError',
  'RestoreInProgressError',
  'InvalidSessionScopeError',
  'TrustGateError',
  'WorkspaceInitConflictError',
  'WorkspaceInitPathEscapeError',
  'WorkspaceInitSymlinkError',
  'WorkspaceInitRaceError',
  'McpServerNotFoundError',
  'McpServerRestartFailedError',
  'PromptDeadlineExceededError',
  'InvalidSessionMetadataError',
  'SubscriberLimitExceededError',
  'BridgeChannelClosedError',
  'BridgeTimeoutError',
  'PermissionForbiddenError',
]);

let initialized = false;

let httpRequestCounter: Counter | undefined;
let httpRequestDurationHistogram: Histogram | undefined;
let sessionLifecycleCounter: Counter | undefined;
let channelLifecycleCounter: Counter | undefined;
let promptQueueWaitHistogram: Histogram | undefined;
let promptDurationHistogram: Histogram | undefined;
let bridgeErrorCounter: Counter | undefined;
let cancelCounter: Counter | undefined;

function normalizeErrorType(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return KNOWN_ERROR_TYPES.has(name) ? name : 'unknown';
}

export function initializeDaemonMetrics(): void {
  if (initialized) return;
  const meter = getMeter();
  if (!meter) return;

  httpRequestCounter = meter.createCounter(DAEMON_HTTP_REQUEST_COUNT, {
    description: 'Daemon HTTP request count by route and status class.',
    valueType: ValueType.INT,
  });

  httpRequestDurationHistogram = meter.createHistogram(
    DAEMON_HTTP_REQUEST_DURATION,
    {
      description: 'Daemon HTTP request duration in milliseconds.',
      unit: 'ms',
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [
          1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
        ],
      },
    },
  );

  sessionLifecycleCounter = meter.createCounter(DAEMON_SESSION_LIFECYCLE, {
    description: 'Daemon session lifecycle events (spawn, close, die).',
    valueType: ValueType.INT,
  });

  channelLifecycleCounter = meter.createCounter(DAEMON_CHANNEL_LIFECYCLE, {
    description: 'Daemon ACP channel lifecycle events (spawn, exit).',
    valueType: ValueType.INT,
  });

  promptQueueWaitHistogram = meter.createHistogram(DAEMON_PROMPT_QUEUE_WAIT, {
    description: 'Time a prompt waited in the per-session FIFO queue.',
    unit: 'ms',
    valueType: ValueType.DOUBLE,
    advice: {
      explicitBucketBoundaries: [
        1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000,
      ],
    },
  });

  promptDurationHistogram = meter.createHistogram(DAEMON_PROMPT_DURATION, {
    description: 'End-to-end prompt duration from dispatch to completion.',
    unit: 'ms',
    valueType: ValueType.DOUBLE,
    advice: {
      explicitBucketBoundaries: [
        100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000, 600000,
      ],
    },
  });

  bridgeErrorCounter = meter.createCounter(DAEMON_BRIDGE_ERROR_COUNT, {
    description: 'Daemon bridge error count by normalized error type.',
    valueType: ValueType.INT,
  });

  cancelCounter = meter.createCounter(DAEMON_CANCEL_COUNT, {
    description: 'Daemon cancel request count.',
    valueType: ValueType.INT,
  });

  initialized = true;
}

export interface DaemonGaugeCallbacks {
  sessionCount: () => number;
  sseCount: () => number;
  heapUsed: () => number;
}

let gaugesRegistered = false;

export function registerDaemonGaugeCallbacks(
  callbacks: DaemonGaugeCallbacks,
): void {
  if (gaugesRegistered) return;
  const meter = getMeter();
  if (!meter) return;
  gaugesRegistered = true;

  meter
    .createObservableGauge(DAEMON_SESSION_ACTIVE, {
      description: 'Current number of active daemon sessions.',
      valueType: ValueType.INT,
    })
    .addCallback((result) => {
      try {
        result.observe(callbacks.sessionCount());
      } catch {
        /* no-op */
      }
    });

  meter
    .createObservableGauge(DAEMON_SSE_ACTIVE, {
      description: 'Current number of active SSE connections.',
      valueType: ValueType.INT,
    })
    .addCallback((result) => {
      try {
        result.observe(callbacks.sseCount());
      } catch {
        /* no-op */
      }
    });

  meter
    .createObservableGauge(DAEMON_PROCESS_HEAP_USED, {
      description: 'Daemon process heap memory usage in bytes.',
      unit: 'bytes',
      valueType: ValueType.INT,
    })
    .addCallback((result) => {
      try {
        result.observe(callbacks.heapUsed());
      } catch {
        /* no-op */
      }
    });
}

export function recordDaemonHttpRequest(
  durationMs: number,
  route: string,
  statusCode: number,
): void {
  if (!initialized) return;
  const statusClass = `${Math.floor(statusCode / 100)}xx`;
  httpRequestCounter?.add(1, { route, status_class: statusClass });
  httpRequestDurationHistogram?.record(durationMs, { route });
}

export function recordDaemonSessionLifecycle(
  action: 'spawn' | 'close' | 'die',
): void {
  if (!initialized) return;
  sessionLifecycleCounter?.add(1, { action });
}

export function recordDaemonChannelLifecycle(
  action: 'spawn' | 'exit',
  expected?: boolean,
): void {
  if (!initialized) return;
  channelLifecycleCounter?.add(1, {
    action,
    ...(expected != null ? { expected } : {}),
  });
}

export function recordDaemonPromptQueueWait(durationMs: number): void {
  if (!initialized) return;
  promptQueueWaitHistogram?.record(durationMs);
}

export function recordDaemonPromptDuration(durationMs: number): void {
  if (!initialized) return;
  promptDurationHistogram?.record(durationMs);
}

export function recordDaemonBridgeError(err: unknown): void {
  if (!initialized) return;
  bridgeErrorCounter?.add(1, { error_type: normalizeErrorType(err) });
}

export function recordDaemonCancel(): void {
  if (!initialized) return;
  cancelCounter?.add(1);
}
