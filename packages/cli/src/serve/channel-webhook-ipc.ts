import { randomUUID } from 'node:crypto';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';

export interface ChannelWebhookTaskRequestMessage {
  type: 'webhook_task';
  id: string;
  task: ChannelWebhookTask;
}

export interface ChannelWebhookTaskResultMessage {
  type: 'webhook_task_result';
  id: string;
  ok: boolean;
  error?: string;
}

export interface ChannelWebhookAccepted {
  accepted: true;
}

export function createChannelWebhookTaskMessage(
  task: ChannelWebhookTask,
): ChannelWebhookTaskRequestMessage {
  return {
    type: 'webhook_task',
    id: randomUUID(),
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
