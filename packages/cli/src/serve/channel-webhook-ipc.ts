import { randomUUID } from 'node:crypto';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';

export type ChannelWebhookEnqueueErrorCode =
  | 'channel_worker_unavailable'
  | 'channel_webhook_enqueue_timeout'
  | 'channel_webhook_queue_full'
  | 'channel_webhook_target_unavailable'
  | 'channel_webhook_invalid_task'
  | 'channel_webhook_enqueue_failed';

const CHANNEL_WEBHOOK_ENQUEUE_ERROR_CODES: ReadonlySet<string> = new Set([
  'channel_worker_unavailable',
  'channel_webhook_enqueue_timeout',
  'channel_webhook_queue_full',
  'channel_webhook_target_unavailable',
  'channel_webhook_invalid_task',
  'channel_webhook_enqueue_failed',
]);

export class ChannelWebhookEnqueueError extends Error {
  constructor(
    readonly code: ChannelWebhookEnqueueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelWebhookEnqueueError';
  }
}

export function isChannelWebhookEnqueueErrorCode(
  value: unknown,
): value is ChannelWebhookEnqueueErrorCode {
  return (
    typeof value === 'string' && CHANNEL_WEBHOOK_ENQUEUE_ERROR_CODES.has(value)
  );
}

export function isChannelWebhookEnqueueError(
  value: unknown,
): value is ChannelWebhookEnqueueError {
  return (
    value instanceof ChannelWebhookEnqueueError ||
    (typeof value === 'object' &&
      value !== null &&
      isChannelWebhookEnqueueErrorCode((value as { code?: unknown }).code) &&
      typeof (value as { message?: unknown }).message === 'string')
  );
}

export interface ChannelWebhookTaskRequestMessage {
  type: 'webhook_task';
  id: string;
  expiresAt: number;
  task: ChannelWebhookTask;
}

export interface ChannelWebhookTaskResultMessage {
  type: 'webhook_task_result';
  id: string;
  ok: boolean;
  code?: ChannelWebhookEnqueueErrorCode;
  error?: string;
}

export interface ChannelWebhookAccepted {
  accepted: true;
}

export const CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS = 30_000;

export function createChannelWebhookTaskMessage(
  task: ChannelWebhookTask,
): ChannelWebhookTaskRequestMessage {
  return {
    type: 'webhook_task',
    id: randomUUID(),
    expiresAt: Date.now() + CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS,
    task,
  };
}

export function isChannelWebhookTaskMessage(
  value: unknown,
): value is ChannelWebhookTaskRequestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'webhook_task' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { expiresAt?: unknown }).expiresAt === 'number' &&
    typeof (value as { task?: unknown }).task === 'object' &&
    (value as { task?: unknown }).task !== null
  );
}

export function isChannelWebhookTaskResultMessage(
  value: unknown,
): value is ChannelWebhookTaskResultMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'webhook_task_result' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}
