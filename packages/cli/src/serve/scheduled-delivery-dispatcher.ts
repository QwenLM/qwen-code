import {
  claimScheduledDelivery,
  completeScheduledDelivery,
  type ScheduledDeliveryRecord,
} from '@qwen-code/qwen-code-core';
import {
  isChannelDeliveryError,
  type ChannelDeliveryAccepted,
  type ChannelDeliveryErrorCode,
  type ChannelDeliveryRequest,
} from './channel-delivery-ipc.js';

export interface ScheduledDeliveryDispatcherOptions {
  listWorkspaces: () => readonly string[];
  deliver: (
    workspaceCwd: string,
    request: ChannelDeliveryRequest,
  ) => Promise<ChannelDeliveryAccepted>;
  now?: () => number;
  pollIntervalMs?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  maxAttempts?: number;
  onError?: (error: unknown) => void;
}

export interface ScheduledDeliveryDispatcher {
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_BASE_RETRY_MS = 1000;
const DEFAULT_MAX_RETRY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export function createScheduledDeliveryDispatcher(
  options: ScheduledDeliveryDispatcherOptions,
): ScheduledDeliveryDispatcher {
  const now = options.now ?? Date.now;
  const pollIntervalMs = positiveOrDefault(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const leaseMs = positiveOrDefault(options.leaseMs, DEFAULT_LEASE_MS);
  const baseRetryMs = positiveOrDefault(
    options.baseRetryMs,
    DEFAULT_BASE_RETRY_MS,
  );
  const maxRetryMs = positiveOrDefault(
    options.maxRetryMs,
    DEFAULT_MAX_RETRY_MS,
  );
  const maxAttempts = positiveOrDefault(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let activeRun: Promise<void> | undefined;

  const processWorkspace = async (workspaceCwd: string): Promise<void> => {
    const claimed = await claimScheduledDelivery(workspaceCwd, {
      now: now(),
      leaseMs,
    });
    if (!claimed) return;
    try {
      await options.deliver(workspaceCwd, toDeliveryRequest(claimed));
      await completeScheduledDelivery(workspaceCwd, {
        deliveryId: claimed.deliveryId,
        outcome: 'delivered',
        now: now(),
      });
    } catch (error) {
      const normalized = normalizeDeliveryError(error);
      const completedAt = now();
      if (
        normalized.code === 'channel_delivery_invalid' ||
        claimed.attempts >= maxAttempts
      ) {
        await completeScheduledDelivery(workspaceCwd, {
          deliveryId: claimed.deliveryId,
          outcome: 'failed',
          now: completedAt,
          error: normalized,
        });
        return;
      }
      const retryMs = Math.min(
        maxRetryMs,
        baseRetryMs * 2 ** Math.max(0, claimed.attempts - 1),
      );
      await completeScheduledDelivery(workspaceCwd, {
        deliveryId: claimed.deliveryId,
        outcome: 'retryable',
        now: completedAt,
        nextAttemptAt: completedAt + retryMs,
        error: normalized,
      });
    }
  };

  const doRun = async (): Promise<void> => {
    if (stopping) return;
    const workspaces = [...new Set(options.listWorkspaces())];
    await Promise.all(workspaces.map(processWorkspace));
  };

  const runOnce = (): Promise<void> => {
    if (activeRun) return activeRun;
    const run = doRun()
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        if (activeRun === run) activeRun = undefined;
      });
    activeRun = run;
    return run;
  };

  return {
    start() {
      if (timer || stopping) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), pollIntervalMs);
      timer.unref();
    },
    runOnce,
    async stop() {
      stopping = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await activeRun;
    },
  };
}

function toDeliveryRequest(
  record: ScheduledDeliveryRecord,
): ChannelDeliveryRequest {
  return {
    deliveryId: record.deliveryId,
    channelName: record.channelName,
    target: record.target,
    text: record.text,
  };
}

function normalizeDeliveryError(error: unknown): {
  code: ChannelDeliveryErrorCode;
  message: string;
} {
  if (isChannelDeliveryError(error)) {
    return { code: error.code, message: error.message || error.code };
  }
  return {
    code: 'channel_delivery_failed',
    message: error instanceof Error && error.message ? error.message : 'failed',
  };
}

function positiveOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
